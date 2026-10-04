"""
Обучение модели риска отказа оборудования для «Живого цеха».

1. Генерирует синтетическую историю работы сварочного робота за 90 дней
   (2 смены по 8 часов). Модель деградации и датчиков та же, что в
   симуляторе js/sim.js (константы SENSOR_MODEL ниже должны совпадать).
2. Каждые 10 минут считает признаки за последние 30 минут:
   - ct_drift      — рост времени цикла относительно номинала;
   - ms_rate       — доля циклов с микроостановками;
   - temp_rise     — превышение температуры привода над базовой, °C;
   - hours_service — часы работы с последнего ППР/ремонта.
3. Метка: произойдёт ли отказ в ближайшие 60 минут.
4. Обучает логистическую регрессию (scikit-learn), проверяет её
   на последних 20 днях и выгружает коэффициенты в js/risk_model.js.

Запуск:  pip install -r ml/requirements.txt && python ml/train_risk_model.py
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (brier_score_loss, precision_score,
                             recall_score, roc_auc_score)
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SEED = 2026

# --- Модель деградации и датчиков (совпадает с js/sim.js) ---
SENSOR_MODEL = {
    "nominal_ct": 4.6,          # мин/кузов, сварка WR-04
    "ct_drift_k": 0.25,         # ct = nominal * (1 + k * (1-h)^2)
    "ct_noise": 0.04,           # лог-нормальный шум
    "temp_rise_k": 18.0,        # нагрев = k * (1-h)^1.5
    "temp_noise": 1.2,
    "ms_base": 0.01,            # вероятность микроостановки за цикл
    "ms_k": 0.15,               # + k * (1-h)^3
    "ms_min": 0.5, "ms_max": 1.5,
    "wear_per_min": 1 / 2600,   # износ за минуту работы * (2 - h)
    "hazard_base": 0.0001,      # интенсивность отказов, 1/мин
    "hazard_k": 0.12,           # + k * max(0, 0.5 - h)^2
    "repair_min": 60, "repair_max": 110,
    "health_after_repair": 0.85,
    "pm_duration": 25,
}
FEATURES = ["ct_drift", "ms_rate", "temp_rise"]
WINDOW = 30      # мин, окно признаков
HORIZON = 60     # мин, горизонт прогноза
STEP = 10        # мин, шаг наблюдений
DAYS = 90
TOTAL_MIN = DAYS * 16 * 60


def hazard(h):
    m = SENSOR_MODEL
    return m["hazard_base"] + m["hazard_k"] * max(0.0, 0.5 - h) ** 2


def simulate(rng):
    m = SENSOR_MODEL
    t, h, since = 0.0, 1.0, 0.0
    next_pm = rng.uniform(800, 1500)
    busy_since_pm = 0.0
    cycles, failures, services = [], [], []
    while t < TOTAL_MIN:
        # плановое ППР (иногда переносится — так в истории появляются отказы)
        if busy_since_pm >= next_pm:
            if rng.random() < 0.25:
                next_pm += rng.uniform(600, 1200)
            else:
                t += m["pm_duration"]
                h, since, busy_since_pm = 1.0, 0.0, 0.0
                next_pm = rng.uniform(800, 1500)
                services.append(("pm", t))
                continue
        ct = m["nominal_ct"] * (1 + m["ct_drift_k"] * (1 - h) ** 2) * math.exp(rng.normal(0, m["ct_noise"]))
        ms = rng.random() < m["ms_base"] + m["ms_k"] * (1 - h) ** 3
        dur = ct + (rng.uniform(m["ms_min"], m["ms_max"]) if ms else 0.0)
        temp = m["temp_rise_k"] * (1 - h) ** 1.5 + rng.normal(0, m["temp_noise"])
        # отказ во время цикла
        p_fail = 1 - math.exp(-hazard(h) * dur)
        if rng.random() < p_fail:
            fail_at = t + rng.uniform(0, dur)
            failures.append(fail_at)
            t = fail_at + rng.uniform(m["repair_min"], m["repair_max"])
            h, since = m["health_after_repair"], 0.0
            services.append(("repair", t))
            continue
        t += dur
        cycles.append((t, ct, ms, temp, since + dur / 60, h))
        h = max(0.0, h - m["wear_per_min"] * (2 - h) * dur)
        since += dur / 60
        busy_since_pm += dur
        # простой из-за отсутствия кузовов (без износа)
        if rng.random() < 0.08:
            t += rng.uniform(1, 6)
    return pd.DataFrame(cycles, columns=["t", "ct", "ms", "temp", "hours_service", "health"]), np.array(failures)


def build_dataset(cyc, failures):
    m = SENSOR_MODEL
    rows = []
    t_arr = cyc["t"].to_numpy()
    for t in np.arange(WINDOW, TOTAL_MIN - HORIZON, STEP):
        lo, hi = np.searchsorted(t_arr, [t - WINDOW, t], side="right")
        w = cyc.iloc[lo:hi]
        if len(w) < 3:
            continue  # оборудование стояло — прогноз не строим
        label = int(((failures > t) & (failures <= t + HORIZON)).any())
        rows.append({
            "minute": float(t),
            "day": int(t // (16 * 60)) + 1,
            "ct_drift": w["ct"].mean() / m["nominal_ct"] - 1,
            "ms_rate": w["ms"].mean(),
            "temp_rise": w["temp"].mean(),
            "hours_service": w["hours_service"].iloc[-1],
            "health_hidden": w["health"].iloc[-1],
            "fail_next_60min": label,
        })
    return pd.DataFrame(rows)


LABELS = {
    "observations_total": "Наблюдений (каждые 10 мин)",
    "failures_in_history": "Отказов в истории за 90 дней",
    "positive_share": "Доля наблюдений «отказ в ближайший час»",
    "test_days": "Дни для проверки (не участвовали в обучении)",
    "roc_auc": "ROC-AUC на проверке",
    "brier": "Brier score",
    "alert_threshold": "Порог предупреждения",
    "precision_at_threshold": "Точность при пороге",
    "recall_at_threshold": "Полнота при пороге (доля пойманных отказов)",
}


def main():
    rng = np.random.default_rng(SEED)
    cyc, failures = simulate(rng)
    df = build_dataset(cyc, failures)
    (ROOT / "data").mkdir(exist_ok=True)
    df.round(4).to_csv(ROOT / "data" / "welding_history_90d.csv", index=False)

    train, test = df[df.day <= 70], df[df.day > 70]
    scaler = StandardScaler().fit(train[FEATURES])
    model = LogisticRegression(class_weight="balanced", max_iter=1000)
    model.fit(scaler.transform(train[FEATURES]), train.fail_next_60min)

    # balanced-веса сдвигают вероятности; калибруем свободный член под реальную частоту
    def predict(X, b0):
        z = scaler.transform(X) @ model.coef_[0] + b0
        return 1 / (1 + np.exp(-z))
    b0 = model.intercept_[0]
    for _ in range(60):
        b0 -= 0.5 * (predict(train[FEATURES], b0).mean() - train.fail_next_60min.mean())

    p = predict(test[FEATURES], b0)
    y = test.fail_next_60min.to_numpy()
    thr = 0.25
    metrics = {
        "observations_total": int(len(df)),
        "failures_in_history": int(len(failures)),
        "positive_share": round(float(df.fail_next_60min.mean()), 4),
        "test_days": "71-90",
        "roc_auc": round(float(roc_auc_score(y, p)), 3),
        "brier": round(float(brier_score_loss(y, p)), 4),
        "alert_threshold": thr,
        "precision_at_threshold": round(float(precision_score(y, p >= thr, zero_division=0)), 3),
        "recall_at_threshold": round(float(recall_score(y, p >= thr)), 3),
    }
    export = {
        "features": FEATURES,
        "mean": scaler.mean_.round(6).tolist(),
        "std": scaler.scale_.round(6).tolist(),
        "coef": model.coef_[0].round(6).tolist(),
        "intercept": round(float(b0), 6),
        "window_min": WINDOW,
        "horizon_min": HORIZON,
        "metrics": metrics,
        "sensor_model": SENSOR_MODEL,
    }
    (ROOT / "ml" / "risk_model.json").write_text(json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / "js" / "risk_model.js").write_text(
        "// Сгенерировано ml/train_risk_model.py — не редактировать вручную\n"
        "window.RISK_MODEL = " + json.dumps(export, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")

    report = [
        "# Модель риска отказа: отчёт обучения", "",
        "Логистическая регрессия: вероятность отказа поста в ближайшие 60 минут по признакам за последние 30 минут.", "",
        "| Метрика | Значение |", "| --- | --- |",
    ] + [f"| {LABELS[k]} | {v} |" for k, v in metrics.items()] + [
        "", "## Вклад признаков (стандартизованные коэффициенты)", "",
        "| Признак | Коэффициент |", "| --- | --- |",
    ] + [f"| {f} | {c:+.3f} |" for f, c in zip(FEATURES, model.coef_[0])] + [
        "", "Данные синтетические: обучение показывает принцип. На заводе модель переобучается на реальных логах MES/SCADA."]
    (ROOT / "ml" / "REPORT.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print(dict(zip(FEATURES, model.coef_[0].round(3))))


if __name__ == "__main__":
    main()
