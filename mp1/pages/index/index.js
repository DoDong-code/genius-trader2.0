// pages/index/index.js
const app = getApp();
import { http } from '../../utils/request.js';
import { pct } from '../../utils/format.js';

Page({
  data: {
    accountList: [],
    activeAccountName: '',

    // Account segmented tabs (matches Web: 全部 + root accounts)
    accountTabs: ['全部'],
    selectedAccountTab: 'all',

    // Today's advice module
    todayAdviceSummary: '',
    todayAdviceUpdated: '',

    // Dynamic Topbar sizes
    statusBarHeight: 20,
    navBarHeight: 44,

    // Market Indices
    marketIndices: [],
    // 行情模块折叠状态（纯 UI 展示，不影响接口/数据/刷新逻辑）
    marketCollapsed: true,
    // 折叠态轮播（纯 UI 展示）：折叠时两个卡片循环轮播，每 1s 前进一个起点
    marketCarouselIdx: 0,
    marketCollapsedItems: [],
    
    // Total aggregate metrics
    totalAssetsStr: '¥0',
    todayProfit: 0,
    todayProfitStr: '¥0.00',
    todayProfitPctStr: '0.00%',
    
    totalProfit: 0,
    totalProfitStr: '¥0',
    totalProfitPctStr: '0.00%',

    // Ticking Status Clock
    timeStr: '00:00:00',
    dateStr: '2026-08-05',
    dataUpdatedText: '',

    // Editing states
    isEditing: false,
    selectedAccounts: {},
    hasSelections: false,
    selectedCount: 0,

    // Modal states
    showAddModal: false,
    newAccountName: '',
    authUser: null  // 正式登录用户 { id, email }；null = 游客模式
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });
    this.initClock();
    this.fetchMarketIndices();
  },

  onUnload() {
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
    }
    this.stopMarketCarousel();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().highlight('/pages/index/index');
    }
    const au = (app.globalData.auth && app.globalData.auth.user) || null;
    this.setData({ authUser: au });
    // ═══ 临时调试：登录后首页实际状态（诊断后删除）═══
    console.log('[Login-Debug] index onShow | authUser_id =', au ? au.id : null, '| authState =', app.globalData.authState, '| accounts keys =', Object.keys(app.globalData.accounts || {}).length, '| active =', app.globalData.activeAccountName);
    this.refreshData();
    this.updateClock();
    this.fetchMarketIndices();
    // 返回首页时若处于折叠态，恢复轮播（纯 UI）
    if (this.data.marketCollapsed) this.startMarketCarousel();
  },

  onHide() {
    // 离开页面（如切到其它 tab）时暂停轮播，避免无效计时
    this.stopMarketCarousel();
  },

  // 登录 / 注册入口（未登录）
  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  // 进入账号中心（已登录）
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onHide() {
    // Keep it clean
  },

  onPullDownRefresh() {
    this.refreshData();
    setTimeout(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '刷新成功', icon: 'success' });
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
    // Compute Shanghai Time (UTC+8) to match database constraints
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
      dateStr: `${y}-${m}-${d}`,
      dataUpdatedText: app.getDataUpdatedText() || ''
    });
  },

  fetchMarketIndices() {
    // 固定展示这 8 个指数的顺序（一排两个、四排）
    const INDEX_ORDER = ['上证指数', '沪深300', '深证成指', '科创50', '恒生科技', '创业板指', '纳斯达克', '标普500'];
    const FALLBACK_INDICES = [
      { name: '上证指数', value: '3,254.21', change: '+0.45%', profit: 1 },
      { name: '沪深300', value: '3,987.65', change: '+0.32%', profit: 1 },
      { name: '深证成指', value: '10,342.12', change: '-0.12%', profit: 0 },
      { name: '科创50', value: '1,012.34', change: '+0.88%', profit: 1 },
      { name: '恒生科技', value: '4,521.09', change: '-1.05%', profit: 0 },
      { name: '创业板指', value: '2,110.45', change: '+1.20%', profit: 1 },
      { name: '纳斯达克', value: '17,890.23', change: '+0.56%', profit: 1 },
      { name: '标普500', value: '5,432.10', change: '-0.23%', profit: 0 }
    ];

    http.get('/api/market/indices', null, { silent: true })
      .then(res => {
        let list = [];
        if (res && Array.isArray(res)) {
          list = res;
        } else if (res && res.indices && Array.isArray(res.indices)) {
          list = res.indices;
        }

        // Ensure format and rate properties match WXML needs
        const formatted = list.map(idx => {
          const val = Number(idx.value || idx.price) || 0;
          const chg = Number(idx.change || idx.changePercent || idx.change_percent) || 0;
          return {
            name: idx.name,
            // P1：指数点位最多 2 位小数、不强制补 0
            value: val.toLocaleString('zh-CN', { maximumFractionDigits: 2 }),
            change: pct(chg / 100),
            profit: chg >= 0 ? 1 : 0
          };
        });

        // 按固定顺序排序并仅保留指定的 8 个指数
        const orderedMap = new Map(formatted.map(i => [i.name, i]));
        const ordered = INDEX_ORDER.map(name => orderedMap.get(name)).filter(Boolean);

        // 接口返回空或没有命中目标指数时，使用兜底数据，确保预览始终可见
        this.setData({ marketIndices: ordered.length ? ordered : FALLBACK_INDICES }, () => {
          if (this.data.marketCollapsed) this.recomputeCollapsedItems();
        });

        // 行情刷新成功，记录数据新鲜度
        app.setDataUpdatedAt();
        this.setData({ dataUpdatedText: app.getDataUpdatedText() || '' });
      })
      .catch(err => {
        console.warn('Indices request failed, using high-quality fallback:', err);
        this.setData({ marketIndices: FALLBACK_INDICES }, () => {
          if (this.data.marketCollapsed) this.recomputeCollapsedItems();
        });
      });
  },

  onRefreshClick() {
    wx.showLoading({ title: '正在联网更新估值...' });
    this.fetchMarketIndices();
    setTimeout(() => {
      this.refreshData();
      wx.hideLoading();
      wx.showToast({ title: '更新成功', icon: 'success' });
    }, 600);
  },

  refreshData() {
    const accounts = app.globalData.accounts || {};
    let activeAccountName = app.globalData.activeAccountName;
    if (!activeAccountName || !accounts[activeAccountName]) {
      const firstValid = Object.keys(accounts)[0] || '主账户';
      app.setActiveAccount(firstValid);
      activeAccountName = firstValid;
    }

    // Build the account segmented tab list (root accounts only, matches Web)
    // Use {key, label} so '全部' (label) and 'all' (key) don't collide.
    const rootAccounts = Object.keys(accounts).filter(name => {
      const acc = accounts[name];
      return !acc || !acc.parent;
    });
    const accountTabs = [
      { key: 'all', label: '全部' },
      ...rootAccounts.map(name => ({ key: name, label: name }))
    ];

    // Keep selected tab valid; fall back to active account or 全部
    let selectedAccountTab = this.data.selectedAccountTab;
    if (!selectedAccountTab || (selectedAccountTab !== 'all' && !accounts[selectedAccountTab])) {
      selectedAccountTab = accounts[activeAccountName] ? activeAccountName : 'all';
    }

    // Build the aggregate accounts selection list (root accounts only, with children = sub-accounts)
    // While building, also compute overall aggregates across all root accounts (for the "全部" tab).
    let allTotalAssets = 0;
    let allTodayProfit = 0;
    let allTotalProfit = 0;

    const accountList = Object.keys(accounts).filter(name => {
      const acctObj = accounts[name];
      return !acctObj || !acctObj.parent;
    }).map(key => {
      const acctObj = accounts[key];
      const acctFunds = acctObj.funds || [];
      let acctTotal = 0;
      let acctTodayProfit = 0;
      let acctTotalProfit = 0;

      acctFunds.forEach(f => {
        const amt = Number(f.amount) || 0;
        const todayPct = Number(f.today) || 0;
        const profitVal = Number(f.holdingProfit) || 0;
        acctTotal += amt;
        acctTodayProfit += amt * todayPct;
        acctTotalProfit += profitVal;
      });

      // Effective total includes children funds (matches Web effFunds)
      const children = (acctObj.children || []).map(n => accounts[n]).filter(Boolean);
      let effTotal = acctTotal;
      let effTodayProfit = acctTodayProfit;
      let effTotalProfit = acctTotalProfit;
      children.forEach(c => {
        (c.funds || []).forEach(f => {
          const amt = Number(f.amount) || 0;
          effTotal += amt;
          effTodayProfit += amt * (Number(f.today) || 0);
          effTotalProfit += Number(f.holdingProfit) || 0;
        });
      });

      allTotalAssets += effTotal;
      allTodayProfit += effTodayProfit;
      allTotalProfit += effTotalProfit;

      return {
        name: key,
        // 同步标识：第三方（养基宝/小倍）导入的账户标记 sync，账户管理列表显示「同步」徽章
        isSync: Boolean(acctObj.accountType === 'sync' || acctObj.syncSource || acctObj.__source),
        count: acctFunds.length,
        totalAssets: effTotal,
        totalStr: `¥${Math.round(effTotal).toLocaleString('zh-CN')}`,
        todayProfit: effTodayProfit,
        todayProfitStr: `${effTodayProfit >= 0 ? '+' : ''}¥${Math.round(effTodayProfit).toLocaleString('zh-CN')}`,
        children: children.map(c => ({
          name: c.name,
          count: (c.funds || []).length,
          totalStr: `¥${Math.round((c.funds || []).reduce((s, f) => s + (Number(f.amount) || 0), 0)).toLocaleString('zh-CN')}`,
          todayProfitStr: `${((c.funds || []).reduce((s, f) => s + (Number(f.amount) || 0) * (Number(f.today) || 0), 0) >= 0 ? '+' : '')}¥${Math.round((c.funds || []).reduce((s, f) => s + (Number(f.amount) || 0) * (Number(f.today) || 0), 0)).toLocaleString('zh-CN')}`
        }))
      };
    });

    // Calculate overall statistics for the selected tab.
    // "全部" shows the aggregate of all root accounts; specific tabs show the active account.
    let totalAssets = 0;
    let todayProfit = 0;
    let totalProfit = 0;

    if (selectedAccountTab === 'all') {
      totalAssets = allTotalAssets;
      todayProfit = allTodayProfit;
      totalProfit = allTotalProfit;
    } else {
      const activeAccount = accounts[selectedAccountTab] || { name: selectedAccountTab, funds: [] };
      const funds = activeAccount.funds || [];

      funds.forEach(f => {
        const amt = Number(f.amount) || 0;
        const todayPct = Number(f.today) || 0;
        const profitVal = Number(f.holdingProfit) || 0;

        totalAssets += amt;
        todayProfit += amt * todayPct;
        totalProfit += profitVal;
      });
    }

    const totalCost = totalAssets - totalProfit;
    const totalProfitPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const todayProfitPct = totalAssets > 0 ? (todayProfit / totalAssets) * 100 : 0;

    const summaryAccountName = selectedAccountTab === 'all' ? '全部账户' : selectedAccountTab;

    // Today's advice summary (cached AI result for the active account)
    let todayAdviceSummary = '';
    try {
      const cached = wx.getStorageSync('LAST_AI_ANALYSIS_' + activeAccountName) ||
                     wx.getStorageSync('LAST_AI_ANALYSIS');
      if (cached && typeof cached === 'object' && cached.summary) {
        todayAdviceSummary = cached.summary;
      }
    } catch (e) { /* ignore */ }

    const todayKey = app.globalData.shanghaiToday;
    const todayAdviceUpdated = wx.getStorageSync('TODAY_ADVICE_AUTO_UPDATED_TIME_' + todayKey) || '';

    this.setData({
      activeAccountName,
      accountTabs,
      selectedAccountTab,
      accountList,
      todayAdviceSummary,
      todayAdviceUpdated,
      summaryAccountName,
      totalAssetsStr: `¥${Math.round(totalAssets).toLocaleString('zh-CN')}`,
      todayProfit,
      todayProfitStr: `${todayProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfit)).toLocaleString('zh-CN')}`,
      todayProfitPctStr: pct(todayProfitPct / 100),
      totalProfit,
      totalProfitStr: `${totalProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(totalProfit)).toLocaleString('zh-CN')}`,
      totalProfitPctStr: pct(totalProfitPct / 100)
    });
  },

  // Account segmented tab selection (matches Web behavior)
  onAccountTabSelect(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab) return;
    this.setData({ selectedAccountTab: tab });
    // 切到非「全部」Tab 时行情模块被隐藏，暂停轮播（纯 UI）
    if (tab !== 'all') this.stopMarketCarousel();
    if (tab !== 'all' && app.globalData.accounts[tab]) {
      app.setActiveAccount(tab);
    }
    this.refreshData();
  },

  goAnalysis() {
    wx.switchTab({
      url: '/pages/analysis/analysis'
    });
  },

  // 行情模块折叠/展开（纯 UI 状态切换，不触发任何数据请求或计算）
  // 双击行情模块切换折叠/展开（纯 UI 状态，不影响接口/数据/刷新逻辑）
  onMarketDoubleTap() {
    const now = Date.now();
    if (this._lastMarketTap && now - this._lastMarketTap < 300) {
      this._lastMarketTap = 0;
      const collapsed = !this.data.marketCollapsed;
      this.setData({ marketCollapsed: collapsed });
      if (collapsed) {
        this.startMarketCarousel();
      } else {
        this.stopMarketCarousel();
      }
    } else {
      this._lastMarketTap = now;
    }
  },

  // 折叠态：根据当前轮播起点取连续 2 个指数（超出末尾循环回开头），纯展示计算
  recomputeCollapsedItems() {
    const list = this.data.marketIndices || [];
    const len = list.length;
    if (len === 0) {
      if (this.data.marketCollapsedItems.length) this.setData({ marketCollapsedItems: [] });
      return;
    }
    if (len <= 2) {
      // 不足 2 个无需轮播，直接全展示
      if (this.data.marketCollapsedItems.length !== len) this.setData({ marketCollapsedItems: list });
      return;
    }
    const start = ((this.data.marketCarouselIdx % len) + len) % len;
    const next = (start + 1) % len;
    this.setData({ marketCollapsedItems: [list[start], list[next]] });
  },

  // 启动折叠轮播：每 1s 推进一次起点，纯 UI 状态，不触发接口/计算/刷新
  startMarketCarousel() {
    this.stopMarketCarousel();
    this.recomputeCollapsedItems();
    if ((this.data.marketIndices || []).length <= 2) return;
    this._marketCarouselTimer = setInterval(() => {
      const len = (this.data.marketIndices || []).length;
      if (len <= 2) return;
      const idx = (((this.data.marketCarouselIdx % len) + len) % len + 1) % len;
      this.setData({ marketCarouselIdx: idx });
      this.recomputeCollapsedItems();
    }, 3000);
  },

  // 停止折叠轮播
  stopMarketCarousel() {
    if (this._marketCarouselTimer) {
      clearInterval(this._marketCarouselTimer);
      this._marketCarouselTimer = null;
    }
  },

  navigateToPortfolio() {
    wx.switchTab({
      url: '/pages/portfolio/portfolio'
    });
  },

  toggleEdit() {
    this.setData({
      isEditing: !this.data.isEditing,
      selectedAccounts: {},
      hasSelections: false,
      selectedCount: 0
    });
  },

  onAccountClick(e) {
    const name = e.currentTarget.dataset.name;
    if (this.data.isEditing) {
      this.toggleSelection(name);
      return;
    }
    
    app.setActiveAccount(name);
    this.setData({ activeAccountName: name });
    this.refreshData();

    wx.showToast({
      title: `已切换至 ${name}`,
      icon: 'none',
      duration: 1000
    });
  },

  onCheckboxClick(e) {
    const name = e.currentTarget.dataset.name;
    this.toggleSelection(name);
  },

  toggleSelection(name) {
    const selectedAccounts = { ...this.data.selectedAccounts };
    selectedAccounts[name] = !selectedAccounts[name];

    const selectedKeys = Object.keys(selectedAccounts).filter(k => selectedAccounts[k]);
    
    this.setData({
      selectedAccounts,
      hasSelections: selectedKeys.length > 0,
      selectedCount: selectedKeys.length
    });
  },

  deleteSelected() {
    const toDelete = Object.keys(this.data.selectedAccounts).filter(k => this.data.selectedAccounts[k]);
    if (!toDelete.length) return;

    wx.showModal({
      title: '删除确认',
      content: `确定要删除这 ${toDelete.length} 个交易账户吗？该操作不可撤销，且会清除账户下的所有基金持仓。`,
      confirmText: '确认删除',
      confirmColor: '#ff3b30',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...', mask: true });
          for (const name of toDelete) {
            await app.deleteAccount(name);
          }
          wx.hideLoading();
          wx.showToast({ title: '已成功删除账户' });
          this.setData({ isEditing: false, selectedAccounts: {}, hasSelections: false, selectedCount: 0 });
          this.refreshData();
        }
      }
    });
  },

  // 编辑态下：为某父账户新建子账户
  onAddSubAccount(e) {
    const parentName = e.currentTarget.dataset.parent;
    wx.showModal({
      title: '新建子账户',
      editable: true,
      placeholderText: '例如：半导体、黄金、债券',
      success: (res) => {
        if (res.confirm && res.content && res.content.trim()) {
          const ok = app.addSubAccount(parentName, res.content.trim());
          if (ok) {
            wx.showToast({ title: '已创建子账户', icon: 'success' });
            this.refreshData();
          } else {
            wx.showToast({ title: '账户名已存在', icon: 'none' });
          }
        }
      }
    });
  },

  // 编辑态下：按板块拆分父账户持仓为子账户
  onSplitBySector(e) {
    const parentName = e.currentTarget.dataset.parent;
    wx.showModal({
      title: '按板块拆分',
      content: `将把「${parentName}」的持仓按板块拆分为子账户，父账户只保留汇总。是否继续？`,
      confirmText: '开始拆分',
      success: (res) => {
        if (res.confirm) {
          const n = app.splitAccountBySector(parentName);
          wx.showToast({ title: `已拆分为 ${n} 个子账户`, icon: 'none' });
          this.refreshData();
        }
      }
    });
  },

  // 编辑态下：删除子账户（持仓合并回父账户）
  onDeleteSubAccount(e) {
    const childName = e.currentTarget.dataset.child;
    const parentName = e.currentTarget.dataset.parent;
    wx.showModal({
      title: '删除子账户',
      content: `确定删除子账户「${childName}」？其持仓将合并回父账户「${parentName}」，父级总资产不变。`,
      confirmText: '删除',
      confirmColor: '#ff3b30',
      success: async (res) => {
        if (res.confirm) {
          await app.deleteSubAccount(childName);
          wx.showToast({ title: '已删除子账户', icon: 'none' });
          this.refreshData();
        }
      }
    });
  },

  // 编辑态下：把选中的多个账户合并移动到目标账户
  onMoveAccounts() {
    const sources = Object.keys(this.data.selectedAccounts).filter(k => this.data.selectedAccounts[k]);
    if (!sources.length) return;
    const targetOptions = Object.keys(app.globalData.accounts).filter(n => !sources.includes(n));
    if (!targetOptions.length) {
      wx.showToast({ title: '没有可移动的目标账户', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: targetOptions,
      success: (resSheet) => {
        const target = targetOptions[resSheet.tapIndex];
        // 涉及同步账户时提示将解除同步（对齐 Web：移动同步账户 → convertAccountToLocal）
        const hasSync = sources.concat([target]).some(name => {
          const acc = app.globalData.accounts[name];
          return acc && app.isSyncAccount(acc);
        });
        const syncTip = hasSync ? '其中含第三方同步账户，移动后将解除同步、转为本地管理账户（不再自动同步）。' : '';
        wx.showModal({
          title: '移动账户',
          content: `将把选中的 ${sources.length} 个账户持仓合并到「${target}」，并删除原账户？${syncTip}`,
          confirmText: '确认移动',
          success: (res) => {
            if (res.confirm) {
              app.moveAccounts(sources, target, false);
              this.setData({ isEditing: false, selectedAccounts: {}, hasSelections: false, selectedCount: 0 });
              wx.showToast({ title: '已移动账户', icon: 'none' });
              this.refreshData();
            }
          }
        });
      }
    });
  },

  // 编辑态下：修改账户名称（同步账户改名 → 转本地，对齐 Web convertAccountToLocal）
  onRenameAccount(e) {
    const oldName = e.currentTarget.dataset.name;
    if (!oldName) return;
    wx.showModal({
      title: '修改账户名称',
      editable: true,
      content: oldName,
      placeholderText: '输入新账户名',
      success: (res) => {
        if (res.confirm && res.content && res.content.trim() && res.content.trim() !== oldName) {
          const newName = res.content.trim();
          const isSync = app.isSyncAccount(app.globalData.accounts[oldName]);
          const ok = app.renameAccount(oldName, newName);
          if (ok) {
            wx.showToast({ title: isSync ? '已改名并解除同步' : '已重命名', icon: 'success' });
            this.refreshData();
          } else {
            wx.showToast({ title: '重命名失败（名称已存在）', icon: 'none' });
          }
        }
      }
    });
  },

  showAddModal() {
    this.setData({
      showAddModal: true,
      newAccountName: ''
    });
  },

  hideAddModal() {
    this.setData({
      showAddModal: false,
      newAccountName: ''
    });
  },

  preventBubble() {
    // Helper to catch events and prevent modal close
  },

  onInputAccountName(e) {
    this.setData({
      newAccountName: e.detail.value
    });
  },

  submitAddAccount() {
    const name = this.data.newAccountName.trim();
    if (!name) {
      wx.showToast({ title: '请输入有效的账户名称', icon: 'none' });
      return;
    }

    if (app.globalData.accounts[name]) {
      wx.showToast({ title: '账户名称已存在', icon: 'none' });
      return;
    }

    const success = app.addAccount(name);
    if (success) {
      wx.showToast({ title: '创建成功', icon: 'success' });
      this.setData({ showAddModal: false, newAccountName: '' });
      this.refreshData();
    } else {
      wx.showToast({ title: '创建失败', icon: 'none' });
    }
  }
});
