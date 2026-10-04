/*
 * «Живой цех» — дискретная симуляция сборочной линии (цифровой двойник).
 * Модель износа и датчиков совпадает с train_risk_model.py,
 * поэтому обученная там модель риска применяется к данным этой симуляции.
 * Не зависит от DOM: можно запускать в браузере и в Node.js.
 */
(function (global) {
  'use strict';

  const RM = global.RISK_MODEL;
  const SM = RM.sensor_model;

  const CONFIG = {
    shiftStart: 10 * 60,      // 10:00
    shiftLen: 480,            // минут в смене
    plan: 100,                // авто за смену
    dt: 0.25,                 // шаг симуляции, мин
    idealCt: 4.4,             // проектный такт линии, мин/авто (для OEE)
    bufferCap: 8,             // ёмкость буфера перед постом
    reworkMin: 40,            // доработка дефектного авто, мин
    reserveSlowdown: 1.7,     // резервный пост медленнее основного
    pmDelay: 120,             // «перенести ППР» = через 2 часа
    obsEvery: 5,              // пересчёт риска, мин
    warn: 0.25,               // порог предупреждения (как в REPORT.md)
    crit: 0.5,
    stations: [
      { id: 'warehouse', name: 'Склад', code: 'KT-01', ct: 3.9, h: 0.93, since: 6, tempBase: 35, queue: 0 },
      { id: 'welding', name: 'Сварка', code: 'WR-04', ct: 4.6, h: 0.30, since: 29, tempBase: 48, queue: 3 },
      { id: 'paint', name: 'Окраска', code: 'PB-02', ct: 4.4, h: 0.80, since: 12, tempBase: 42, queue: 2 },
      { id: 'assembly', name: 'Сборка', code: 'AS-01', ct: 4.5, h: 0.90, since: 8, tempBase: 38, queue: 3 },
      { id: 'quality', name: 'Контроль', code: 'QC-03', ct: 3.6, h: 0.95, since: 5, tempBase: 30, queue: 1 },
    ],
  };

  const ACTIONS = {
    none: 'Ничего не менять',
    pm_now: 'Провести ППР сейчас',
    reserve: 'Включить резервный пост',
    pm_reserve: 'ППР сейчас + резервный пост',
    pm_later: 'Перенести ППР на 2 часа',
  };

  // ---------- случайные числа (состояние хранится в самой линии, чтобы её можно было копировать) ----------
  function rnd(L) {
    let t = (L.rs = (L.rs + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const uni = (L, a, b) => a + (b - a) * rnd(L);
  function normal(L) {
    const u = Math.max(rnd(L), 1e-12), v = rnd(L);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const hazard = h => SM.hazard_base + SM.hazard_k * Math.max(0, 0.5 - h) ** 2;
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  const clock = t => {
    const m = Math.floor(CONFIG.shiftStart + t);
    return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };
  const planAt = t => CONFIG.plan * Math.min(t, CONFIG.shiftLen) / CONFIG.shiftLen;

  // ---------- создание линии ----------
  function createLine(seed) {
    const L = {
      t: 0, rs: seed >>> 0, seed, light: false,
      out: 0, inspected: 0, defects: 0, rework: [],
      events: [], series: [{ t: 0, out: 0 }], scheduled: [],
      nextObs: 0, nextMin: 1, lastPlanAlert: -999,
      stations: [],
    };
    L.stations = CONFIG.stations.map(c => ({
      id: c.id, name: c.name, code: c.code, nominal: c.ct, tempBase: c.tempBase,
      h: c.h, since: c.since, queue: c.queue,
      state: 'idle', hasJob: false, rem: 0, curCt: 0, curMs: false,
      downRem: 0, pmRem: 0, reserve: false, backup: { has: false, rem: 0, done: 0 },
      stats: { busy: 0, idle: 0, blocked: 0, down: 0, pm: 0 },
      cycles: 0, failures: 0, downLog: [],
      temp: c.tempBase, win: [], risk: null, contrib: null, feats: null,
      riskHist: [], cum: [0], busyCum: [0], blockedCum: [0], alertLevel: 0, qAlert: -999,
    }));
    // линия уже работает: на постах кузова на разной стадии цикла
    L.stations.forEach(st => { startJob(L, st); st.rem *= rnd(L); });
    // история датчиков за последние 30 минут, чтобы риск был виден сразу
    L.stations.forEach(st => {
      for (let k = 0; k < 7; k++) {
        const c = sampleCycle(L, st);
        st.win.push({ t: -30 + k * 4.3, ct: c.ct, ms: c.ms ? 1 : 0, temp: c.temp });
      }
    });
    ev(L, 'info', 'Смена началась', 'Линия L-01, план ' + CONFIG.plan + ' авто');
    observe(L);
    return L;
  }

  function ev(L, level, title, detail, stationId) {
    if (L.light) return;
    L.events.unshift({ t: L.t, time: clock(L.t), level, title, detail, station: stationId || null });
    if (L.events.length > 80) L.events.pop();
  }

  function sampleCycle(L, st) {
    const ct = st.nominal * (1 + SM.ct_drift_k * (1 - st.h) ** 2) * Math.exp(normal(L) * SM.ct_noise);
    const ms = rnd(L) < SM.ms_base + SM.ms_k * (1 - st.h) ** 3;
    const temp = SM.temp_rise_k * (1 - st.h) ** 1.5 + normal(L) * SM.temp_noise;
    return { ct, ms, temp };
  }

  function startJob(L, st) {
    const ct = st.nominal * (1 + SM.ct_drift_k * (1 - st.h) ** 2) * Math.exp(normal(L) * SM.ct_noise);
    const ms = rnd(L) < SM.ms_base + SM.ms_k * (1 - st.h) ** 3;
    st.curCt = ct; st.curMs = ms;
    st.rem = ct + (ms ? uni(L, SM.ms_min, SM.ms_max) : 0);
    st.jobDur = st.rem;
    st.hasJob = true; st.state = 'busy';
  }

  function finishCycle(L, st) {
    const rise = SM.temp_rise_k * (1 - st.h) ** 1.5 + normal(L) * SM.temp_noise;
    st.temp = st.tempBase + rise;
    st.cycles++;
    if (!L.light) st.win.push({ t: L.t, ct: st.curCt, ms: st.curMs ? 1 : 0, temp: rise });
  }

  // передать кузов дальше; false — следующий буфер полон
  function push(L, i) {
    const last = L.stations.length - 1;
    if (i === last) {
      L.inspected++;
      const paint = L.stations[2];
      if (rnd(L) < 0.018 + 0.06 * (1 - paint.h) ** 2) {
        L.defects++;
        L.rework.push(L.t + CONFIG.reworkMin);
        ev(L, 'warn', 'Дефект на контроле', 'Авто отправлено на доработку (' + CONFIG.reworkMin + ' мин)', 'quality');
      } else {
        L.out++;
      }
      return true;
    }
    const next = L.stations[i + 1];
    if (next.queue < CONFIG.bufferCap) { next.queue++; return true; }
    return false;
  }

  function pm(L, st) {
    if (st.state === 'down' || st.state === 'pm') return false;
    st.state = 'pm';
    st.pmRem = SM.pm_duration;
    st.pmStart = L.t;
    ev(L, 'info', st.code + ': начато ППР', 'Плановое обслуживание ' + SM.pm_duration + ' мин', st.id);
    return true;
  }

  function doAction(L, type, stationId) {
    const st = L.stations.find(s => s.id === stationId) || L.stations[1];
    if (type === 'pm_now') pm(L, st);
    if (type === 'reserve' || type === 'pm_reserve') {
      if (!st.reserve) ev(L, 'ok', 'Включён резервный пост', st.name + ': работает медленнее в ' + CONFIG.reserveSlowdown + ' раза, пока основной стоит', st.id);
      st.reserve = true;
    }
    if (type === 'pm_reserve') pm(L, st);
    if (type === 'pm_later') {
      L.scheduled.push({ at: L.t + CONFIG.pmDelay, type: 'pm_now', station: st.id, done: false });
      ev(L, 'info', st.code + ': ППР запланировано', 'На ' + clock(L.t + CONFIG.pmDelay), st.id);
    }
  }

  function forceFail(L, stationId) {
    const st = L.stations.find(s => s.id === stationId);
    if (!st || st.state === 'down') return;
    st.state = 'down';
    st.downRem = uni(L, SM.repair_min, SM.repair_max);
    st.failures++;
    st.downLog.push({ start: L.t, end: L.t + st.downRem, forced: true });
    ev(L, 'crit', st.code + ' остановлен', 'Отказ оборудования (внесён вручную). Ремонт ~' + Math.round(st.downRem) + ' мин', st.id);
  }

  // ---------- один шаг симуляции ----------
  function step(L) {
    const dt = CONFIG.dt;
    L.t += dt;
    for (const a of L.scheduled) if (!a.done && L.t >= a.at) { a.done = true; doAction(L, a.type, a.station); }
    if (L.rework.length) {
      const ready = L.rework.filter(x => x <= L.t).length;
      if (ready) { L.out += ready; L.rework = L.rework.filter(x => x > L.t); }
    }
    const n = L.stations.length;
    for (let i = n - 1; i >= 0; i--) {
      const st = L.stations[i];
      switch (st.state) {
        case 'down':
          st.downRem -= dt;
          if (st.downRem <= 0) {
            st.state = st.hasJob ? 'busy' : 'idle';
            st.h = SM.health_after_repair; st.since = 0; st.win = [];
            ev(L, 'ok', st.code + ' снова в работе', 'Ремонт завершён', st.id);
          }
          break;
        case 'pm':
          st.pmRem -= dt;
          if (st.pmRem <= 0) {
            st.state = st.hasJob ? 'busy' : 'idle';
            st.h = 1; st.since = 0; st.win = [];
            ev(L, 'ok', st.code + ': ППР завершено', 'Износ сброшен, время цикла вернётся к номиналу', st.id);
          }
          break;
        case 'busy':
          if (rnd(L) < hazard(st.h) * dt) {
            st.state = 'down';
            st.downRem = uni(L, SM.repair_min, SM.repair_max);
            st.failures++;
            st.downLog.push({ start: L.t, end: L.t + st.downRem });
            ev(L, 'crit', st.code + ' остановлен', 'Отказ оборудования. Ремонт ~' + Math.round(st.downRem) + ' мин', st.id);
            break;
          }
          st.rem -= dt;
          st.h = Math.max(0, st.h - SM.wear_per_min * (2 - st.h) * dt);
          st.since += dt / 60;
          if (st.rem <= 0) {
            finishCycle(L, st);
            st.hasJob = false;
            st.state = push(L, i) ? 'idle' : 'blocked';
          }
          break;
        case 'blocked':
          if (push(L, i)) st.state = 'idle';
          break;
      }
      if (st.state === 'idle' && (i === 0 || st.queue > 0)) {
        if (i > 0) st.queue--;
        startJob(L, st);
      }
      // резервный пост работает, только пока основной стоит
      if (st.reserve) {
        const b = st.backup;
        const mainOff = st.state === 'down' || st.state === 'pm';
        if (b.has) {
          b.rem -= dt;
          if (b.rem <= 0 && push(L, i)) { b.has = false; b.done++; }
        }
        if (!b.has && mainOff && (i === 0 || st.queue > 0)) {
          if (i > 0) st.queue--;
          b.has = true;
          b.rem = st.nominal * CONFIG.reserveSlowdown * Math.exp(normal(L) * 0.05);
        }
      }
      st.stats[st.state] += dt;
    }
    if (!L.light && L.t >= L.nextMin - 1e-9) { L.nextMin += 1; perMinute(L); }
    if (!L.light && L.t >= L.nextObs - 1e-9) { L.nextObs += CONFIG.obsEvery; observe(L); }
  }

  function perMinute(L) {
    L.series.push({ t: L.t, out: L.out });
    for (const st of L.stations) {
      st.cum.push(st.stats.busy + st.stats.down + st.stats.pm);
      st.busyCum.push(st.stats.busy);
      st.blockedCum.push(st.stats.blocked);
      if (st.queue >= CONFIG.bufferCap && L.t - st.qAlert > 90) {
        st.qAlert = L.t;
        ev(L, 'warn', 'Буфер перед постом «' + st.name + '» заполнен', st.queue + ' из ' + CONFIG.bufferCap + ' кузовов: участки выше по потоку блокируются', st.id);
      }
    }
    if (L.t >= 30 && Math.round(L.t) % 30 === 0 && L.out < planAt(L.t) * 0.95 && L.t - L.lastPlanAlert >= 60) {
      L.lastPlanAlert = L.t;
      ev(L, 'warn', 'Отставание от плана', 'Выпущено ' + L.out + ' при плане ' + Math.round(planAt(L.t)) + ' к ' + clock(L.t));
    }
  }

  // ---------- модель риска (коэффициенты из risk_model.json) ----------
  function riskOf(feats) {
    const contrib = RM.features.map((f, k) => ((feats[f] - RM.mean[k]) / RM.std[k]) * RM.coef[k]);
    const z = RM.intercept + contrib.reduce((a, b) => a + b, 0);
    return { risk: sigmoid(z), contrib };
  }

  function observe(L) {
    for (const st of L.stations) {
      st.win = st.win.filter(c => c.t > L.t - RM.window_min);
      if (st.state === 'down') { st.risk = null; continue; }
      if (st.win.length < 3) continue;
      const mean = key => st.win.reduce((a, c) => a + c[key], 0) / st.win.length;
      st.feats = { ct_drift: mean('ct') / st.nominal - 1, ms_rate: mean('ms'), temp_rise: mean('temp') };
      const r = riskOf(st.feats);
      st.risk = r.risk; st.contrib = r.contrib;
      st.riskHist.push({ t: L.t, r: r.risk });
      const level = r.risk >= CONFIG.crit ? 2 : r.risk >= CONFIG.warn ? 1 : 0;
      if (level > st.alertLevel) {
        ev(L, level === 2 ? 'crit' : 'warn', st.code + ': риск отказа ' + Math.round(r.risk * 100) + '%',
          'Модель: ' + topFactorText(st) + '. Горизонт прогноза ' + RM.horizon_min + ' мин', st.id);
        st.alertLevel = level;
      } else if (level < st.alertLevel && r.risk < (st.alertLevel === 2 ? CONFIG.crit : CONFIG.warn) - 0.08) {
        st.alertLevel = level;
      }
    }
  }

  const FACTOR_NAMES = { ct_drift: 'время цикла', ms_rate: 'микроостановки', temp_rise: 'температура привода' };
  function factorValue(st, f) {
    const v = st.feats ? st.feats[f] : 0;
    if (f === 'ct_drift') return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '% к номиналу';
    if (f === 'ms_rate') return (v * 100).toFixed(0) + '% циклов';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + ' °C к норме';
  }
  function topFactorText(st) {
    if (!st.contrib) return 'нет данных';
    let k = 0;
    st.contrib.forEach((c, i) => { if (c > st.contrib[k]) k = i; });
    const f = RM.features[k];
    return FACTOR_NAMES[f] + ' ' + factorValue(st, f);
  }

  // ---------- показатели ----------
  // доля времени за последние win минут: 'active' — работа+простой, 'busy', 'blocked', 'down'
  function share(st, win, kind) {
    const pick = {
      active: st.cum, busy: st.busyCum, blocked: st.blockedCum,
    }[kind === 'down' ? 'active' : kind];
    const m = pick.length - 1, k = Math.max(0, m - win);
    if (m - k < 5) {
      const s = st.stats, tot = s.busy + s.idle + s.blocked + s.down + s.pm || 1;
      return { active: s.busy + s.down + s.pm, busy: s.busy, blocked: s.blocked, down: s.down + s.pm }[kind] / tot;
    }
    if (kind === 'down') return ((st.cum[m] - st.cum[k]) - (st.busyCum[m] - st.busyCum[k])) / (m - k);
    return (pick[m] - pick[k]) / (m - k);
  }
  const util = (st, win, busyOnly) => share(st, win, busyOnly ? 'busy' : 'active');

  function bottleneck(L) {
    let best = L.stations[0], bu = -1;
    for (const st of L.stations) {
      const u = util(st, 60) + st.queue * 0.002; // при равной загрузке — где больше очередь
      if (u > bu) { bu = u; best = st; }
    }
    return { station: best, util: util(best, 60) };
  }

  function downtime(L) {
    return L.stations.reduce((a, s) => a + s.stats.down + s.stats.pm, 0);
  }

  function kpis(L) {
    const el = Math.max(L.t, 1e-6);
    const planNow = planAt(L.t);
    const bn = bottleneck(L).station;
    const stop = bn.stats.down + bn.stats.pm;
    const A = Math.max(0, (el - stop) / el);
    const Q = L.inspected ? (L.inspected - L.defects) / L.inspected : 1;
    const P = A > 0 ? Math.min(1, (L.inspected * CONFIG.idealCt) / (el * A)) : 0;
    const s = L.series, back = s[Math.max(0, s.length - 61)];
    const made60 = L.out - back.out, span = L.t - back.t;
    return {
      out: L.out, planNow, planPct: planNow > 0.5 ? L.out / planNow : 1,
      oee: A * P * Q, A, P, Q,
      downtime: downtime(L), failures: L.stations.reduce((a, s) => a + s.failures, 0),
      defectPct: L.inspected ? L.defects / L.inspected : 0, inspected: L.inspected, defects: L.defects,
      wip: L.stations.reduce((a, st) => a + st.queue + (st.hasJob || st.state === 'blocked' ? 1 : 0) + (st.backup.has ? 1 : 0), 0) + L.rework.length,
      taktFact: made60 > 0 ? span / made60 : null,
      avgLoad: L.stations.reduce((a, st) => a + util(st, 60, true), 0) / L.stations.length,
    };
  }

  // ---------- что если: Монте-Карло по копиям линии ----------
  function cloneLight(L, seed) {
    return {
      ...L, light: true, rs: seed >>> 0, events: [], series: [L.series[L.series.length - 1]],
      rework: L.rework.slice(), scheduled: L.scheduled.map(a => ({ ...a })),
      stations: L.stations.map(s => ({ ...s, stats: { ...s.stats }, backup: { ...s.backup }, win: [], riskHist: [], cum: [0], busyCum: [0], blockedCum: [0], downLog: [] })),
    };
  }

  function quant(arr, q) {
    const a = arr.slice().sort((x, y) => x - y);
    const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return a[lo] + (a[hi] - a[lo]) * (p - lo);
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

  function runScenario(L, action, stationId, seeds) {
    return seeds.map(seed => {
      const c = cloneLight(L, seed);
      const d0 = downtime(c), f0 = c.stations.reduce((a, s) => a + s.failures, 0);
      doAction(c, action, stationId);
      while (c.t < CONFIG.shiftLen - 1e-9) step(c);
      return { out: c.out, down: downtime(c) - d0, fails: c.stations.reduce((a, s) => a + s.failures, 0) - f0 };
    });
  }

  // все варианты на одних и тех же случайных сценариях — сравнение «при прочих равных»
  function compareActions(L, stationId, runs) {
    runs = runs || 40;
    const seeds = Array.from({ length: runs }, (_, k) => (L.rs ^ (k * 2654435761)) >>> 0);
    const base = runScenario(L, 'none', stationId, seeds);
    return Object.keys(ACTIONS).map(a => {
      const r = a === 'none' ? base : runScenario(L, a, stationId, seeds);
      const diff = r.map((x, k) => x.out - base[k].out);
      return {
        action: a, label: ACTIONS[a],
        out: avg(r.map(x => x.out)), outP10: quant(r.map(x => x.out), 0.1), outP90: quant(r.map(x => x.out), 0.9),
        down: avg(r.map(x => x.down)), failProb: avg(r.map(x => (x.fails > 0 ? 1 : 0))),
        gain: avg(diff), gainP10: quant(diff, 0.1), gainP90: quant(diff, 0.9),
      };
    });
  }

  function forecastEnd(L, runs) {
    const seeds = Array.from({ length: runs || 16 }, (_, k) => (L.rs ^ (k * 40503 + 977)) >>> 0);
    const r = runScenario(L, 'none', null, seeds).map(x => x.out);
    return { mean: avg(r), p10: quant(r, 0.1), p90: quant(r, 0.9) };
  }

  // ---------- текстовая сводка смены ----------
  function summary(L, extra) {
    const k = kpis(L), bn = bottleneck(L);
    const lines = [];
    lines.push('К ' + clock(L.t) + ' выпущено ' + k.out + ' авто при плане ' + Math.round(k.planNow) + ' (' + Math.round(k.planPct * 100) + '%). OEE линии ' + Math.round(k.oee * 100) + '%.');
    if (extra && extra.forecast) lines.push('Прогноз на конец смены: ' + Math.round(extra.forecast.mean) + ' авто (от ' + Math.round(extra.forecast.p10) + ' до ' + Math.round(extra.forecast.p90) + ') при плане ' + CONFIG.plan + '.');
    const fails = [];
    L.stations.forEach(st => st.downLog.forEach(d => fails.push(st.code + ' в ' + clock(d.start) + ' (' + Math.round(Math.min(d.end, L.t) - d.start) + ' мин)')));
    lines.push('Простои оборудования: ' + Math.round(k.downtime) + ' мин' + (fails.length ? ', отказы: ' + fails.join(', ') + '.' : ', отказов не было.'));
    lines.push('Узкое место: ' + bn.station.name + ' (' + bn.station.code + '), занятость ' + Math.round(bn.util * 100) + '% за последний час, очередь ' + bn.station.queue + ' кузовов.');
    const risky = L.stations.filter(s => s.risk != null).sort((a, b) => b.risk - a.risk)[0];
    if (risky) lines.push('Наибольший риск отказа: ' + risky.code + ' — ' + Math.round(risky.risk * 100) + '% в ближайший час; главный фактор — ' + topFactorText(risky) + '.');
    lines.push('Качество: дефектов ' + k.defects + ' из ' + k.inspected + ' проверенных (' + (k.defectPct * 100).toFixed(1) + '%), на доработке ' + L.rework.length + '.');
    if (extra && extra.best && extra.best.action !== 'none' && extra.best.gain > 0.5) lines.push('Рекомендация: «' + extra.best.label + '» — по симуляции +' + extra.best.gain.toFixed(1) + ' авто к концу смены.');
    return lines;
  }

  global.Twin = {
    CONFIG, ACTIONS, FACTOR_NAMES, createLine, step, doAction, forceFail, kpis, bottleneck,
    util, share, compareActions, forecastEnd, summary, clock, planAt, factorValue, topFactorText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
