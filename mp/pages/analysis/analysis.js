// pages/analysis/analysis.js
const app = getApp();

Page({
  data: {
    activeAccountName: '',
    allocations: [],
    strategy: [],
    closedPositions: []
  },

  onShow() {
    this.refreshData();
  },

  onPullDownRefresh() {
    this.refreshData();
    setTimeout(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '诊断更新成功', icon: 'success' });
    }, 800);
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    const funds = account.funds || [];

    // 1. Calculate Aggregate Allocation by Category
    const categoryTotals = {};
    let totalAssets = 0;

    funds.forEach(f => {
      const amt = Number(f.amount) || 0;
      const cat = f.category || '其他';
      
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;
      totalAssets += amt;
    });

    // Color definitions matching assets mood
    const colorMap = {
      '权益类': '#ff453a', // Growth Red
      '黄金类': '#ffd60a', // Safeguard Gold
      '债券类': '#30d158', // Stable Green
      '海外类': '#0a84ff', // Diversify Blue
      '其他': '#bf5af2'   // Complex Purple
    };

    // Construct Allocations Array
    const allocations = Object.keys(categoryTotals).map(cat => {
      const amt = categoryTotals[cat];
      const pct = totalAssets > 0 ? (amt / totalAssets) * 100 : 0;

      return {
        category: cat,
        amount: amt,
        amountStr: `¥${Math.round(amt).toLocaleString('zh-CN')}`,
        pct,
        pctStr: `${pct.toFixed(2)}%`,
        color: colorMap[cat] || colorMap['其他']
      };
    }).sort((a, b) => b.amount - a.amount); // Sort high allocation to low

    this.setData({
      activeAccountName,
      allocations,
      strategy: account.strategy || [],
      closedPositions: account.closedPositions || []
    });
  }
});
