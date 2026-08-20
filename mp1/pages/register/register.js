// pages/register/register.js
// 正式多用户注册页（邮箱 + 密码 + 确认密码），复用后端 POST /api/auth/register
const app = getApp();
import { http, setAuthToken } from '../../utils/request.js';

Page({
  data: {
    email: '',
    password: '',
    passwordDisplay: '',   // 自定义掩码显示值（●）
    confirmPassword: '',
    confirmDisplay: '',    // 自定义掩码显示值（●）
    loading: false,
    error: '',
    statusBarHeight: 20,
    navBarHeight: 44
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      navBarHeight: app.globalData.navBarHeight || 44
    });
  },

  onInputEmail(e) { this.setData({ email: e.detail.value, error: '' }); },
  onInputPassword(e) {
    // 自定义掩码：type=text 输入，显示用 ● 替换；删除按掩码长度截断真实密码
    const v = e.detail.value || '';
    const real = this.data.password || '';
    let newReal;
    if (v.length <= real.length) {
      newReal = real.slice(0, v.length);
    } else {
      newReal = real + v.slice(real.length).split('').filter(c => c !== '●').join('');
    }
    this.setData({ password: newReal, passwordDisplay: '●'.repeat(newReal.length), error: '' });
  },
  onInputConfirm(e) {
    // 确认密码同样自定义掩码
    const v = e.detail.value || '';
    const real = this.data.confirmPassword || '';
    let newReal;
    if (v.length <= real.length) {
      newReal = real.slice(0, v.length);
    } else {
      newReal = real + v.slice(real.length).split('').filter(c => c !== '●').join('');
    }
    this.setData({ confirmPassword: newReal, confirmDisplay: '●'.repeat(newReal.length), error: '' });
  },

  async onSubmit() {
    if (this.data.loading) return;
    const email = (this.data.email || '').trim();
    const password = this.data.password || '';
    const confirmPassword = this.data.confirmPassword || '';

    if (!email) { this.setData({ error: '请输入邮箱' }); return; }
    if (!password) { this.setData({ error: '请输入密码' }); return; }
    if (password.length < 6) { this.setData({ error: '密码至少 6 位' }); return; }
    if (password !== confirmPassword) { this.setData({ error: '两次输入的密码不一致' }); return; }

    this.setData({ loading: true, error: '' });
    try {
      let res = await http.post('/api/auth/register', { email, password });
      // 兜底：若注册接口未返回 token，则自动登录一次获取 token
      if (!res || !res.token) {
        res = await http.post('/api/auth/login', { email, password });
      }
      if (!res || !res.token) {
        throw new Error((res && res.error) || '注册失败，请重试');
      }
      setAuthToken(res.token);
      app.globalData.auth = { token: res.token, user: res.user || null };
      app.globalData.authState = 'authenticated'; // 注册即进入已认证状态（否则后续 saveStateToCloud/loadStateFromCloud 会被竞态防护拦截）
      // 注册成功：检测本地游客数据 → 提示迁移；否则进入空账户引导
      if (app.hasLocalGuestData()) {
        this._askMigrateGuestData();
      } else {
        this._finishRegister();
      }
    } catch (err) {
      // 注册错误可显示具体原因（邮箱格式 / 已注册 / 密码长度）
      this.setData({ error: (err && err.message) || '注册失败，请重试', loading: false });
    }
  },

  // 提示「本机有未同步数据」，只有用户确认才迁移到正式账号
  _askMigrateGuestData() {
    this.setData({ loading: false });
    wx.showModal({
      title: '发现本机数据',
      content: '本机有未同步的账户/持仓数据。是否保存到你的账号，跨设备同步？',
      confirmText: '保存到账号',
      cancelText: '暂不保存',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '保存中...', mask: true });
          const ok = await app.saveStateToCloud(true);
          wx.hideLoading();
          wx.showToast({ title: ok ? '已保存到账号' : '保存失败', icon: ok ? 'success' : 'none' });
        }
        setTimeout(() => {
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
        }, 600);
      }
    });
  },

  _finishRegister() {
    wx.showToast({ title: '注册成功', icon: 'success' });
    setTimeout(() => {
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
    }, 600);
  },

  goLogin() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/login/login' }) });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  }
});
