// components/fundDetail/fundDetail.js
import { http } from '../../utils/request.js';
import { pct, money } from '../../utils/format.js';

const app = getApp();

// ── 数据同步状态机常量（与网页端 detail-api.js 统一语义）──
// 轮询退避：首次 1.5s，其后递增，最长单轮 10s；上限 40 次 / 180s，杜绝无限后台任务与请求风暴。
const SYNC_POLL_DELAYS = [1500, 2000, 3000, 5000, 8000, 10000, 10000, 10000];
const SYNC_MAX_ATTEMPTS = 40;
const SYNC_MAX_WAIT_MS = 180000;
const FUND_DATA_SOURCE_LABEL = '天天基金';
// 跨抽屉打开的刷新节流：同一基金 5 分钟内只触发一次 refresh=1&fast=1 的后台同步。
const fundRefreshCache = {};
function shouldRefresh(code) {
  const now = Date.now();
  const last = fundRefreshCache[code] || 0;
  return now - last > 5 * 60 * 1000;
}

Component({
  properties: {
    // 外部传入基金代码，组件内部据此加载本地持仓 + 服务端/兜底历史
    code: {
      type: String,
      value: '',
      observer(value) {
        if (value) this.initDetail(value);
      }
    },
    // 抽屉模式：隐藏顶部返回按钮（由父级控制关闭）
    embedded: {
      type: Boolean,
      value: false
    },
    // 抽屉是否完全可见（由父级控制）。完全可见后再渲染走势图，避免 canvas 节点尺寸异常导致走势错位
    visible: {
      type: Boolean,
      value: false,
      observer(value) {
        if (value) {
          // 等滑入动画结束、布局稳定后再绘制，坐标才不会偏
          setTimeout(() => this.tryRenderChart(), 320);
        }
      }
    },
    // 顶部安全区高度（px），抽屉模式下用于为状态栏/关闭按钮让出空间
    safeTop: {
      type: Number,
      value: 0
    }
  },

  data: {
    fund: {},
    accountWeightStr: '0.00%',
    majorHoldings: [],
    transactions: [],

    perf: {
      month1: 0, month1Str: '—',
      month3: 0, month3Str: '—',
      month6: 0, month6Str: '—',
      year1: 0, year1Str: '—',
      year3: 0, year3Str: '—',
      sinceStart: 0, sinceStartStr: '—',
      yearYtd: 0, yearYtdStr: '—'
    },

    ranges: [
      { key: 'today', label: '今日估值', days: 0 },
      { key: '1m', label: '近1月', days: 31 },
      { key: '3m', label: '近3月', days: 93 },
      { key: '6m', label: '近6月', days: 186 },
      { key: '1y', label: '近1年', days: 366 },
      { key: '3y', label: '近3年', days: 1096 }
    ],
    activeRange: '1y',
    isLoadingChart: true,
    chartStatus: 'loading',   // loading | syncing | retrying | success | failed（不再使用 empty 终态）
    chartErrorMsg: '',
    chartMinMaxStr: '',
    // 同步进度 UI 字段（不伪造百分比，仅展示真实经过时间/尝试次数）
    syncDataSource: FUND_DATA_SOURCE_LABEL,
    syncWaitSeconds: 0,
    syncAttempt: 0,
    syncStatusText: '',
    // 前十大持仓独立状态：loading | syncing | success | none（与历史净值解耦）
    holdingsStatus: 'loading',
    todayChartFallback: false,
    dataStatusLabel: '',

    // 估值校准（对齐网页端 /api/fund/:code/calibration）
    calibration: null,
    isCalibrating: false,

    // 走势图交互状态
    chartIndicator: { show: false },
    chartTooltip: { show: false },
    chartLegend: { cost: false, buy: false, sell: false },

    activeTab: 'nav',

    // modal
    showEditModal: false,
    editMode: 'edit',
    editAmount: '',
    editProfit: '',
    newTxAmount: '',
    newTxFee: '',
    newTxDate: '',
    investAmount: '',
    investFrequencyIndex: 2,
    investFrequencies: ['每日', '每周', '每月'],
    investFrequenciesValues: ['daily', 'weekly', 'monthly'],
    investDate: '',

    serverHistory: [],
    navRows: [],
    autoInvestBanner: '',

    // 详情抽屉「当日净值 / 净值日期」成对字段（由 serverHistory 推导，对齐 Phase 3 一致性）
    currentNav: '',
    currentNavDate: ''
  },

  lifetimes: {
    attached() {
      if (this.data.code) this.initDetail(this.data.code);
    },
    detached() {
      // 抽屉销毁 → 立即停止轮询，避免无限后台任务与请求风暴
      this._stopSync();
    }
  },

  methods: {
    initDetail(code) {
      this.setData({
        newTxDate: app.globalData.shanghaiToday,
        investDate: app.globalData.shanghaiToday
      });
      this.loadFundLocalDetails(code);
      this.fetchFundServerDetails(code);
      this.loadCalibration(code);
    },

    loadFundLocalDetails(code) {
      const account = app.getActiveAccount();
      const funds = account.funds || [];
      const fund = funds.find(f => f.code === code);

      if (!fund) return;

      const totalAssets = funds.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      const amt = Number(fund.amount) || 0;
      const profit = Number(fund.holdingProfit) || 0;
      const todayPct = Number(fund.today) || 0;
      const todayProfitVal = amt * todayPct;
      const holdRate = Number(fund.holdingRate) || Number(fund.hold) || 0;

      const formattedFund = {
        ...fund,
        amountStr: `¥${money(amt)}`,
        holdingProfitStr: `${profit >= 0 ? '+' : '-'}¥${money(Math.abs(profit))}`,
        holdingRateStr: pct(holdRate),
        holdingRate: holdRate,
        todayProfit: todayProfitVal,
        todayProfitStr: `${todayProfitVal >= 0 ? '+' : '-'}¥${money(Math.abs(todayProfitVal))}`,
        todayProfitPctStr: pct(todayPct)
      };

      const formattedTxs = (fund.transactions || []).map(tx => ({
        ...tx,
        typeStr: tx.type === 'buy' ? '买入' : '卖出',
        // P1：金额最多 2 位小数、不强制补 0（10,000 而非 10,000.00）
        amountStr: `¥${Number(tx.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`,
        feeStr: Number(tx.fee || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
      })).reverse();

      const autoInvestBanner = (fund.autoInvest && fund.autoInvest.enabled)
        ? `定投计划：每${fund.autoInvest.frequency === 'daily' ? '日' : fund.autoInvest.frequency === 'weekly' ? '周' : '月'} ¥${Number(fund.autoInvest.amount || 0).toLocaleString('zh-CN')}，下次 ${fund.autoInvest.nextDate || '—'}`
        : '';

      this.setData({
        fund: formattedFund,
        transactions: formattedTxs,
        accountWeightStr: totalAssets > 0 ? pct(amt / totalAssets, false) : pct(0, false),
        autoInvestBanner,
        // 二次验收修复：回填编辑框限最多 2 位小数（原直接 String(fund.holdingProfit) 暴露 -59.55999999999945 浮点误差）
        editAmount: String(Number(Number(fund.amount).toFixed(2))),
        editProfit: String(Number(Number(fund.holdingProfit).toFixed(2)))
      });
    },

    fetchFundServerDetails(code) {
      // 入口：启动统一的同步状态机（加载/同步/重试/成功/失败）
      this._startSync(code, {});
    },

    // 重试 / 继续获取：手动触发一次带 refresh 的完整同步周期（重置轮询计时与次数）
    onRetryChart() {
      if (this.data.code) this._startSync(this.data.code, { force: true });
    },

    // ── 同步控制器生命周期 ──
    _stopSync() {
      if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
      if (this._waitTimer) { clearInterval(this._waitTimer); this._waitTimer = null; }
      if (this._syncCtl) this._syncCtl.stopped = true;
    },

    _newCtl() {
      const ctl = { stopped: false, attempt: 0, waitStart: 0, status: 'idle' };
      this._syncCtl = ctl;
      return ctl;
    },

    _elapsed(ctl) {
      return ctl.waitStart ? Math.floor((Date.now() - ctl.waitStart) / 1000) : 0;
    },

    _startSync(code, options) {
      options = options || {};
      // 先停掉旧控制器：切换基金 / 重开 / 重试时都不会残留旧轮询
      this._stopSync();
      this._newCtl();
      this._stockLoaded = false;
      this.setData({
        chartStatus: 'loading',
        isLoadingChart: false,
        chartErrorMsg: '',
        syncWaitSeconds: 0,
        syncAttempt: 0,
        syncStatusText: '数据准备中…',
        holdingsStatus: 'loading'
      });
      const doRefresh = options.force === true || shouldRefresh(code);
      if (doRefresh) fundRefreshCache[code] = Date.now();
      this._fetchPayload(code, doRefresh)
        .then(payload => this._handlePayload(code, payload))
        .catch(err => this._retryOrFail(code, (err && err.message) || '加载失败'));
    },

    // 拉取 /api/fund/:code。首次（refresh）触发后台同步；并镜像网页端处理 404（未导入→导入后重试）。
    _fetchPayload(code, refresh) {
      const url = `/api/fund/${code}${refresh ? '?refresh=1&fast=1' : ''}`;
      return http.get(url, null, { silent: true }).catch(err => {
        const msg = (err && err.message) || '';
        // 仅当明确是“尚未导入”时才走导入后重试，避免网络错误也去打导入接口
        if (/尚未导入|not found|404/i.test(msg)) {
          return http.get(`/api/fund/import/${code}`, null, { silent: true })
            .then(() => http.get(`/api/fund/${code}?refresh=1`, null, { silent: true }))
            .catch(() => { throw err; });
        }
        throw err;
      });
    },

    // 统一分支：有数据 → SUCCESS；空数据（无论 pending 或未知）→ 继续等待（绝不判 EMPTY）
    _handlePayload(code, payload) {
      const history = Array.isArray(payload.history) ? payload.history : [];
      if (history.length > 0) {
        this._finishSuccess(code, payload, history);
        return;
      }
      // 后端 data_status.history 仅有 normal / pending，无“永久无数据”信号。
      // 只要 history 仍为空，一律视为“尚未取得数据”继续等待/轮询（显示正在同步），绝不提前结束。
      this._enterSyncing(code, payload);
    },

    // 把服务端响应落到 data（历史净值/业绩/持仓/今日净值）。terminal=true 时才把空持仓判为 none。
    _applyServerData(code, payload, history, terminal) {
      const majorHoldings = this._mapHoldings(payload.holdings);
      const dataStatusLabel = (payload.data_status && payload.data_status.label) ? payload.data_status.label : '';
      let holdingsStatus;
      if (majorHoldings.length > 0) holdingsStatus = 'success';
      else if (terminal) holdingsStatus = 'none';
      else holdingsStatus = 'syncing';
      this.setData({
        serverHistory: history,
        majorHoldings,
        dataStatusLabel,
        holdingsStatus
      }, () => {
        this.calculatePerformanceMetrics(history);
        this.computeNavRows(history);
        this._resolveCurrentNav(history);
        if (history.length > 0) this.tryRenderChart();
        // 仅首次补全实时股价，避免每次轮询都打 /api/stock/ 造成请求风暴
        if (!this._stockLoaded) {
          this._enrichHoldingsQuotes(majorHoldings);
          this._stockLoaded = true;
        }
      });
    },

    _mapHoldings(holdingsRaw) {
      const list = Array.isArray(holdingsRaw) ? holdingsRaw : [];
      return list.map(h => ({
        ...h,
        weightPctStr: pct(Number(h.weight) || 0, false),
        changePercent: null,
        changePctStr: '--',
        changeDate: ''
      }));
    },

    _enterSyncing(code, payload) {
      const ctl = this._syncCtl;
      ctl.status = 'syncing';
      if (!ctl.waitStart) ctl.waitStart = Date.now();
      this._applyServerData(code, payload, [], false);
      this.setData({
        chartStatus: 'syncing',
        syncWaitSeconds: this._elapsed(ctl),
        syncStatusText: (payload.data_status && payload.data_status.label) || '数据准备完成后自动显示'
      });
      this._startWaitTimer();
      this._schedulePoll(code);
    },

    _enterRetrying(code, message) {
      const ctl = this._syncCtl;
      ctl.status = 'retrying';
      if (!ctl.waitStart) ctl.waitStart = Date.now();
      this.setData({
        chartStatus: 'retrying',
        syncAttempt: ctl.attempt + 1,
        syncWaitSeconds: this._elapsed(ctl),
        syncStatusText: '数据源暂时不可用，正在自动重试…'
      });
      this._startWaitTimer();
      this._schedulePoll(code);
    },

    // 轮询：首次由 _startSync 触发 refresh；此处后续轮询一律不带 refresh（避免请求风暴）。
    // 递增退避 1.5→2→3→5→8→10s…，到达次数/总等待上限后判 FAILED（绝不判 EMPTY）。
    _schedulePoll(code) {
      const ctl = this._syncCtl;
      if (ctl.stopped) return;
      if (ctl.attempt >= SYNC_MAX_ATTEMPTS || (ctl.waitStart && Date.now() - ctl.waitStart > SYNC_MAX_WAIT_MS)) {
        this._finishFailed(code, '数据同步超时，可继续获取');
        return;
      }
      const delay = SYNC_POLL_DELAYS[Math.min(ctl.attempt, SYNC_POLL_DELAYS.length - 1)];
      this._pollTimer = setTimeout(() => {
        if (ctl.stopped) return;
        ctl.attempt += 1;
        this._fetchPayload(code, false) // 后续轮询绝不带 refresh
          .then(payload => {
            if (ctl.stopped) return;
            const history = Array.isArray(payload.history) ? payload.history : [];
            if (history.length > 0) {
              this._finishSuccess(code, payload, history);
              return;
            }
            this._enterSyncing(code, payload);
          })
          .catch(err => {
            if (ctl.stopped) return;
            this._retryOrFail(code, (err && err.message) || '加载失败');
          });
      }, delay);
    },

    // 抓取抛错时：尚有重试额度 → RETRYING 自动重试；耗尽 → FAILED（失败≠无数据，绝不判 EMPTY）
    _retryOrFail(code, message) {
      const ctl = this._syncCtl;
      if (ctl.attempt >= SYNC_MAX_ATTEMPTS || (ctl.waitStart && Date.now() - ctl.waitStart > SYNC_MAX_WAIT_MS)) {
        this._finishFailed(code, message);
        return;
      }
      this._enterRetrying(code, message);
    },

    _finishSuccess(code, payload, history) {
      this._stopSync();
      this._applyServerData(code, payload, history, true);
      this.setData({ chartStatus: 'success', isLoadingChart: false });
    },

    _finishFailed(code, message) {
      this._stopSync();
      // 失败≠永久无数据：显示“数据获取较慢”，并提供“继续获取”按钮重新启动周期。
      this.setData({
        chartStatus: 'failed',
        isLoadingChart: false,
        syncStatusText: message || '已自动尝试获取 3 分钟，当前仍未获得历史净值。系统不会把它判断为“基金没有历史数据”。'
      });
    },

    _startWaitTimer() {
      const ctl = this._syncCtl;
      if (this._waitTimer) clearInterval(this._waitTimer);
      this._waitTimer = setInterval(() => {
        if (ctl.stopped || this._syncCtl !== ctl) return;
        const secs = this._elapsed(ctl);
        if (ctl.status === 'retrying') {
          this.setData({ syncWaitSeconds: secs, syncAttempt: ctl.attempt + 1 });
        } else {
          this.setData({ syncWaitSeconds: secs });
        }
      }, 1000);
    },

    // 用真实个股行情补全前十大持仓的今日涨幅（缺失显示 --，不伪造 0%）
    _enrichHoldingsQuotes(holdings) {
      if (!holdings || !holdings.length) return;
      const codes = holdings.map(h => h.stock_code).filter(Boolean);
      if (!codes.length) return;
      Promise.all(codes.map(code =>
        http.get(`/api/stock/${code}`, null, { silent: true })
          .then(r => (r && r.quote) ? r.quote : null)
          .catch(() => null)
      )).then(quotes => {
        const enriched = holdings.map((h, i) => {
          const q = quotes[i];
          if (q && Number.isFinite(Number(q.change_percent))) {
            const pct = Number(q.change_percent) * 100;
            return { ...h, changePercent: pct, changePctStr: pct(pct, true), changeDate: '' };
          }
          // 无行情 → 显示 --（数据缺失，不伪造 0%）
          return { ...h, changePercent: null, changePctStr: '--', changeDate: '' };
        });
        this.setData({ majorHoldings: enriched });
      }).catch(() => { /* 行情补全失败不影响净值曲线 */ });
    },

    // 加载已有校准结果（不强制重算，复用后端缓存）
    loadCalibration(code) {
      http.get(`/api/fund/${code}/calibration`, null, { silent: true })
        .then(res => {
          const cal = (res && res.calibration) || null;
          if (cal) {
            this.setData({
              calibration: {
                calibrated: Boolean(cal.calibrated),
                sampleSize: Number(cal.sample_size) || 0,
                directionAccuracy: cal.direction_accuracy != null
                  ? `${(Number(cal.direction_accuracy) * 100).toFixed(0)}%`
                  : '—',
                mae: cal.mae != null ? (Number(cal.mae) * 100).toFixed(3) + '%' : '—',
                calibratedAt: cal.calibrated_at ? String(cal.calibrated_at).slice(0, 10) : ''
              }
            });
          }
        })
        .catch(() => { /* 校准接口不可用时静默忽略 */ });
    },

    // 手动触发校准（强制重算）
    onCalibrate() {
      const code = this.data.code;
      if (!code || this.data.isCalibrating) return;
      this.setData({ isCalibrating: true });
      wx.showLoading({ title: '校准中...', mask: true });
      http.get(`/api/fund/${code}/calibration?recalibrate=1`, null, { silent: true })
        .then(res => {
          wx.hideLoading();
          const cal = (res && res.calibration) || null;
          if (cal) {
            this.setData({
              calibration: {
                calibrated: Boolean(cal.calibrated),
                sampleSize: Number(cal.sample_size) || 0,
                directionAccuracy: cal.direction_accuracy != null
                  ? `${(Number(cal.direction_accuracy) * 100).toFixed(0)}%`
                  : '—',
                mae: cal.mae != null ? (Number(cal.mae) * 100).toFixed(3) + '%' : '—',
                calibratedAt: cal.calibrated_at ? String(cal.calibrated_at).slice(0, 10) : ''
              }
            });
            wx.showToast({ title: cal.calibrated ? '校准完成' : '样本不足，暂无法校准', icon: 'none' });
          } else {
            wx.showToast({ title: '校准失败', icon: 'none' });
          }
        })
        .catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '校准失败', icon: 'none' });
        })
        .finally(() => {
          this.setData({ isCalibrating: false });
        });
    },

    calculatePerformanceMetrics(history) {
      if (!history || history.length < 2) return;

      const calculateReturn = (days) => {
        const latest = history[history.length - 1];
        const latestVal = Number(latest.nav) || 0;
        if (!latestVal) return null;
        const latestTime = new Date(`${latest.date}T00:00:00`).getTime();
        const cutoff = latestTime - days * 86400000;
        const matchedPoint = history.find(item => new Date(`${item.date}T00:00:00`).getTime() >= cutoff);
        if (!matchedPoint) return null;
        const matchedVal = Number(matchedPoint.nav) || 0;
        return matchedVal ? (latestVal - matchedVal) / matchedVal : null;
      };

      const ytdDays = () => {
        const latest = history[history.length - 1];
        const year = new Date(`${latest.date}T00:00:00`).getFullYear();
        const jan1Time = new Date(`${year}-01-01T00:00:00`).getTime();
        const latestTime = new Date(`${latest.date}T00:00:00`).getTime();
        return Math.max(1, Math.round((latestTime - jan1Time) / 86400000));
      };

      const m1 = calculateReturn(31);
      const m3 = calculateReturn(93);
      const m6 = calculateReturn(186);
      const y1 = calculateReturn(366);
      const y3 = calculateReturn(1096);
      const sinceStart = calculateReturn(99999);
      const ytd = calculateReturn(ytdDays());

      const formatRate = (val) => val === null ? '—' : pct(val);

      this.setData({
        perf: {
          month1: m1, month1Str: formatRate(m1),
          month3: m3, month3Str: formatRate(m3),
          month6: m6, month6Str: formatRate(m6),
          year1: y1, year1Str: formatRate(y1),
          year3: y3, year3Str: formatRate(y3),
          sinceStart: sinceStart, sinceStartStr: formatRate(sinceStart),
          yearYtd: ytd, yearYtdStr: formatRate(ytd)
        }
      });
    },

    computeNavRows(history) {
      if (!history || history.length < 1) { this.setData({ navRows: [] }); return; }
      const rows = [];
      for (let i = 0; i < history.length; i++) {
        const cur = Number(history[i].nav) || 0;
        const prev = i > 0 ? (Number(history[i - 1].nav) || 0) : cur;
        const change = prev ? (cur - prev) / prev : 0;
        rows.push({
          date: history[i].date,
          navStr: cur ? cur.toFixed(4) : '—',
          accStr: history[i].acc != null ? Number(history[i].acc).toFixed(4) : '—',
          changePct: change,
          changePctStr: pct(change, false)
        });
      }
      rows.reverse();
      // 至少展示一个月的交易日（~22）+ 余量，提升到 30 行
      this.setData({ navRows: rows.slice(0, 30) });
    },

    // 基于已拉取的 serverHistory 推导「当日净值 / 净值日期 / 今日收益」，
    // 保证详情抽屉的净值、日期、今日收益来自同一个最新有效 NAV 口径（对齐 Phase 3 一致性要求）。
    // 当天已有正式 NAV → 用当天；当天没有 → 用最近有效交易日（history 末条即最新 NAV）。
    // 今日收益率 = 最新 NAV 相对前一交易日的日变化，今日收益 = 持仓金额 × 该变化。
    _resolveCurrentNav(history) {
      if (!history || !history.length) return;
      const amt = Number(this.data.fund && this.data.fund.amount) || 0;
      const last = history[history.length - 1];
      const nav = Number(last.nav);
      const navDate = last.date || '';
      if (!Number.isFinite(nav)) return;
      const prev = history.length > 1 ? history[history.length - 2] : null;
      const dailyPct = (prev && Number.isFinite(Number(prev.nav)) && Number(prev.nav) > 0)
        ? (nav / Number(prev.nav) - 1)
        : 0;
      const todayProfitVal = amt * dailyPct;
      this.setData({
        currentNav: nav ? nav.toFixed(4) : '—',
        currentNavDate: navDate,
        'fund.todayProfit': todayProfitVal,
        'fund.todayProfitStr': `${todayProfitVal >= 0 ? '+' : '-'}¥${money(Math.abs(todayProfitVal))}`,
        'fund.todayProfitPctStr': pct(dailyPct)
      });
    },

    onTabSelect(e) {
      this.setData({ activeTab: e.currentTarget.dataset.tab });
    },

    onRangeSelect(e) {
      this.setData({ activeRange: e.currentTarget.dataset.range }, () => this.renderCanvasChart());
    },

    tryRenderChart() {
      // 抽屉未完全可见时不绘制，避免 canvas 节点尺寸异常导致走势图错位
      if (this.data.embedded && !this.data.visible) return;
      this.renderCanvasChart();
    },

    renderCanvasChart() {
      const history = this.data.serverHistory;
      if (!history || history.length < 2) return;

      // 重新渲染前清除上一次交互指示，避免残留
      this.setData({ chartIndicator: { show: false }, chartTooltip: { show: false } });

      const rangeKey = this.data.activeRange;
      if (rangeKey === 'today') {
        this.setData({
          chartMinMaxStr: '今日实时估值走势图暂不可用',
          todayChartFallback: true,
          chartLegend: { cost: false, buy: false, sell: false }
        });
        return;
      }
      this.setData({ todayChartFallback: false });

      const rangeObj = this.data.ranges.find(r => r.key === rangeKey) || this.data.ranges[3];
      let segment = [];
      const latest = history[history.length - 1];
      const latestTime = new Date(`${latest.date}T00:00:00`).getTime();

      if (rangeKey === 'ytd') {
        const year = new Date(`${latest.date}T00:00:00`).getFullYear();
        segment = history.filter(item => new Date(`${item.date}T00:00:00`).getFullYear() === year);
      } else {
        const cutoff = latestTime - rangeObj.days * 86400000;
        segment = history.filter(item => new Date(`${item.date}T00:00:00`).getTime() >= cutoff);
      }
      if (segment.length < 2) segment = [...history];

      const vals = segment.map(item => Number(item.nav)).filter(Number.isFinite);
      const minVal = Math.min(...vals);
      const maxVal = Math.max(...vals);
      const pctChange = segment[0] && segment[segment.length - 1] ? ((segment[segment.length - 1].nav - segment[0].nav) / segment[0].nav) * 100 : 0;
      this.setData({
        chartMinMaxStr: `${segment[0].date} ~ ${segment[segment.length - 1].date} (${pct(pctChange)})`
      });

      const query = this.createSelectorQuery();
      query.select('#chartCanvas').fields({ node: true, size: true, rect: true }).exec((res) => {
        if (!res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const canvasLeft = res[0].left || 0;
        let dpr = 2;
        try {
          if (typeof wx.getWindowInfo === 'function') dpr = wx.getWindowInfo().pixelRatio || 2;
          else if (typeof wx.getSystemInfoSync === 'function') dpr = wx.getSystemInfoSync().pixelRatio || 2;
        } catch (e) {}

        const width = res[0].width;
        const height = res[0].height;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const paddingLeft = 12, paddingRight = 12, paddingTop = 12, paddingBottom = 12;
        const plotW = width - paddingLeft - paddingRight;
        const plotH = height - paddingTop - paddingBottom;
        const valRange = maxVal - minVal || 1;
        const getX = (index) => paddingLeft + (index / (segment.length - 1)) * plotW;
        const getY = (nav) => paddingTop + ((maxVal - nav) / valRange) * plotH;

        // 成本线：优先 costNav，否则用 市值-收益 反推
        const fund = this.data.fund;
        const latestNav = Number(segment[segment.length - 1].nav) || 0;
        const costPrice = this.computeCostPrice(fund, latestNav);
        let costY = null;
        let costHint = '';
        if (costPrice != null) {
          if (costPrice > maxVal) {
            costY = paddingTop;
            costHint = '（高于当前区间）';
          } else if (costPrice < minVal) {
            costY = paddingTop + plotH;
            costHint = '（低于当前区间）';
          } else {
            costY = getY(costPrice);
          }
        }

        // 买入/卖出交易点
        const txns = this.computeChartTransactions(fund, segment);

        // 缓存图表状态，供触摸交互复用
        this._chartState = {
          canvas, ctx, dpr, width, height, canvasLeft,
          paddingLeft, paddingRight, paddingTop, paddingBottom, plotW, plotH,
          minVal, maxVal, valRange,
          segment, getX, getY,
          costPrice, costY, costHint, txns
        };

        this.drawChart();

        this.setData({
          chartLegend: {
            cost: costPrice != null,
            buy: txns.some(t => t.type === 'buy'),
            sell: txns.some(t => t.type === 'sell')
          }
        });
      });
    },

    // 依据 this._chartState 重绘整张走势图（渐变/曲线/成本线/标记/末端点）
    drawChart() {
      const s = this._chartState;
      if (!s) return;
      const { ctx, width, height, segment, getX, getY, paddingLeft, paddingRight, paddingTop, costPrice, costY, costHint, txns } = s;
      ctx.clearRect(0, 0, width, height);

      // 渐变填充
      const gradient = ctx.createLinearGradient(0, paddingTop, 0, height);
      gradient.addColorStop(0, 'rgba(10, 132, 255, 0.22)');
      gradient.addColorStop(1, 'rgba(10, 132, 255, 0.0)');
      ctx.beginPath();
      ctx.moveTo(getX(0), height);
      segment.forEach((item, index) => ctx.lineTo(getX(index), getY(Number(item.nav))));
      ctx.lineTo(getX(segment.length - 1), height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // 蓝色净值曲线
      ctx.beginPath();
      segment.forEach((item, index) => {
        if (index === 0) ctx.moveTo(getX(index), getY(Number(item.nav)));
        else ctx.lineTo(getX(index), getY(Number(item.nav)));
      });
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 成本线（水平虚线）
      if (costPrice != null && costY != null) {
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        ctx.moveTo(paddingLeft, costY);
        ctx.lineTo(width - paddingRight, costY);
        ctx.strokeStyle = '#0071e3';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#0071e3';
        ctx.textAlign = 'right';
        const label = `成本 ${costPrice.toFixed(4)}${costHint}`;
        if (costY < height / 2) {
          ctx.textBaseline = 'top';
          ctx.fillText(label, width - paddingRight - 2, costY + 2);
        } else {
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, width - paddingRight - 2, costY - 2);
        }
        ctx.restore();
      }

      // 买入/卖出标记
      if (txns && txns.length) {
        txns.forEach(t => {
          const nav = Number(segment[t.index].nav);
          const x = getX(t.index);
          const y = getY(nav);
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, 2 * Math.PI);
          ctx.fillStyle = t.type === 'buy' ? '#ff3b30' : '#ff9500';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        });
      }

      // 末端高亮点
      const lastIndex = segment.length - 1;
      const endX = getX(lastIndex);
      const endY = getY(Number(segment[lastIndex].nav));
      ctx.beginPath();
      ctx.arc(endX, endY, 5, 0, 2 * Math.PI);
      ctx.fillStyle = '#0a84ff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(endX, endY, 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    },

    // 计算持仓成本价：优先 fund.costNav，否则 latestNav * (1 - 收益/金额)
    computeCostPrice(fund, latestNav) {
      if (!fund) return null;
      if (Number.isFinite(Number(fund.costNav)) && Number(fund.costNav) > 0) {
        return Number(fund.costNav);
      }
      const amount = Number(fund.amount) || 0;
      const profit = Number(fund.holdingProfit != null ? fund.holdingProfit : fund.profit) || 0;
      if (amount <= 0 || !Number.isFinite(latestNav) || latestNav <= 0) return null;
      const price = latestNav * (1 - profit / amount);
      return Number.isFinite(price) && price > 0 ? price : null;
    },

    // 将交易记录的日期映射到当前 segment 的索引
    computeChartTransactions(fund, segment) {
      const txns = Array.isArray(fund && fund.transactions) ? fund.transactions : [];
      if (!txns.length || !segment || segment.length < 2) return [];
      const result = [];
      txns.forEach(t => {
        if (!t) return;
        const type = t.type === 'sell' ? 'sell' : 'buy';
        const date = String(t.date || '');
        const day = date.slice(0, 10);
        if (!day) return;
        const index = segment.findIndex(h => String(h.date).slice(0, 10) === day);
        if (index === -1) return;
        result.push({ type, date, amount: t.amount, index });
      });
      return result;
    },

    onChartTouchStart(e) {
      this.handleChartTouch(e);
    },

    onChartTouchMove(e) {
      this.handleChartTouch(e);
    },

    onChartTouchEnd() {
      this.setData({ chartIndicator: { show: false }, chartTooltip: { show: false } });
    },

    handleChartTouch(e) {
      const s = this._chartState;
      if (!s || !s.segment || s.segment.length < 2) return;
      const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || null;
      if (!touch) return;
      
      let touchX = null;
      if (s.canvasLeft !== undefined && typeof touch.clientX === 'number') {
        touchX = touch.clientX - s.canvasLeft;
      } else if (typeof touch.x === 'number') {
        touchX = touch.x;
      } else if (e.detail && typeof e.detail.x === 'number') {
        touchX = e.detail.x;
      }
      if (touchX == null) return;

      const { width, height, paddingLeft, paddingRight, plotW, segment, getX, getY } = s;
      const clampedX = Math.max(paddingLeft, Math.min(width - paddingRight, touchX));
      const pct = plotW > 0 ? (clampedX - paddingLeft) / plotW : 0;
      let index = Math.round(pct * (segment.length - 1));
      index = Math.max(0, Math.min(segment.length - 1, index));

      const point = segment[index];
      const nav = Number(point.nav);
      const acc = point.acc != null ? Number(point.acc) : nav;
      const prev = index > 0 ? (Number(segment[index - 1].nav) || 0) : 0;
      const dailyChange = prev ? (nav - prev) / prev : 0;
      const dailyPct = dailyChange * 100;

      const x = getX(index);
      const y = getY(nav);

      // 浮层尽量留在可视区内：点位偏上时显示在上方，否则显示在下方
      const tipH = 96;
      let above = y > tipH;
      if (!above && (height - y) < tipH + 12) above = true;
      const left = Math.max(80, Math.min(width - 80, x));

      this.setData({
        chartIndicator: { show: true, left: x, top: y },
        chartTooltip: {
          show: true,
          left,
          top: y,
          above,
          date: point.date,
          nav: nav ? nav.toFixed(4) : '—',
          acc: acc ? acc.toFixed(4) : '—',
          changePct: dailyPct,
          changePctStr: pct(dailyChange)
        }
      });
    },

    // ---------- Modal ----------
    onClose() {
      this.triggerEvent('close');
    },

    showEditModal() {
      const fund = this.data.fund;
      this.setData({
        showEditModal: true,
        editMode: 'edit',
        editAmount: String(fund.amount),
        editProfit: String(fund.holdingProfit),
        newTxAmount: '',
        newTxFee: '',
        newTxDate: app.globalData.shanghaiToday,
        investAmount: '',
        investFrequencyIndex: 2,
        investDate: app.globalData.shanghaiToday
      });
    },

    hideEditModal() {
      this.setData({ showEditModal: false }, () => {
        // 弹窗关闭后 canvas 重新显示，需要重绘
        setTimeout(() => this.tryRenderChart(), 60);
      });
    },
    preventBubble() {},

    onSelectEditMode(e) {
      const mode = e.currentTarget.dataset.mode;
      const fund = this.data.fund;
      let tradeAmount = '';
      if (mode === 'liquidate') tradeAmount = String(Number(fund.amount) || 0);
      this.setData({ editMode: mode, newTxAmount: tradeAmount, newTxFee: '' });
    },

    // 快捷比例：以当前基金持仓金额 fund.amount 为基准，自动填入交易金额（保留手动修改）
    onQuickRatio(e) {
      const ratio = Number(e.currentTarget.dataset.ratio);
      const base = Number(this.data.fund.amount) || 0;
      const value = Math.round(base * ratio * 100) / 100;
      this.setData({ newTxAmount: String(value) });
    },

    onInputEditAmount(e) { this.setData({ editAmount: e.detail.value }); },
    onInputEditProfit(e) { this.setData({ editProfit: e.detail.value }); },
    onInputNewTxAmount(e) { this.setData({ newTxAmount: e.detail.value }); },
    onInputNewTxFee(e) { this.setData({ newTxFee: e.detail.value }); },
    onTxDateChange(e) { this.setData({ newTxDate: e.detail.value }); },
    onInputInvestAmount(e) { this.setData({ investAmount: e.detail.value }); },
    onInvestFrequencyChange(e) { this.setData({ investFrequencyIndex: Number(e.detail.value) }); },
    onInvestDateChange(e) { this.setData({ investDate: e.detail.value }); },

    submitEditHolding() {
      const code = this.data.code;
      const activeAccountName = app.globalData.activeAccountName;
      const accounts = app.globalData.accounts;
      const account = accounts[activeAccountName];
      if (!account) return;

      const fIdx = account.funds.findIndex(f => f.code === code);
      if (fIdx === -1) return;

      const fund = account.funds[fIdx];
      const mode = this.data.editMode;

      let nextAmount = Number(this.data.editAmount);
      let nextProfit = Number(this.data.editProfit) || 0;

      if (isNaN(nextAmount) || nextAmount < 0) {
        wx.showToast({ title: '持有金额输入不正确', icon: 'none' });
        return;
      }

      // 清仓
      if (mode === 'liquidate') {
        const tradeAmount = Number(fund.amount) || 0;
        const feeRate = Number(this.data.newTxFee) || 0;
        if (isNaN(feeRate) || feeRate < 0 || feeRate > 100) {
          wx.showToast({ title: '请填写有效的卖出费率 (0-100)', icon: 'none' });
          return;
        }
        const fee = tradeAmount * feeRate / 100;
        const date = this.data.newTxDate;
        fund.transactions = fund.transactions || [];
        fund.transactions.unshift({ type: 'sell', amount: tradeAmount, fee, date });
        account.closedPositions = account.closedPositions || [];
        account.closedPositions.unshift({
          name: fund.name, code: fund.code, closedBefore: date,
          reason: '手动清仓', amount: tradeAmount, profit: Number(fund.holdingProfit) || 0, fee
        });
        account.funds.splice(fIdx, 1);
        app.saveState();
        wx.showToast({ title: '已清仓并移出', icon: 'success' });
        this.setData({ showEditModal: false });
        // 通知父级关闭抽屉
        this.triggerEvent('deleted', { code });
        return;
      }

      // 定投
      if (mode === 'invest') {
        const investAmount = Number(this.data.investAmount);
        if (isNaN(investAmount) || investAmount <= 0) {
          wx.showToast({ title: '请填写有效的定投金额', icon: 'none' });
          return;
        }
        const frequency = this.data.investFrequenciesValues[this.data.investFrequencyIndex];
        const date = this.data.investDate;
        fund.transactions = fund.transactions || [];
        fund.transactions.unshift({ type: 'buy', amount: investAmount, fee: 0, date, invest: true });
        nextAmount = (Number(this.data.editAmount) || 0) + investAmount;
        nextProfit = Number(this.data.editProfit) || 0;

        const nextDateBase = date ? new Date(`${date}T00:00:00`) : new Date();
        if (frequency === 'daily') nextDateBase.setDate(nextDateBase.getDate() + 1);
        else if (frequency === 'weekly') nextDateBase.setDate(nextDateBase.getDate() + 7);
        else nextDateBase.setMonth(nextDateBase.getMonth() + 1);
        const pad = n => String(n).padStart(2, '0');
        const nextDateStr = `${nextDateBase.getFullYear()}-${pad(nextDateBase.getMonth() + 1)}-${pad(nextDateBase.getDate())}`;
        fund.autoInvest = { enabled: true, amount: investAmount, frequency, nextDate: nextDateStr };
      }

      // 加仓 / 减仓
      if (mode === 'add' || mode === 'reduce') {
        const tradeAmount = Number(this.data.newTxAmount);
        const feeRate = Number(this.data.newTxFee) || 0;
        if (isNaN(tradeAmount) || tradeAmount <= 0) {
          wx.showToast({ title: '请填写有效的交易金额', icon: 'none' });
          return;
        }
        if (isNaN(feeRate) || feeRate < 0) {
          wx.showToast({ title: '请填写有效的费率', icon: 'none' });
          return;
        }
        const fee = tradeAmount * feeRate / 100;
        const date = this.data.newTxDate;
        if (mode === 'reduce') {
          const currentAmount = Number(this.data.editAmount) || 0;
          if (tradeAmount + fee > currentAmount) {
            wx.showToast({ title: '卖出金额及费率不可超过持有金额', icon: 'none' });
            return;
          }
          const remainingRatio = currentAmount === 0 ? 0 : (currentAmount - tradeAmount) / currentAmount;
          nextAmount = currentAmount - tradeAmount;
          nextProfit = (Number(this.data.editProfit) || 0) * remainingRatio - fee;
        } else {
          nextAmount = (Number(this.data.editAmount) || 0) + tradeAmount;
          nextProfit = (Number(this.data.editProfit) || 0) - fee;
        }
        fund.transactions = fund.transactions || [];
        fund.transactions.unshift({ type: mode === 'add' ? 'buy' : 'sell', amount: tradeAmount, fee, date });
      }

      // 写入并持久化
      fund.amount = nextAmount;
      fund.holdingProfit = nextProfit;
      const totalCost = nextAmount - nextProfit;
      fund.holdingRate = totalCost > 0 ? nextProfit / totalCost : 0;
      fund.hold = fund.holdingRate;
      app.saveState();
      wx.showToast({ title: '已保存修改', icon: 'success' });
      this.setData({ showEditModal: false });
      this.loadFundLocalDetails(code);
      this.triggerEvent('changed', { code });
    },

    deletePosition() {
      const code = this.data.code;
      const activeAccountName = app.globalData.activeAccountName;
      wx.showModal({
        title: '删除确认',
        content: '确定要移除该基金持仓吗？对应历史交易明细也将被清除。',
        confirmText: '确认删除',
        confirmColor: '#ff453a',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            app.deleteFund(activeAccountName, code);
            app.saveState();
            wx.showToast({ title: '持仓已移出' });
            this.setData({ showEditModal: false });
            this.triggerEvent('deleted', { code });
          }
        }
      });
    }
  }
});
