// pages/index/index.js
const app = getApp();

Page({
  data: {
    accountList: [],
    activeAccountName: '',
    
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

    // Editing states
    isEditing: false,
    selectedAccounts: {},
    hasSelections: false,
    selectedCount: 0,

    // Modal states
    showAddModal: false,
    newAccountName: ''
  },

  onLoad() {
    this.initClock();
  },

  onUnload() {
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
    }
  },

  onShow() {
    this.refreshData();
    // Also trigger immediate clock update
    this.updateClock();
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
      dateStr: `${y}-${m}-${d}`
    });
  },

  onRefreshClick() {
    wx.showLoading({ title: '正在联网更新估值...' });
    setTimeout(() => {
      this.refreshData();
      wx.hideLoading();
      wx.showToast({ title: '更新成功', icon: 'success' });
    }, 600);
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const accounts = app.globalData.accounts;

    // Calculate overall statistics for the ACTIVE account
    const activeAccount = accounts[activeAccountName] || { name: activeAccountName, funds: [] };
    const funds = activeAccount.funds || [];

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

    // Build the aggregate accounts selection list
    const accountList = Object.keys(accounts).map(key => {
      const acctObj = accounts[key];
      const acctFunds = acctObj.funds || [];
      let acctTotal = 0;
      let acctTodayProfit = 0;

      acctFunds.forEach(f => {
        const amt = Number(f.amount) || 0;
        const todayPct = Number(f.today) || 0;
        acctTotal += amt;
        acctTodayProfit += amt * todayPct;
      });

      return {
        name: key,
        count: acctFunds.length,
        totalAssets: acctTotal,
        totalStr: `¥${Math.round(acctTotal).toLocaleString('zh-CN')}`,
        todayProfit: acctTodayProfit,
        todayProfitStr: `${acctTodayProfit >= 0 ? '+' : ''}¥${Math.round(acctTodayProfit).toLocaleString('zh-CN')}`
      };
    });

    this.setData({
      activeAccountName,
      accountList,
      totalAssetsStr: `¥${Math.round(totalAssets).toLocaleString('zh-CN')}`,
      todayProfit,
      todayProfitStr: `${todayProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfit)).toLocaleString('zh-CN')}`,
      todayProfitPctStr: `${todayProfit >= 0 ? '+' : ''}${todayProfitPct.toFixed(2)}%`,
      totalProfit,
      totalProfitStr: `${totalProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(totalProfit)).toLocaleString('zh-CN')}`,
      totalProfitPctStr: `${totalProfit >= 0 ? '+' : ''}${totalProfitPct.toFixed(2)}%`
    });
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

    // Navigate to portfolio after short delay
    setTimeout(() => {
      wx.switchTab({
        url: '/pages/portfolio/portfolio'
      });
    }, 400);
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
      success: (res) => {
        if (res.confirm) {
          toDelete.forEach(name => {
            app.deleteAccount(name);
          });
          wx.showToast({ title: '已成功删除账户' });
          this.setData({ isEditing: false, selectedAccounts: {}, hasSelections: false, selectedCount: 0 });
          this.refreshData();
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
