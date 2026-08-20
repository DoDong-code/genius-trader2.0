import { http } from '../../utils/request.js';
import { computeDataBadge, shanghaiDate, officialNavChange, isQdiiFund, getPreviousTradingDay } from '../../utils/tradingDay.js';
import { assetClassOf } from '../../utils/fundSectors.js';
import { pct } from '../../utils/format.js';
const app = getApp();

const COLUMN_LABELS = {
  holdingProfit: '持有收益',
  todayProfit: '今日收益',
  amount: '持有金额'
};

const COLUMN_WIDTHS = {
  holdingProfit: 'minmax(130rpx, 0.74fr)',
  todayProfit: 'minmax(120rpx, 0.62fr)',
  amount: 'minmax(130rpx, 0.74fr)'
};

const SORT_CYCLES = {
  holding: ['default', 'holdingProfitAsc', 'holdingProfitDesc', 'holdingRateAsc', 'holdingRateDesc'],
  today: ['default', 'todayProfitAsc', 'todayProfitDesc', 'todayRateAsc', 'todayRateDesc'],
  amount: ['default', 'amountAsc', 'amountDesc']
};

const SORT_LABELS = {
  default: '默认顺序',
  holdingProfitAsc: '持有收益 低→高',
  holdingProfitDesc: '持有收益 高→低',
  holdingRateAsc: '持有收益率 低→高',
  holdingRateDesc: '持有收益率 高→低',
  todayProfitAsc: '今日收益 低→高',
  todayProfitDesc: '今日收益 高→低',
  todayRateAsc: '今日估算 低→高',
  todayRateDesc: '今日估算 高→低',
  amountAsc: '持有金额 低→高',
  amountDesc: '持有金额 高→低'
};

const COLUMN_FOR_STATE = {
  default: '',
  holdingProfitAsc: 'holding', holdingProfitDesc: 'holding', holdingRateAsc: 'holding', holdingRateDesc: 'holding',
  todayProfitAsc: 'today', todayProfitDesc: 'today', todayRateAsc: 'today', todayRateDesc: 'today',
  amountAsc: 'amount', amountDesc: 'amount'
};

