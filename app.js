/* «Живой цех» — интерфейс цифрового двойника. Вся логика модели — в js/sim.js. */
(function () {
  'use strict';
  const T = window.Twin, C = T.CONFIG, RM = window.RISK_MODEL;
  const $ = id => document.getElementById(id);
  const SEED = 30; // фиксированный сценарий: демо всегда проходит одинаково, пока никто не вмешался

  const STATE_LABEL = { busy: 'работает', idle: 'ждёт кузов', blocked: 'заблокирован', down: 'простой: ремонт', pm: 'ППР' };
  const LEVEL_LABEL = { crit: 'критично', warn: 'внимание', ok: 'решено', info: 'событие' };
  const nf = new Intl.NumberFormat('ru-RU');
  const money = n => nf.format(Math.round(n)) + ' ₸';
  const pct = x => Math.round(x * 100) + '%';
  const sign = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1);
  const riskColor = r => (r == null ? '#5f6d8a' : r >= C.crit ? '#ef6666' : r >= C.warn ? '#e8a63c' : '#58d67b');
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  let L, running, ended, speed = 3, selected, acc = 0, lastFrame = 0, lastRender = 0;
  let forecast, nextForecastT, compare, autoLevel, shownEvents;

  // ---------- построение интерфейса ----------
  function buildMap() {
    const html = [];
    L.stations.forEach((st, i) => {
      if (i > 0) {
        html.push('<div class="buffer" id="buf-' + st.id + '" title="Буфер перед постом «' + st.name + '»"><span class="arr">→</span><div class="cells">' +
          '<i></i>'.repeat(C.bufferCap) + '</div><span class="bq">0/' + C.bufferCap + '</span></div>');
      }
      html.push('<div class="station" id="st-' + st.id + '" data-id="' + st.id + '" tabindex="0" role="button" aria-label="Пост ' + st.name + '">' +
        '<span class="nm">' + st.name + '</span><span class="cd">' + st.code + '</span>' +
        '<span class="chip"></span><div class="prog"><i></i></div>' +
        '<div class="meta"><span>загрузка<b class="ld">—</b></span><span>темп.<b class="tp">—</b></span></div>' +
        '<div class="rk"></div><span class="reserve" hidden></span></div>');
    });
    $('lineMap').innerHTML = html.join('');
    document.querySelectorAll('.station').forEach(el => {
      el.addEventListener('click', () => select(el.dataset.id));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(el.dataset.id); } });
    });
    $('riskList').innerHTML = L.stations.map(st =>
      '<button data-id="' + st.id + '"><span>' + st.name + '</span><i><b></b></i><strong>—</strong></button>').join('');
    $('riskList').querySelectorAll('button').forEach(b => b.addEventListener('click', () => select(b.dataset.id)));
    $('wfStation').innerHTML = L.stations.map(st => '<option value="' + st.id + '">' + st.name + ' · ' + st.code + '</option>').join('');
    $('loads').innerHTML = L.stations.map(st =>
      '<div class="loadrow" id="ld-' + st.id + '"><span>' + st.name + '</span><div class="stack"><i style="background:#58d67b"></i><i style="background:#ef6666"></i><i style="background:#e8a63c"></i></div><strong>—</strong></div>').join('');
    const m = RM.metrics;
    $('modelNote').innerHTML = 'Логистическая регрессия по трём признакам за 30 минут. ROC-AUC ' + m.roc_auc +
      ' на днях ' + m.test_days + ', которые не участвовали в обучении. <a href="https://github.com/nallsy/zhivoy-cekh/blob/main/ml/REPORT.md">Отчёт модели</a>';
  }

  function reset() {
    L = T.createLine(SEED);
    running = false; ended = false; acc = 0; selected = 'welding';
    forecast = null; nextForecastT = 0; compare = null; autoLevel = 0; shownEvents = -1;
    buildMap();
    $('wfStation').value = selected;
    $('wfBody').innerHTML = '<tr><td colspan="6" class="muted">Нажмите «Рассчитать варианты»: двойник прогонит каждый вариант 40 раз до конца смены.</td></tr>';
    $('summary').innerHTML = '<li class="muted">Сводка появится по кнопке или автоматически в конце смены.</li>';
    $('recText').textContent = 'Запустите смену: двойник сам сравнит варианты действий, когда риск превысит порог 25%.';
    $('recApply').hidden = true;
    $('eCars').value = 0;
    updateForecast();
    updateEconomics();
    setPlay();
    render();
  }

  function select(id) {
    selected = id;
    $('wfStation').value = id;
    render();
  }

  function setPlay() {
    $('playBtn').textContent = ended ? '↺ Новая смена' : running ? '❚❚ Пауза' : (L.t > 0 ? '▶ Продолжить' : '▶ Запустить смену');
    $('liveDot').classList.toggle('on', running);
  }

  // ---------- расчёты двойника ----------
  function updateForecast() {
    forecast = T.forecastEnd(L, 16);
    nextForecastT = L.t + 15;
  }

  function runCompare(stationId, auto) {
    $('wfStation').value = stationId;
    $('wfBody').innerHTML = '<tr><td colspan="6" class="muted">Считаю 5 вариантов × 40 прогонов…</td></tr>';
    setTimeout(() => {
      const rows = T.compareActions(L, stationId, 40);
      const best = rows.filter(r => r.action !== 'none').sort((a, b) => b.out - a.out)[0];
      compare = { station: stationId, t: L.t, rows, best };
      renderCompare();
      renderRecommendation();
      if (auto) addEvent('info', 'ИИ сравнил варианты для ' + stationOf(stationId).code, best.gain > 0.5
        ? 'Лучший: «' + best.label + '», ' + sign(best.gain) + ' авто к концу смены'
        : 'Вмешательство не даёт заметного эффекта');
      renderEvents(true);
    }, 30);
  }

  function apply(action, stationId) {
    const st = stationOf(stationId);
    T.doAction(L, action, stationId);
    addEvent('ok', 'Решение принято: ' + T.ACTIONS[action], st.name + ' · ' + st.code);
    compare = null;
    $('recText').textContent = 'Применено: «' + T.ACTIONS[action] + '». Двойник пересчитал прогноз выпуска.';
    $('recApply').hidden = true;
    $('wfBody').innerHTML = '<tr><td colspan="6" class="muted">Решение применено. Рассчитайте варианты заново, чтобы увидеть новую картину.</td></tr>';
    updateForecast();
    render();
  }

  function addEvent(level, title, detail) {
    L.events.unshift({ t: L.t, time: T.clock(L.t), level, title, detail });
  }
  const stationOf = id => L.stations.find(s => s.id === id);

  // ---------- главный цикл ----------
  function frame(ts) {
    const dtReal = Math.min(0.25, (ts - lastFrame) / 1000 || 0);
    lastFrame = ts;
    if (running) {
      acc += dtReal * speed;
      let guard = 0;
      while (acc >= C.dt && L.t < C.shiftLen && guard++ < 2000) { T.step(L); acc -= C.dt; }
      if (L.t >= nextForecastT) updateForecast();
      // когда риск на каком-то посту поднимается до нового уровня — сразу считаем варианты
      const top = L.stations.reduce((a, s) => (s.alertLevel > a.alertLevel ? s : a), L.stations[0]);
      if (top.alertLevel > autoLevel) { autoLevel = top.alertLevel; selected = top.id; runCompare(top.id, true); }
      if (top.alertLevel < autoLevel) autoLevel = top.alertLevel;
      if (L.t >= C.shiftLen) { running = false; ended = true; addEvent('info', 'Смена завершена', 'Выпущено ' + L.out + ' из ' + C.plan); renderSummary(); setPlay(); }
    }
    if (ts - lastRender > 100) { render(); lastRender = ts; }
    requestAnimationFrame(frame);
  }

  // ---------- отрисовка ----------
  function render() {
    const k = T.kpis(L), bn = T.bottleneck(L).station;
    $('clock').textContent = T.clock(L.t);

    // режим линии
    const down = L.stations.find(s => s.state === 'down');
    const maxR = Math.max(...L.stations.map(s => s.risk || 0));
    const mode = $('mode');
    if (ended) { mode.textContent = 'Смена завершена'; mode.className = 'mode idle'; }
    else if (down) { mode.textContent = 'Отказ: ' + down.code + ' в ремонте'; mode.className = 'mode bad'; }
    else if (maxR >= C.crit) { mode.textContent = 'Высокий риск отказа'; mode.className = 'mode bad'; }
    else if (maxR >= C.warn) { mode.textContent = 'Предаварийный режим'; mode.className = 'mode warn'; }
    else { mode.textContent = running ? 'Норма' : (L.t > 0 ? 'Пауза' : 'Готово к запуску'); mode.className = running ? 'mode ok' : 'mode idle'; }

    // KPI
    $('kOut').textContent = k.out + ' авто';
    $('kOut').className = k.planPct >= 0.98 ? 'good' : k.planPct >= 0.9 ? 'warn' : 'bad';
    $('kOutSub').textContent = 'план к ' + T.clock(L.t) + ': ' + Math.round(k.planNow) + ' (' + pct(k.planPct) + ')';
    if (L.t >= C.shiftLen) {
      $('kFc').textContent = L.out + ' авто'; $('kFc').className = '';
      $('kFcSub').textContent = 'смена завершена, план ' + C.plan;
    } else if (forecast) {
      $('kFc').textContent = Math.round(forecast.mean) + ' авто';
      $('kFc').className = forecast.mean >= C.plan * 0.98 ? 'good' : forecast.mean >= C.plan * 0.9 ? 'warn' : 'bad';
      $('kFcSub').textContent = 'от ' + Math.round(forecast.p10) + ' до ' + Math.round(forecast.p90) + ' при плане ' + C.plan;
    }
    $('kOee').textContent = L.t > 1 ? pct(k.oee) : '—';
    $('kOeeSub').textContent = L.t > 1 ? 'Д ' + pct(k.A) + ' · П ' + pct(k.P) + ' · К ' + pct(k.Q) : 'доступность · производительность · качество';
    $('kDown').textContent = Math.round(k.downtime) + ' мин';
    $('kDownSub').textContent = 'отказов: ' + k.failures + ' · ППР учитывается в простое';
    $('kDef').textContent = (k.defectPct * 100).toFixed(1) + '%';
    $('kDefSub').textContent = 'дефектов ' + k.defects + ' из ' + k.inspected;
    $('kWip').textContent = k.wip;
    $('kWipSub').textContent = 'кузовов на линии и в доработке';

    // карта
    L.stations.forEach((st, i) => {
      const el = $('st-' + st.id);
      el.className = 'station s-' + st.state + (st.id === selected ? ' sel' : '') + (st === bn && L.t >= 5 ? ' bn' : '');
      const chip = el.querySelector('.chip');
      chip.className = 'chip ' + st.state; chip.textContent = STATE_LABEL[st.state];
      let p = 0;
      if (st.state === 'busy') p = 1 - st.rem / st.jobDur;
      else if (st.state === 'blocked') p = 1;
      else if (st.state === 'pm') p = 1 - st.pmRem / RM.sensor_model.pm_duration;
      else if (st.state === 'down') { const d = st.downLog[st.downLog.length - 1]; p = d ? (L.t - d.start) / (d.end - d.start) : 0; }
      el.querySelector('.prog i').style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
      el.querySelector('.ld').textContent = pct(T.util(st, 60, true));
      el.querySelector('.tp').textContent = Math.round(st.temp) + '°';
      const rk = el.querySelector('.rk');
      if (st.state === 'down') { rk.className = 'rk r2'; rk.textContent = 'ремонт до ' + T.clock(st.downLog[st.downLog.length - 1].end); }
      else if (st.risk == null) { rk.className = 'rk'; rk.textContent = 'риск —'; }
      else { rk.className = 'rk r' + (st.risk >= C.crit ? 2 : st.risk >= C.warn ? 1 : 0); rk.textContent = 'риск ' + pct(st.risk); }
      const rs = el.querySelector('.reserve');
      rs.hidden = !st.reserve;
      rs.textContent = st.backup.has ? 'резервный пост работает' : 'резервный пост готов';
      if (i > 0) {
        const b = $('buf-' + st.id);
        b.classList.toggle('full', st.queue >= C.bufferCap);
        b.querySelectorAll('.cells i').forEach((c, j) => c.classList.toggle('f', j < st.queue));
        b.querySelector('.bq').textContent = st.queue + '/' + C.bufferCap;
      }
    });
    $('takt').textContent = k.taktFact ? k.taktFact.toFixed(1) + ' мин/авто (план ' + (C.shiftLen / C.plan).toFixed(1) + ')' : '—';
    $('bnFoot').textContent = L.t >= 5 ? bn.name + ' · ' + bn.code + ', занят ' + pct(T.util(bn, 60)) : 'считается…';
    $('outFoot').textContent = k.out;
    $('planFoot').textContent = C.plan;

    renderRisk();
    renderEvents(false);
    renderChart();
    renderLoads(bn);
  }

  function renderRisk() {
    $('riskList').querySelectorAll('button').forEach(b => {
      const st = stationOf(b.dataset.id);
      b.classList.toggle('sel', st.id === selected);
      const bar = b.querySelector('b');
      bar.style.width = (st.risk == null ? 0 : st.risk * 100) + '%';
      bar.style.background = riskColor(st.risk);
      b.querySelector('strong').textContent = st.state === 'down' ? 'ремонт' : st.risk == null ? '—' : pct(st.risk);
    });
    const st = stationOf(selected);
    $('rName').textContent = st.name + ' · ' + st.code;
    const r = st.risk;
    $('rVal').textContent = st.state === 'down' ? 'ремонт' : r == null ? '—' : pct(r);
    $('rVal').style.color = riskColor(r);
    $('rBar').style.width = (r == null ? 0 : r * 100) + '%';
    $('rBar').style.background = riskColor(r);

    // спарклайн за 2 часа
    const from = L.t - 120, pts = st.riskHist.filter(p => p.t >= from);
    const X = t => ((t - from) / 120) * 300, Y = v => 58 - v * 54;
    $('spark').innerHTML =
      '<line x1="0" x2="300" y1="' + Y(C.warn) + '" y2="' + Y(C.warn) + '" stroke="#5c4518" stroke-dasharray="3 3"/>' +
      '<line x1="0" x2="300" y1="' + Y(C.crit) + '" y2="' + Y(C.crit) + '" stroke="#5e2329" stroke-dasharray="3 3"/>' +
      (pts.length > 1 ? '<polyline fill="none" stroke="' + riskColor(r) + '" stroke-width="2" vector-effect="non-scaling-stroke" points="' +
        pts.map(p => X(p.t).toFixed(1) + ',' + Y(p.r).toFixed(1)).join(' ') + '"/>' : '');

    // вклад признаков
    $('factors').innerHTML = RM.features.map((f, k) => {
      const c = st.contrib ? st.contrib[k] : 0;
      const w = Math.min(50, Math.abs(c) * 18);
      const style = c >= 0 ? 'left:50%;width:' + w + '%;background:#ef6666' : 'right:50%;width:' + w + '%;background:#58d67b';
      return '<div class="factor"><div>' + T.FACTOR_NAMES[f] + '<small>' + (st.feats ? T.factorValue(st, f) : 'нет данных') + '</small></div>' +
        '<div class="fbar" title="' + (c >= 0 ? 'повышает риск' : 'снижает риск') + '"><b style="' + style + '"></b></div></div>';
    }).join('');
  }

  function renderRecommendation() {
    if (!compare) return;
    const st = stationOf(compare.station), b = compare.best, none = compare.rows[0];
    const riskTxt = st.state === 'down' ? st.code + ' в ремонте. ' : st.risk != null ? st.code + ': риск отказа ' + pct(st.risk) + '. ' : '';
    if (b.gain > 0.5) {
      $('recText').textContent = riskTxt + 'Лучший вариант — «' + b.label + '»: ' + sign(b.gain) + ' авто к 18:00 (от ' + sign(b.gainP10) + ' до ' + sign(b.gainP90) + ')' +
        (b.down < none.down - 5 ? ', простой ' + Math.round(b.down) + ' мин вместо ' + Math.round(none.down) : '') +
        (b.failProb < none.failProb - 0.1 ? ', риск отказа до конца смены ' + pct(b.failProb) + ' вместо ' + pct(none.failProb) : '') + '.';
      $('recApply').hidden = false;
      $('recApply').textContent = 'Применить: ' + b.label.toLowerCase();
      $('recApply').onclick = () => apply(b.action, compare.station);
    } else {
      $('recText').textContent = riskTxt + 'По симуляции вмешательство сейчас не увеличивает выпуск. Продолжаем наблюдение.';
      $('recApply').hidden = true;
    }
  }

  function renderCompare() {
    const best = compare.best;
    $('wfBody').innerHTML = compare.rows.map(r => {
      const g = r.action === 'none' ? '—' : '<span class="' + (r.gain > 0.5 ? 'pos' : r.gain < -0.5 ? 'neg' : '') + '">' + sign(r.gain) + ' авто</span><small>' + sign(r.gainP10) + '…' + sign(r.gainP90) + '</small>';
      return '<tr class="' + (r === best && r.gain > 0.5 ? 'best' : '') + '"><td>' + esc(r.label) + '</td><td>' + r.out.toFixed(1) +
        '<small>' + Math.round(r.outP10) + '–' + Math.round(r.outP90) + '</small></td><td>' + Math.round(r.down) + ' мин</td><td>' +
        pct(r.failProb) + '</td><td>' + g + '</td><td>' + (r.action === 'none' ? '' : '<button data-a="' + r.action + '">Применить</button>') + '</td></tr>';
    }).join('');
    $('wfBody').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => apply(btn.dataset.a, compare.station)));
    $('wfNote').textContent = 'Расчёт на ' + T.clock(compare.t) + ' для поста «' + stationOf(compare.station).name + '». Каждый вариант — 40 прогонов до 18:00 на одинаковых случайных сценариях, диапазон — 10–90 перцентиль.';
    $('eCars').value = Math.max(0, best.gain).toFixed(1);
    updateEconomics();
  }

  function renderEvents(force) {
    if (!force && shownEvents === L.events.length && L.events[0] === lastTop) return;
    shownEvents = L.events.length; lastTop = L.events[0];
    $('evCount').textContent = L.events.length + ' событий';
    $('events').innerHTML = L.events.map(e =>
      '<div class="event"><time>' + e.time + '</time><span class="badge ' + e.level + '">' + LEVEL_LABEL[e.level] + '</span><div><b>' +
      esc(e.title) + '</b><small>' + esc(e.detail || '') + '</small></div></div>').join('');
  }
  let lastTop = null;

  function renderChart() {
    const W = 640, H = 240, x0 = 40, x1 = 625, y0 = 12, y1 = 210, yMax = 110;
    const X = t => x0 + (t / C.shiftLen) * (x1 - x0), Y = v => y1 - (v / yMax) * (y1 - y0);
    const parts = [];
    [0, 25, 50, 75, 100].forEach(v => parts.push('<line class="grid-l" x1="' + x0 + '" x2="' + x1 + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text x="' + (x0 - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>'));
    for (let h = 0; h <= 8; h += 2) parts.push('<text x="' + X(h * 60) + '" y="' + (H - 8) + '" text-anchor="middle">' + (10 + h) + ':00</text>');
    parts.push('<line x1="' + X(0) + '" y1="' + Y(0) + '" x2="' + X(C.shiftLen) + '" y2="' + Y(C.plan) + '" stroke="#8390ad" stroke-width="1.5" stroke-dasharray="6 5"/>');
    if (forecast && L.t < C.shiftLen) {
      parts.push('<polygon fill="#5d82f1" fill-opacity="0.14" points="' + X(L.t) + ',' + Y(L.out) + ' ' + X(C.shiftLen) + ',' + Y(forecast.p90) + ' ' + X(C.shiftLen) + ',' + Y(forecast.p10) + '"/>');
      parts.push('<line x1="' + X(L.t) + '" y1="' + Y(L.out) + '" x2="' + X(C.shiftLen) + '" y2="' + Y(forecast.mean) + '" stroke="#a9bcff" stroke-width="2" stroke-dasharray="2 4"/>');
      parts.push('<text x="' + (x1 - 2) + '" y="' + (Y(forecast.mean) - 8) + '" text-anchor="end" style="fill:#c9d6ff">прогноз ' + Math.round(forecast.mean) + '</text>');
    }
    const s = L.series;
    parts.push('<polyline fill="none" stroke="#5d82f1" stroke-width="2.5" points="' + s.map(p => X(p.t).toFixed(1) + ',' + Y(p.out).toFixed(1)).join(' ') + ' ' + X(L.t).toFixed(1) + ',' + Y(L.out).toFixed(1) + '"/>');
    parts.push('<line x1="' + X(L.t) + '" x2="' + X(L.t) + '" y1="' + y0 + '" y2="' + y1 + '" stroke="#34415e"/>');
    L.stations.forEach(st => st.downLog.forEach(d => parts.push('<rect x="' + X(d.start) + '" y="' + (y1 + 2) + '" width="' + Math.max(2, X(Math.min(d.end, L.t)) - X(d.start)) + '" height="5" fill="#ef6666"><title>' + st.code + ': простой</title></rect>')));
    $('chart').innerHTML = parts.join('');
  }

  function renderLoads(bn) {
    L.stations.forEach(st => {
      const row = $('ld-' + st.id);
      const busy = T.share(st, 60, 'busy'), down = T.share(st, 60, 'down'), blocked = T.share(st, 60, 'blocked');
      const seg = row.querySelectorAll('.stack i');
      seg[0].style.width = busy * 100 + '%'; seg[1].style.width = down * 100 + '%'; seg[2].style.width = blocked * 100 + '%';
      row.querySelector('strong').textContent = pct(busy + down);
      row.classList.toggle('bn', st === bn && L.t >= 5);
    });
  }

  function renderSummary() {
    const lines = T.summary(L, { forecast: L.t < C.shiftLen ? forecast : null, best: compare && compare.best });
    const decisions = L.events.filter(e => e.title.startsWith('Решение принято')).reverse();
    if (decisions.length) lines.push('Решения за смену: ' + decisions.map(e => e.time + ' — ' + e.title.replace('Решение принято: ', '').toLowerCase()).join('; ') + '.');
    $('summary').innerHTML = lines.map(l => '<li>' + esc(l) + '</li>').join('');
  }

  function updateEconomics() {
    const cars = Number($('eCars').value) || 0, m = Number($('eMargin').value) || 0, n = Number($('eTimes').value) || 0;
    $('eShift').textContent = money(cars * m);
    $('eYear').textContent = money(cars * m * n);
    if (compare && compare.best.gain > 0.5) {
      const lo = Math.max(0, compare.best.gainP10) * m * n, hi = Math.max(0, compare.best.gainP90) * m * n;
      $('eRange').textContent = 'По разбросу симуляции за год: от ' + money(lo) + ' до ' + money(hi) + '.';
    } else $('eRange').textContent = '';
  }

  // ---------- обработчики ----------
  $('playBtn').addEventListener('click', () => {
    if (ended) { reset(); return; }
    running = !running; setPlay(); render();
  });
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('failBtn').addEventListener('click', () => {
    if (ended) return;
    T.forceFail(L, 'welding');
    selected = 'welding';
    updateForecast();
    runCompare('welding', true);
    render();
  });
  $('resetBtn').addEventListener('click', reset);
  $('wfRun').addEventListener('click', () => runCompare($('wfStation').value, false));
  $('wfStation').addEventListener('change', e => select(e.target.value));
  $('sumBtn').addEventListener('click', renderSummary);
  ['eCars', 'eMargin', 'eTimes'].forEach(id => $(id).addEventListener('input', updateEconomics));

  reset();
  requestAnimationFrame(frame);
})();
