// pages/profile/profile.js
import { http } from '../../utils/request.js';
import { formatShanghaiTime } from '../../utils/formatTime.js';
const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    userInfo: {},
    cloudOpenId: '',
    maskedId: '',
    useCloudDb: false,
    isLoggedIn: false,
    authUser: null, // 正式用户 { id, email }；null = 游客模式
    cloudReady: false,
    lastSyncTime: '',
    backups: [],
    restoringLocal: false,
    restoringBackupId: ''
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });
  },

  onShow() {
    this.refreshData();
    this.loadBackups();
  },

  // 拉取最近 5 次备份列表
  loadBackups() {
    http.get('/api/account/backups', null, { silent: true })
      .then(res => {
        const list = (res && res.backups) || [];
        this.setData({ backups: list.map(b => ({
          ...b,
          id: String(b.id),
          created_at: b.created_at ? this._formatTime(new Date(b.created_at).getTime()) : ''
        })) });
      })
      .catch(() => { /* 备份列表拉取失败静默 */ });
  },

  // 恢复指定备份：确认后从服务器恢复到本地
  onRestoreBackup(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '恢复备份',
      content: '恢复后当前服务器数据将被该时间点的数据覆盖，是否继续？',
      confirmText: '恢复',
      confirmColor: '#0071e3',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ restoringBackupId: id });
        wx.showLoading({ title: '恢复中...', mask: true });
        http.post(`/api/account/backups/${id}/restore`, {}, { silent: true })
          .then(r => {
            const ok = this._applyRestoredState(r && r.state);
            wx.showToast({ title: ok ? '已恢复备份' : '恢复失败', icon: ok ? 'success' : 'none' });
          })
          .catch(err => {
            const msg = (err && err.message) || '恢复失败';
            wx.showToast({ title: msg, icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
            this.setData({ restoringBackupId: '' });
          });
      }
    });
  },

  // 删除备份：确认后 DELETE（后端按 user_id 隔离，只能删除本人备份）
  onDeleteBackup(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除备份',
      content: '确定删除该备份快照吗？删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#ff453a',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...', mask: true });
        http.delete(`/api/account/backups/${id}`, null, { silent: true })
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已删除备份', icon: 'success' });
            this.loadBackups(); // 删除成功后立即刷新列表
          })
          .catch(err => {
            wx.hideLoading();
            const msg = (err && err.message) || '删除失败';
            wx.showModal({ title: '删除失败', content: msg, showCancel: false });
          });
      }
    });
  },

  refreshData() {
    const auth = app.globalData.auth || {};
    const authUser = auth.user || null;
    // P3.19：头像昵称按【当前业务账号】读取；未登录/退出 → 强制默认头像与「未登录」
    const isLoggedIn = Boolean(authUser);
    const userInfo = isLoggedIn
      ? (app.getProfile() || {})
      : { nickName: '未登录', avatarUrl: '/images/default_avatar.png' };
    const openId = app.globalData.cloudOpenId || wx.getStorageSync('user_openid') || '';
    const lastSync = wx.getStorageSync('cloud_last_sync') || 0;
    this.setData({
      userInfo,
      cloudOpenId: openId,
      maskedId: openId ? (openId.length > 8 ? openId.slice(-8) : openId) : '',
      useCloudDb: wx.getStorageSync('use_cloud_db') || false,
      isLoggedIn,
      authUser,
      cloudReady: Boolean(app.globalData.cloudReady),
      lastSyncTime: lastSync ? this._formatTime(Number(lastSync)) : ''
    });
  },

  // 跳转登录/注册页
  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goBack() {
    wx.navigateBack();
  },

  // 修改头像（微信官方 chooseAvatar）——P3.19：按当前业务账号保存
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    if (!avatarUrl) return;
    const userInfo = app.setProfile({ avatarUrl });
    this.setData({ userInfo });
    wx.showToast({ title: '头像已更新', icon: 'success' });
  },

  // 修改昵称（微信官方 nickname 输入）——P3.19：按当前业务账号保存
  onInputNickname(e) {
    const nickName = e.detail.value;
    if (!nickName) return;
    const userInfo = app.setProfile({ nickName });
    this.setData({ userInfo });
  },

  // 立即同步：手动把本地数据推送到后端，显示成功/失败 + 记录时间
  onSyncNow() {
    console.log('[profile] onSyncNow clicked');
    // 登录前同步守卫：未登录不使用残留身份同步
    const authUser = app.globalData.auth && app.globalData.auth.user;
    if (!authUser) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (this.data._syncing) return; // 防重复点击
    this.data._syncing = true;
    wx.showLoading({ title: '同步中...', mask: true });
    app.saveStateToCloud(true)
      .then(ok => {
        wx.hideLoading();
        this.data._syncing = false;
        if (ok) {
          const now = Date.now();
          wx.setStorageSync('cloud_last_sync', now);
          const timeStr = this._formatTime(now);
          this.setData({ useCloudDb: true, lastSyncTime: timeStr });
          // 同步成功后创建一次服务器备份（最多保留 5 个）
          http.post('/api/account/backups', {
            state: {
              accounts: app.globalData.accounts,
              active: app.globalData.activeAccountName,
              providerStatus: app.globalData.providerStatus || {},
              updatedAt: now
            },
            reason: 'manual'
          }, { silent: true })
            .then(() => this.loadBackups())
            .catch(() => {});
          wx.showToast({ title: '同步成功', icon: 'success' });
        } else {
          wx.showToast({ title: '同步失败：后端服务不可用', icon: 'none' });
        }
      })
      .catch(err => {
        wx.hideLoading();
        this.data._syncing = false;
        const msg = (err && err.message) || '网络异常';
        wx.showToast({ title: '同步失败：' + msg, icon: 'none' });
      });
  },

  // 统一按 Asia/Shanghai 时区格式化时间戳（与设备本地时区无关），委托共享工具
  _formatTime(ts) {
    return formatShanghaiTime(ts);
  },

  // 恢复本地：从最近云端备份恢复账户与持仓覆盖本地
  onRestoreLocal() {
    wx.showModal({
      title: '恢复本地',
      content: '将用最近云端备份覆盖当前本地数据？',
      confirmText: '恢复',
      confirmColor: '#0071e3',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ restoringLocal: true });
        wx.showLoading({ title: '恢复中...', mask: true });
        http.get('/api/account/backups', null, { silent: true })
          .then(r => {
            const backups = (r && r.backups) || [];
            if (!backups.length) {
              wx.showToast({ title: '云端暂无备份', icon: 'none' });
              return;
            }
            return http.post(`/api/account/backups/${backups[0].id}/restore`, {}, { silent: true })
              .then(r2 => {
                const ok = this._applyRestoredState(r2 && r2.state);
                wx.showToast({ title: ok ? '已恢复本地数据' : '恢复失败', icon: ok ? 'success' : 'none' });
              });
          })
          .catch(err => {
            wx.showToast({ title: (err && err.message) || '恢复失败', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
            this.setData({ restoringLocal: false });
          });
      }
    });
  },

  _applyRestoredState(state) {
    if (state && state.accounts && typeof state.accounts === 'object') {
      app.globalData.accounts = state.accounts;
      app.globalData.activeAccountName = state.active || Object.keys(state.accounts)[0] || '主账户';
      if (state.providerStatus && typeof state.providerStatus === 'object') {
        app.globalData.providerStatus = { ...app.globalData.providerStatus, ...state.providerStatus };
      }
      app.saveState();
      app.notifyAccountsChanged();
      return true;
    }
    return false;
  },

  // 退出登录：强制同步 → 退第三方 → auth logout → 清本地 → logged_out
  onLogout() {
    console.log('[profile] onLogout clicked');
    const authUser = app.globalData.auth && app.globalData.auth.user;
    if (!authUser) {
      wx.showToast({ title: '当前未登录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '退出登录',
      content: '退出前会自动同步最新数据，然后清空本机账户、持仓与第三方登录态（云端数据保留，重新登录可恢复）。',
      confirmText: '退出',
      confirmColor: '#ff453a',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在退出...', mask: true });
        try {
          const result = await app.logout();
          wx.hideLoading();
          if (result.done) {
            this._onLoggedOut();
            // 自动备份失败：明确提示（数据已通过强制同步保存在云端，不阻止退出）
            if (result.backupOk === false) {
              wx.showToast({ title: '退出前自动备份失败（云端已同步）', icon: 'none' });
            }
          } else {
            // 强制同步失败：提示「是否仍然退出」
            this._askForceLogout();
          }
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '退出失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 强制同步失败时的二次确认：取消=保留账户；仍然退出=跳过同步直接清理
  _askForceLogout() {
    wx.showModal({
      title: '数据同步失败',
      content: '数据同步失败，是否仍然退出？',
      confirmText: '仍然退出',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return; // 取消：保留当前账户（app.logout 已回退 authState）
        wx.showLoading({ title: '正在退出...', mask: true });
        try {
          await app.logout(true); // forceClear=true 跳过同步
          wx.hideLoading();
          this._onLoggedOut();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '退出失败，请重试', icon: 'none' });
        }
      }
    });
  },

  _onLoggedOut() {
    this.refreshData();
    app.notifyAccountsChanged();
    wx.showToast({ title: '已退出登录', icon: 'none' });
  },
});
