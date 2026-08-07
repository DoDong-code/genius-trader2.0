/**
 * 小倍养基 Provider（手机号 + 短信验证码登录）
 *
 * 参考 FundVal-Live 的 XiaoBeiYangJiSource 接口语义实现：
 * - /yangji-api/api/send-sms                发送短信验证码
 * - /yangji-api/api/login/phone             验证码登录（返回 accessToken + unionId）
 * - /yangji-api/api/get-account-list        账户分组列表
 * - /yangji-api/api/get-hold-list           全部持仓（按 accountId 分组）
 * - /yangji-api/api/get-optional-change-nav 批量估值（用于推算份额）
 */
const BaseProvider = require('./baseProvider');

class XiaoBeiYangJiProvider extends BaseProvider {
  constructor() {
    super();
    this.sourceName = 'xiaobeiyangji';
    this.displayName = '小倍养基';
    this.BASE_URL = process.env.XBYJ_BASE_URL || 'https://api.xiaobeiyangji.com';
    this.VERSION = process.env.XBYJ_VERSION || '3.5.7.0';
    this._unionId = null;
  }

  getLoginType() {
    return 'phone';
  }

  setToken(token) {
    this._token = token;
    this._unionId = this._parseUnionId(token);
  }

  _parseUnionId(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    try {
      const payload = token.split('.')[1];
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return json.unionId || null;
    } catch (e) {
      return null;
    }
  }

  _commonBody() {
    return {
      unionId: this._unionId,
      version: this.VERSION,
      clientType: 'APP'
    };
  }

  async _request(method, path, body) {
    const response = await fetch(this.BASE_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token || ''}`,
        // 贴近官方 App 的客户端指纹，部分接口会校验
        'User-Agent': 'okhttp/4.9.0',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const err = new Error(`小倍养基接口请求失败 (HTTP ${response.status})`);
      if (response.status === 401) err.statusCode = 401;
      throw err;
    }
    const result = await response.json();
    if (result.code !== 200) {
      const err = new Error(result.msg || '小倍养基接口返回错误');
      console.error(`[xiaobeiyangji] ${path} 返回错误: code=${result.code} msg=${result.msg}`);
      if (/未登录|登录已过期|token/i.test(err.message)) err.statusCode = 401;
      throw err;
    }
    return result.data;
  }

  async sendSMS(phone) {
    await this._request('POST', '/yangji-api/api/send-sms', {
      phoneNumber: String(phone),
      isBind: false,
      version: this.VERSION,
      clientType: 'APP'
    });
  }

  async verifySMS(phone, code) {
    const data = await this._request('POST', '/yangji-api/api/login/phone', {
      phone: String(phone),
      code: String(code),
      clientType: 'PHONE',
      version: this.VERSION
    });
    if (!data || !data.accessToken) throw new Error('小倍养基登录返回数据缺少 accessToken');
    this.setToken(data.accessToken);
    return {
      token: data.accessToken,
      user_info: data.user || null
    };
  }

  async fetchAccounts() {
    this._requireLogin();
    const data = await this._request('POST', '/yangji-api/api/get-account-list', this._commonBody());
    const list = (data && data.accountList) || [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(item => item)
      .map(item => ({
        account_id: item.accountId === null || item.accountId === undefined ? '' : String(item.accountId),
        name: String(item.name || '默认账户')
      }));
  }

  async fetchHoldings() {
    this._requireLogin();
    const data = await this._request('POST', '/yangji-api/api/get-hold-list', this._commonBody());
    const items = ((data && data.list) || []).filter(item => item && item.money);
    if (!items.length) return [];

    const codes = items.map(item => String(item.code));
    let navMap = new Map();
    try {
      const navList = await this._getOptionalChangeNav(codes);
      navMap = new Map(
        (navList || [])
          .filter(item => item && item.nav)
          .map(item => [String(item.code), Number(item.nav)])
      );
    } catch (e) {
      // 估值接口失败时份额按 0 处理
    }

    return items.map(item => {
      const code = String(item.code || '');
      const money = Number(item.money);
      const earnings = Number(item.earnings || 0);
      const nav = navMap.get(code) || 0;
      const share = nav > 0 ? money / nav : 0;
      return {
        fund_code: code,
        fund_name: String((item.data && item.data.name) || ''),
        share,
        nav,
        amount: money,
        earnings,
        operation_date: item.headDate ? String(item.headDate) : new Date().toISOString().slice(0, 10),
        account_id: item.accountId === null || item.accountId === undefined || item.accountId === 0 || item.accountId === '0'
          ? null
          : String(item.accountId)
      };
    });
  }

  async _getOptionalChangeNav(codes) {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const toDate = d => d.toISOString().slice(0, 10);
    const body = {
      dataResources: '4',
      dataSourceSwitch: true,
      valuationDate: toDate(today),
      navDate: toDate(yesterday),
      isTD: true,
      codeArr: codes,
      ...this._commonBody()
    };
    return this._request('POST', '/yangji-api/api/get-optional-change-nav', body);
  }

  async _getFundDetail(fundCode) {
    const body = {
      code: String(fundCode),
      accountId: 0,
      dataResources: '4',
      dataSourceSwitch: true,
      isHasPosition: true,
      fromType: 'home',
      ...this._commonBody()
    };
    return this._request('POST', '/yangji-api/api/get-fund-detail-v310', body);
  }

  async fetch_estimate(fundCode) {
    this._requireLogin();
    try {
      const navList = await this._getOptionalChangeNav([String(fundCode)]);
      const item = (navList || []).find(x => String(x.code) === String(fundCode));
      if (!item) return null;
      const valuation = Number(item.valuation);
      const valuationY = Number(item.valuationY);
      const nav = Number(item.nav);
      const navY = Number(item.navY);

      let estimateNav;
      let estimateGrowth;
      if (Number.isFinite(valuation) && valuation !== 0) {
        estimateNav = valuation;
        estimateGrowth = Number.isFinite(valuationY) ? valuationY * 100 : null;
      } else if (Number.isFinite(nav) && nav !== 0) {
        estimateNav = nav;
        estimateGrowth = Number.isFinite(navY) ? navY * 100 : null;
      } else {
        return null;
      }
      if (!Number.isFinite(estimateNav) || estimateGrowth === null || !Number.isFinite(estimateGrowth)) {
        return null;
      }

      let fundName = '';
      try {
        const detail = await this._getFundDetail(fundCode);
        fundName = String((detail && detail.name) || '');
      } catch (e) { /* 名称获取失败不影响估值 */ }

      return {
        fund_code: String(fundCode),
        fund_name: fundName,
        estimate_nav: estimateNav,
        estimate_time: new Date().toISOString(),
        estimate_growth: estimateGrowth
      };
    } catch (e) {
      return null;
    }
  }

  logout() {
    this._token = null;
    this._unionId = null;
  }
}

module.exports = XiaoBeiYangJiProvider;
