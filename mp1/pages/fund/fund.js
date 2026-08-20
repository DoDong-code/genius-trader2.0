// pages/fund/fund.js
// 基金详情页（深链入口）：仅负责顶部导航与接收 code，详情 UI 由 fundDetail 组件承载。
const app = getApp();

Page({
  data: {
    code: '',
    statusBarHeight: 20,
    navBarHeight: 44
  },

  onLoad(options) {
    const code = options.code;
    if (!code) {
      wx.showToast({ title: '参数错误', icon: 'error' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.setData({
      code,
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });
  },

  onBackClick() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  }
});
