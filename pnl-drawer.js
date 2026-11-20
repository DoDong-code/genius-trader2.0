/**
 * 盈亏分析抽屉（2026-11-20 新增，参考养基宝）：
 * 点击持仓页汇总卡的「今日收益」打开，包含：
 *   1. 收益走势   —— 官方净值还原的账户级累计收益曲线（本周/本月/今年/全部；当日走实时估算，不画历史线）
 *   2. 收益日历   —— 日/月/年 三粒度，逐日/逐月/逐年收益，涨红跌绿
 *   3. 当日盈亏明细 —— 盈利 TOP5 / 亏损 TOP5（前端实时估值口径，与持仓列表同源）
 *   4. 金额 ↔ 收益率 切换 —— 同时作用于走势 / 日历 / 明细
 *
 * 数据契约：
 * - 历史部分来自 GET /api/portfolio/pnl-history（官方净值，只读）；
 *   口径为「当前持仓 × 历史净值日涨跌」近似还原（详见 pnlHistoryService 文件头），抽屉底部如实标注。
 * - 当日部分与持仓列表同源：todayEstimate 优先，兜底 amount × today。
 * - 颜色契约沿用全站：涨 = .positive 红，跌 = .negative 绿。
 */
(function () {
  'use strict';
  var state = window.portfolioState;

  // ───────────────────────── 格式化 ─────────────────────────
  function fmtMoney(v, withSign) {
    var n = Number(v) || 0;
    var s = n < 0 ? '−' : (withSign && n > 0 ? '+' : '');
    return s + Math.abs(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  function fmtRate(r, withSign) {
    var n = Number(r) || 0;
    var s = n < 0 ? '−' : (withSign && n > 0 ? '+' : '');
    return s + (Math.abs(n) * 100).toFixed(2) + '%';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toneCls(v) { return v > 0 ? 'positive' : v < 0 ? 'negative' : ''; }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function fmtMD(d) {
    return (d.getMonth() + 1) + '.' + String(d.getDate()).padStart(2, '0');
  }
  function mondayOf(d) {
    var m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return m;
  }
  function isoOf(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ───────────────────────── 状态 ─────────────────────────
  var PERIODS = [
    { key: 'day', label: '当日' },
    { key: 'week', label: '本周' },
    { key: 'month', label: '本月' },
    { key: 'year', label: '今年' },
    { key: 'all', label: '全部' }
  ];
  var pnl = {
    account: '',
    loading: false,
    error: null,
    errorCode: null,
    data: null,        // { series, firstDate, lastDate, base, warnings }
    fetchedAt: 0,
    period: 'day',     // day | week | month | year | all
    mode: 'amount',    // amount | rate
    calView: 'day',    // day | month | year
    calY: 0, calM: 0,  // 日历锚点（年 / 月 0-based）
    topTab: 'loss'     // gain | loss
  };
  var CACHE_TTL = 5 * 60 * 1000;
  var backdrop = null;

  // ───────────────────────── 数据获取 ─────────────────────────
  function fetchPnl(accountName, force) {
    var headers = window.auth && window.auth.authHeaders ? window.auth.authHeaders() : {};
    var url = '/api/portfolio/pnl-history?account=' + encodeURIComponent(accountName) + (force ? '&t=' + Date.now() : '');
    return fetch(url, { headers: headers }).then(function (res) {
      if (res.status === 401) { var e = new Error('AUTH'); e.code = 'AUTH'; throw e; }
      return res.json().catch(function () { throw new Error('响应格式错误'); });
    }).then(function (json) {
      if (!json || !json.success) throw new Error(json && json.error ? json.error : '盈亏历史获取失败');
      return json;
    });
  }

  function liveFunds() {
    var account = state.accounts && state.accounts[state.getActive()];
    if (!account) return [];
    var funds = (typeof state.effectiveFunds === 'function')
      ? state.effectiveFunds(account)
      : (Array.isArray(account.funds) ? account.funds : []);
    return funds.filter(function (f) { return f && f.code; });
  }
  // 与持仓列表/汇总卡同一口径：todayEstimate 优先，兜底 amount × today
  function todayProfitOf(f) {
    var n = Number(f && f.todayEstimate);
    if (Number.isFinite(n)) return n;
    return (Number(f && f.amount) || 0) * (Number(f && f.today) || 0);
  }

  // ───────────────────────── 期间计算 ─────────────────────────
  function periodSeries() {
    var series = (pnl.data && pnl.data.series) || [];
    if (!series.length) return { sub: [], prevValue: (pnl.data && pnl.data.base) || 0 };
    var lastD = parseDate(pnl.data.lastDate);
    var sub = series;
    var prevPoint = null;
    if (pnl.period === 'week' && lastD) {
      var mon = mondayOf(lastD);
      var key = isoOf(mon);
      var idx = series.findIndex(function (p) { return p.date >= key; });
      if (idx > 0) prevPoint = series[idx - 1];
      sub = series.slice(Math.max(idx, 0));
    } else if (pnl.period === 'month' && lastD) {
      var mKey = lastD.getFullYear() + '-' + String(lastD.getMonth() + 1).padStart(2, '0');
      var idx2 = series.findIndex(function (p) { return p.date.slice(0, 7) === mKey; });
      if (idx2 > 0) prevPoint = series[idx2 - 1];
      sub = series.slice(Math.max(idx2, 0));
    } else if (pnl.period === 'year' && lastD) {
      var yKey = String(lastD.getFullYear());
      var idx3 = series.findIndex(function (p) { return p.date.slice(0, 4) === yKey; });
      if (idx3 > 0) prevPoint = series[idx3 - 1];
      sub = series.slice(Math.max(idx3, 0));
    }
    return {
      sub: sub,
      prevValue: prevPoint ? prevPoint.value : ((pnl.data && pnl.data.base) || 0)
    };
  }

  function periodSummary() {
    var funds = liveFunds();
    if (pnl.period === 'day') {
      var profit = funds.reduce(function (s, f) { return s + todayProfitOf(f); }, 0);
      var total = funds.reduce(function (s, f) { return s + (Number(f.amount) || 0); }, 0);
      var base = total - profit;
      return {
        profit: profit,
        rate: base > 0 ? profit / base : null,
        isEstimate: true,
        asOf: null
      };
    }
    var ps = periodSeries();
    var sum = ps.sub.reduce(function (s, p) { return s + (Number(p.profit) || 0); }, 0);
    return {
      profit: sum,
      rate: ps.prevValue > 0 ? sum / ps.prevValue : null,
      isEstimate: false,
      asOf: pnl.data ? pnl.data.lastDate : null
    };
  }

  // ───────────────────────── 收益走势（SVG） ─────────────────────────
  function trendSvg(points) {
    if (!points || points.length < 2) {
      return '<div class="pnl-trend-empty">该期间官方净值样本不足，暂无法绘制走势</div>';
    }
    var W = 600, H = 190, PL = 8, PR = 8, PT = 16, PB = 8;
    var vals = points.map(function (p) { return p.v; });
    var min = Math.min.apply(null, vals.concat([0]));
    var max = Math.max.apply(null, vals.concat([0]));
    if (max === min) { max = min + Math.abs(min) * 0.1 + 1; min = min - Math.abs(min) * 0.1 - 1; }
    var span = max - min;
    function x(i) { return PL + (W - PL - PR) * (i / (points.length - 1)); }
    function y(v) { return PT + (H - PT - PB) * (1 - (v - min) / span); }
    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ');
    var zeroY = y(0);
    var area = line + ' L' + x(points.length - 1).toFixed(1) + ',' + zeroY.toFixed(1) + ' L' + x(0).toFixed(1) + ',' + zeroY.toFixed(1) + ' Z';
    var last = points[points.length - 1].v;
    var up = last >= 0;
    var color = up ? '#ff3b30' : '#34a853';
    var gid = 'pnlgrad' + (up ? 'Up' : 'Down');
    var zeroLine = (min < 0 && max > 0)
      ? '<line x1="' + PL + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + zeroY.toFixed(1) + '" stroke="rgba(0,0,0,.18)" stroke-dasharray="4 4" stroke-width="1"/>'
      : '';
    var maxV = Math.max.apply(null, vals);
    var minV = Math.min.apply(null, vals);
    function yLabel(v) {
      return pnl.mode === 'rate' ? fmtRate(v / 100) : fmtMoney(v);
    }
    var d1 = parseDate(points[0].date);
    var d2 = parseDate(points[points.length - 1].date);
    var dMid = parseDate(points[Math.floor(points.length / 2)].date);
    return '' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="收益走势">' +
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity=".18"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
        zeroLine +
        '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (W - PR) + '" y="' + (PT + 9) + '" text-anchor="end" font-size="10" fill="' + (maxV >= 0 ? '#ff3b30' : '#34a853') + '">' + esc(yLabel(maxV)) + '</text>' +
        '<text x="' + (W - PR) + '" y="' + (H - PB - 2) + '" text-anchor="end" font-size="10" fill="' + (minV >= 0 ? '#ff3b30' : '#34a853') + '">' + esc(yLabel(minV)) + '</text>' +
      '</svg>' +
      '<div class="pnl-trend-labels">' +
        '<span>' + (d1 ? fmtMD(d1) : esc(points[0].date)) + '</span>' +
        '<span>' + (dMid ? fmtMD(dMid) : '') + '</span>' +
        '<span>' + (d2 ? fmtMD(d2) : esc(points[points.length - 1].date)) + '</span>' +
      '</div>';
  }

  function renderTrend() {
    var head =
      '<div class="pnl-section-head"><span class="pnl-section-title">收益走势</span>' +
      '<span class="pnl-section-sub">' + (pnl.mode === 'amount' ? '累计收益（金额）' : '累计收益率（%）') + '</span></div>';
    if (pnl.period === 'day') {
      return head + '<div class="pnl-trend-empty">当日以实时估值为准（净值晚间公布）；切换「本周 / 本月 / 今年 / 全部」查看官方净值还原的累计走势</div>';
    }
    var ps = periodSeries();
    var points = ps.sub.map(function (p) {
      return { date: p.date, v: pnl.mode === 'amount' ? Number(p.cum) || 0 : (Number(p.cumRate) || 0) * 100 };
    });
    return head + '<div class="pnl-trend-chart">' + trendSvg(points) + '</div>';
  }

  // ───────────────────────── 收益日历 ─────────────────────────
  function monthAgg(y, m) {
    var series = (pnl.data && pnl.data.series) || [];
    var key = y + '-' + String(m + 1).padStart(2, '0');
    var sub = series.filter(function (p) { return p.date.slice(0, 7) === key; });
    var profit = sub.reduce(function (s, p) { return s + (Number(p.profit) || 0); }, 0);
    var prevValue = null;
    var idx = series.findIndex(function (p) { return p.date.slice(0, 7) === key; });
    if (idx > 0) prevValue = series[idx - 1].value;
    else if (sub.length) prevValue = (pnl.data && pnl.data.base) || null;
    var rate = (prevValue && prevValue > 0) ? profit / prevValue : null;
    return { profit: profit, rate: rate, count: sub.length };
  }
  function yearAgg(y) {
    var series = (pnl.data && pnl.data.series) || [];
    var key = String(y);
    var sub = series.filter(function (p) { return p.date.slice(0, 4) === key; });
    var profit = sub.reduce(function (s, p) { return s + (Number(p.profit) || 0); }, 0);
    var prevValue = null;
    var idx = series.findIndex(function (p) { return p.date.slice(0, 4) === key; });
    if (idx > 0) prevValue = series[idx - 1].value;
    else if (sub.length) prevValue = (pnl.data && pnl.data.base) || null;
    var rate = (prevValue && prevValue > 0) ? profit / prevValue : null;
    return { profit: profit, rate: rate, count: sub.length };
  }
  function dayPoint(dateStr) {
    var series = (pnl.data && pnl.data.series) || [];
    return series.find(function (p) { return p.date === dateStr; }) || null;
  }
  function calValue(p) {
    if (!p) return null;
    return pnl.mode === 'amount' ? fmtMoney(p.profit, true) : fmtRate(p.rate != null ? p.rate : null, true);
  }
  function calCellClass(p) {
    if (!p) return 'pnl-cal-cell empty';
    var v = pnl.mode === 'amount' ? Number(p.profit) : (p.rate != null ? Number(p.rate) : null);
    if (v === null || !Number.isFinite(v)) return 'pnl-cal-cell flat';
    return 'pnl-cal-cell ' + (v > 0 ? 'gain' : v < 0 ? 'loss' : 'flat');
  }

  function renderCalendar() {
    if (!pnl.data || !pnl.data.lastDate) {
      return '<div class="pnl-section-head"><span class="pnl-section-title">盈亏日历</span></div>' +
        '<div class="pnl-trend-empty">暂无官方净值数据，无法生成日历</div>';
    }
    var lastD = parseDate(pnl.data.lastDate);
    var head =
      '<div class="pnl-section-head"><span class="pnl-section-title">盈亏日历</span>' +
      '<span class="pnl-section-sub">' + (pnl.mode === 'amount' ? '按金额' : '按收益率') + '</span></div>' +
      '<div class="pnl-cal-toolbar">' +
        '<div class="pnl-cal-views">' +
          ['day', 'month', 'year'].map(function (v) {
            return '<button type="button" class="pnl-cal-view' + (pnl.calView === v ? ' active' : '') + '" data-pnl-cal-view="' + v + '">' +
              (v === 'day' ? '日' : v === 'month' ? '月' : '年') + '</button>';
          }).join('') +
        '</div>' +
        (pnl.calView === 'year'
          ? '<span class="pnl-cal-label pnl-cal-label-wide">全部年份</span>'
          : '<button type="button" class="pnl-cal-nav" data-pnl-cal-prev>‹</button>' +
            '<span class="pnl-cal-label" id="pnl-cal-label"></span>' +
            '<button type="button" class="pnl-cal-nav" data-pnl-cal-next>›</button>') +
      '</div>';

    var body = '';
    var footer = '';
    if (pnl.calView === 'day') {
      var y = pnl.calY, m = pnl.calM;
      var first = new Date(y, m, 1);
      var offset = (first.getDay() + 6) % 7; // 周一=0
      var daysInMonth = new Date(y, m + 1, 0).getDate();
      var cells = [];
      for (var i = 0; i < offset; i++) cells.push('<div class="pnl-cal-cell blank"></div>');
      for (var d = 1; d <= daysInMonth; d++) {
        var dt = new Date(y, m, d);
        var dow = dt.getDay();
        if (dow === 0 || dow === 6) { cells.push('<div class="pnl-cal-cell blank"></div>'); continue; }
        var p = dayPoint(isoOf(dt));
        var isToday = lastD && isoOf(lastD) === isoOf(dt);
        var cls = calCellClass(p) + (isToday ? ' today' : '');
        cells.push(
          '<div class="' + cls + '">' +
            '<span class="pnl-cal-day">' + (isToday ? '今' : d) + '</span>' +
            '<span class="pnl-cal-val">' + esc(p ? (calValue(p) || '—') : '') + '</span>' +
          '</div>');
      }
      body = '<div class="pnl-cal-week">' + ['一', '二', '三', '四', '五'].map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>' +
        '<div class="pnl-cal-grid">' + cells.join('') + '</div>';
      var agg = monthAgg(y, m);
      footer = '<div class="pnl-cal-footer">' +
        '<span>' + (m + 1) + '月累计收益：<b class="' + toneCls(agg.profit) + '">' + fmtMoney(agg.profit) + '</b>' +
        (agg.rate != null ? '<i>（' + fmtRate(agg.rate) + '）</i>' : '') + '</span></div>';
    } else if (pnl.calView === 'month') {
      var y2 = pnl.calY;
      var cells2 = [];
      for (var mm = 0; mm < 12; mm++) {
        var agg2 = monthAgg(y2, mm);
        var has = agg2.count > 0;
        var v2 = pnl.mode === 'amount' ? fmtMoney(agg2.profit, true) : (agg2.rate != null ? fmtRate(agg2.rate, true) : '—');
        var cls2 = has ? calCellClass({ profit: agg2.profit, rate: agg2.rate }) : 'pnl-cal-cell empty';
        cells2.push('<div class="' + cls2 + '"><span class="pnl-cal-day">' + (mm + 1) + '月</span>' +
          '<span class="pnl-cal-val">' + (has ? esc(v2) : '') + '</span></div>');
      }
      body = '<div class="pnl-cal-grid pnl-cal-grid-months">' + cells2.join('') + '</div>';
      var yAgg = yearAgg(y2);
      footer = '<div class="pnl-cal-footer"><span>' + y2 + '年累计收益：<b class="' + toneCls(yAgg.profit) + '">' + fmtMoney(yAgg.profit) + '</b>' +
        (yAgg.rate != null ? '<i>（' + fmtRate(yAgg.rate) + '）</i>' : '') + '</span></div>';
    } else {
      var years = availableYears();
      var cells3 = years.map(function (yy) {
        var agg3 = yearAgg(yy);
        var v3 = pnl.mode === 'amount' ? fmtMoney(agg3.profit, true) : (agg3.rate != null ? fmtRate(agg3.rate, true) : '—');
        return '<div class="' + calCellClass({ profit: agg3.profit, rate: agg3.rate }) + '"><span class="pnl-cal-day">' + yy + '年</span>' +
          '<span class="pnl-cal-val">' + esc(agg3.count ? v3 : '') + '</span></div>';
      });
      body = '<div class="pnl-cal-grid pnl-cal-grid-months">' + (cells3.join('') || '<div class="pnl-trend-empty">暂无数据</div>') + '</div>';
    }
    return head + body + footer;
  }

  function availableYears() {
    var series = (pnl.data && pnl.data.series) || [];
    var set = {};
    series.forEach(function (p) { set[p.date.slice(0, 4)] = true; });
    return Object.keys(set).sort();
  }

  function calClamp(dir) {
    var lastD = pnl.data && pnl.data.lastDate ? parseDate(pnl.data.lastDate) : null;
    var firstD = pnl.data && pnl.data.firstDate ? parseDate(pnl.data.firstDate) : null;
    if (!lastD) return;
    if (pnl.calView === 'day') {
      var t = new Date(pnl.calY, pnl.calM + dir, 1);
      if (t > new Date(lastD.getFullYear(), lastD.getMonth() + 1, 0)) return;
      if (firstD && t < new Date(firstD.getFullYear(), firstD.getMonth(), 1)) return;
      pnl.calY = t.getFullYear(); pnl.calM = t.getMonth();
    } else {
      var y = pnl.calY + dir;
      if (y > lastD.getFullYear()) return;
      if (firstD && y < firstD.getFullYear()) return;
      pnl.calY = y;
    }
  }
  function calLabel() {
    if (pnl.calView === 'day') return pnl.calY + '年' + (pnl.calM + 1) + '月';
    if (pnl.calView === 'month') return pnl.calY + '年';
    return '全部年份';
  }

  // ───────────────────────── 当日盈亏明细 ─────────────────────────
  function renderDetail() {
    var funds = liveFunds()
      .map(function (f) {
        return {
          name: f.name || f.code,
          code: f.code,
          profit: todayProfitOf(f),
          rate: Number(f.today)
        };
      })
      .filter(function (f) { return Number.isFinite(f.profit) && f.profit !== 0; });
    var gains = funds.filter(function (f) { return f.profit > 0; }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 5);
    var losses = funds.filter(function (f) { return f.profit < 0; }).sort(function (a, b) { return a.profit - b.profit; }).slice(0, 5);
    var list = pnl.topTab === 'gain' ? gains : losses;
    var maxAbs = list.reduce(function (m, f) { return Math.max(m, Math.abs(f.profit)); }, 0) || 1;
    var ranks = ['1', '2', '3', '4', '5'];
    var rows = list.length ? list.map(function (f, i) {
      var val = pnl.mode === 'amount' ? fmtMoney(f.profit, true)
        : (Number.isFinite(f.rate) ? fmtRate(f.rate, true) : '—');
      var w = Math.max(4, Math.round(Math.abs(f.profit) / maxAbs * 100));
      return '<div class="pnl-top-row">' +
        '<span class="pnl-top-rank r' + (i + 1) + '">' + ranks[i] + '</span>' +
        '<div class="pnl-top-info"><b>' + esc(f.name) + '</b>' +
          '<div class="pnl-top-bar"><i class="' + toneCls(f.profit) + '" style="width:' + w + '%"></i></div>' +
        '</div>' +
        '<b class="pnl-top-val ' + toneCls(f.profit) + '">' + esc(val) + '</b>' +
      '</div>';
    }).join('') : '<div class="pnl-trend-empty">' + (pnl.topTab === 'gain' ? '当日暂无盈利基金' : '当日暂无亏损基金') + '</div>';
    return '<div class="pnl-section-head"><span class="pnl-section-title">当日盈亏明细</span>' +
      '<span class="pnl-section-sub">实时估值口径，与持仓列表一致</span></div>' +
      '<div class="pnl-top-tabs">' +
        '<button type="button" class="pnl-top-tab' + (pnl.topTab === 'gain' ? ' active' : '') + '" data-pnl-top="gain">盈利 TOP5</button>' +
        '<button type="button" class="pnl-top-tab' + (pnl.topTab === 'loss' ? ' active' : '') + '" data-pnl-top="loss">亏损 TOP5</button>' +
      '</div>' +
      '<div class="pnl-top-list">' + rows + '</div>';
  }

  // ───────────────────────── 抽屉壳与渲染 ─────────────────────────
  function drawerSkeleton(accountName) {
    return '<aside class="detail-drawer pnl-analysis-drawer" role="dialog" aria-modal="true" aria-label="盈亏分析">' +
      '<button class="drawer-close" aria-label="关闭盈亏分析">×</button>' +
      '<div class="drawer-scroll">' +
        '<p class="eyebrow">盈亏分析</p>' +
        '<div class="pnl-head-row"><h2 class="pnl-title">' + esc(accountName) + '</h2>' +
          '<button type="button" class="pnl-refresh" data-pnl-refresh>刷新</button></div>' +
        '<div class="pnl-period-tabs">' +
          PERIODS.map(function (p) {
            return '<button type="button" class="pnl-period-tab' + (pnl.period === p.key ? ' active' : '') + '" data-pnl-period="' + p.key + '">' + p.label + '</button>';
          }).join('') +
        '</div>' +
        '<div class="pnl-summary">' +
          '<div class="pnl-summary-main"><span class="pnl-summary-label">期间收益</span>' +
            '<strong class="pnl-summary-value" id="pnl-summary-value">—</strong>' +
            '<span class="pnl-summary-rate" id="pnl-summary-rate"></span>' +
            '<span class="pnl-summary-asof" id="pnl-summary-asof"></span>' +
          '</div>' +
          '<button type="button" class="pnl-mode-toggle" data-pnl-mode-toggle>金额 ⇄ 收益率</button>' +
        '</div>' +
        '<div id="pnl-body"></div>' +
        '<div class="pnl-footnote" id="pnl-footnote"></div>' +
      '</div>' +
    '</aside>';
  }

  function renderBody() {
    var body = document.getElementById('pnl-body');
    var footnote = document.getElementById('pnl-footnote');
    if (!body) return;
    var label = document.getElementById('pnl-cal-label');
    if (label) label.textContent = calLabel();
    body.innerHTML = renderTrend() + '<div class="pnl-divider"></div>' + renderCalendar() + '<div class="pnl-divider"></div>' + renderDetail();

    var sum = periodSummary();
    var valueEl = document.getElementById('pnl-summary-value');
    var rateEl = document.getElementById('pnl-summary-rate');
    var asofEl = document.getElementById('pnl-summary-asof');
    if (valueEl) {
      valueEl.textContent = pnl.mode === 'amount' ? fmtMoney(sum.profit) : (sum.rate != null ? fmtRate(sum.rate) : '—');
      valueEl.className = 'pnl-summary-value ' + toneCls(sum.profit);
    }
    if (rateEl) {
      var rateVal = pnl.mode === 'amount' ? (sum.rate != null ? fmtRate(sum.rate) : '') : (sum.isEstimate ? fmtMoney(sum.profit) : '');
      rateEl.textContent = rateVal ? '（' + rateVal + '）' : '';
    }
    if (asofEl) {
      asofEl.textContent = sum.isEstimate
        ? '实时估算 · 净值以晚间官方公布为准'
        : (pnl.data && pnl.data.lastDate ? '数据截至官方净值 ' + pnl.data.lastDate : '');
    }
    if (footnote) {
      var warns = (pnl.data && pnl.data.warnings) || [];
      footnote.innerHTML = warns.length
        ? warns.map(function (w) { return '<p>' + esc(w) + '</p>'; }).join('')
        : '';
    }
  }

  function setLoading(msg) {
    var body = document.getElementById('pnl-body');
    if (body) body.innerHTML = '<div class="pnl-loading">' + esc(msg || '正在加载盈亏历史…') + '</div>';
  }
  function setError(msg, code) {
    var body = document.getElementById('pnl-body');
    if (body) body.innerHTML = '<div class="pnl-error">' + esc(msg) + '</div>';
  }

  function openDrawer() {
    var accountName = state.getActive();
    if (!accountName) return;
    if (backdrop) return; // 已打开
    pnl.account = accountName;
    pnl.period = 'day';
    pnl.topTab = 'loss';
    var lastD = pnl.data && pnl.data.lastDate ? parseDate(pnl.data.lastDate) : null;
    if (pnl.data && pnl.account === accountName && lastD) {
      pnl.calY = lastD.getFullYear(); pnl.calM = lastD.getMonth();
    } else {
      var now = new Date();
      pnl.calY = now.getFullYear(); pnl.calM = now.getMonth();
    }

    backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop pnl-drawer-backdrop';
    backdrop.innerHTML = drawerSkeleton(accountName);
    document.body.appendChild(backdrop);
    document.body.classList.add('drawer-open');
    requestAnimationFrame(function () { backdrop.classList.add('visible'); });

    function close() {
      backdrop.classList.remove('visible');
      document.body.classList.remove('drawer-open');
      var el = backdrop;
      setTimeout(function () { el.remove(); }, 180);
      backdrop = null;
    }
    pnl._close = close;
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop || event.target.closest('.drawer-close')) close();
    });
    document.addEventListener('keydown', function onEsc(event) {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onEsc);
        if (backdrop) close();
      }
    });

    // 数据加载（账户未变且缓存新鲜则直接复用）
    var fresh = pnl.data && pnl.account === accountName && (Date.now() - pnl.fetchedAt < CACHE_TTL);
    if (fresh) {
      renderBody();
    } else {
      setLoading('正在加载盈亏历史…');
      fetchPnl(accountName).then(function (json) {
        pnl.data = json;
        pnl.fetchedAt = Date.now();
        var d = json.lastDate ? parseDate(json.lastDate) : null;
        if (d) { pnl.calY = d.getFullYear(); pnl.calM = d.getMonth(); }
        if (backdrop) renderBody();
      }).catch(function (err) {
        if (err && err.code === 'AUTH') setError('请先登录后再查看盈亏分析', 'AUTH');
        else setError((err && err.message) || '盈亏历史加载失败');
      });
    }
  }

  // ───────────────────────── 交互绑定（抽屉内委托） ─────────────────────────
  document.addEventListener('click', function (e) {
    if (!backdrop) return;
    var el;
    if ((el = e.target.closest('[data-pnl-period]'))) {
      pnl.period = el.getAttribute('data-pnl-period');
      backdrop.querySelectorAll('.pnl-period-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-pnl-period') === pnl.period);
      });
      renderBody();
      return;
    }
    if ((el = e.target.closest('[data-pnl-mode-toggle]'))) {
      pnl.mode = pnl.mode === 'amount' ? 'rate' : 'amount';
      renderBody();
      return;
    }
    if ((el = e.target.closest('[data-pnl-cal-view]'))) {
      pnl.calView = el.getAttribute('data-pnl-cal-view');
      backdrop.querySelectorAll('.pnl-cal-view').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-pnl-cal-view') === pnl.calView);
      });
      var lbl = document.getElementById('pnl-cal-label');
      if (lbl) lbl.textContent = calLabel();
      renderBody();
      return;
    }
    if (e.target.closest('[data-pnl-cal-prev]')) { calClamp(-1); renderBody(); return; }
    if (e.target.closest('[data-pnl-cal-next]')) { calClamp(1); renderBody(); return; }
    if ((el = e.target.closest('[data-pnl-top]'))) {
      pnl.topTab = el.getAttribute('data-pnl-top');
      backdrop.querySelectorAll('.pnl-top-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-pnl-top') === pnl.topTab);
      });
      renderBody();
      return;
    }
    if (e.target.closest('[data-pnl-refresh]')) {
      setLoading('正在刷新盈亏历史…');
      fetchPnl(pnl.account, true).then(function (json) {
        pnl.data = json;
        pnl.fetchedAt = Date.now();
        if (backdrop) renderBody();
      }).catch(function (err) {
        setError((err && err.message) || '盈亏历史刷新失败');
      });
    }
  });

  // ───────────────────────── 入口：点击汇总卡「今日收益」 ─────────────────────────
  document.addEventListener('click', function (e) {
    if (!state) return;
    if (!e.target.closest('.portfolio-summary-today')) return;
    e.preventDefault();
    openDrawer();
  });
})();
