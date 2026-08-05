// pages/fund/fund.js
import { http } from '../../utils/request.js';
const app = getApp();

Page({
  data: {
    code: '',
    fund: {},
    accountWeightStr: '0.00%',
    majorHoldings: [],
    transactions: [],
    
    // Performance metrics
    perf: {
      month1: 0, month1Str: '—',
      month3: 0, month3Str: '—',
      month6: 0, month6Str: '—',
      yearYtd: 0, yearYtdStr: '—'
    },

    // Charts ranges
    ranges: [
      { key: '1m', label: '1月', days: 31 },
      { key: '3m', label: '3月', days: 93 },
      { key: '6m', label: '6月', days: 186 },
      { key: '1y', label: '1年', days: 366 },
      { key: 'ytd', label: '今年', days: 0 },
      { key: 'all', label: '全部', days: 9999 }
    ],
    activeRange: '1y',
    isLoadingChart: true,
    chartMinMaxStr: '',

    // Tabs
    activeTab: 'holdings',

    // Edit Position Modals
    showEditModal: false,
    editAmount: '',
    editProfit: '',
    newTxType: 'buy',
    newTxAmount: '',
    newTxDate: '',

    // Shared fetched server data
    serverHistory: []
  },

  canvas: null,
  ctx: null,

  onLoad(options) {
    const code = options.code;
    if (!code) {
      wx.showToast({ title: '参数错误', icon: 'error' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    this.setData({
      code,
      newTxDate: app.globalData.shanghaiToday
    });

    this.loadFundLocalDetails();
    this.fetchFundServerDetails();
  },

  onReady() {
    // We will initialize canvas sizing onReady and once data loads
  },

  loadFundLocalDetails() {
    const code = this.data.code;
    const account = app.getActiveAccount();
    const funds = account.funds || [];
    const fund = funds.find(f => f.code === code);

    if (!fund) {
      wx.showToast({ title: '持仓未找到', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    // Calculate position weight in current account
    const totalAssets = funds.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const amt = Number(fund.amount) || 0;
    const profit = Number(fund.holdingProfit) || 0;
    const todayPct = Number(fund.today) || 0;
    const todayProfitVal = amt * todayPct;
    const holdRate = Number(fund.holdingRate) || Number(fund.hold) || 0;

    const formattedFund = {
      ...fund,
      amountStr: `¥${Math.round(amt).toLocaleString('zh-CN')}`,
      holdingProfitStr: `${profit >= 0 ? '+' : '-'}¥${Math.abs(Math.round(profit)).toLocaleString('zh-CN')}`,
      holdingRateStr: `${holdRate >= 0 ? '+' : ''}${(holdRate * 100).toFixed(2)}%`,
      todayProfit: todayProfitVal,
      todayProfitStr: `${todayProfitVal >= 0 ? '+' : '-'}¥${Math.abs(Math.round(todayProfitVal)).toLocaleString('zh-CN')}`,
      todayProfitPctStr: `${todayPct >= 0 ? '+' : ''}${(todayPct * 100).toFixed(2)}%`
    };

    // Format Transactions
    const formattedTxs = (fund.transactions || []).map(tx => ({
      ...tx,
      typeStr: tx.type === 'buy' ? '买入' : '卖出',
      amountStr: `¥${Number(tx.amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
    })).reverse(); // show latest first

    this.setData({
      fund: formattedFund,
      transactions: formattedTxs,
      accountWeightStr: totalAssets > 0 ? `${((amt / totalAssets) * 100).toFixed(2)}%` : '0.00%',
      editAmount: String(fund.amount),
      editProfit: String(fund.holdingProfit)
    });
  },

  fetchFundServerDetails() {
    const code = this.data.code;
    this.setData({ isLoadingChart: true });

    // Query server backend /api/fund/:code for history and stock weightings!
    http.get(`/api/fund/${code}?refresh=1`, null, { silent: true })
      .then(res => {
        this.setData({ isLoadingChart: false });
        if (res && res.fund) {
          const sHistory = res.history || [];
          
          // Render major holdings
          const holdingsRaw = res.fund.holdings || [];
          const majorHoldings = holdingsRaw.map(h => ({
            ...h,
            weightPctStr: `${((Number(h.weight) || 0) * 100).toFixed(2)}%`
          }));

          this.setData({
            serverHistory: sHistory,
            majorHoldings
          }, () => {
            this.calculatePerformanceMetrics(sHistory);
            this.renderCanvasChart();
          });
        }
      })
      .catch(err => {
        console.warn('Failed to load fund server details:', err);
        this.setData({ isLoadingChart: false });
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
    const ytd = calculateReturn(ytdDays());

    const formatRate = (val) => {
      if (val === null) return '—';
      return `${val >= 0 ? '+' : ''}${(val * 100).toFixed(2)}%`;
    };

    this.setData({
      perf: {
        month1: m1, month1Str: formatRate(m1),
        month3: m3, month3Str: formatRate(m3),
        month6: m6, month6Str: formatRate(m6),
        yearYtd: ytd, yearYtdStr: formatRate(ytd)
      }
    });
  },

  onTabSelect(e) {
    this.setData({
      activeTab: e.currentTarget.dataset.tab
    });
  },

  onRangeSelect(e) {
    const activeRange = e.currentTarget.dataset.range;
    this.setData({ activeRange }, () => {
      this.renderCanvasChart();
    });
  },

  // Premium Vector Line Chart Renderer inside WeChat Mini-Program!
  renderCanvasChart() {
    const history = this.data.serverHistory;
    if (!history || history.length < 2) return;

    // Filter history based on range key
    const rangeKey = this.data.activeRange;
    const rangeObj = this.data.ranges.find(r => r.key === rangeKey) || this.data.ranges[3];
    
    let segment = [];
    const latest = history[history.length - 1];
    const latestTime = new Date(`${latest.date}T00:00:00`).getTime();

    if (rangeKey === 'all') {
      segment = [...history];
    } else if (rangeKey === 'ytd') {
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
    
    // Update chart status labels
    const pctChange = segment[0] && segment[segment.length - 1] ? ((segment[segment.length - 1].nav - segment[0].nav) / segment[0].nav) * 100 : 0;
    this.setData({
      chartMinMaxStr: `${segment[0].date} ~ ${segment[segment.length - 1].date} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%)`
    });

    // Draw using Canvas 2D
    const query = wx.createSelectorQuery();
    query.select('#chartCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio;

        const width = res[0].width;
        const height = res[0].height;

        // Scale resolution for Retina sharp drawing
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        // Styling configuration
        ctx.clearRect(0, 0, width, height);
        
        const paddingLeft = 12;
        const paddingRight = 12;
        const paddingTop = 12;
        const paddingBottom = 12;

        const plotW = width - paddingLeft - paddingRight;
        const plotH = height - paddingTop - paddingBottom;
        const valRange = maxVal - minVal || 1;

        // Coordinate conversion helper
        const getX = (index) => paddingLeft + (index / (segment.length - 1)) * plotW;
        const getY = (nav) => paddingTop + ((maxVal - nav) / valRange) * plotH;

        // 1. Draw gradient fill under the line
        const gradient = ctx.createLinearGradient(0, paddingTop, 0, height);
        gradient.addColorStop(0, 'rgba(10, 132, 255, 0.22)');
        gradient.addColorStop(1, 'rgba(10, 132, 255, 0.0)');

        ctx.beginPath();
        ctx.moveTo(getX(0), height);
        segment.forEach((item, index) => {
          ctx.lineTo(getX(index), getY(Number(item.nav)));
        });
        ctx.lineTo(getX(segment.length - 1), height);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // 2. Draw the solid blue vector curve line
        ctx.beginPath();
        segment.forEach((item, index) => {
          if (index === 0) {
            ctx.moveTo(getX(index), getY(Number(item.nav)));
          } else {
            ctx.lineTo(getX(index), getY(Number(item.nav)));
          }
        });
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // 3. Draw end-point circle highlight
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

        // Save reference
        this.canvas = canvas;
        this.ctx = ctx;
      });
  },

  // Modal handlers
  showEditModal() {
    const fund = this.data.fund;
    this.setData({
      showEditModal: true,
      editAmount: String(fund.amount),
      editProfit: String(fund.holdingProfit),
      newTxType: 'buy',
      newTxAmount: '',
      newTxDate: app.globalData.shanghaiToday
    });
  },

  hideEditModal() {
    this.setData({
      showEditModal: false
    });
  },

  preventBubble() {},

  onInputEditAmount(e) {
    this.setData({ editAmount: e.detail.value });
  },

  onInputEditProfit(e) {
    this.setData({ editProfit: e.detail.value });
  },

  onSelectTxType(e) {
    this.setData({
      newTxType: e.currentTarget.dataset.type
    });
  },

  onInputNewTxAmount(e) {
    this.setData({ newTxAmount: e.detail.value });
  },

  onTxDateChange(e) {
    this.setData({
      newTxDate: e.detail.value
    });
  },

  submitEditHolding() {
    const code = this.data.code;
    const activeAccountName = app.globalData.activeAccountName;
    const accounts = app.globalData.accounts;
    const account = accounts[activeAccountName];

    if (!account) return;

    let baseAmount = Number(this.data.editAmount);
    let baseProfit = Number(this.data.editProfit) || 0;

    if (isNaN(baseAmount) || baseAmount < 0) {
      wx.showToast({ title: '持有金额输入不正确', icon: 'none' });
      return;
    }

    // Process optional transaction entry
    const txAmt = Number(this.data.newTxAmount) || 0;
    const txType = this.data.newTxType;
    const txDate = this.data.newTxDate;

    if (this.data.newTxAmount && (isNaN(txAmt) || txAmt <= 0)) {
      wx.showToast({ title: '交易金额输入不正确', icon: 'none' });
      return;
    }

    // Find local object reference in parent collections
    const fIdx = account.funds.findIndex(f => f.code === code);
    if (fIdx === -1) return;

    const fund = account.funds[fIdx];

    // Initialize ledger array
    if (!fund.transactions) fund.transactions = [];

    // Apply incremental transaction adjustments
    if (txAmt > 0) {
      fund.transactions.push({
        type: txType,
        amount: txAmt,
        fee: 0,
        date: txDate
      });

      if (txType === 'buy') {
        baseAmount += txAmt;
      } else {
        baseAmount = Math.max(0, baseAmount - txAmt);
      }
    }

    // Apply general manual adjustments
    fund.amount = baseAmount;
    fund.holdingProfit = baseProfit;
    
    const totalCost = baseAmount - baseProfit;
    fund.holdingRate = totalCost > 0 ? baseProfit / totalCost : 0;
    fund.hold = fund.holdingRate;

    // Persist
    app.saveState();
    wx.showToast({ title: '已成功保存持仓修改', icon: 'success' });
    this.setData({ showEditModal: false });

    // Reload page details
    this.loadFundLocalDetails();
  },

  deletePosition() {
    const code = this.data.code;
    const activeAccountName = app.globalData.activeAccountName;

    wx.showModal({
      title: '删除确认',
      content: '确定要将该基金持仓移出当前账户吗？对应历史交易账单明细也将被清除。',
      confirmText: '确认删除',
      confirmColor: '#ff453a',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          app.deleteFund(activeAccountName, code);
          wx.showToast({ title: '持仓已移出' });
          this.setData({ showEditModal: false });
          setTimeout(() => {
            wx.navigateBack();
          }, 800);
        }
      }
    });
  }
});
