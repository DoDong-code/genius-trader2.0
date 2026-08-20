// pages/setting/setting.js
const app = getApp();
import { http, getApiBase, PUBLIC_API_BASE } from '../../utils/request.js';
import { formatShanghaiTime } from '../../utils/formatTime.js';

Page({
  data: {
    activeAccountName: '',
    isLoggedIn: false,
    openid: '',
    cloudOpenId: '',
    maskedId: '',
    userInfo: {},
    apiBaseUrl: '',
    useCloudDb: false,
    cloudReady: false,

    // Custom Topbar heights
    statusBarHeight: 20,
    navBarHeight: 44,

    // AI configurations
    aiProviders: ['OpenAI', 'DeepSeek', 'Google Gemini', 'Moonshot Kimi', 'Claude', '自定义 OpenAI Compatible'],
    aiProviderIndex: 0,
    aiProvider: 'OpenAI',
    aiBaseUrl: '',
    aiApiKey: '',
    aiModelName: 'gpt-5-mini',

    // Connection testing
    testFundCode: '000001',
    testApiResult: '',
    isTestingApi: false,
    testAiQuestion: '今天几号',
    testAiResult: '',
    isTestingAi: false,

    // Strategy
    strategy: [],
    newStrategyText: '',

    // Third-party provider sync state
    yjbConnected: false,
    yjbLastSync: '—',
    xbyjConnected: false,
    xbyjLastSync: '—',
    xbyjPhone: '',
    xbyjCode: '',

    // 养基宝扫码登录（内联二维码 + 轮询）
    yjbQrShow: false,
    yjbQrUrl: '',
    yjbQrStatus: '', // '' | 'loading' | 'error' | 'expired' | 'confirmed'
    yjbQrId: '',

    // Closed Position Form
    closedFundName: '',
    closedFundCode: '',
    closedFundReasons: '',

    // 实验功能开关（关闭时隐藏「实验接口配置」分组并隐藏分析 tab）
    experimentalEnabled: false,

    // Collapsible sections state (matches Web settingsCollapsedState)
    collapsed: {
      datasource: true,
      experimental: true,
      strategy: true,
      providers: true,
      backup: true
    }
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().highlight('/pages/setting/setting');
    }
    this.setData({ experimentalEnabled: wx.getStorageSync('experimentalMode') || false });

    // ═══ 用户身份变化（登录/退出/切换账号）时清理第三方登录临时输入 ═══
    // 小倍手机号/验证码只存在页面 data（无 storage/globalData 写入），但设置页是 tab 页，
    // 退出登录后页面实例不销毁，必须在此显式重置，否则旧用户输入残留。
    const au = (app.globalData.auth && app.globalData.auth.user) || null;
    const uid = au ? au.id : 0;
    if (this._lastSeenUid !== undefined && this._lastSeenUid !== uid) {
      console.log('[Verify] 用户身份变化 uid', this._lastSeenUid, '->', uid, '：清理小倍手机号/验证码与养基宝二维码状态');
      this._stopQrPoll();
      this.setData({
        xbyjPhone: '',
        xbyjCode: '',
        yjbQrShow: false,
        yjbQrUrl: '',
        yjbQrStatus: '',
        yjbQrId: ''
      });
    }
    this._lastSeenUid = uid;

    this.refreshData();
    this.loadProviderStatus();
    // 返回小程序时：重启轮询 + 立即查一次扫码状态（微信后台会节流 setInterval，切回前台必须重启否则检测不到）
    this._resumeQrPoll();
  },

  // Collapsible accordion toggle (matches Web settings-toggle-header behavior)
  toggleSection(e) {
    const panel = e.currentTarget.dataset.panel;
    if (!panel) return;
    const collapsed = { ...this.data.collapsed };
    collapsed[panel] = !collapsed[panel];
    this.setData({ collapsed });
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    
    // Retrieve server settings
    // 体验版/真机：默认走 CloudBase 公网域名，避免使用 storage 里残留的 localhost:3000（域名拦截）
    let apiBaseUrl = '';
    try {
      const stored = wx.getStorageSync('api_base_url');
      if (stored && !/localhost|127\.0\.0\.1/i.test(stored)) {
        apiBaseUrl = stored;
      } else if (stored) {
        // 清理旧的 localhost 缓存，避免误用
        wx.removeStorageSync('api_base_url');
      }
    } catch (e) { /* ignore */ }
    if (!apiBaseUrl) apiBaseUrl = PUBLIC_API_BASE || '';
    const useCloudDb = wx.getStorageSync('use_cloud_db') || false;
    const cloudReady = Boolean(app.globalData.cloudReady);

    // Retrieve AI configurations（P3.18：API Key 不回填明文；配置过则显示占位并保留）
    const aiProvider = wx.getStorageSync('ai_provider') || 'OpenAI';
    const aiProviders = ['OpenAI', 'DeepSeek', 'Google Gemini', 'Moonshot Kimi', 'Claude', '自定义 OpenAI Compatible'];
    const aiProviderIndex = aiProviders.indexOf(aiProvider) >= 0 ? aiProviders.indexOf(aiProvider) : 0;
    const aiBaseUrl = wx.getStorageSync('ai_base_url_config') || '';
    const storedApiKey = wx.getStorageSync('ai_api_key') || '';
    const aiApiKeyConfigured = Boolean(storedApiKey);
    const aiModelName = wx.getStorageSync('ai_model_name') || 'gpt-5-mini';
    const aiEngine = wx.getStorageSync('ai_engine') || '';

    // Retrieve user profiles（P3.19：头像昵称按【当前业务账号】读取；未登录强制默认）
    const openid = wx.getStorageSync('user_openid') || 'mock_openid_guest';
    // 已登录 = 正式用户（邮箱登录）；游客 = user_id=0
    const authUser = (app.globalData.auth && app.globalData.auth.user) || null;
    const isLoggedIn = Boolean(authUser);
    const userInfo = isLoggedIn
      ? (app.getProfile() || {})
      : { nickName: '未登录', avatarUrl: '/images/default_avatar.png' };
    // 真实微信身份（云端自动写入的 _openid）优先用于展示
    const cloudOpenId = app.globalData.cloudOpenId || '';
    const displayOpenId = cloudOpenId || (openid !== 'mock_openid_guest' ? openid : '');
    const maskedId = displayOpenId ? (displayOpenId.slice(0, 6) + '****' + displayOpenId.slice(-4)) : '';

    this.setData({
      activeAccountName,
      strategy: account.strategy || [],
      apiBaseUrl,
      useCloudDb,
      cloudReady,
      aiProvider,
      aiProviderIndex,
      aiBaseUrl,
      aiApiKey: '',
      aiApiKeyConfigured,
      aiModelName,
      aiEngine,
      openid,
      cloudOpenId,
      maskedId,
      userInfo,
      isLoggedIn,
      authUser
    });
  },

  // 进入账号二级页面（改头像/昵称/同步云端/恢复本地/退出）
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  // 跳转正式登录页（邮箱+密码）
  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  // 微信授权登录：优先真实微信云身份；云端不可用时回退本机 mock 身份（自适配，不依赖启动快照）
  onWechatLogin() {
    wx.showLoading({ title: '授权登录中...', mask: true });

    // 在用户点击的同步回调中获取微信头像昵称
    const finish = () => this._doCloudLogin();
    const fallbackUser = { nickName: '微信用户', avatarUrl: '/images/default_avatar.png' };
    if (typeof wx.getUserProfile === 'function') {
      wx.getUserProfile({
        desc: '用于完善用户资料',
        success: (res) => {
          const userInfo = (res && res.userInfo) || fallbackUser;
          app.setProfile(userInfo);
          this.setData({ userInfo });
          finish();
        },
        fail: () => {
          app.setProfile(fallbackUser);
          finish();
        }
      });
    } else if (typeof wx.getUserInfo === 'function') {
      wx.getUserInfo({
        success: (res) => {
          const userInfo = (res && res.userInfo) || fallbackUser;
          app.setProfile(userInfo);
          this.setData({ userInfo });
          finish();
        },
        fail: () => {
          app.setProfile(fallbackUser);
          finish();
        }
      });
    } else {
      app.setProfile(fallbackUser);
      finish();
    }
  },

  _doCloudLogin() {
    app.enableCloudSync()
      .then(() => {
        wx.hideLoading();
        wx.setStorageSync('use_cloud_db', true);
        this.setData({ useCloudDb: true });
        wx.showToast({ title: app.globalData.cloudOpenId ? '微信账号已连接' : '已开启云端同步', icon: 'success' });
        this.refreshData();
      })
      .catch((err) => {
        // 云端不可用（未开通云开发 / 未创建环境）：回退本机登录，并明确告知
        wx.hideLoading();
        console.warn('[Login] cloud unavailable, fallback local:', err && err.message);
        this._mockLogin(true);
      });
  },

  _mockLogin(cloudUnavailable) {
    wx.showLoading({ title: '授权登录中...', mask: true });
    setTimeout(() => {
      wx.hideLoading();
      const mockOpenId = 'openid_mp_' + Math.random().toString(36).substring(2, 10);
      const mockUser = app.getProfile() || {
        nickName: '微信用户',
        avatarUrl: '/images/default_avatar.png'
      };
      wx.setStorageSync('user_openid', mockOpenId);
      app.setProfile(mockUser);
      if (cloudUnavailable) {
        wx.showModal({
          title: '云端未启用',
          content: '当前小程序未开通微信云开发（或未创建云环境），已使用本机登录，账户数据仅保存在本机。\n\n如需跨设备同步，请在微信开发者工具中开通「云开发」并创建环境后重新登录。',
          showCancel: false,
          confirmText: '我知道了'
        });
      } else {
        wx.showToast({ title: '已登录（本机）', icon: 'success' });
      }
      this.refreshData();
    }, 600);
  },

  onInputApiBase(e) {
    const val = e.detail.value.trim();
    wx.setStorageSync('api_base_url', val);
    this.setData({ apiBaseUrl: val });
  },

  onInputAiBaseUrl(e) {
    this.setData({ aiBaseUrl: e.detail.value.trim() });
  },

  onInputAiApiKey(e) {
    this.setData({ aiApiKey: e.detail.value.trim() });
  },

  onInputAiModelName(e) {
    this.setData({ aiModelName: e.detail.value.trim() });
  },

  onAiProviderChange(e) {
    const idx = Number(e.detail.value);
    const selected = this.data.aiProviders[idx];
    this.setData({
      aiProviderIndex: idx,
      aiProvider: selected
    });
  },

  onSaveAiConfig() {
    const provider = this.data.aiProvider;
    const baseURL = this.data.aiBaseUrl;
    const inputKey = (this.data.aiApiKey || '').trim();
    const modelName = this.data.aiModelName;
    // P3.18：Key 留空且原已配置 → 保留原 Key（输入框不回填明文）；否则用新值
    const apiKey = inputKey || wx.getStorageSync('ai_api_key') || '';

    wx.setStorageSync('ai_provider', provider);
    wx.setStorageSync('ai_base_url_config', baseURL);
    wx.setStorageSync('ai_model_name', modelName);
    if (apiKey) wx.setStorageSync('ai_api_key', apiKey);
    else wx.removeStorageSync('ai_api_key');
    wx.removeStorageSync('ai_engine'); // 保存外部配置 = 退出本地引擎

    wx.showToast({
      title: '天才接口配置保存成功',
      icon: 'success'
    });
  },

  // P3.18：本地引擎 —— 清空 AI 配置输入框与存储，engine=local（分析/评估理由完全不依赖外部 AI）
  onUseLocalEngine() {
    const hadKey = Boolean(wx.getStorageSync('ai_api_key'));
    this.setData({ aiBaseUrl: '', aiApiKey: '', aiApiKeyConfigured: false, aiEngine: 'local' });
    wx.removeStorageSync('ai_base_url_config');
    wx.removeStorageSync('ai_api_key');
    wx.setStorageSync('ai_engine', 'local');
    // 清理历史 AI 分析缓存（避免切换后仍显示旧 AI 胡编的摘要/理由）
    const activeName = app.globalData.activeAccountName || '';
    wx.removeStorageSync('LAST_AI_ANALYSIS_' + activeName);
    wx.removeStorageSync('LAST_AI_ANALYSIS_TIME_' + activeName);
    wx.removeStorageSync('LAST_AI_ANALYSIS_MODEL_' + activeName);
    wx.showToast({
      title: hadKey ? '已切换本地引擎，AI 配置已清空' : '已切换本地引擎',
      icon: 'success'
    });
  },

  onInputTestFundCode(e) {
    this.setData({ testFundCode: e.detail.value.trim() });
  },

  onInputTestAiQuestion(e) {
    this.setData({ testAiQuestion: e.detail.value.trim() });
  },

  onTestApi() {
    const testCode = this.data.testFundCode || '000001';
    // 体验版/真机：默认走 CloudBase 公网域名（已 curl 实测 200），避开 localhost:3000 的域名拦截。
    // 用户手动填了 baseUrl 才用填的（用于本地开发指向其他服务器）。
    const manualBase = this.data.apiBaseUrl.replace(/\/+$/, '');
    const baseUrl = manualBase || PUBLIC_API_BASE || getApiBase();

    this.setData({
      isTestingApi: true,
      testApiResult: '正在连接接口进行连通性测试...'
    });

    const targetUrl = `${baseUrl}/api/fund/${testCode}`;
    
    const startTime = Date.now();
    wx.request({
      url: targetUrl,
      method: 'GET',
      success: (res) => {
        const duration = Date.now() - startTime;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.setData({
            testApiResult: `✓ 接口连接成功 (耗时: ${duration}ms)\n请求地址: ${targetUrl}\n返回数据预览:\n${JSON.stringify(res.data, null, 2).substring(0, 300)}...`,
            isTestingApi: false
          });
        } else {
          this.setData({
            testApiResult: `✗ 接口响应失败 (HTTP 状态码: ${res.statusCode})\n请求地址: ${targetUrl}\n请检查接口地址配置是否正确。`,
            isTestingApi: false
          });
        }
      },
      fail: (err) => {
        this.setData({
          testApiResult: `✗ 接口连接异常: ${err.errMsg || '未知网络错误'}\n请求地址: ${targetUrl}\n请检查您的网络，或确保服务端已允许小程序域名请求。`,
          isTestingApi: false
        });
      }
    });
  },

  onTestAi() {
    const provider = this.data.aiProvider;
    const baseURL = this.data.aiBaseUrl;
    const apiKey = this.data.aiApiKey;
    const modelName = this.data.aiModelName;
    const question = this.data.testAiQuestion || '请分析当前基金市场风险';

    this.setData({
      isTestingAi: true,
      testAiResult: '正在发起天才服务连接测试，请稍候...'
    });

    const appBaseUrl = this.data.apiBaseUrl.replace(/\/+$/, '') || getApiBase();
    const startTime = Date.now();

    wx.request({
      url: `${appBaseUrl}/api/ai/chat`,
      method: 'POST',
      header: {
        'content-type': 'application/json',
        'X-AI-API-Key': apiKey
      },
      data: {
        message: question,
        config: {
          provider,
          baseURL,
          model: modelName
        }
      },
      success: (res) => {
        const duration = Date.now() - startTime;
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.success) {
          this.setData({
            testAiResult: `✓ 天才接口调用成功 (耗时: ${duration}ms)\n使用模型: ${modelName}\n天才原始回复：\n${res.data.reply}`,
            isTestingAi: false
          });
        } else {
          const errMsg = (res.data && res.data.error) || '未知网络或网关错误';
          this.setData({
            testAiResult: `✗ 天才接口响应失败 (HTTP 状态码: ${res.statusCode})\n错误详情: ${errMsg}\n排查建议：\n1. 确保已在后端或上方输入框正确配置 API Key；\n2. 检查网络或代理是否通畅。`,
            isTestingAi: false
          });
        }
      },
      fail: (err) => {
        this.setData({
          testAiResult: `✗ 天才接口调用异常: ${err.errMsg}\n请检查网络连接或后端服务器是否正常运行。`,
          isTestingAi: false
        });
      }
    });
  },

  // ── Third-party provider sync (养基宝 / 小倍养基) ──
  loadProviderStatus() {
    const fetch = (key) => http.get(`/api/provider/${key}/status`, null, { silent: true })
      .then(res => {
        const connected = Boolean(res && res.logged_in);
        const last = (res && res.last_sync_at) ? formatShanghaiTime(res.last_sync_at) : '—';
        return { connected, last };
      })
      .catch(() => ({ connected: false, last: '—' }));

    Promise.all([fetch('yangjibao'), fetch('xiaobeiyangji')])
      .then(([yjb, xbyj]) => {
        const status = {
          yjbConnected: yjb.connected,
          yjbLastSync: yjb.last,
          xbyjConnected: xbyj.connected,
          xbyjLastSync: xbyj.last
        };
        this.setData(status);
        app.updateProviderStatus(status);
      })
      .catch(() => {});
  },

  syncProvider(source, overwrite) {
    wx.showLoading({ title: '正在同步持仓...' });
    http.post(`/api/provider/${source}/import`, { overwrite: !!overwrite }, { silent: true })
      .then(res => {
        wx.hideLoading();
        const accounts = (res && res.accounts) || [];
        const accountCount = accounts.length;
        const fundCount = accounts.reduce((sum, a) => sum + (a.funds || []).length, 0);
        const msg = (res && res.message)
          || `同步完成：成功导入 ${fundCount} 个基金、${accountCount} 个账户`;
        wx.showModal({ title: '同步结果', content: msg, showCancel: false });
        if (accountCount) {
          this._mergeImportedAccounts(accounts, !!overwrite, source);
        }
        this.loadProviderStatus();
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '同步失败', icon: 'none' });
      });
  },

  // 将后端返回的账户数组（[{name, funds}]）合并进 globalData.accounts 对象
  _mergeImportedAccounts(imported, overwrite, source) {
    const serverNames = new Set((imported || []).map(a => a.name).filter(Boolean));
    const baseAccounts = overwrite ? {} : { ...app.globalData.accounts };
    // 删除「本地 sync 账户但服务端已不存在」的账户（对齐 Web refreshSyncedAccounts:1241）
    // 仅删 accountType==='sync' 的第三方账户；已转 local（convertedFromSync）与本地自建账户不删，
    // 保证改名/移动转本地后的账户不会被同步「复活」覆盖。
    Object.keys(baseAccounts).forEach(name => {
      const acc = baseAccounts[name];
      if (app.isSyncAccount(acc) && !serverNames.has(name)) {
        delete baseAccounts[name];
      }
    });
    for (const acc of imported) {
      if (!acc || !acc.name) continue;
      const prev = baseAccounts[acc.name];
      baseAccounts[acc.name] = {
        name: acc.name,
        portfolioDataVersion: 'imported-v1',
        snapshotDate: app.globalData.shanghaiToday,
        strategy: (prev && prev.strategy) || [],
        closedPositions: (prev && prev.closedPositions) || [],
        funds: acc.funds || [],
        // 同步标识：第三方导入的账户标记 sync，账户管理列表显示「同步」徽章
        accountType: 'sync',
        syncSource: source || (prev && prev.syncSource) || null
      };
    }
    app.globalData.accounts = baseAccounts;
    app.globalData.activeAccountName = imported[0] && imported[0].name
      ? imported[0].name
      : (Object.keys(baseAccounts)[0] || '主账户');
    app.saveState();
  },

  onYjbQrcode() {
    this.fetchYjbQrcode();
  },

  // 获取养基宝登录二维码并内联展示（与网页端一致：qr_url 需现场生成二维码图片）
  fetchYjbQrcode() {
    this._stopQrPoll();
    this.setData({ yjbQrShow: true, yjbQrUrl: '', yjbQrStatus: 'loading', yjbQrError: '' });
    http.post('/api/provider/yangjibao/qrcode', {}, { silent: true })
      .then(res => {
        const qrUrl = res && res.qr_url;
        const qrId = res && (res.qr_id || res.qrId);
        if (!qrUrl) {
          this.setData({ yjbQrStatus: 'error', yjbQrError: '后端未返回二维码内容' });
          wx.showToast({ title: '获取二维码失败', icon: 'none' });
          return;
        }
        // 养基宝登录二维码是给「养基宝 App」扫的（微信长按识别只会打开公众号、无法登录）。
        // 后端已用 qrcode 包生成 base64 data URI（qr_data_url），小程序直接展示，不依赖任何第三方图片域名。
        const imgUrl = (res && res.qr_data_url) || '';
        this.setData({ yjbQrUrl: imgUrl, yjbQrId: qrId || '', yjbQrStatus: '', yjbQrError: '' });
        console.log('[YJB QR] generate qr_id=' + (qrId || ''));
        this._startQrPoll(qrId);
      })
      .catch(err => {
        const raw = String((err && (err.errMsg || err.message)) || '');
        let userMsg = raw || '网络或后端服务异常';
        let toastMsg = userMsg;
        // 常见根因识别：域名白名单拦截 → 提示配置 Render request 合法域名
        if (/INVALID_HOST|-501000|url not in domain/i.test(raw)) {
          userMsg = '请求域名未配置。请在微信公众平台 → 开发设置 → 服务器域名 → request 合法域名，添加：https://genius-trader.onrender.com';
          toastMsg = '请求域名未配置，请添加 request 合法域名';
        }
        console.error('[养基宝二维码]', err);
        this.setData({ yjbQrStatus: 'error', yjbQrError: userMsg });
        wx.showToast({ title: toastMsg, icon: 'none', duration: 3500 });
      });
  },

  // 轮询扫码状态（每 1.5s，最长 120s，与网页端一致；P3.19-F：90s→120s 给公众号确认留时间）
  _startQrPoll(qrId) {
    if (!qrId) return;
    this._stopQrPoll(); // 防御：清除旧 timer，保证最多一个 polling timer（P3.19-F 十三）
    this._qrStartedAt = Date.now();
    this._qrPollErrors = 0;
    console.log('[YJB QR] polling start qr_id=' + qrId);
    this._qrTimer = setInterval(() => {
      if (Date.now() - this._qrStartedAt > 120000) {
        this._markExpired();
        return;
      }
      this._checkQrOnce();
    }, 1500);
  },

  _stopQrPoll() {
    if (this._qrTimer) {
      clearInterval(this._qrTimer);
      this._qrTimer = null;
    }
  },

  // P3.19-F：120s 超时 → 停止轮询并标记 expired（禁止继续复用旧 qr_id）
  _markExpired() {
    this._stopQrPoll();
    if (this.data.yjbQrStatus !== 'expired') {
      this.setData({ yjbQrStatus: 'expired' });
      console.log('[YJB QR] status=expired (120s timeout)');
    }
  },

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  // P3.19-F：返回小程序时的扫码状态恢复
  // 规则：无 qr_id / expired → 重新生成新二维码（禁止复用旧 qr_id）；
  //       waiting → 连续 3 次快速检查（800ms 间隔，严格串行）后仍 waiting 才恢复 1500ms polling
  _resumeQrPoll() {
    if (!this.data.yjbQrShow) return;
    if (this.data.yjbQrStatus === 'confirmed') return;
    const qrId = this.data.yjbQrId;
    if (!qrId || this.data.yjbQrStatus === 'expired') {
      console.log('[YJB QR] lifecycle=show, expired/no-qr -> regenerate');
      this.fetchYjbQrcode();
      return;
    }
    console.log('[YJB QR] lifecycle=show, fast check x3');
    this._fastCheckChain(qrId, 3);
  },

  // P3.19-F：连续最多 3 次快速检查（严格串行：await check → sleep 800 → check …）
  // 不是 3 个 timer；同一时刻最多一个 status 请求
  async _fastCheckChain(qrId, times) {
    this._stopQrPoll(); // 快查期间不跑定时轮询，避免重复请求
    for (let i = 0; i < times; i++) {
      if (this.data.yjbQrStatus === 'confirmed' || this.data.yjbQrStatus === 'expired') return;
      if (this.data.yjbQrId !== qrId) return; // 旧二维码异步结果不污染新二维码
      const done = await this._checkQrOnce(qrId);
      if (done) return;
      if (i < times - 1) await this._sleep(800);
    }
    // 仍 waiting → 恢复 1500ms polling（仅当 qr_id 未变化且未终结）
    if (this.data.yjbQrId === qrId &&
        this.data.yjbQrStatus !== 'confirmed' &&
        this.data.yjbQrStatus !== 'expired') {
      this._startQrPoll(qrId);
    }
  },

  // 查一次扫码状态；confirmed 时自动收起面板并刷新连接状态
  // P3.19-F：旧 qr_id 的异步结果不得污染新二维码状态（返回 true=已终结）
  async _checkQrOnce(qrId) {
    const targetQrId = qrId || this.data.yjbQrId;
    if (!targetQrId || !this.data.yjbQrShow) return false;
    if (this.data.yjbQrStatus === 'confirmed') return true;
    try {
      const st = await http.get('/api/provider/yangjibao/status?qr_id=' + encodeURIComponent(targetQrId), null, { silent: true });
      // 异步结果隔离：二维码已被刷新（yjbQrId 变化）时丢弃旧结果
      if (this.data.yjbQrId !== targetQrId) return false;
      if (st && st.state === 'confirmed') {
        this._stopQrPoll();
        this.setData({ yjbQrStatus: 'confirmed', yjbQrUrl: '' });
        console.log('[YJB QR] status=confirmed -> refresh provider status');
        wx.showToast({ title: '养基宝登录成功', icon: 'success' });
        this.loadProviderStatus();
        // 1.2 秒后自动收起二维码面板
        setTimeout(() => this.closeYjbQr(), 1200);
        return true;
      }
      if (st && st.state === 'expired') {
        this._stopQrPoll();
        this.setData({ yjbQrStatus: 'expired' });
        console.log('[YJB QR] status=expired');
        return true;
      }
      console.log('[YJB QR] status=waiting');
    } catch (e) { /* 静默：轮询仍会继续尝试 */ }
    return false;
  },

  closeYjbQr() {
    this._stopQrPoll();
    this.setData({ yjbQrShow: false, yjbQrUrl: '', yjbQrStatus: '', yjbQrId: '' });
  },

  onUnload() { this._stopQrPoll(); },
  // P3.19-F：onHide 必须停止轮询（微信后台 setInterval 被节流/挂起，不能假设前台节奏）
  // 不清除 qr_id：用户只是暂时进入公众号/H5；onShow 恢复时按状态机处理（waiting→快查/expired→换新码）
  onHide() {
    this._stopQrPoll();
    console.log('[YJB QR] lifecycle=hide, stop polling');
  },

  onYjbImport() { this.syncProvider('yangjibao', false); },
  onYjbOverwrite() { this.syncProvider('yangjibao', true); },

  onYjbLogout() {
    http.post('/api/provider/yangjibao/logout', {}, { silent: true })
      .then(() => {
        wx.showToast({ title: '已退出养基宝', icon: 'none' });
        app.updateProviderStatus({ yjbConnected: false, yjbLastSync: '—' });
        this.loadProviderStatus();
      })
      .catch(() => wx.showToast({ title: '退出失败', icon: 'none' }));
  },

  onInputXbyjPhone(e) { this.setData({ xbyjPhone: e.detail.value }); },
  onInputXbyjCode(e) { this.setData({ xbyjCode: e.detail.value }); },

  onXbyjSms() {
    const phone = this.data.xbyjPhone.trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    http.post('/api/provider/xiaobeiyangji/sendSMS', { phone }, { silent: true })
      .then(() => wx.showToast({ title: '验证码已发送，请注意查收', icon: 'none' }))
      .catch(err => {
        const msg = (err && err.message) || '验证码发送失败';
        wx.showToast({ title: msg, icon: 'none', duration: 3000 });
      });
  },

  onXbyjLogin() {
    const phone = this.data.xbyjPhone.trim();
    const code = this.data.xbyjCode.trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (!code) {
      wx.showToast({ title: '请输入验证码', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '登录中...' });
    http.post('/api/provider/xiaobeiyangji/login', { phone, code }, { silent: true })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '登录成功', icon: 'success' });
        this.loadProviderStatus();
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '登录失败', icon: 'none' });
      });
  },

  onXbyjImport() { this.syncProvider('xiaobeiyangji', false); },
  onXbyjOverwrite() { this.syncProvider('xiaobeiyangji', true); },

  onXbyjLogout() {
    http.post('/api/provider/xiaobeiyangji/logout', {}, { silent: true })
      .then(() => {
        wx.showToast({ title: '已退出小倍养基', icon: 'none' });
        app.updateProviderStatus({ xbyjConnected: false, xbyjLastSync: '—' });
        this.loadProviderStatus();
      })
      .catch(() => wx.showToast({ title: '退出失败', icon: 'none' }));
  },

  onCloudDbChange(e) {
    const val = e.detail.value;
    wx.setStorageSync('use_cloud_db', val);
    this.setData({ useCloudDb: val });

    if (!val) {
      wx.showToast({ title: '已切回本地存储', icon: 'none' });
      return;
    }

    // 已移除 cloudReady 判断，直接走 enableCloudSync（内部 GET/PUT /api/account/state）
    wx.showLoading({ title: '正在同步云端...', mask: true });
    app.enableCloudSync()
      .then(synced => {
        wx.hideLoading();
        wx.showToast({
          title: synced ? '已从云端同步账户' : '已备份到云端',
          icon: 'none'
        });
        this.refreshData();
        this.onShow();
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '云端同步失败', icon: 'none' });
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

    // Capture the holding amount at liquidation (web records closed amount)
    const fund = (account.funds || []).find(f => String(f.code) === String(code));
    const amount = fund ? (Number(fund.amount) || 0) : 0;

    account.closedPositions.push({
      name,
      code,
      amount,
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

  // 导出备份：P1 支持范围选择（全部数据 / 投资策略），调起微信分享文件消息（shareFileMessage）
  onCopyBackup() {
    wx.showActionSheet({
      itemList: ['全部数据', '投资策略'],
      success: (res) => {
        if (res.tapIndex === 0) this._exportBackup('all');
        else if (res.tapIndex === 1) this._exportBackup('strategy');
      },
      fail: () => { /* 用户取消 */ }
    });
  },

  _exportBackup(kind) {
    const accounts = app.globalData.accounts || {};
    let backupObj;
    if (kind === 'strategy') {
      // 仅投资策略（不含持仓/交易等明细），与网页端「导出策略」一致
      backupObj = {
        version: 1,
        kind: 'strategy',
        exportedAt: new Date().toISOString(),
        strategies: Object.keys(accounts).map(name => ({
          name,
          strategy: (accounts[name] && accounts[name].strategy) || []
        }))
      };
    } else {
      backupObj = {
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts,
        active: app.globalData.activeAccountName,
        providerStatus: app.globalData.providerStatus || {}
      };
    }
    const str = JSON.stringify(backupObj, null, 2);
    const fileName = `genius-trader-backup-${kind === 'strategy' ? 'strategy' : 'all'}-${app.globalData.shanghaiToday}.json`;
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
    const fs = wx.getFileSystemManager();
    // 导出统一降级：分享面板不可用/取消时，直接复制备份内容到剪贴板（用户粘贴保存为本地 .json 文件），
    // 与网页版「导出即得文件」一致 —— 不再弹失败提示（UI 一致性：无失败噪音，数据始终到手）
    const copyToClipboard = () => {
      wx.setClipboardData({
        data: str,
        success: () => wx.showToast({ title: '已复制备份内容，可粘贴保存为文件', icon: 'none' })
      });
    };
    fs.writeFile({
      filePath,
      data: str,
      encoding: 'utf8',
      success: () => {
        if (typeof wx.shareFileMessage === 'function') {
          wx.shareFileMessage({
            filePath,
            fileName,
            success: () => wx.showToast({ title: '请选择发送/保存位置', icon: 'none' }),
            fail: () => copyToClipboard()
          });
        } else {
          copyToClipboard();
        }
      },
      fail: () => wx.showToast({ title: '导出失败', icon: 'none' })
    });
  },

  // 从手机文件导入备份（wx.chooseMessageFile 从聊天会话选 json 文件）
  onImportBackup() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json', 'txt'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        const fs = wx.getFileSystemManager();
        fs.readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: (r) => {
            const str = (r.data || '').trim();
            if (!str || !str.startsWith('{')) {
              wx.showModal({
                title: '导入失败',
                content: '所选文件不是合法的备份 JSON，请重新选择。',
                showCancel: false
              });
              return;
            }
            this._applyBackupJson(str);
          },
          fail: () => wx.showToast({ title: '读取文件失败', icon: 'none' })
        });
      },
      fail: () => { /* 用户取消 */ }
    });
  },

  // 解析并确认覆盖导入备份 JSON（P1：兼容「投资策略」专用导出，只合并策略不覆盖持仓）
  _applyBackupJson(str) {
    let parsed;
    try {
      parsed = JSON.parse(str);
    } catch (e) {
      wx.showModal({
        title: '导入解析失败',
        content: '备份 JSON 数据格式有误或缺少有效账户，导入失败。',
        showCancel: false
      });
      return;
    }
    if (parsed && parsed.kind === 'strategy' && Array.isArray(parsed.strategies)) {
      // 投资策略专用备份：仅逐账户合并 strategy（不覆盖持仓/账户结构）
      wx.showModal({
        title: '导入策略确认',
        content: '导入将覆盖对应账户的「投资策略」，持仓与交易记录不受影响。是否导入？',
        confirmText: '导入覆盖',
        confirmColor: '#ff453a',
        success: (res) => {
          if (!res.confirm) return;
          const accounts = app.globalData.accounts || {};
          let applied = 0;
          parsed.strategies.forEach(item => {
            const acc = accounts[item.name];
            if (acc && Array.isArray(item.strategy)) {
              acc.strategy = item.strategy;
              applied++;
            }
          });
          if (applied === 0) {
            wx.showModal({
              title: '导入失败',
              content: '备份中未找到可匹配的账户（账户名需与当前一致），导入失败。',
              showCancel: false
            });
            return;
          }
          app.saveState();
          wx.showToast({ title: `已导入 ${applied} 个账户策略`, icon: 'success' });
          this.refreshData();
        }
      });
      return;
    }
    wx.showModal({
      title: '导入覆盖确认',
      content: '继续导入将永久覆盖当前小程序内所有持仓与历史账户。是否导入？',
      confirmText: '导入覆盖',
      confirmColor: '#ff453a',
      success: (res) => {
        if (res.confirm) {
          try {
            if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
              // 逐账户格式校验（与网页端 validData 对齐）：仅接受 name:string + funds:array 的账户，
              // 过滤掉随机文本/畸形条目，避免导入后程序崩溃
              const validAccounts = {};
              Object.keys(parsed.accounts).forEach(name => {
                const acc = parsed.accounts[name];
                if (acc && typeof acc === 'object' && typeof acc.name === 'string' && Array.isArray(acc.funds)) {
                  validAccounts[name] = acc;
                }
              });
              if (Object.keys(validAccounts).length === 0) throw new Error('无有效账户');
              app.globalData.accounts = validAccounts;
              app.globalData.activeAccountName = (parsed.active && validAccounts[parsed.active])
                ? parsed.active
                : Object.keys(validAccounts)[0];
              if (parsed.providerStatus && typeof parsed.providerStatus === 'object') {
                app.globalData.providerStatus = { ...app.globalData.providerStatus, ...parsed.providerStatus };
              }
              app.saveState();
              wx.showToast({ title: '备份数据导入成功', icon: 'success' });
              this.refreshData();
            } else {
              throw new Error('格式不规范');
            }
          } catch (e) {
            wx.showModal({
              title: '导入解析失败',
              content: '备份 JSON 数据格式有误或缺少有效账户，导入失败。',
              showCancel: false
            });
          }
        }
      }
    });
  }
});
