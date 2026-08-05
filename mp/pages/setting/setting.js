// pages/setting/setting.js
const app = getApp();

Page({
  data: {
    activeAccountName: '',
    isLoggedIn: false,
    openid: '',
    userInfo: {},
    apiBaseUrl: '',
    useCloudDb: false,

    // Strategy
    strategy: [],
    newStrategyText: '',

    // Closed Position Form
    closedFundName: '',
    closedFundCode: '',
    closedFundReasons: ''
  },

  onShow() {
    this.refreshData();
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    
    // Retrieve server settings
    const apiBaseUrl = wx.getStorageSync('api_base_url') || 'https://ais-dev-epsmejybqglmqess2x7hc4-466561077391.us-east1.run.app';
    const useCloudDb = wx.getStorageSync('use_cloud_db') || false;

    // Retrieve user profiles
    const openid = wx.getStorageSync('user_openid') || 'mock_openid_guest';
    const userInfo = wx.getStorageSync('user_info') || {
      nickName: '未登录用户 (Guest)',
      avatarUrl: 'https://mmbiz.qpic.cn/mmbiz/icTdbqgA98eO8Z33ibA9ic2A1X3G1A8OticH8K0zK8zK8zK8zK8zK8zK8w/0'
    };
    const isLoggedIn = openid !== 'mock_openid_guest';

    this.setData({
      activeAccountName,
      strategy: account.strategy || [],
      apiBaseUrl,
      useCloudDb,
      openid,
      userInfo,
      isLoggedIn
    });
  },

  // WeChat login simulator with secure isolation openID generation
  onWechatLogin() {
    wx.showLoading({ title: '授权登录中...', mask: true });
    
    // Simulate beautiful OAuth callback
    setTimeout(() => {
      wx.hideLoading();
      
      const mockOpenId = 'openid_mp_' + Math.random().toString(36).substring(2, 10);
      const mockUser = {
        nickName: 'Genius WeChat User',
        avatarUrl: 'https://mmbiz.qpic.cn/mmbiz/icTdbqgA98eO8Z33ibA9ic2A1X3G1A8OticH8K0zK8zK8zK8zK8zK8zK8w/0'
      };

      wx.setStorageSync('user_openid', mockOpenId);
      wx.setStorageSync('user_info', mockUser);

      wx.showToast({
        title: '微信授权登录成功',
        icon: 'success'
      });

      this.refreshData();
    }, 1000);
  },

  onInputApiBase(e) {
    const val = e.detail.value.trim();
    wx.setStorageSync('api_base_url', val);
    this.setData({ apiBaseUrl: val });
  },

  onCloudDbChange(e) {
    const val = e.detail.value;
    wx.setStorageSync('use_cloud_db', val);
    this.setData({ useCloudDb: val });
    
    wx.showToast({
      title: val ? '云数据库已启用' : '已切回本地存储',
      icon: 'none'
    });
  },

  onInputNewStrategy(e) {
    this.setData({ newStrategyText: e.detail.value });
  },

  onAddStrategy() {
    const val = this.data.newStrategyText.trim();
    if (!val) return;

    const account = app.getActiveAccount();
    if (!account.strategy) account.strategy = [];
    account.strategy.push(val);

    app.saveState();
    this.setData({ newStrategyText: '' });
    this.refreshData();
    wx.showToast({ title: '已新增策略', icon: 'none' });
  },

  onDeleteStrategy(e) {
    const index = e.currentTarget.dataset.index;
    const account = app.getActiveAccount();
    if (account.strategy) {
      account.strategy.splice(index, 1);
      app.saveState();
      this.refreshData();
      wx.showToast({ title: '策略已删除', icon: 'none' });
    }
  },

  onInputClosedFundName(e) { this.setData({ closedFundName: e.detail.value }); },
  onInputClosedFundCode(e) { this.setData({ closedFundCode: e.detail.value }); },
  onInputClosedFundReasons(e) { this.setData({ closedFundReasons: e.detail.value }); },

  onSubmitClosedFund() {
    const name = this.data.closedFundName.trim();
    const code = this.data.closedFundCode.trim();
    const reasonsStr = this.data.closedFundReasons.trim();

    if (!name || !code || code.length !== 6) {
      wx.showToast({ title: '请输入正确的名称与6位代码', icon: 'none' });
      return;
    }

    const reasons = reasonsStr ? reasonsStr.split(/[,;，；]/).map(r => r.trim()).filter(Boolean) : ['调仓清算'];

    const account = app.getActiveAccount();
    if (!account.closedPositions) account.closedPositions = [];

    account.closedPositions.push({
      name,
      code,
      closedBefore: app.globalData.shanghaiToday,
      reason: reasons
    });

    app.saveState();
    
    this.setData({
      closedFundName: '',
      closedFundCode: '',
      closedFundReasons: ''
    });

    wx.showToast({
      title: '清仓记录已归档',
      icon: 'success'
    });

    this.refreshData();
  },

  // Export positions backup to Clipboard!
  onCopyBackup() {
    const backupObj = {
      accounts: app.globalData.accounts,
      active: app.globalData.activeAccountName
    };
    const str = JSON.stringify(backupObj, null, 2);

    wx.setClipboardData({
      data: str,
      success: () => {
        wx.showToast({
          title: '备份 JSON 已复制',
          icon: 'success'
        });
      }
    });
  },

  // Import positions backup from Clipboard dynamically!
  onImportBackup() {
    wx.getClipboardData({
      success: (clipRes) => {
        const str = clipRes.data ? clipRes.data.trim() : '';
        if (!str || !str.startsWith('{')) {
          wx.showModal({
            title: '导入失败',
            content: '未在剪贴板中检测到合法的备份 JSON 格式，请先复制合法的备份数据。',
            showCancel: false
          });
          return;
        }

        wx.showModal({
          title: '导入覆盖确认',
          content: '检测到剪贴板备份数据。继续导入将永久覆盖您当前的小程序内所有持仓与历史账户！是否导入？',
          confirmText: '导入覆盖',
          confirmColor: '#ff453a',
          success: (res) => {
            if (res.confirm) {
              try {
                const parsed = JSON.parse(str);
                if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
                  app.globalData.accounts = parsed.accounts;
                  app.globalData.activeAccountName = parsed.active || Object.keys(parsed.accounts)[0] || '主账户';
                  app.saveState();
                  
                  wx.showToast({
                    title: '备份数据导入成功',
                    icon: 'success'
                  });
                  this.refreshData();
                } else {
                  throw new Error('格式不规范');
                }
              } catch (e) {
                wx.showModal({
                  title: '导入解析失败',
                  content: '剪贴板中的 JSON 数据格式有误，导入失败。',
                  showCancel: false
                });
              }
            }
          }
        });
      },
      fail: () => {
        wx.showToast({ title: '无法读取剪贴板数据', icon: 'none' });
      }
    });
  },

  // Reset entire Storage
  onResetStorage() {
    wx.showModal({
      title: '极度危险警告',
      content: '该操作将永久擦除本小程序内的所有账户、交易记录以及策略明细，并重置为初始的出厂 Mock 示例，是否继续？',
      confirmText: '确定重置',
      confirmColor: '#ff453a',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('genius-trader-portfolio-v2');
          wx.removeStorageSync('user_openid');
          wx.removeStorageSync('user_info');
          
          app.loadState();
          
          wx.showToast({
            title: '重置完成',
            icon: 'success'
          });
          this.refreshData();
        }
      }
    });
  }
});
