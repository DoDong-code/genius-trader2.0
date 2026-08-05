// pages/portfolio/portfolio.js
import { http } from '../../utils/request.js';
const app = getApp();

Page({
  data: {
    activeAccountName: '',
    totalAssetsStr: '¥0',
    todayProfit: 0,
    todayProfitStr: '¥0.00',
    todayProfitPctStr: '0.00%',

    // Ticking Status Clock
    timeStr: '00:00:00',
    dateStr: '2026-08-05',

    // Filters and sorting
    categories: ['全部', '权益类', '黄金类', '债券类', '海外类', '其他'],
    activeCategory: '全部',
    sortKey: 'holdingProfit', // Default sort key
    sortOrder: 'desc',        // Default descending
    filteredFunds: [],

    // Add Fund Modal inputs
    showAddModal: false,
    newFundCode: '',
    newFundName: '',
    newFundAmount: '',
    newFundProfit: '',
    pickerCategories: ['权益类', '黄金类', '债券类', '海外类', '其他'],
    categoryIndex: 0,
    lookupStatus: '请输入6位代码自动查询匹配',
    lookupSuccess: false
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
    // Immediate clock sync
    this.updateClock();
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
    wx.showLoading({ title: '正在同步估值...' });
    setTimeout(() => {
      this.refreshData();
      wx.hideLoading();
      wx.showToast({ title: '估值已同步', icon: 'success' });
    }, 600);
  },

  navigateToOverview() {
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    const funds = account.funds || [];

    // Calculate sum totals for the active account
    let totalAssets = 0;
    let todayProfit = 0;

    funds.forEach(f => {
      const amt = Number(f.amount) || 0;
      const todayPct = Number(f.today) || 0;
      totalAssets += amt;
      todayProfit += amt * todayPct;
    });

    const todayProfitPct = totalAssets > 0 ? (todayProfit / totalAssets) * 100 : 0;

    this.setData({
      activeAccountName,
      totalAssetsStr: `¥${Math.round(totalAssets).toLocaleString('zh-CN')}`,
      todayProfit,
      todayProfitStr: `${todayProfit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfit)).toLocaleString('zh-CN')}`,
      todayProfitPctStr: `${todayProfit >= 0 ? '+' : ''}${todayProfitPct.toFixed(2)}%`
    });

    this.filterAndSortFunds();
  },

  // Category selection click
  onCategorySelect(e) {
    const activeCategory = e.currentTarget.dataset.category;
    this.setData({ activeCategory }, () => {
      this.filterAndSortFunds();
    });
  },

  // Column header sorting click
  onSortChange(e) {
    const key = e.currentTarget.dataset.sort;
    let sortOrder = 'desc';

    if (this.data.sortKey === key) {
      sortOrder = this.data.sortOrder === 'desc' ? 'asc' : 'desc';
    }

    this.setData({
      sortKey: key,
      sortOrder
    }, () => {
      this.filterAndSortFunds();
    });
  },

  onCustomizeClick() {
    wx.showActionSheet({
      itemList: ['按持有收益降序 (高→低)', '按今日估算降序 (高→低)', '按持有金额降序 (高→低)', '按基金代码升序 (低→高)'],
      success: (res) => {
        let key = 'holdingProfit';
        let order = 'desc';
        if (res.tapIndex === 1) {
          key = 'todayProfit';
        } else if (res.tapIndex === 2) {
          key = 'amount';
        } else if (res.tapIndex === 3) {
          key = 'code';
          order = 'asc';
        }
        
        this.setData({
          sortKey: key,
          sortOrder: order
        }, () => {
          this.filterAndSortFunds();
          wx.showToast({ title: '排序规则已更新', icon: 'none' });
        });
      }
    });
  },

  filterAndSortFunds() {
    const account = app.getActiveAccount();
    let list = [...(account.funds || [])];

    // 1. Filter by category
    if (this.data.activeCategory !== '全部') {
      list = list.filter(f => f.category === this.data.activeCategory);
    }

    // 2. Sort list
    const sortKey = this.data.sortKey;
    const isAsc = this.data.sortOrder === 'asc';

    list.sort((a, b) => {
      let valA, valB;

      if (sortKey === 'code') {
        valA = a.code;
        valB = b.code;
      } else if (sortKey === 'amount') {
        valA = Number(a.amount) || 0;
        valB = Number(b.amount) || 0;
      } else if (sortKey === 'holdingProfit') {
        valA = Number(a.holdingProfit) || 0;
        valB = Number(b.holdingProfit) || 0;
      } else if (sortKey === 'todayProfit') {
        valA = (Number(a.amount) || 0) * (Number(a.today) || 0);
        valB = (Number(b.amount) || 0) * (Number(b.today) || 0);
      }

      if (valA < valB) return isAsc ? -1 : 1;
      if (valA > valB) return isAsc ? 1 : -1;
      return 0;
    });

    // 3. Format and serialize output fields for rendering
    const filteredFunds = list.map(f => {
      const amt = Number(f.amount) || 0;
      const profit = Number(f.holdingProfit) || 0;
      const todayPct = Number(f.today) || 0;
      const todayProfitVal = amt * todayPct;
      const holdRate = Number(f.holdingRate) || Number(f.hold) || 0;

      return {
        ...f,
        amountStr: `¥${Math.round(amt).toLocaleString('zh-CN')}`,
        holdingProfitStr: `${profit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(profit)).toLocaleString('zh-CN')}`,
        holdingRateStr: `${holdRate >= 0 ? '+' : ''}${(holdRate * 100).toFixed(2)}%`,
        todayProfit: todayProfitVal,
        todayProfitStr: `${todayProfitVal >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfitVal)).toLocaleString('zh-CN')}`,
        todayProfitPctStr: `${todayPct >= 0 ? '+' : ''}${(todayPct * 100).toFixed(2)}%`
      };
    });

    this.setData({ filteredFunds });
  },

  navigateToDetail(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({
      url: `/pages/fund/fund?code=${code}`
    });
  },

  // Modal Actions
  showAddModal() {
    this.setData({
      showAddModal: true,
      newFundCode: '',
      newFundName: '',
      newFundAmount: '',
      newFundProfit: '',
      categoryIndex: 0,
      lookupStatus: '请输入6位代码自动查询匹配',
      lookupSuccess: false
    });
  },

  hideAddModal() {
    this.setData({
      showAddModal: false
    });
  },

  preventBubble() {},

  onInputFundName(e) {
    this.setData({ newFundName: e.detail.value });
  },

  onInputFundAmount(e) {
    this.setData({ newFundAmount: e.detail.value });
  },

  onInputFundProfit(e) {
    this.setData({ newFundProfit: e.detail.value });
  },

  onCategoryPickerChange(e) {
    this.setData({
      categoryIndex: Number(e.detail.value)
    });
  },

  // Auto-complete querying logic when 6 digits are typed!
  onInputFundCode(e) {
    const val = e.detail.value.trim();
    this.setData({ newFundCode: val });

    if (val.length === 6 && /^\d+$/.test(val)) {
      this.setData({ lookupStatus: '正在联网查询对应基金...', lookupSuccess: false });
      
      // Call endpoint of the Genius Trader node server!
      http.get(`/api/fund/${val}`, null, { silent: true })
        .then(data => {
          if (data && data.fund) {
            const f = data.fund;
            // Guess a category based on the type
            let catIdx = 0; // 权益类
            const name = f.name || '';
            
            if (name.includes('黄金') || name.includes('金ETF')) {
              catIdx = 1; // 黄金类
            } else if (name.includes('债') || name.includes('存单') || name.includes('固收')) {
              catIdx = 2; // 债券类
            } else if (name.includes('恒生') || name.includes('标普') || name.includes('纳斯达克') || name.includes('QDII') || name.includes('海外') || name.includes('互联')) {
              catIdx = 3; // 海外类
            }

            this.setData({
              newFundName: name,
              categoryIndex: catIdx,
              lookupStatus: `已成功匹配真实基金: ${name}`,
              lookupSuccess: true
            });
          } else {
            this.setData({ lookupStatus: '查询完成，但未能解析具体数据' });
          }
        })
        .catch(err => {
          console.warn('Fund lookup failed:', err);
          this.setData({ lookupStatus: '未能在服务器找到该代码，请手动输入名称' });
        });
    } else if (val.length > 0) {
      this.setData({ lookupStatus: '请输入完整的6位数字基金代码', lookupSuccess: false });
    } else {
      this.setData({ lookupStatus: '请输入6位代码自动查询匹配', lookupSuccess: false });
    }
  },

  submitAddFund() {
    const code = this.data.newFundCode.trim();
    const name = this.data.newFundName.trim();
    const amountVal = Number(this.data.newFundAmount);
    const profitVal = Number(this.data.newFundProfit) || 0;
    const category = this.data.pickerCategories[this.data.categoryIndex];

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

    // Estimate holding profit rate
    const totalCost = amountVal - profitVal;
    const holdingRate = totalCost > 0 ? profitVal / totalCost : 0;

    // Build the fund object structure
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
      transactions: [
        {
          type: 'buy',
          amount: amountVal,
          fee: 0,
          date: app.globalData.shanghaiToday
        }
      ]
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
