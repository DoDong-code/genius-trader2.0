// pages/login/login.js
// 正式多用户登录页（邮箱 + 密码），复用后端 POST /api/auth/login
const app = getApp();

Page({
  data: {
    email: '',
    password: '',
    passwordDisplay: '', // 自定义掩码显示值（●）
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

  onInputEmail(e) {
    this.setData({ email: e.detail.value, error: '' });
    // ═══ 临时调试：确认 iOS 真机 input 事件拿到的 value（诊断后删除）═══
    console.log('[Login-Debug] email input value =', JSON.stringify(e.detail.value), '| len =', (e.detail.value || '').length);
  },
  onInputPassword(e) {
    // 自定义掩码：type=text 输入，显示用 ● 替换；删除按掩码长度截断真实密码
    const v = e.detail.value || '';
    const real = this.data.password || '';
    let newReal;
    if (v.length <= real.length) {
      newReal = real.slice(0, v.length); // 删除场景（含全选清空）
    } else {
      // 新增场景：取 v 超出 real 的部分，过滤掉掩码字符（防中间插入/粘贴脏字符）
      newReal = real + v.slice(real.length).split('').filter(c => c !== '●').join('');
    }
    this.setData({ password: newReal, passwordDisplay: '●'.repeat(newReal.length), error: '' });
    // ═══ 临时调试：只打长度不打明文（诊断后删除）═══
    console.log('[Login-Debug] password input | len =', newReal.length, '(不打印明文)');
  },

  async onSubmit() {
    if (this.data.loading) return;
    const email = (this.data.email || '').trim();
    const password = this.data.password || '';
    // ═══ 临时调试（诊断后删除）═══
    console.log('[Login-Debug] submit click | email =', JSON.stringify(email), '| password len =', password.length);
    if (!email || !password) {
      this.setData({ error: '请输入邮箱和密码' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const result = await app.login(email, password);
      console.log('[Login-Debug] login API OK | result =', JSON.stringify(result));
      // 登录成功：云端无数据且本地有游客数据 → 提示迁移；否则直接完成
      if (!result.cloudSynced && app.hasLocalGuestData()) {
        this._askMigrateGuestData();
      } else {
        this._finishLogin('登录成功');
      }
    } catch (err) {
      // 统一模糊提示，不泄露用户是否存在/密码是否正确
      console.log('[Login-Debug] login API FAIL | err =', (err && err.message) || String(err));
      this.setData({ error: '邮箱或密码错误', loading: false });
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

  _finishLogin(title) {
    wx.showToast({ title, icon: 'success' });
    setTimeout(() => {
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
    }, 600);
  },

  goRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  }
});
