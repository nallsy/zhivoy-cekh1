// Сгенерировано train_risk_model.py — не редактировать вручную
window.RISK_MODEL = {
  "features": [
    "ct_drift",
    "ms_rate",
    "temp_rise"
  ],
  "mean": [
    0.029486,
    0.018162,
    3.188904
  ],
  "std": [
    0.034191,
    0.056073,
    2.704042
  ],
  "coef": [
    0.369944,
    -0.148988,
    0.952551
  ],
  "intercept": -3.67561,
  "window_min": 30,
  "horizon_min": 60,
  "metrics": {
    "observations_total": 8269,
    "failures_in_history": 33,
    "positive_share": 0.0239,
    "test_days": "71-90",
    "roc_auc": 0.845,
    "brier": 0.0259,
    "alert_threshold": 0.25,
    "precision_at_threshold": 0.165,
    "recall_at_threshold": 0.472
  },
  "sensor_model": {
    "nominal_ct": 4.6,
    "ct_drift_k": 0.25,
    "ct_noise": 0.04,
    "temp_rise_k": 18.0,
    "temp_noise": 1.2,
    "ms_base": 0.01,
    "ms_k": 0.15,
    "ms_min": 0.5,
    "ms_max": 1.5,
    "wear_per_min": 0.0003846153846153846,
    "hazard_base": 0.0001,
    "hazard_k": 0.12,
    "repair_min": 60,
    "repair_max": 110,
    "health_after_repair": 0.85,
    "pm_duration": 25
  }
};
