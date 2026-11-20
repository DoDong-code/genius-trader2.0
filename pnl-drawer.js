/**
 * 盈亏分析抽屉（2026-11-20 新增，参考养基宝；同日二轮增强）：
 * 点击持仓页汇总卡的「今日收益」打开，包含：
 *   1. 收益走势   —— 官方净值还原的账户级累计收益曲线，独立 tab（本月/今年/全部），
 *                    Y 轴带刻度，鼠标悬浮显示每日「当日收益 + 累计」数值
 *   2. 收益日历   —— 日/月/年 三粒度，逐日/逐月/逐年收益，涨红跌绿；
 *                    今日格 = 实时估算（与顶部「当日」汇总同源同步，带「估」标）
 *   3. 盈亏明细   —— 默认当日 TOP5（实时估值口径）；点击日历某日/某月/某年
 *                    切换为该区间每只基金盈亏明细（官方净值口径，服务端逐日累加，
 *                    合计与日历数值一致）；「返回当日」复位
 *   4. 金额 ↔ 收益率 切换 —— 同时作用于走势 / 日历 / 明细
 *
 * 数据契约：
 * - 历史部分来自 GET /api/portfolio/pnl-history（官方净值，只读；from+to → 区间明细）；
 *   口径为「当前持仓 × 历史净值日涨跌」近似还原（详见 pnlHistoryService 文件头），抽屉底部如实标注。
 * - 当日部分与持仓列表同源：todayEstimate 优先，兜底 amount × today。
 * - 颜色契约沿用全站：涨 = .positive 红，跌 = .negative 绿；估算值绝不标蓝。
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
  function fmtTick(v) {
    if (pnl.mode === 'rate') return v.toFixed(1) + '%';
    var n = Number(v) || 0;
    var abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n * 100) / 100);
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
  function todayIso() { return isoOf(new Date()); }

  // ───────────────────────── 状态 ─────────────────────────
  var PERIODS = [
    { key: 'day', label: '当日' },
    { key: 'week', label: '本周' },
    { key: 'month', label: '本月' },
    { key: 'year', label: '今年' },
    { key: 'all', label: '全部' }
  ];
  var TREND_PERIODS = [
    { key: 'month', label: '本月' },
    { key: 'year', label: '今年' },
    { key: 'all', label: '全部' }
  ];
  var pnl = {
    account: '',
    loading: false,
    error: null,
    errorCode: null,
    data: null,          // { series, firstDate, lastDate, base, warnings }
    fetchedAt: 0,
    period: 'day',       // 顶部期间 tab：day | week | month | year | all
    trendPeriod: 'month',// 走势独立 tab：month | year | all
    mode: 'amount',      // amount | rate
    calView: 'day',      // day | month | year
    calY: 0, calM: 0,    // 日历锚点（年 / 月 0-based）
    topTab: 'loss',      // 当日明细：gain | loss
    detailSel: null,     // 日历选中区间：{kind:'day'|'month'|'year', label, from, to, isTodayEst}
    detailData: null,    // { items:[{code,name,profit,rate}], total, rate }
    detailLoading: false,
    detailError: null
  };
  var CACHE_TTL = 5 * 60 * 1000;
  var backdrop = null;
  var trendCtx = null; // 走势悬浮定位上下文（renderTrend 时写入）

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
  function fetchPnlDetail(from, to) {
    var headers = window.auth && window.auth.authHeaders ? window.auth.authHeaders() : {};
    var url = '/api/portfolio/pnl-history?account=' + encodeURIComponent(pnl.account) +
      '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    return fetch(url, { headers: headers }).then(function (res) {
      if (res.status === 401) { var e = new Error('AUTH'); e.code = 'AUTH'; throw e; }
      return res.json().catch(function () { throw new Error('响应格式错误'); });
    }).then(function (json) {
      if (!json || !json.success) throw new Error(json && json.error ? json.error : '盈亏明细获取失败');
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
  // 当日实时估算汇总（顶部「当日」/日历今日格/今日明细 三处同源，保证数值同步）
  function todayEstimate() {
    var funds = liveFunds();
    var profit = funds.reduce(function (s, f) { return s + todayProfitOf(f); }, 0);
    var total = funds.reduce(function (s, f) { return s + (Number(f.amount) || 0); }, 0);
    return { profit: profit, rate: (total - profit) > 0 ? profit / (total - profit) : null };
  }

  // ───────────────────────── 期间计算 ─────────────────────────
  function seriesForPeriod(periodKey) {
    var series = (pnl.data && pnl.data.series) || [];
    if (!series.length) return { sub: [], prevValue: (pnl.data && pnl.data.base) || 0 };
    var lastD = parseDate(pnl.data.lastDate);
    var sub = series;
    var prevPoint = null;
    if (periodKey === 'week' && lastD) {
      var mon = mondayOf(lastD);
      var idx = series.findIndex(function (p) { return p.date >= isoOf(mon); });
      if (idx > 0) prevPoint = series[idx - 1];
      sub = series.slice(Math.max(idx, 0));
    } else if (periodKey === 'month' && lastD) {
      var mKey = lastD.getFullYear() + '-' + String(lastD.getMonth() + 1).padStart(2, '0');
      var idx2 = series.findIndex(function (p) { return p.date.slice(0, 7) === mKey; });
      if (idx2 > 0) prevPoint = series[idx2 - 1];
      sub = series.slice(Math.max(idx2, 0));
    } else if (periodKey === 'year' && lastD) {
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
    if (pnl.period === 'day') {
      var est = todayEstimate();
      return { profit: est.profit, rate: est.rate, isEstimate: true, asOf: null };
    }
    var ps = seriesForPeriod(pnl.period);
    var sum = ps.sub.reduce(function (s, p) { return s + (Number(p.profit) || 0); }, 0);
    return {
      profit: sum,
      rate: ps.prevValue > 0 ? sum / ps.prevValue : null,
      isEstimate: false,
      asOf: pnl.data ? pnl.data.lastDate : null
    };
  }

  // ───────────────────────── 收益走势（SVG + 悬浮 + Y 轴） ─────────────────────────
  function trendSvg(points) {
    if (!points || points.length < 2) {
      trendCtx = null;
      return '<div class="pnl-trend-empty">该期间官方净值样本不足，暂无法绘制走势</div>';
    }
    var W = 640, H = 210, PL = 60, PR = 10, PT = 12, PB = 8;
    var vals = points.map(function (p) { return p.v; });
    var min = Math.min.apply(null, vals.concat([0]));
    var max = Math.max.apply(null, vals.concat([0]));
    if (max === min) { max = min + Math.abs(min) * 0.1 + 1; min = min - Math.abs(min) * 0.1 - 1; }
    var pad = (max - min) * 0.06; // 上下留白，避免曲线贴边
    max += pad; min -= pad;
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
    // Y 轴：5 条刻度网格线 + 左侧刻度值（HTML 绝对定位，避免 preserveAspectRatio 拉伸变形）
    var gridLines = '', yLabels = '';
    for (var t = 0; t <= 4; t++) {
      var tv = min + span * t / 4;
      var ty = y(tv);
      gridLines += '<line x1="' + PL + '" y1="' + ty.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + ty.toFixed(1) + '" stroke="rgba(0,0,0,.06)" stroke-width="1"/>';
      yLabels += '<span class="pnl-trend-ylabel" style="top:' + (ty / H * 100).toFixed(2) + '%">' + esc(fmtTick(tv)) + '</span>';
    }
    var hover =
      '<line class="pnl-hover-line" x1="0" y1="' + PT + '" x2="0" y2="' + (H - PB) + '" style="display:none"/>' +
      '<circle class="pnl-hover-dot" r="3.5" cx="0" cy="0" style="display:none"/>';
    trendCtx = { points: points, W: W, H: H, PL: PL, PR: PR, x: x, y: y };
    var d1 = parseDate(points[0].date);
    var d2 = parseDate(points[points.length - 1].date);
    return '' +
      '<div class="pnl-trend-plot">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="收益走势">' +
          '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + color + '" stop-opacity=".18"/>' +
            '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
          '</linearGradient></defs>' +
          '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
          gridLines +
          ((min < 0 && max > 0)
            ? '<line x1="' + PL + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + zeroY.toFixed(1) + '" stroke="rgba(0,0,0,.18)" stroke-dasharray="4 4" stroke-width="1"/>'
            : '') +
          '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
          hover +
        '</svg>' +
        '<div class="pnl-trend-yaxis">' + yLabels + '</div>' +
        '<div class="pnl-trend-tip"></div>' +
      '</div>' +
      '<div class="pnl-trend-labels">' +
        '<span>' + (d1 ? fmtMD(d1) : esc(points[0].date)) + '</span>' +
        '<span>' + (d2 ? fmtMD(d2) : esc(points[points.length - 1].date)) + '</span>' +
      '</div>';
  }

  function bindTrendHover() {
    var plot = document.querySelector('.pnl-trend-plot');
    var svg = plot && plot.querySelector('svg');
    if (!svg || !trendCtx || !plot) return;
    var tip = plot.querySelector('.pnl-trend-tip');
    var line = svg.querySelector('.pnl-hover-line');
    var dot = svg.querySelector('.pnl-hover-dot');
    if (!tip || !line || !dot) return;
    var pts = trendCtx.points;
    var n = pts.length;
    svg.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      var vx = (ev.clientX - rect.left) / rect.width * trendCtx.W;
      var i = Math.round((vx - trendCtx.PL) / (trendCtx.W - trendCtx.PL - trendCtx.PR) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      var p = pts[i];
      var sx = trendCtx.x(i);
      var sy = trendCtx.y(p.v);
      line.setAttribute('x1', sx); line.setAttribute('x2', sx);
      line.style.display = '';
      dot.setAttribute('cx', sx); dot.setAttribute('cy', sy);
      dot.style.display = '';
      var dayColor = p.profit > 0 ? '#ff7a6e' : p.profit < 0 ? '#63d7a2' : '#fff';
      tip.innerHTML =
        '<div><b>' + esc(p.date.slice(0, 4) + '-' + p.date.slice(5, 7) + '-' + p.date.slice(8, 10)) + '</b></div>' +
        '<div>当日 <b style="color:' + dayColor + '">' + fmtMoney(p.profit, true) + '</b></div>' +
        '<div>' + (pnl.mode === 'amount' ? '累计 ' + fmtMoney(p.v, true) : '累计 ' + fmtRate(p.v / 100, true)) + '</div>';
      tip.style.display = 'block';
      var px = sx / trendCtx.W * rect.width;
      var py = sy / trendCtx.H * rect.height;
      var tw = tip.offsetWidth || 120;
      var left = px + 14;
      if (left + tw > rect.width - 4) left = px - tw - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, py - 16) + 'px';
    });
    svg.addEventListener('mouseleave', function () {
      tip.style.display = 'none';
      line.style.display = 'none';
      dot.style.display = 'none';
    });
  }

  function renderTrend() {
    var head =
      '<div class="pnl-section-head"><span class="pnl-section-title">收益走势</span>' +
      '<span class="pnl-section-sub">' + (pnl.mode === 'amount' ? '累计收益（金额）' : '累计收益率（%）') + '</span></div>';
    var tabs = '<div class="pnl-trend-tabs">' +
      TREND_PERIODS.map(function (p) {
        return '<button type="button" class="pnl-trend-tab' + (pnl.trendPeriod === p.key ? ' active' : '') + '" data-pnl-trend="' + p.key + '">' + p.label + '</button>';
      }).join('') + '</div>';
    var ps = seriesForPeriod(pnl.trendPeriod);
    var points = ps.sub.map(function (p) {
      return {
        date: p.date,
        v: pnl.mode === 'amount' ? Number(p.cum) || 0 : (Number(p.cumRate) || 0) * 100,
        profit: Number(p.profit) || 0
      };
    });
    return head + tabs + '<div class="pnl-trend-chart">' + trendSvg(points) + '</div>';
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
    var tIso = todayIso();
    var est = todayEstimate();
    var hasEst = liveFunds().length > 0;
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
        var iso = isoOf(dt);
        var isToday = tIso === iso;
        var p = dayPoint(iso);
        if (isToday && hasEst) {
          // 今日格 = 实时估算（与顶部「当日」汇总同源同步）；官方净值晚间公布后仍以估算口径为准
          var estVal = pnl.mode === 'amount' ? fmtMoney(est.profit, true) : (est.rate != null ? fmtRate(est.rate, true) : '—');
          cells.push(
            '<div class="pnl-cal-cell ' + (est.profit > 0 ? 'gain' : est.profit < 0 ? 'loss' : 'flat') + ' today clickable" data-pnl-day="' + iso + '">' +
              '<span class="pnl-cal-day">今<i class="pnl-cal-est-tag">估</i></span>' +
              '<span class="pnl-cal-val">' + esc(estVal) + '</span>' +
            '</div>');
          continue;
        }
        var cls = calCellClass(p) + (isToday ? ' today' : '') + (p ? ' clickable' : '');
        var dataAttr = p ? ' data-pnl-day="' + iso + '"' : '';
        cells.push(
          '<div class="' + cls + '"' + dataAttr + '>' +
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
        var cls2 = has ? calCellClass({ profit: agg2.profit, rate: agg2.rate }) + ' clickable' : 'pnl-cal-cell empty';
        var attr2 = has ? ' data-pnl-month="' + y2 + '-' + String(mm + 1).padStart(2, '0') + '"' : '';
        cells2.push('<div class="' + cls2 + '"' + attr2 + '><span class="pnl-cal-day">' + (mm + 1) + '月</span>' +
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
        return '<div class="' + calCellClass({ profit: agg3.profit, rate: agg3.rate }) + ' clickable" data-pnl-year="' + yy + '"><span class="pnl-cal-day">' + yy + '年</span>' +
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

  // ───────────────────────── 盈亏明细（当日 TOP5 / 日历选中区间） ─────────────────────────
  function top5Rows(list, emptyMsg) {
    if (!list.length) return '<div class="pnl-trend-empty">' + esc(emptyMsg) + '</div>';
    var maxAbs = list.reduce(function (m, f) { return Math.max(m, Math.abs(f.profit)); }, 0) || 1;
    var ranks = ['1', '2', '3', '4', '5'];
    return list.map(function (f, i) {
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
    }).join('');
  }

  function todayTopFunds() {
    return liveFunds()
      .map(function (f) {
        return {
          name: f.name || f.code,
          code: f.code,
          profit: todayProfitOf(f),
          rate: Number(f.today)
        };
      })
      .filter(function (f) { return Number.isFinite(f.profit) && f.profit !== 0; });
  }

  function renderSelectedDetail() {
    var sel = pnl.detailSel;
    var kindNoun = sel.kind === 'day' ? '日' : sel.kind === 'month' ? '月' : '年';
    var head = '<div class="pnl-section-head"><span class="pnl-section-title">' + esc(sel.label) + '盈亏明细</span>' +
      '<button type="button" class="pnl-detail-clear" data-pnl-detail-clear>返回当日</button></div>' +
      '<div class="pnl-detail-sub">' + (sel.isTodayEst
        ? '实时估值口径（与持仓列表一致）'
        : '官方净值口径 · ' + sel.from + ' ~ ' + sel.to) + '</div>';
    var inner;
    if (pnl.detailError) {
      inner = '<div class="pnl-error">' + esc(pnl.detailError) + '</div>';
    } else if (pnl.detailLoading) {
      inner = '<div class="pnl-loading">正在加载' + esc(sel.label) + '盈亏明细…</div>';
    } else {
      var d = pnl.detailData;
      var shown = ((d && d.items) || []).filter(function (f) { return f.profit !== 0; });
      if (!shown.length) {
        inner = '<div class="pnl-trend-empty">该' + kindNoun + '暂无可算的盈亏数据</div>';
      } else {
        var maxAbs = shown.reduce(function (m, f) { return Math.max(m, Math.abs(f.profit)); }, 0) || 1;
        var rows = shown.map(function (f, i) {
          var val = pnl.mode === 'amount' ? fmtMoney(f.profit, true)
            : (f.rate != null ? fmtRate(f.rate, true) : '—');
          var w = Math.max(4, Math.round(Math.abs(f.profit) / maxAbs * 100));
          return '<div class="pnl-top-row">' +
            '<span class="pnl-top-rank">' + (i + 1) + '</span>' +
            '<div class="pnl-top-info"><b>' + esc(f.name) + '</b>' +
              '<div class="pnl-top-bar"><i class="' + toneCls(f.profit) + '" style="width:' + w + '%"></i></div>' +
            '</div>' +
            '<b class="pnl-top-val ' + toneCls(f.profit) + '">' + esc(val) + '</b>' +
          '</div>';
        }).join('');
        inner = '<div class="pnl-top-list">' + rows + '</div>' +
          '<div class="pnl-cal-footer"><span>合计：<b class="' + toneCls(d.total) + '">' + fmtMoney(d.total) + '</b>' +
          (d.rate != null ? '<i>（' + fmtRate(d.rate) + '）</i>' : '') + '</span></div>';
      }
    }
    return head + inner;
  }

  function selectDetail(sel) {
    pnl.detailSel = sel;
    pnl.detailData = null;
    pnl.detailError = null;
    pnl.detailLoading = false;
    if (sel.isTodayEst) {
      // 今日：与持仓列表同一估算口径，本地直接构建（不请求服务端官方净值，保证与「当日」同步）
      var funds = todayTopFunds().sort(function (a, b) { return b.profit - a.profit; });
      pnl.detailData = {
        items: funds,
        total: Math.round(funds.reduce(function (s, f) { return s + f.profit; }, 0) * 100) / 100,
        rate: null
      };
      renderBody();
      return;
    }
    pnl.detailLoading = true;
    renderBody();
    fetchPnlDetail(sel.from, sel.to).then(function (json) {
      pnl.detailData = json;
      pnl.detailLoading = false;
      if (backdrop) renderBody();
    }).catch(function (err) {
      pnl.detailLoading = false;
      pnl.detailError = (err && err.code === 'AUTH') ? '请先登录后再查看盈亏明细' : ((err && err.message) || '盈亏明细加载失败');
      if (backdrop) renderBody();
    });
  }

  function renderDetail() {
    if (pnl.detailSel) return renderSelectedDetail();
    var funds = todayTopFunds();
    var gains = funds.filter(function (f) { return f.profit > 0; }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 5);
    var losses = funds.filter(function (f) { return f.profit < 0; }).sort(function (a, b) { return a.profit - b.profit; }).slice(0, 5);
    var list = pnl.topTab === 'gain' ? gains : losses;
    return '<div class="pnl-section-head"><span class="pnl-section-title">当日盈亏明细</span>' +
      '<span class="pnl-section-sub">实时估值口径，与持仓列表一致</span></div>' +
      '<div class="pnl-top-tabs">' +
        '<button type="button" class="pnl-top-tab' + (pnl.topTab === 'gain' ? ' active' : '') + '" data-pnl-top="gain">盈利 TOP5</button>' +
        '<button type="button" class="pnl-top-tab' + (pnl.topTab === 'loss' ? ' active' : '') + '" data-pnl-top="loss">亏损 TOP5</button>' +
      '</div>' +
      '<div class="pnl-top-list">' + top5Rows(list, pnl.topTab === 'gain' ? '当日暂无盈利基金' : '当日暂无亏损基金') + '</div>' +
      '<div class="pnl-cal-footer"><i>提示：点击上方日历的日期 / 月份 / 年份，可查看对应区间的盈亏明细</i></div>';
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
    bindTrendHover();

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
    pnl.trendPeriod = 'month';
    pnl.topTab = 'loss';
    pnl.detailSel = null;
    pnl.detailData = null;
    pnl.detailError = null;
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
    if ((el = e.target.closest('[data-pnl-trend]'))) {
      pnl.trendPeriod = el.getAttribute('data-pnl-trend');
      backdrop.querySelectorAll('.pnl-trend-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-pnl-trend') === pnl.trendPeriod);
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
    // 日历点击 → 区间盈亏明细
    if ((el = e.target.closest('[data-pnl-day]'))) {
      var date = el.getAttribute('data-pnl-day');
      var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (dm) {
        selectDetail({
          kind: 'day',
          label: Number(dm[2]) + '月' + Number(dm[3]) + '日',
          from: date, to: date,
          isTodayEst: date === todayIso()
        });
      }
      return;
    }
    if ((el = e.target.closest('[data-pnl-month]'))) {
      var mk = el.getAttribute('data-pnl-month'); // YYYY-MM
      var mp = /^(\d{4})-(\d{2})$/.exec(mk);
      if (mp) {
        var my = Number(mp[1]), mo = Number(mp[2]);
        var lastDay = new Date(my, mo, 0).getDate();
        selectDetail({
          kind: 'month',
          label: my + '年' + mo + '月',
          from: mk + '-01', to: mk + '-' + String(lastDay).padStart(2, '0'),
          isTodayEst: false
        });
      }
      return;
    }
    if ((el = e.target.closest('[data-pnl-year]'))) {
      var yv = el.getAttribute('data-pnl-year');
      if (/^\d{4}$/.test(yv)) {
        selectDetail({ kind: 'year', label: yv + '年', from: yv + '-01-01', to: yv + '-12-31', isTodayEst: false });
      }
      return;
    }
    if (e.target.closest('[data-pnl-detail-clear]')) {
      pnl.detailSel = null;
      pnl.detailData = null;
      pnl.detailError = null;
      renderBody();
      return;
    }
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