Page({
  data: {
    activeAccountName: '',
    totalAssetsStr: '¥0',
    todayProfit: 0,
    todayProfitStr: '¥0.00',
    todayProfitPctStr: '0.00%',

    // Custom Topbar heights
    statusBarHeight: 20,
    navBarHeight: 44,

    // Holding profit metrics
    totalProfit: 0,
    totalProfitStr: '¥0',
    totalProfitPctStr: '0.00%',

    // Ticking Status Clock
    timeStr: '00:00:00',
    dateStr: '2026-08-05',

    // Filters
    activeCategory: '全部',

    // Account segmented tabs (持仓页：只展示「有持仓」的账户，无「全部」)
    accountTabs: [],
    selectedAccountTab: '',
    // 账户 tab 布局状态：tab 总长超过 2/3 屏宽时为 true（单独一行），否则与时间组同一行（纯 UI 布局，非业务逻辑）
    accountTabFullRow: false,

    // 数据源切换（与网页端 estimate_source_<account> 对齐：local / yjb / xbyj）
    estimateSource: 'local',
    estimateSourceLabel: '本地估算',

    // Sorting state machine
    sortState: 'default',

    // Column customization
    columnOrder: ['holdingProfit', 'todayProfit', 'amount'],
    columnLabels: COLUMN_LABELS,
    headerColumns: [],
    gridTemplateColumns: '',
    filteredFunds: [],

    // 数据标识状态机（对齐网页端 live-estimates.js）
    navDateMap: {},  // code -> { navDate: 'yyyy-mm-dd', source: 'local'|'xiaobeiyangji'|'yangjibao', day: 'yyyy-mm-dd' }
    // 注意：navDatePending 不放 data（data 会 JSON 序列化，Set 会退化）；改为实例变量 this._navDatePending，见 _initNavDatePending()

    // 基金详情抽屉
    showDrawer: false,
    drawerVisible: false,
    drawerSettled: false,  // 滑入动画完成后置 true，用于移除 drawer-panel 的 transform（让 fundDetail 内 fixed 弹窗正常铺满）
    drawerCode: '',
    drawerTopPad: 0,
    drawerCloseTop: 0,

    // Add Fund Modal inputs
    showAddModal: false,
    newFundCode: '',
    newFundName: '',
    newFundAmount: '',
    newFundProfit: '',
    authUser: null,  // 正式登录用户 { id, email }；null = 游客模式
    lookupStatus: '请输入6位代码自动查询匹配',
    lookupSuccess: false,
    fundsCatalog: [], // 全量基金目录（fund_code, fund_name），用于名称→代码模糊搜索

    // Customize header modal
    showCustomizeModal: false,
    tempColumnOrder: [],
    draggingIndex: -1,
    dragOffsetY: 0,
    dragStartY: 0,
    dragStartIndex: -1,
    dragCurrentIndex: -1,
    itemOffsets: [],  // 每个 item 的让位 transform（被拖项由 dragOffsetY 控制）
    itemHeightPx: 0,
    listTopPx: 0,

    windowWidth: 375
  },

  // 统一初始化 navDatePending：必须是纯运行时 Set（实例变量，不放 data，避免 JSON 序列化退化成 {}）
  // 在 onLoad / onShow / refreshData 等入口调用，保证 _refreshNavDatesIfNeeded 执行前一定是 Set
  _initNavDatePending() {
    if (!(this._navDatePending instanceof Set)) {
      this._navDatePending = new Set();
    }
  },

  onLoad() {
    this._initNavDatePending();
    let windowWidth = 375;
    try {
      const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
      windowWidth = info.windowWidth || 375;
    } catch (e) { /* ignore */ }

    const savedOrder = wx.getStorageSync('genius-trader-column-order') || ['holdingProfit', 'todayProfit', 'amount'];
    const validOrder = savedOrder.filter(k => COLUMN_LABELS[k]);
    if (validOrder.length !== 3) validOrder.push(...['holdingProfit', 'todayProfit', 'amount'].filter(k => !validOrder.includes(k)));

    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight,
      windowWidth,
      columnOrder: validOrder
    });

    this.buildHeaderColumns();
    this.initClock();
  },

  onUnload() {
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
    }
  },

  onShow() {
    this._initNavDatePending();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().highlight('/pages/portfolio/portfolio');
    }
    this.setData({ authUser: (app.globalData.auth && app.globalData.auth.user) || null });
    this.refreshData();
    this.updateClock();
  },

  onReady() {
    this.measureAccountTabs();
  },

  // 测量账户 tab 总宽，超过 2/3 屏宽则单独成行（纯 UI 布局，不触碰 tab 选择/数据逻辑）
  measureAccountTabs() {
    const tabs = this.data.accountTabs;
    if (!tabs || tabs.length <= 1) {
      if (this.data.accountTabFullRow) this.setData({ accountTabFullRow: false });
      return;
    }
    wx.createSelectorQuery().in(this)
      .select('.account-segmented').boundingClientRect()
      .exec(res => {
        const rect = res && res[0];
        if (!rect || !rect.width) return;
        let winW = 375;
        try { winW = (wx.getWindowInfo ? wx.getWindowInfo().windowWidth : wx.getSystemInfoSync().windowWidth) || 375; } catch (e) {}
        const full = rect.width > winW * 2 / 3;
        if (full !== this.data.accountTabFullRow) this.setData({ accountTabFullRow: full });
      });
  },

  // 登录 / 注册入口（未登录）
  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  // 进入账号中心（已登录）
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onPullDownRefresh() {
    this.refreshData();
    setTimeout(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '列表已更新', icon: 'success' });
    }, 800);
  },

  initClock() {
    this.updateClock();
    this.clockInterval = setInterval(() => {
      this.updateClock();
    }, 1000);
  },

  updateClock() {
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const shanghaiTime = new Date(utc + 3600000 * 8);

    const hh = pad(shanghaiTime.getHours());
    const mm = pad(shanghaiTime.getMinutes());
    const ss = pad(shanghaiTime.getSeconds());
    const y = shanghaiTime.getFullYear();
    const m = pad(shanghaiTime.getMonth() + 1);
    const d = pad(shanghaiTime.getDate());

    this.setData({
      timeStr: `${hh}:${mm}:${ss}`,
      dateStr: `${y}-${m}-${d}`
    });
  },

  onRefreshClick() {
    wx.showLoading({ title: '正在同步估值...' });
    setTimeout(() => {
      this.refreshData();
      wx.hideLoading();
      wx.showToast({ title: '估值已同步', icon: 'success' });
    }, 600);
  },

  navigateToOverview() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  refreshData() {
    this._initNavDatePending();
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    const funds = account.funds || [];

    // 恢复当前账户的「数据源」偏好（与网页端 estimate_source_<account> 对齐）
    let estimateSource = this.data.estimateSource;
    try {
      const saved = wx.getStorageSync(`genius-mp-estimate-source-${activeAccountName}`);
      if (saved && ['local', 'yjb', 'xbyj'].includes(saved)) estimateSource = saved;
    } catch (e) { /* ignore */ }

    let totalAssets = 0;
    let todayProfit = 0;
    let totalProfit = 0;

    funds.forEach(f => {
      const amt = Number(f.amount) || 0;
      const todayPct = Number(f.today) || 0;
      const profitVal = Number(f.holdingProfit) || 0;

      totalAssets += amt;
      todayProfit += amt * todayPct;
      totalProfit += profitVal;
    });

    const totalCost = totalAssets - totalProfit;
    const totalProfitPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const todayProfitPct = totalAssets > 0 ? (todayProfit / totalAssets) * 100 : 0;

    this.setData({ holdingsCount: funds.length });
    this.buildAccountTabs(); // 先构建 tab，保证 selectedAccountTab 与 tabs 一致

    const estimateSourceLabel = estimateSource === 'yjb' ? '养基宝' : estimateSource === 'xbyj' ? '小倍' : '本地估算';

    this.setData({
      activeAccountName,
      estimateSource,
      estimateSourceLabel,
      totalAssetsStr: `¥${Math.round(totalAssets).toLocaleString('zh-CN')}`,
      todayProfit,
      todayProfitStr: `${todayProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfit)).toLocaleString('zh-CN')}`,
      todayProfitPctStr: `${todayProfit >= 0 ? '+' : ''}${todayProfitPct.toFixed(2)}%`,
      totalProfit,
      totalProfitStr: `${totalProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(totalProfit)).toLocaleString('zh-CN')}`,
      totalProfitPctStr: `${totalProfit >= 0 ? '+' : ''}${totalProfitPct.toFixed(2)}%`
    });

    this.updateSortUI();
    this.filterAndSortFunds();
  },

  // 构建持仓页账户分段 tab：根账户（有持仓才显示，避免空主账户占 tab）+ 子账户（始终显示，新建后可立即进入添加基金）
  // 与网页端对齐：网页端子账户通过账户卡片点击进入，小程序持仓页无该路径，故子账户直接纳入分段 tab 可选中。
  buildAccountTabs() {
    const accounts = app.globalData.accounts || {};
    const activeName = app.globalData.activeAccountName;
    const tabs = [];

    Object.keys(accounts).forEach(name => {
      const acc = accounts[name];
      if (!acc) return;
      if (acc.parent) {
        // 子账户：始终显示，确保「新建子账户 → 立即在持仓列表看到并进入」可用
        tabs.push({ key: name, label: name, isChild: true });
      } else if (acc.funds && acc.funds.length > 0) {
        // 根账户：仅在有持仓时显示（保留原行为）
        tabs.push({ key: name, label: name, isChild: false });
      }
    });

    // 保证当前激活账户（即使是空子账户）出现在 tab 中，避免被自动切走
    if (activeName && !tabs.find(t => t.key === activeName) && accounts[activeName]) {
      tabs.push({ key: activeName, label: activeName, isChild: Boolean(accounts[activeName].parent) });
    }

    const validActive = tabs.find(t => t.key === activeName) ? activeName : (tabs[0] ? tabs[0].key : '');

    this.setData({
      accountTabs: tabs,
      selectedAccountTab: validActive
    }, () => {
      this.measureAccountTabs();
    });

    // 如果当前激活账户不在 tabs（空账户或已被删），自动切到第一个可用
    if (validActive && app.globalData.activeAccountName !== validActive) {
      app.setActiveAccount(validActive);
    }
  },

  // 账户分段 tab 点击：切换全局激活账户并刷新列表
  onAccountTabSelect(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.selectedAccountTab) return;
    if (!app.globalData.accounts[tab]) return;
    app.setActiveAccount(tab);
    this.setData({ selectedAccountTab: tab });
    this.refreshData();
  },

  // 顶部右侧「数据源」切换：弹出菜单式（与网页版一致），不再循环切换
  onSwitchEstimateSource() {
    const status = app.globalData.providerStatus || {};
    // 仅展示已登录的来源；本地永远可用
    const items = [{ key: 'local', label: '本地估算' }];
    if (status.yjbConnected) items.push({ key: 'yjb', label: '养基宝' });
    if (status.xbyjConnected) items.push({ key: 'xbyj', label: '小倍' });
    const itemList = items.map(i => `${i.label}${i.key === this.data.estimateSource ? ' ✓' : ''}`);
    const cancelText = '取消';
    wx.showActionSheet({
      itemList: [...itemList, cancelText],
      success: (res) => {
        if (typeof res.tapIndex !== 'number') return;
        if (res.tapIndex >= items.length) return; // 取消
        const picked = items[res.tapIndex];
        if (!picked || picked.key === this.data.estimateSource) return;
        this.setData({ estimateSource: picked.key, estimateSourceLabel: picked.label });
        try { wx.setStorageSync(`genius-mp-estimate-source-${app.globalData.activeAccountName}`, picked.key); } catch (e) {}
        this.refreshData();
        if (picked.key !== 'local') this.refreshEstimatesBySource(picked.key);
      }
    });
  },

  // 按数据源批量拉真实估值（仅 yjb / xbyj；local 走本地规则）
  refreshEstimatesBySource(source) {
    const account = app.getActiveAccount();
    const funds = (account && account.funds) || [];
    if (!funds.length || !source || source === 'local') return;

    const queue = funds.filter(f => f && f.code);
    if (!queue.length) {
      // 没有需要同步的基金：直接刷新本地列表，避免 showLoading 永不关闭
      this.refreshData();
      return;
    }

    wx.showLoading({ title: '同步真实估值...', mask: true });
    const CONCURRENCY = 6; // 并发上限，避免多基金同时请求卡顿（对齐网页端 MAX_CONCURRENT）
    let pending = queue.length;
    let updated = 0;
    let active = 0;
    let finished = false;

    // 无论成功/失败/超时，最终一定关闭 loading，禁止无限转圈
    const finish = () => {
      if (finished) return;
      finished = true;
      wx.hideLoading();
      app.saveState();
      this.refreshData();
      wx.showToast({
        title: updated > 0 ? `已同步 ${updated} 条` : '无新数据',
        icon: updated > 0 ? 'success' : 'none'
      });
    };
    // 兜底看门狗：极端情况下（接口挂起）20s 后强制结束，避免永久转圈
    const watchdog = setTimeout(() => {
      if (!finished) {
        console.warn('[A-Debug] refreshEstimatesBySource watchdog 触发（接口可能挂起）| source =', source);
        finish();
      }
    }, 20000);

    const done = () => {
      pending -= 1;
      if (pending <= 0) {
        clearTimeout(watchdog);
        finish();
      }
    };
    const runNext = () => {
      while (active < CONCURRENCY && queue.length) {
        const f = queue.shift();
        active += 1;
        const amount = Number(f.amount) || 0;
        const url = `/api/fund/${encodeURIComponent(f.code)}/estimate?amount=${amount}&mode=provider&source=${encodeURIComponent(source)}`;
        http.get(url, null, { silent: true })
          .then(res => {
            const est = (res && (res.estimate || res)) || {};
            const change = Number(est.estimate_change);
            if (Number.isFinite(change)) {
              f.today = change;
              f.todayEstimate = Number.isFinite(Number(est.estimate_profit)) ? Number(est.estimate_profit) : amount * change;
              f.estimateSource = source;
              f.estimateUpdatedAt = new Date().toISOString();
              updated += 1;
            }
          })
          .catch(() => { /* 单只失败不影响其他 */ })
          .finally(() => {
            active -= 1;
            done();
            runNext();
          });
      }
    };
    runNext();
  },

  // ---------- Column header rendering ----------
  buildHeaderColumns() {
    const order = this.data.columnOrder;
    const sortState = this.data.sortState;
    const activeColumn = COLUMN_FOR_STATE[sortState];
    const isAsc = sortState.endsWith('Asc');
    const isDesc = sortState.endsWith('Desc');
    const isRate = sortState.indexOf('Rate') !== -1; // 收益率态（对齐网页端 sortedLabel 的 '率'）

    const headerColumns = order.map(key => {
      const column = key === 'amount' ? 'amount' : (key === 'todayProfit' ? 'today' : 'holding');
      const active = activeColumn === column;
      // 排序状态直接显示在表头（对齐网页端 portfolio-fix.js:191-196）
      // 收益率态：基数标签追加「率」（今日收益→今日收益率、持有收益→持有收益率）
      let label = COLUMN_LABELS[key];
      if (active && sortState !== 'default' && isRate) label = COLUMN_LABELS[key] + '率';
      // 箭头方向与网页端一致：升序 ↑、降序 ↓
      const arrow = active ? (isAsc ? '↑' : (isDesc ? '↓' : '')) : '';
      return {
        key,
        column,
        label,
        active,
        arrow
      };
    });

    const gridTemplateColumns = `minmax(0, 1fr) ${order.map(k => COLUMN_WIDTHS[k]).join(' ')}`;

    this.setData({ headerColumns, gridTemplateColumns });
  },

  // ---------- Sorting state machine ----------
  onSortChange(e) {
    const column = e.currentTarget.dataset.column;
    const cycle = SORT_CYCLES[column];
    const currentIdx = cycle.indexOf(this.data.sortState);
    const nextIdx = (currentIdx === -1 ? 0 : currentIdx) + 1;
    const nextState = cycle[nextIdx % cycle.length];

    this.setData({ sortState: nextState }, () => {
      this.updateSortUI();
      this.filterAndSortFunds();
    });
  },

  updateSortUI() {
    // 排序状态已直接渲染在表头（箭头 + 收益率态标签），不再额外显示辅助文案
    this.buildHeaderColumns();
  },

  filterAndSortFunds() {
    const account = app.getActiveAccount();
    let list = [...(account.funds || [])];
    const sortState = this.data.sortState;

    if (sortState !== 'default') {
      const isAsc = sortState.endsWith('Asc');
      const key = sortState;

      list.sort((a, b) => {
        let valA = 0, valB = 0;

        if (key.startsWith('holdingProfit')) {
          valA = Number(a.holdingProfit) || 0;
          valB = Number(b.holdingProfit) || 0;
        } else if (key.startsWith('holdingRate')) {
          valA = Number(a.holdingRate) || Number(a.hold) || 0;
          valB = Number(b.holdingRate) || Number(b.hold) || 0;
        } else if (key.startsWith('todayProfit')) {
          // 金额排序优先 todayEstimate，否则 amt×today（对齐 Web portfolio-fix.js:581-583）
          valA = Number.isFinite(Number(a.todayEstimate)) ? Number(a.todayEstimate) : (Number(a.amount) || 0) * (Number(a.today) || 0);
          valB = Number.isFinite(Number(b.todayEstimate)) ? Number(b.todayEstimate) : (Number(b.amount) || 0) * (Number(b.today) || 0);
        } else if (key.startsWith('todayRate')) {
          valA = Number(a.today) || 0;
          valB = Number(b.today) || 0;
        } else if (key.startsWith('amount')) {
          valA = Number(a.amount) || 0;
          valB = Number(b.amount) || 0;
        }

        if (valA < valB) return isAsc ? -1 : 1;
        if (valA > valB) return isAsc ? 1 : -1;
        return 0;
      });
    } else {
      // P1 默认排序：基金（名称）→ 今日收益 → 持有收益 → 持有金额（数值键均降序）
      list.sort((a, b) => {
        const nameA = String(a.name || a.code || '');
        const nameB = String(b.name || b.code || '');
        if (nameA !== nameB) return nameA.localeCompare(nameB, 'zh-Hans-CN');
        const todayA = Number.isFinite(Number(a.todayEstimate)) ? Number(a.todayEstimate) : (Number(a.amount) || 0) * (Number(a.today) || 0);
        const todayB = Number.isFinite(Number(b.todayEstimate)) ? Number(b.todayEstimate) : (Number(b.amount) || 0) * (Number(b.today) || 0);
        if (todayA !== todayB) return todayB - todayA;
        const profitA = Number(a.holdingProfit) || 0;
        const profitB = Number(b.holdingProfit) || 0;
        if (profitA !== profitB) return profitB - profitA;
        return (Number(b.amount) || 0) - (Number(a.amount) || 0);
      });
    }

    const filteredFunds = list.map(f => {
      const amt = Number(f.amount) || 0;
      const profit = Number(f.holdingProfit) || 0;
      const todayPct = Number(f.today) || 0;
      // 当日收益优先用估值引擎算好的金额 todayEstimate，否则 amt×today（对齐 Web detail-api.js:98-104）
      const todayProfitVal = Number.isFinite(Number(f.todayEstimate))
        ? Number(f.todayEstimate)
        : amt * todayPct;
      const holdRate = Number(f.holdingRate) || Number(f.hold) || 0;

      // 数据标识徽章（三态状态机，对齐网页端 live-estimates.js）
      // 优先级：①官方净值已更新到预期日期(蓝"已更新MMDD") ②非交易日(蓝"已更新MMDD"最近交易日) ③盘中/盘后(灰"估值/小倍/养基宝")
      const cached = this.data.navDateMap && this.data.navDateMap[f.code];
      const status = app.globalData.providerStatus || {};
      // 估值数据源优先级：用户选的 estimateSource → navDateMap 里的 source → 'local'
      let source = 'local';
      if (this.data.estimateSource === 'yjb' && status.yjbConnected) source = 'yjb';
      else if (this.data.estimateSource === 'xbyj' && status.xbyjConnected) source = 'xbyj';
      // navDateMap 里的 source 优先（如果该基金有第三方已结算净值）
      if (cached && cached.source) source = cached.source;
      const navDate = cached ? cached.navDate : null;
      // 是否存在有效估值/数据源数据：有净值日期 或 有限今日涨跌幅 / 估值金额（避免 Number(null)=0 误判）
      const hasEstimateData = Boolean(navDate)
        || Number.isFinite(Number(f.today))
        || Number.isFinite(Number(f.todayEstimate));
      const badge = computeDataBadge(f, navDate, source, new Date(), cached ? cached.officialChange : null, hasEstimateData);

      // 与蓝色「已更新」徽章同源：最新 NAV 已是今天（QDII 为前一交易日）的正式净值时，
      // 今日收益/收益率改用官方当日涨跌幅，避免「蓝日期 + 收益按旧 NAV 算」错位。
      // （对齐网页端 resolveTodayData 的 officialUpdated 分支；不新增数据层、不改算法）
      const todayStr = shanghaiDate();
      const expectedNavDate = isQdiiFund(f) ? getPreviousTradingDay(todayStr) : todayStr;
      const officialUpdated = Boolean(
        cached && cached.navDate && cached.navDate === expectedNavDate && Number.isFinite(cached.officialChange)
      );
      let finalTodayPct = todayPct;
      let finalTodayProfit = todayProfitVal;
      if (officialUpdated) {
        // 与蓝徽章同一净值分支：收益率 = 官方当日涨跌幅，收益 = 持仓金额 × 官方涨跌幅
        finalTodayPct = Number(cached.officialChange);
        finalTodayProfit = amt * finalTodayPct;
      }

      return {
        ...f,
        amountStr: `¥${Math.round(amt).toLocaleString('zh-CN')}`,
        holdingProfitStr: `${profit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(profit)).toLocaleString('zh-CN')}`,
        holdingRateStr: pct(holdRate),
        todayProfit: finalTodayProfit,
        todayProfitStr: `${finalTodayProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(finalTodayProfit)).toLocaleString('zh-CN')}`,
        todayProfitPctStr: pct(finalTodayPct),
        // UI 展示：去掉蓝色徽章里的「已更新」前缀，只保留日期，减少行高避免列表下方被遮挡
        dataBadge: badge ? { ...badge, text: badge.text.replace(/^已更新/, '') } : null
      };
    });

    this.setData({ filteredFunds });
    // 异步并发刷新每只基金的 navDate（首次/缓存失效时拉取）
    this._refreshNavDatesIfNeeded(account.funds || []);
  },

  // 并发拉取每只基金的 latest_nav.date（fast=1 不重算，直接读缓存）
  // 与网页端 updatedNavDates 同源：已更新净值且是当天的跳过
  _refreshNavDatesIfNeeded(funds) {
    if (!Array.isArray(funds) || !funds.length) return;
    const today = shanghaiDate();
    const map = { ...(this.data.navDateMap || {}) };
    const queue = [];
    const CONCURRENCY = 6;
    let active = 0;
    let remaining = 0;
    let startedRefresh = false;
    const start = () => {
      while (active < CONCURRENCY && queue.length) {
        const code = queue.shift();
        const entry = map[code];
        if (entry && entry.day === today && entry.kind === 'updated') continue; // 当日已确认更新，跳过
        if (this._navDatePending && this._navDatePending.has(code)) continue; // 正在请求中，跳过
        active += 1;
        remaining += 1;
        startedRefresh = true;
        this._navDatePending.add(code);
        http.get(`/api/fund/${code}?fast=1`, null, { silent: true })
          .then(res => {
            // 关键字段：后端 fund 字段是 fund_code/fund_name，但 navDate 在 latest_nav.date
            const fund = res && res.fund;
            const navDate = fund && fund.latest_nav && fund.latest_nav.date;
            const source = (res && res.data_status && res.data_status.source) || null;
            if (navDate) {
              // 官方涨跌幅由 history 计算（对齐 Web officialNavChange，用于状态①判定）
              const officialChange = officialNavChange((res && res.history) || [], navDate);
              const next = { ...this.data.navDateMap, [code]: { navDate, source, officialChange, day: today, kind: 'updated' } };
              this.setData({ navDateMap: next });
              this.filterAndSortFunds(); // 重新渲染徽章
            }
          })
          .catch(() => { /* 单只失败不影响 */ })
          .finally(() => {
            this._navDatePending.delete(code);
            active -= 1;
            remaining -= 1;
            // 全部完成后清掉 loading 标记（用于头部转圈提示）
            if (remaining === 0 && startedRefresh) {
              this.setData({ isSyncingNavDates: false });
            }
            start();
          });
      }
    };
    // 用 isSyncingNavDates 让外部显示一个轻微的转圈提示（避免点击刷新按钮后长时间没反馈）
    this.setData({ isSyncingNavDates: true });
    funds.forEach(f => { if (f && f.code && !queue.includes(f.code)) queue.push(f.code); });
    start();
  },

  // ---------- Customize header order modal ----------
  onShowCustomizeModal() {
    this.setData({
      showCustomizeModal: true,
      tempColumnOrder: [...this.data.columnOrder],
      draggingIndex: -1,
      dragOffsetY: 0,
      dragStartIndex: -1,
      dragCurrentIndex: -1
    });
    setTimeout(() => this.queryCustomizeRects(), 60);
  },

  onCancelCustomize() {
    this.setData({ showCustomizeModal: false });
  },

  onSaveCustomize() {
    const order = this.data.tempColumnOrder;
    wx.setStorageSync('genius-trader-column-order', order);
    this.setData({
      showCustomizeModal: false,
      columnOrder: order
    }, () => {
      this.buildHeaderColumns();
      this.filterAndSortFunds();
      wx.showToast({ title: '表头顺序已保存', icon: 'success' });
    });
  },

  queryCustomizeRects() {
    const query = wx.createSelectorQuery().in(this);
    query.select('.customize-items').boundingClientRect();
    query.select('.customize-draggable').boundingClientRect();
    query.exec(res => {
      if (!res || !res[0] || !res[1]) return;
      this.setData({
        listTopPx: res[0].top,
        itemHeightPx: res[1].height
      });
    });
  },

  onDragStart(e) {
    const index = e.currentTarget.dataset.index;
    const touch = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]);
    if (!touch) return;

    if (!this.data.itemHeightPx) {
      this.queryCustomizeRects();
    }

    this.setData({
      draggingIndex: index,
      dragStartIndex: index,
      dragCurrentIndex: index,
      dragStartY: touch.pageY,
      dragOffsetY: 0,
      itemOffsets: new Array((this.data.tempColumnOrder || []).length).fill(0)
    });
  },

  onDragMove(e) {
    if (this.data.draggingIndex === -1) return;
    const touch = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]);
    if (!touch) return;

    const { listTopPx, itemHeightPx, dragStartY, dragStartIndex, tempColumnOrder } = this.data;
    if (!itemHeightPx) return;

    // 计算视觉上的目标位置（基于手指 Y 坐标）
    let targetIndex = Math.floor((touch.pageY - listTopPx + itemHeightPx / 2) / itemHeightPx);
    targetIndex = Math.max(0, Math.min(tempColumnOrder.length - 1, targetIndex));

    // ★ 关键修复：拖动期间不修改 tempColumnOrder，避免 wx:for 重渲染导致按钮内容交换
    // 1. 被拖项用 dragOffsetY 跟随手指
    // 2. 其他项根据 dragStartIndex → targetIndex 计算让位 transform
    const dragOffsetY = touch.pageY - dragStartY;
    const itemOffsets = this._computeItemOffsets(dragStartIndex, targetIndex, itemHeightPx);

    this.setData({
      dragCurrentIndex: targetIndex,
      dragOffsetY,
      itemOffsets
    });
  },

  // 计算每个 item 的让位偏移：被拖项由 dragOffsetY 控制；其他项若在原位置和目标位置之间则让位 itemHeightPx
  _computeItemOffsets(fromIndex, toIndex, itemHeightPx) {
    const len = this.data.tempColumnOrder ? this.data.tempColumnOrder.length : 0;
    const offsets = new Array(len).fill(0);
    if (fromIndex === toIndex) return offsets;
    const movePx = itemHeightPx + 32; // 32rpx gap (转 px 由调用方换算，这里直接用 px)
    if (toIndex > fromIndex) {
      // 向下拖：原位置与目标位置之间的项向上让位
      for (let i = fromIndex + 1; i <= toIndex; i++) offsets[i] = -movePx;
    } else {
      // 向上拖：原位置与目标位置之间的项向下让位
      for (let i = toIndex; i < fromIndex; i++) offsets[i] = movePx;
    }
    return offsets;
  },

  onDragEnd() {
    const { draggingIndex, dragStartIndex, dragCurrentIndex, tempColumnOrder } = this.data;
    if (draggingIndex === -1 || dragStartIndex === dragCurrentIndex || dragStartIndex < 0) {
      this.setData({
        draggingIndex: -1,
        dragOffsetY: 0,
        dragStartIndex: -1,
        dragCurrentIndex: -1,
        itemOffsets: []
      });
      return;
    }
    // 松手时才真正重排 tempColumnOrder + columnOrder
    const arr = [...tempColumnOrder];
    const [moved] = arr.splice(dragStartIndex, 1);
    arr.splice(dragCurrentIndex, 0, moved);
    this.setData({
      tempColumnOrder: arr,
      columnOrder: arr,
      draggingIndex: -1,
      dragOffsetY: 0,
      dragStartIndex: -1,
      dragCurrentIndex: -1,
      itemOffsets: []
    });
  },

  // ---------- Fund detail drawer ----------
  openDetailDrawer(e) {
    const code = e.currentTarget.dataset.code;
    const statusBarHeight = this.data.statusBarHeight || 0;
    const navBarHeight = this.data.navBarHeight || 44;
    const topPad = statusBarHeight + navBarHeight;
    this.setData({
      drawerCode: code,
      showDrawer: true,
      drawerVisible: false,
      drawerSettled: false,
      drawerTopPad: topPad,
      drawerCloseTop: topPad + 12
    }, () => {
      setTimeout(() => {
        this.setData({ drawerVisible: true });
        // 滑入动画(280ms)完成后移除 transform，让 fundDetail 内 position:fixed 弹窗相对视口定位、铺满屏幕
        setTimeout(() => {
          this.setData({ drawerSettled: true });
        }, 300);
      }, 30);
    });
  },

  closeDrawer() {
    this.setData({ drawerVisible: false, drawerSettled: false }, () => {
      setTimeout(() => {
        this.setData({ showDrawer: false, drawerCode: '' });
      }, 280);
    });
  },

  // 抽屉内「从左往右滑」关闭抽屉（返回上一层），避免触发 iOS 系统左滑退出小程序
  onDrawerTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    this._drawerTouch = { x: t.clientX, y: t.clientY };
  },
  onDrawerTouchEnd(e) {
    if (!this._drawerTouch) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - this._drawerTouch.x;
    const dy = t.clientY - this._drawerTouch.y;
    this._drawerTouch = null;
    // 横向右滑 > 60px 且横向位移明显大于纵向（避免误触纵向滚动）
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      this.closeDrawer();
    }
  },

  preventBubble() {},

  onDrawerChanged() {
    this.refreshData();
  },

  onDrawerDeleted() {
    this.closeDrawer();
    this.refreshData();
  },

  // ---------- Add Fund Modal ----------
  showAddModal() {
    this.setData({
      showAddModal: true,
      newFundCode: '',
      newFundName: '',
      newFundAmount: '',
      newFundProfit: '',
      lookupStatus: '请输入6位代码自动查询匹配',
      lookupSuccess: false
    });
    this.fetchFundsCatalog();
  },

  hideAddModal() {
    this.setData({ showAddModal: false });
  },

  // 拉基金目录（后端已导入基金 + 前端内置常用目录），用于名称→代码模糊搜索
  fetchFundsCatalog() {
    // 先合并内置常用目录（后端 /api/funds 只返回数据库已导入的基金，通常很少，无法覆盖全量）
    const builtin = (require('../../utils/fundCatalog.js').default || []).map(f => ({
      fund_code: f.code, fund_name: f.name
    }));
    this.setData({ fundsCatalog: builtin });
    if (!http || !http.get) return;
    http.get('/api/funds', null, { silent: true })
      .then(res => {
        const list = (res && res.funds) || [];
        const remote = Array.isArray(list) ? list : [];
        // 合并去重：内置在前，后端补充（后端有 latest_nav 等详情，但这里只要 code/name）
        const merged = [...builtin];
        const seen = new Set(builtin.map(f => f.fund_code));
        remote.forEach(f => {
          const code = String(f.fund_code || f.code || '');
          if (code && !seen.has(code)) {
            seen.add(code);
            merged.push({ fund_code: code, fund_name: String(f.fund_name || f.name || '') });
          }
        });
        this.setData({ fundsCatalog: merged });
      })
      .catch(() => { /* 静默失败：内置目录仍在 */ });
  },

  onInputFundName(e) {
    const name = e.detail.value;
    this.setData({ newFundName: name });

    // 双向自动填策略（与网页版一致）：
    // 1) 优先用全量基金目录做模糊匹配（fund_name 包含输入 或 输入包含 fund_name）→ 填代码并查
    // 2) 其次正则从名称里提取 6 位数字（如「易方达蓝筹(005827)」）
    const trimmed = (name || '').trim();
    if (!trimmed) return;

    const catalog = this.data.fundsCatalog || [];
    let matchedCode = '';
    if (catalog.length) {
      // 按相关度排序：① 名称完全等于输入 ② 名称以输入开头 ③ 名称包含输入；取最相关的一个
      const scored = [];
      catalog.forEach(f => {
        const fn = String(f.fund_name || f.name || '').replace(/\s/g, '');
        const q = trimmed.replace(/\s/g, '');
        if (!fn || !q) return;
        let score = -1;
        if (fn === q) score = 3;
        else if (fn.startsWith(q)) score = 2;
        else if (fn.includes(q)) score = 1;
        if (score > 0) scored.push({ code: String(f.fund_code || f.code || ''), score });
      });
      scored.sort((a, b) => b.score - a.score);
      if (scored.length) matchedCode = scored[0].code;
    }
    // 兜底：正则提取 6 位数字
    if (!matchedCode) {
      const m = trimmed.match(/\b(\d{6})\b/);
      if (m) matchedCode = m[1];
    }

    if (matchedCode && this.data.newFundCode !== matchedCode) {
      this.setData({ newFundCode: matchedCode });
      this._lookupFundByCode(matchedCode);
    } else if (!matchedCode && !this.data.newFundCode) {
      this.setData({ lookupStatus: '请输入6位代码，或在名称里包含代码也可自动识别', lookupSuccess: false });
    }
  },

  onInputFundAmount(e) {
    this.setData({ newFundAmount: e.detail.value });
  },

  onInputFundProfit(e) {
    this.setData({ newFundProfit: e.detail.value });
  },

  onInputFundCode(e) {
    const val = e.detail.value.trim();
    this.setData({ newFundCode: val });

    if (val.length === 6 && /^\d+$/.test(val)) {
      this._lookupFundByCode(val);
    } else if (val.length > 0) {
      this.setData({ lookupStatus: '请输入完整的6位数字基金代码', lookupSuccess: false });
    } else {
      this.setData({ lookupStatus: '请输入6位代码自动查询匹配', lookupSuccess: false });
    }
  },

  // 抽出：根据 6 位代码联网查基金名称 + 自动分类（被代码输入和名称输入双向触发）
  _lookupFundByCode(code) {
    this.setData({ lookupStatus: '正在联网查询对应基金...', lookupSuccess: false });

    http.get(`/api/fund/${code}`, null, { silent: true })
      .then(data => {
        if (data && data.fund) {
          const f = data.fund;
          // 后端字段是 fund_name 不是 name —— 之前用 f.name 永远取不到，导致自动回填失败
          const name = String(f.fund_name || f.name || '').trim();
          // P1：删除「分类」picker，分类由系统自动识别（assetClassOf：代码板块映射→名称关键词→其他），无需 catIdx

          // 仅在名称框为空时才回填服务器名称，避免覆盖用户手输的名称
          const currentName = (this.data.newFundName || '').trim();
          const updates = {
            lookupStatus: name
              ? `已成功匹配真实基金: ${name}`
              : '已查询，但该代码暂未返回基金名称（请手动输入）',
            lookupSuccess: Boolean(name)
          };
          if (!currentName && name) {
            updates.newFundName = name;
          }
          this.setData(updates);
        } else {
          this.setData({ lookupStatus: '查询完成，但未能解析具体数据' });
        }
      })
      .catch(err => {
        console.warn('Fund lookup failed:', err);
        this.setData({ lookupStatus: '未能在服务器找到该代码，请手动输入名称' });
      });
  },

  submitAddFund() {
    const code = this.data.newFundCode.trim();
    const name = this.data.newFundName.trim();
    const amountVal = Number(this.data.newFundAmount);
    const profitVal = Number(this.data.newFundProfit) || 0;
    // P1：系统自动识别板块/大类（代码板块映射 → 名称关键词 → 历史 category → '其他'），删除手动「分类」选择
    const category = assetClassOf({ code, name });

    if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
      wx.showToast({ title: '请输入正确的6位基金代码', icon: 'none' });
      return;
    }

    if (!name) {
      wx.showToast({ title: '请输入基金名称', icon: 'none' });
      return;
    }

    if (isNaN(amountVal) || amountVal <= 0) {
      wx.showToast({ title: '请输入有效的持有金额', icon: 'none' });
      return;
    }

    const activeAccountName = this.data.activeAccountName;
    const account = app.globalData.accounts[activeAccountName];
    if (account && account.funds && account.funds.some(f => f.code === code)) {
      wx.showToast({ title: '该账户中已存在此基金', icon: 'none' });
      return;
    }

    const totalCost = amountVal - profitVal;
    const holdingRate = totalCost > 0 ? profitVal / totalCost : 0;

    const newFund = {
      name,
      code,
      category,
      amount: amountVal,
      holdingProfit: profitVal,
      holdingRate,
      hold: holdingRate,
      today: 0,
      todayEstimate: 0,
      notes: ['手动导入'],
      holdings: [],
      transactionVersion: 2,
      transactions: [{
        type: 'buy',
        amount: amountVal,
        fee: 0,
        date: app.globalData.shanghaiToday
      }]
    };

    const success = app.addFund(activeAccountName, newFund);
    if (success) {
      wx.showToast({ title: '成功添加持仓', icon: 'success' });
      this.setData({ showAddModal: false });
      this.refreshData();
    } else {
      wx.showToast({ title: '添加失败，请重试', icon: 'none' });
    }
  }
});
