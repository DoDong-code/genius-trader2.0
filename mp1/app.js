// app.js
import { http, getAuthToken, setAuthToken, clearAuthToken } from './utils/request.js';
import { formatShanghaiTime } from './utils/formatTime.js';

const STORAGE_KEY = 'genius-trader-portfolio-v2';
const DATA_UPDATED_AT_KEY = 'genius-trader-data-updated-at';
const DATA_FRESHNESS_TTL_MS = 30 * 60 * 1000; // 30 分钟，与网页端一致

App({
  globalData: {
    accounts: {},
    activeAccountName: '主账户',
    shanghaiToday: '',
    statusBarHeight: 20,
    navBarHeight: 44,
    cloudReady: false,
    cloudError: null,
    cloudOpenId: '', // 微信云数据库自动写入的真实 _openid，用于「账户」展示
    auth: { token: '', user: null }, // 正式多用户登录态：{ token, user:{id, email} }；空 token = 游客模式 user_id=0
    authState: 'logged_out', // 认证状态机：authenticated | logging_out | logged_out（用于竞态防护）
    providerStatus: {
      yjbConnected: false,
      yjbLastSync: '—',
      xbyjConnected: false,
      xbyjLastSync: '—'
    },
    // 实验功能（隐藏「分析」tab）全局唯一运行时状态，所有 custom-tab-bar 实例共享。
    // storage 为持久化真值；globalData.experimentalMode 为当前运行时唯一状态。
    experimentalMode: Boolean(wx.getStorageSync('experimentalMode')),
    // custom-tab-bar 实例注册表：attached 时登记、detached 时注销，长按切换时统一广播。
    tabBarInstances: []
  },

  onLaunch() {
    // 0. Calculate system info for custom navigation bar
    try {
      let sysInfo = {};
      if (typeof wx.getWindowInfo === 'function') {
        sysInfo = wx.getWindowInfo();
      } else if (typeof wx.getSystemInfoSync === 'function') {
        sysInfo = wx.getSystemInfoSync();
      }
      this.globalData.statusBarHeight = sysInfo.statusBarHeight || 20;
    } catch (e) {
      console.warn('Failed to get system info:', e);
    }

    // 1. 已彻底移除 wx.cloud 依赖，云同步统一走后端 /api/account/state
    this.globalData.cloudReady = false;

    // 2. Initialize timezone-adjusted dates (Asia/Shanghai)
    this.initDate();

    // 3. Load or restore state (local first, instant)
    this.loadState();

    // 3b. If cloud sync is enabled, pull latest account data in background
    if (wx.getStorageSync('use_cloud_db')) {
      this.loadStateFromCloud()
        .then(synced => { if (synced) this.notifyAccountsChanged(); })
        .catch(() => {});
    }

    // 4. 恢复登录态（正式多用户：token → GET /api/auth/me）
    this.restoreAuth();
  },

  // 恢复登录态：有 token 则校验并进入正式用户模式，否则回游客模式（不删本地账户数据）
  async restoreAuth() {
    const token = getAuthToken();
    if (!token) {
      this.globalData.auth = { token: '', user: null };
      this.globalData.authState = 'logged_out';
      return;
    }
    try {
      const res = await http.get('/api/auth/me', null, { silent: true });
      if (res && res.user) {
        this.globalData.auth = { token, user: res.user };
        this.globalData.authState = 'authenticated';
        console.log('[Auth] restoring account state');
        // 登录用户：后台拉取该用户的云端 account/state
        this.loadStateFromCloud()
          .then(synced => {
            console.log('[Auth] account state restored =', synced);
            if (synced) this.notifyAccountsChanged();
            // 恢复第三方真实连接状态（account/state 里的 providerStatus 可能是陈旧快照）
            this.refreshProviderStatus().catch(() => {});
          })
          .catch(() => {});
      } else {
        clearAuthToken();
        this.globalData.auth = { token: '', user: null };
        this.globalData.authState = 'logged_out';
      }
    } catch (e) {
      clearAuthToken();
      this.globalData.auth = { token: '', user: null };
      this.globalData.authState = 'logged_out';
    }
  },

  // 正式登录：邮箱+密码 → 保存 token → 强制从云端恢复当前账号账户
  // 返回 { user, cloudSynced }：cloudSynced=true 表示已从云端恢复数据；false 表示云端无 state 或拉取失败（本地保留，等待用户选择是否保存）
  async login(email, password) {
    console.log('[Auth] login start');
    const res = await http.post('/api/auth/login', { email, password });
    if (!res || !res.token) {
      throw new Error((res && res.error) || '登录失败');
    }
    setAuthToken(res.token);
    this.globalData.auth = { token: res.token, user: res.user || null };
    this.globalData.authState = 'authenticated';
    console.log('[Auth] login success');
    // ═══ 临时调试：登录身份确认（诊断后删除）═══
    console.log('[Login-Debug] auth set | user_id =', res.user && res.user.id, '| email =', res.user && res.user.email, '| token len =', (res.token || '').length);
    // 登录成功：force=true 强制用云端覆盖本地（忽略本地 updatedAt 时间戳保护，云端为权威）。
    // 安全规则：云端有数据 → 覆盖本地；云端无数据 → 保留本地、不自动 PUT、不自动迁移、不自动清空。
    let cloudSynced = false;
    try {
      cloudSynced = await this.loadStateFromCloud(true);
      console.log('[Auth] account state restored =', cloudSynced);
      // ═══ 临时调试：登录后账户恢复确认（诊断后删除）═══
      console.log('[Login-Debug] cloud restore =', cloudSynced, '| accounts keys =', Object.keys(this.globalData.accounts || {}).length, '| active =', this.globalData.activeAccountName);
      if (cloudSynced) this.notifyAccountsChanged();
      // 恢复第三方真实连接状态（account/state 里的 providerStatus 可能是陈旧快照）
      await this.refreshProviderStatus();
      console.log('[Auth] provider state restored');
    } catch (e) { /* 云端无数据/拉取失败不影响登录 */ }
    return { user: res.user, cloudSynced };
  },

  // 检测本地是否有「实际账户/持仓数据」（空主账户不算；有基金持仓才算）
  // 用于登录/注册后判断是否需要提示「本机有未同步数据」
  hasLocalGuestData() {
    try {
      const saved = wx.getStorageSync(STORAGE_KEY);
      if (!saved || !saved.accounts || typeof saved.accounts !== 'object') return false;
      return Object.keys(saved.accounts).some(name => {
        const acc = saved.accounts[name];
        return acc && Array.isArray(acc.funds) && acc.funds.length > 0;
      });
    } catch (e) { return false; }
  },

  // 退出登录：强制同步 → 退第三方 → auth logout → 清本地 → logged_out。
  // forceClear=true（用户「仍然退出」）：跳过强制同步，直接清理。
  // 返回 { syncOk, done }：syncOk=false 且 done=false 表示强制同步失败、未清理（调用方应提示「是否仍然退出」）。
  async logout(forceClear = false) {
    console.log('[Logout] start');
    const authUser = this.globalData.auth && this.globalData.auth.user;
    if (!authUser) {
      console.log('[Logout] already logged out');
      return { syncOk: true, done: true };
    }
    this.globalData.authState = 'logging_out';

    // 1. 强制同步（先保存最新数据，此时第三方仍为 connected 状态；不受 localUpdatedAt/cloudUpdatedAt 影响）
    let syncOk = true;
    if (!forceClear) {
      console.log('[Logout] force sync start');
      try { syncOk = await this.saveStateToCloud(true); } catch (e) { syncOk = false; console.warn('[Logout] force sync failed:', e); }
      console.log('[Logout] force sync success =', syncOk);
      console.log('[Sync] sync completedAt =', Date.now());
    }
    if (!syncOk) {
      // 同步失败：不清理数据，回退状态，交还调用方提示「是否仍然退出」
      this.globalData.authState = 'authenticated';
      return { syncOk: false, done: false };
    }

    // 2. 退出自动备份（await 完成后才继续：此刻 token 仍有效、globalData.accounts 仍在内存，
    //    避免「backup 未 await → auth logout/清本地 → 备份丢失」的时序问题）。
    //    备份绑定当前 user_id，用户重新登录后可在「备份与恢复」列表中看到（reason=logout → 显示「退出前」）。
    let backupOk = false;
    if (!forceClear) {
      console.log('[Logout] auto backup start');
      try {
        await http.post('/api/account/backups', {
          state: {
            accounts: this.globalData.accounts,
            active: this.globalData.activeAccountName,
            providerStatus: this.globalData.providerStatus || {},
            updatedAt: Date.now()
          },
          reason: 'logout'
        }, { silent: true });
        backupOk = true;
        console.log('[Logout] auto backup success');
      } catch (e) {
        backupOk = false;
        console.warn('[Logout] auto backup FAILED:', e && e.message);
      }
    }

    // 2b. 第三方凭证云端保留（不调 /api/provider/*/logout）：
    //    重新登录同一账号时按 user_id 从 source_credentials 恢复第三方登录态。
    //    用户主动解绑请用设置页「退出养基宝 / 退出小倍养基」按钮。
    // ═══ 临时验证日志：确认退出时第三方凭证保留（不打印 token，诊断后删除）═══
    console.log('[Verify] logout: 保留第三方凭证（跳过 provider logout），重新登录后可恢复');

    // 3. auth logout（失败也不阻止进入 logged_out）
    console.log('[Logout] auth logout');
    const token = getAuthToken();
    try { if (token) await http.post('/api/auth/logout', null, { silent: true }); } catch (e) { console.warn('[Logout] auth logout failed:', e && e.message); }
    clearAuthToken();

    // 4. 清理本地用户数据
    console.log('[Logout] local state cleared');
    this._clearLocalUserData();

    // 5. logged_out
    this.globalData.auth = { token: '', user: null };
    this.globalData.authState = 'logged_out';
    console.log('[Logout] state = logged_out');
    return { syncOk: true, done: true, backupOk };
  },

  // 清理当前用户相关本地数据，恢复「未登录默认状态」。
  // 保留公共配置：api_base_url / ai 配置 / experimentalMode / estimate_source / columnOrder / user_info 等（与用户无关的数据不删）。
  _clearLocalUserData() {
    this.globalData.accounts = { '主账户': { name: '主账户', funds: [] } };
    this.globalData.activeAccountName = '主账户';
    this.globalData.providerStatus = {
      yjbConnected: false, yjbLastSync: '—',
      xbyjConnected: false, xbyjLastSync: '—'
    };
    try {
      wx.setStorageSync(STORAGE_KEY, {
        accounts: this.globalData.accounts,
        active: '主账户',
        updatedAt: Date.now()
      });
      wx.removeStorageSync('cloud_last_sync');
      wx.removeStorageSync('use_cloud_db');
    } catch (e) {
      console.warn('[Logout] clear local storage failed:', e);
    }
  },

  initDate() {
    const formatTwo = n => String(n).padStart(2, '0');
    // Compute Shanghai Date (UTC+8)
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const shanghaiTime = new Date(utc + 3600000 * 8);
    const y = shanghaiTime.getFullYear();
    const m = formatTwo(shanghaiTime.getMonth() + 1);
    const d = formatTwo(shanghaiTime.getDate());
    this.globalData.shanghaiToday = `${y}-${m}-${d}`;
    console.log('[App] Date Initialized (Shanghai Timezone):', this.globalData.shanghaiToday);
  },

  loadState() {
    try {
      const saved = wx.getStorageSync(STORAGE_KEY);
      if (saved && saved.accounts && typeof saved.accounts === 'object') {
        this.globalData.accounts = saved.accounts;
        this.globalData.activeAccountName = saved.active || Object.keys(saved.accounts)[0] || '主账户';
        // 基金实体一致性校验（仅上报，不删除用户数据）
        let localOrphans = 0;
        Object.values(this.globalData.accounts).forEach(acc => { localOrphans += this.normalizeAccountFunds(acc); });
        if (localOrphans > 0) console.warn('[C-Debug] 本地账户检测到孤立基金数据共', localOrphans, '条（仅上报，未删除）');
        console.log('[App] State restored from LocalStorage.');
        return;
      }
    } catch (e) {
      console.warn('[App] LocalStorage restore failed:', e);
    }

    // Default Fallback Accounts（产品化：全新用户 = 空主账户，不创建任何 mock 持仓）
    console.log('[App] Loading empty default account.');
    this.globalData.accounts = {
      '主账户': {
        name: '主账户',
        funds: []
      }
    };
    this.globalData.activeAccountName = '主账户';
    this.saveState();
  },

  saveState() {
    try {
      wx.setStorageSync(STORAGE_KEY, {
        accounts: this.globalData.accounts,
        active: this.globalData.activeAccountName,
        updatedAt: Date.now()
      });
    } catch (e) {
      console.error('[App] Local state persistence failed:', e);
    }
    // 手动同步模式：不再每次改动自动同步云端，由用户点「立即同步」显式推送
  },

  // ---------- Cloud Account Sync (mirrors accounts to Render backend) ----------
  // 统一走后端 /api/account/state（POST/GET），userId 由后端 session 或匿名(0)决定。
  // 已彻底移除 wx.cloud.database 依赖。
  async saveStateToCloud(force = false) {
    // 竞态防护：logged_out 状态禁止发起账户请求（退出后旧请求不能再写回）
    if (this.globalData.authState === 'logged_out') {
      console.warn('[Auth] logged_out, block account request');
      return false;
    }
    // 手动同步模式：不再因 use_cloud_db 关闭而跳过，用户点「立即同步」即推送
    // 串行化：先等上一次写完成（避免并发覆盖），再起一个新写用最新 accounts
    while (this._cloudSavePending) {
      try { await this._cloudSavePending; } catch (e) { /* ignore */ }
    }

    this._cloudSavePending = (async () => {
      // 在 IIFE 内重新读取全局状态，确保拿到的是调用瞬间的最新值
      const payload = {
        accounts: this.globalData.accounts,
        active: this.globalData.activeAccountName,
        providerStatus: this.globalData.providerStatus || {},
        updatedAt: Date.now()
      };
      try {
        await http.put('/api/account/state', { state: payload }, { silent: true });
        // 记录最近一次同步时间
        try { wx.setStorageSync('cloud_last_sync', Date.now()); } catch (e) { /* ignore */ }
        console.log('[Sync] 同步成功，账户数 =', Object.keys(payload.accounts || {}).length);
        return true;
      } catch (e) {
        console.warn('[Sync] 保存云端状态失败:', e);
        return false;
      }
    })();

    try {
      return await this._cloudSavePending;
    } finally {
      this._cloudSavePending = null;
    }
  },

  // 从云端拉取账户状态。
  // force=true（登录成功后强制恢复当前账号）：忽略本地 updatedAt 时间戳保护，云端数据为权威，直接覆盖本地。
  // force=false（游客手动「恢复本地」/ 启动恢复）：保留时间戳保护，避免已删账户被云端拉回。
  async loadStateFromCloud(force = false) {
    // 竞态防护：只有 authenticated 才允许拉取账户数据（logging_out/logged_out 均禁止，防止退出后旧请求写回）
    if (this.globalData.authState !== 'authenticated') {
      console.warn('[Auth] not authenticated, block account request');
      return false;
    }
    try {
      const res = await http.get('/api/account/state', null, { silent: true });
      const doc = res && res.state;
      if (doc && doc.accounts && typeof doc.accounts === 'object') {
        console.log('[Sync] 读到的账户数 =', Object.keys(doc.accounts).length, '账户名 =', Object.keys(doc.accounts).join(','));
        // 时间戳保护（仅非 force 场景）：本地比云端新（例如刚删过账户但云端写入失败/未完成），保留本地、不覆盖
        if (!force) {
          let localUpdatedAt = 0;
          try {
            const saved = wx.getStorageSync(STORAGE_KEY);
            localUpdatedAt = (saved && saved.updatedAt) ? Number(saved.updatedAt) : 0;
          } catch (e) { /* ignore */ }
          const cloudUpdatedAt = Number(doc.updatedAt) || 0;
          console.log('[Sync] 时间戳比较 cloudUpdatedAt =', cloudUpdatedAt, 'localUpdatedAt =', localUpdatedAt);
          if (cloudUpdatedAt <= localUpdatedAt && localUpdatedAt > 0) {
            console.warn('[Sync] 本地比云端新，保留本地、不覆盖');
            return false; // 本地更新，保留本地，避免已删账户被云端拉回
          }
        }
        // 写入前再次检查（防退出后旧响应写回）
        if (this.globalData.authState !== 'authenticated') {
          console.warn('[Auth] not authenticated, block account state write');
          return false;
        }
        this.globalData.accounts = doc.accounts;
        this.globalData.activeAccountName = doc.active || Object.keys(doc.accounts)[0] || '主账户';
        // 基金实体一致性校验（仅上报，不删除用户数据）
        let cloudOrphans = 0;
        Object.values(this.globalData.accounts).forEach(acc => { cloudOrphans += this.normalizeAccountFunds(acc); });
        if (cloudOrphans > 0) console.warn('[C-Debug] 云端账户检测到孤立基金数据共', cloudOrphans, '条（仅上报，未删除）');
        if (doc.providerStatus && typeof doc.providerStatus === 'object') {
          this.globalData.providerStatus = { ...this.globalData.providerStatus, ...doc.providerStatus };
        }
        // Mirror cloud -> local so offline still works（updatedAt 使用云端值）
        try {
          wx.setStorageSync(STORAGE_KEY, {
            accounts: this.globalData.accounts,
            active: this.globalData.activeAccountName,
            updatedAt: Number(doc.updatedAt) || Date.now()
          });
        } catch (e) { /* ignore */ }
        return true;
      }
    } catch (e) {
      console.warn('[App] Load accounts from server failed:', e);
    }
    return false;
  },

  // Called when user enables cloud sync in Settings:
  // pull cloud data if present (source of truth across devices),
  // otherwise seed the cloud with the current local accounts.
  async enableCloudSync() {
    const synced = await this.loadStateFromCloud();
    let saved = false;
    if (!synced) {
      // 首次启用云端同步时 use_cloud_db 尚未写入，需要强制保存
      saved = await this.saveStateToCloud(true);
    }
    if (!synced && !saved) {
      throw new Error('服务器同步不可用，请检查后端服务是否正常。');
    }
    this.notifyAccountsChanged();
    return true;
  },

  notifyAccountsChanged() {
    const pages = getCurrentPages() || [];
    pages.forEach(p => {
      if (p && typeof p.refreshData === 'function') {
        try { p.refreshData(); } catch (e) { /* ignore */ }
      }
    });
  },

  // 当前账户的展示标识：优先真实微信 openid（云端），否则本地 mock openid
  getUserId() {
    return this.globalData.cloudOpenId || wx.getStorageSync('user_openid') || '';
  },

  // 更新第三方基金同步状态（养基宝 / 小倍养基）并尝试同步到云端
  // 注意：真实的登录凭证（Session / Cookie）保存在后端，这里只同步连接状态与最后同步时间
  updateProviderStatus(status) {
    if (!status || typeof status !== 'object') return;
    const prev = JSON.stringify(this.globalData.providerStatus);
    this.globalData.providerStatus = { ...this.globalData.providerStatus, ...status };
    if (JSON.stringify(this.globalData.providerStatus) !== prev) {
      this.saveStateToCloud().catch(e => console.warn('[App] Provider status cloud sync failed:', e));
    }
  },

  // 刷新第三方真实连接状态（查询后端 /api/provider/:source/status），
  // 用于登录/恢复后校准 account/state 里可能陈旧的 providerStatus 快照。
  async refreshProviderStatus() {
    const fetch = (key) => http.get(`/api/provider/${key}/status`, null, { silent: true })
      .then(res => {
        const connected = Boolean(res && res.logged_in);
        const last = (res && res.last_sync_at) ? formatShanghaiTime(res.last_sync_at) : '—';
        return { connected, last };
      })
      .catch(() => ({ connected: false, last: '—' }));
    const [yjb, xbyj] = await Promise.all([fetch('yangjibao'), fetch('xiaobeiyangji')]);
    const status = {
      yjbConnected: yjb.connected,
      yjbLastSync: yjb.last,
      xbyjConnected: xbyj.connected,
      xbyjLastSync: xbyj.last
    };
    this.globalData.providerStatus = { ...this.globalData.providerStatus, ...status };
    // ═══ 临时验证日志：只打连接状态布尔值，不打 token（诊断后删除）═══
    console.log('[Verify] provider status restored | yjbConnected =', status.yjbConnected, '| xbyjConnected =', status.xbyjConnected, '| yjbLastSync =', status.yjbLastSync, '| xbyjLastSync =', status.xbyjLastSync);
    return status;
  },

  // ---------- 数据新鲜度（与网页端 sessionStorage 逻辑对齐）----------
  // 记录最近一次成功刷新行情/持仓估值数据的时间戳
  setDataUpdatedAt() {
    try {
      wx.setStorageSync(DATA_UPDATED_AT_KEY, String(Date.now()));
    } catch (e) {
      console.warn('[App] Set data updated-at failed:', e);
    }
  },

  // 读取时间戳并校验 30 分钟过期；返回有效时间戳或 null
  getDataUpdatedAt() {
    try {
      const raw = wx.getStorageSync(DATA_UPDATED_AT_KEY);
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts > Date.now() || Date.now() - ts > DATA_FRESHNESS_TTL_MS) {
        return null;
      }
      return ts;
    } catch (e) {
      return null;
    }
  },

  // 返回给 UI 展示的“X 分钟前”文案；null 表示已过期/未刷新
  getDataUpdatedText() {
    const ts = this.getDataUpdatedAt();
    if (!ts) return null;
    const minutes = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (minutes < 60) return `数据更新 · ${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `数据更新 · ${hours} 小时${rem > 0 ? rem + ' 分钟' : ''}前`;
  },

  // Helper getters/setters
  getActiveAccount() {
    return this.globalData.accounts[this.globalData.activeAccountName] || { name: '未知账户', funds: [] };
  },

  setActiveAccount(name) {
    if (this.globalData.accounts[name]) {
      this.globalData.activeAccountName = name;
      this.saveState();
      return true;
    }
    return false;
  },

  // 是否同步账户（对齐 Web app-refactor.js:25 isSyncAccount）
  isSyncAccount(acc) {
    return Boolean(acc && (acc.accountType === 'sync' || (!acc.accountType && acc.__source)));
  },

  // 同步账户 → 本地账户（解除同步，保留数据与来源记录；对齐 Web app-refactor.js:29 convertAccountToLocal）
  // 用于：同步账户改名/移动后转本地管理，不再自动同步；再次同步需用户手动触发。
  convertAccountToLocal(acc) {
    if (!acc || !this.isSyncAccount(acc)) return;
    acc.originalSource = acc.syncSource || acc.__source || 'sync';
    acc.accountType = 'local';
    acc.syncSource = null;
    acc.convertedFromSync = true;
    acc.convertedTime = new Date().toISOString();
    delete acc.__source;
  },

  addAccount(name) {
    if (!name || this.globalData.accounts[name]) return false;
    this.globalData.accounts[name] = {
      name: name,
      portfolioDataVersion: '20260731-account2-corrected-v2',
      snapshotDate: this.globalData.shanghaiToday,
      strategy: [],
      closedPositions: [],
      funds: []
    };
    this.saveState();
    return true;
  },

  // 新建子账户（parentName 为父账户名；子账户带 parent 标记，父账户维护 children 列表）
  addSubAccount(parentName, childName) {
    if (!childName || this.globalData.accounts[childName]) return false;
    const parent = this.globalData.accounts[parentName];
    if (!parent) return false;
    this.globalData.accounts[childName] = {
      name: childName,
      parent: parentName,
      portfolioDataVersion: '20260731-account2-corrected-v2',
      snapshotDate: this.globalData.shanghaiToday,
      strategy: [],
      closedPositions: [],
      funds: []
    };
    parent.children = parent.children || [];
    if (!parent.children.includes(childName)) parent.children.push(childName);
    this.saveState();
    return true;
  },

  // 把父账户持仓按板块拆分为多个子账户（父账户只保留汇总，持仓下沉到子账户）
  splitAccountBySector(parentName) {
    const parent = this.globalData.accounts[parentName];
    if (!parent || !Array.isArray(parent.funds) || !parent.funds.length) return 0;

    const sectorNameOf = (f) => {
      const MAP = {
        '019633': '半导体', '008702': '黄金', '013309': '恒生科技',
        '007339': '沪深300', '014002': '全球科技', '022184': '全球科技'
      };
      return MAP[f.code] || f.category || f.sector || '其他';
    };

    const groups = {};
    parent.funds.forEach(f => {
      const sector = sectorNameOf(f);
      (groups[sector] = groups[sector] || []).push(f);
    });

    parent.children = parent.children || [];
    Object.keys(groups).forEach(sector => {
      const childName = `${parentName}-${sector}`;
      if (!this.globalData.accounts[childName]) {
        this.globalData.accounts[childName] = {
          name: childName, parent: parentName,
          portfolioDataVersion: '20260731-account2-corrected-v2',
          snapshotDate: this.globalData.shanghaiToday,
          strategy: [], closedPositions: [], funds: []
        };
      }
      this.globalData.accounts[childName].funds = groups[sector];
      if (!parent.children.includes(childName)) parent.children.push(childName);
    });
    parent.funds = [];
    this.saveState();
    return Object.keys(groups).length;
  },

  // 删除子账户：持仓合并回父账户，父账户总资产不减少（纯本地，云端由「立即同步」手动推送）
  deleteSubAccount(childName) {
    const child = this.globalData.accounts[childName];
    if (!child || !child.parent) return false;
    const parent = this.globalData.accounts[child.parent];
    if (parent) {
      // 合并回父账户（对齐 Web mergeFundsInto：同 code 加 amount/收益，重算 rate，流水去重）
      this.mergeFundsInto(parent, child.funds);
      if (Array.isArray(parent.children)) {
        const i = parent.children.indexOf(childName);
        if (i !== -1) parent.children.splice(i, 1);
      }
    }
    delete this.globalData.accounts[childName];
    if (this.globalData.activeAccountName === childName) {
      this.globalData.activeAccountName = parent ? parent.name : (Object.keys(this.globalData.accounts)[0] || '');
    }
    this.saveState();
    return true;
  },

  // 移动/合并账户：把 sources 的持仓合并进 target，可选保留原账户
  moveAccounts(sources, targetName, keep) {
    const target = this.globalData.accounts[targetName];
    if (!target) return false;
    // 涉及同步账户：先转为本地账户（解除同步），对齐 Web app-refactor.js:3254-3275
    // 小程序无服务端账户体系，无需 /api/portfolio/rename 休眠，仅本地 convertAccountToLocal 即达成业务结果等价
    const involved = sources.map(name => this.globalData.accounts[name]).concat([target]).filter(Boolean);
    involved.forEach(acc => { this.convertAccountToLocal(acc); });
    sources.forEach(name => {
      const src = this.globalData.accounts[name];
      if (!src || name === targetName) return;
      // 合并持仓（对齐 Web mergeFundsInto：同 code 加 amount/收益，重算 rate，流水去重）
      this.mergeFundsInto(target, src.funds);
      if (!keep) {
        Object.values(this.globalData.accounts).forEach(a => {
          if (Array.isArray(a.children)) {
            const i = a.children.indexOf(name);
            if (i !== -1) a.children.splice(i, 1);
          }
        });
        if (src.parent) {
          const p = this.globalData.accounts[src.parent];
          if (p && Array.isArray(p.children)) {
            const i = p.children.indexOf(name);
            if (i !== -1) p.children.splice(i, 1);
          }
          delete src.parent;
        }
        delete this.globalData.accounts[name];
      }
    });
    this.saveState();
    return true;
  },

  // 合并持仓到目标账户（对齐 Web app-refactor.js:109-131 mergeFundsInto）
  // 同 code：amount + holdingProfit + shares 相加，重算 holdingRate/hold；transactions 去重后 unshift
  mergeFundsInto(target, funds) {
    (funds || []).forEach(cf => {
      const existing = (target.funds || []).find(pf => pf.code === cf.code);
      if (existing) {
        existing.amount = (Number(existing.amount) || 0) + (Number(cf.amount) || 0);
        existing.holdingProfit = (Number(existing.holdingProfit ?? existing.profit) || 0) + (Number(cf.holdingProfit ?? cf.profit) || 0);
        existing.shares = (Number(existing.shares) || 0) + (Number(cf.shares) || 0);
        const costBasis = (Number(existing.amount) || 0) - (Number(existing.holdingProfit) || 0);
        existing.holdingRate = costBasis > 0 ? existing.holdingProfit / costBasis : 0;
        existing.hold = existing.holdingRate;
        (cf.transactions || []).forEach(t => {
          const dup = (existing.transactions || []).some(x => x.type === t.type && x.date === t.date && Math.abs((x.amount || 0) - (t.amount || 0)) < 0.01);
          if (!dup) {
            existing.transactions = existing.transactions || [];
            existing.transactions.unshift(t);
          }
        });
      } else {
        target.funds = target.funds || [];
        target.funds.push(cf);
      }
    });
  },

  // 基金实体数据一致性校验（C1/C2）：一个基金必须同时拥有 code 与 name。
  // 仅检测并上报孤立数据（code 或 name 缺失），不擅自删除用户数据（数据安全原则）。
  normalizeAccountFunds(account) {
    if (!account || !Array.isArray(account.funds)) return 0;
    let orphans = 0;
    account.funds.forEach(f => {
      const hasCode = typeof f.code === 'string' && f.code.trim().length > 0;
      const hasName = typeof f.name === 'string' && f.name.trim().length > 0;
      if (!hasCode || !hasName) {
        orphans += 1;
        console.warn('[C-Debug] 孤立基金数据 | account =', account.name, '| code =', JSON.stringify(f.code), '| name =', JSON.stringify(f.name));
      }
    });
    return orphans;
  },

  deleteAccount(name) {
    if (!this.globalData.accounts[name]) return false;
    delete this.globalData.accounts[name];
    if (this.globalData.activeAccountName === name) {
      this.globalData.activeAccountName = Object.keys(this.globalData.accounts)[0] || '';
    }
    this.saveState();
    return true;
  },

  // 修改账户名称：本地账户直接改 key；同步账户改名 = 用户主动修改 → 先转本地（解除同步）
  // 对齐 Web：同步账户改名后 accountType='local'、syncSource=null、convertedFromSync=true，不再自动同步
  renameAccount(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    const accounts = this.globalData.accounts;
    if (!accounts[oldName]) return false;
    if (accounts[newName]) return false; // 新名称已存在
    const acc = accounts[oldName];
    // 同步账户改名 → 转本地（解除同步，保留数据与来源记录）
    this.convertAccountToLocal(acc);
    // 迁移到新 key
    accounts[newName] = acc;
    acc.name = newName;
    delete accounts[oldName];
    // 更新所有 parent/children 引用
    Object.values(accounts).forEach(a => {
      if (Array.isArray(a.children)) {
        const i = a.children.indexOf(oldName);
        if (i !== -1) a.children[i] = newName;
      }
      if (a.parent === oldName) a.parent = newName;
    });
    if (this.globalData.activeAccountName === oldName) {
      this.globalData.activeAccountName = newName;
    }
    this.saveState();
    return true;
  },

  addFund(accountName, fund) {
    const account = this.globalData.accounts[accountName];
    if (!account) return false;
    if (!account.funds) account.funds = [];
    
    // Check if fund already exists
    const exists = account.funds.find(f => f.code === fund.code);
    if (exists) return false;

    account.funds.push(fund);
    this.saveState();
    return true;
  },

  deleteFund(accountName, fundCode) {
    const account = this.globalData.accounts[accountName];
    if (!account) return false;
    if (!account.funds) return false;

    const index = account.funds.findIndex(f => f.code === fundCode);
    if (index !== -1) {
      account.funds.splice(index, 1);
      this.saveState();
      return true;
    }
    return false;
  }
});
