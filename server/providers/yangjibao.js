/**
 * 养基宝 Provider（二维码扫码登录）
 *
 * 参考 FundVal-Live 的 YangJiBaoSource 接口语义实现，按 Node.js 风格重写：
 * - /qr_code            获取登录二维码
 * - /qr_code_state/{id} 轮询扫码状态（1 等待 / 2 已确认返回 token / 3 过期）
 * - /user_account       账户列表
 * - /fund_hold         指定账户持仓
 *
 * 请求签名：md5(pathname + path + token + timestamp + SECRET)
 */
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const BaseProvider = require('./baseProvider');
// Phase 3.3-H：provider 出站请求经全局并发闸门（与股票行情/Yahoo 共享同一把锁），
// 封住"第二条无界外部 HTTP 路径"——providerEstimate 的 per-fund 兜底 tryProviderEstimate
// 在冷缓存/批量预取失败时可能 fan-out 至 2×基金数且不受限。
const { withLimit } = require('../services/concurrencyLimit');

class YangJiBaoProvider extends BaseProvider {
  constructor() {
    super();
    this.sourceName = 'yangjibao';
    this.displayName = '养基宝';
    this.BASE_URL = process.env.YJB_BASE_URL || 'http://browser-plug-api.yangjibao.com';
    this.SECRET = process.env.YJB_SECRET || 'YxmKSrQR4uoJ5lOoWIhcbd7SlUEh9OOc';
  }

  getLoginType() {
    return 'qrcode';
  }

  _generateSign(path, timestamp) {
    const signPath = String(path).split('?')[0];
    const signStr = `${signPath}${this._token || ''}${timestamp}${this.SECRET}`;
    return crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
  }

  async _request(method, path, body) {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'Request-Time': String(timestamp),
      'Request-Sign': this._generateSign(path, timestamp),
      'Content-Type': 'application/json'
    };
    if (this._token) headers.Authorization = this._token;

    // Phase 3.3-H：provider 出站请求经全局并发闸门（与股票行情/Yahoo 共享同一把锁），
    // 封住"第二条无界外部 HTTP 路径"——providerEstimate 的 per-fund 兜底 tryProviderEstimate
    // 在冷缓存/批量预取失败时可能 fan-out 至 2×基金数且不受限。
    const result = await withLimit(async () => {
      const response = await fetch(this.BASE_URL + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) {
        const err = new Error(`养基宝接口请求失败 (HTTP ${response.status})`);
        if (response.status === 401) err.statusCode = 401;
        throw err;
      }
      return response.json();
    });
    if (result.code !== 200) {
      const err = new Error(result.message || '养基宝接口返回错误');
      if (/未登录|登录已过期|token/i.test(err.message)) err.statusCode = 401;
      throw err;
    }
    return result.data;
  }

  async getQRCode() {
    const data = await this._request('GET', '/qr_code');
    if (!data || !data.id || !data.url) throw new Error('养基宝二维码数据格式错误');
    const qrId = String(data.id);
    const qrContent = String(data.url);
    // 后端本地把登录串生成为二维码图片并转 Base64，
    // 使小程序直接展示 data URI，无需 downloadFile 第三方图片域名，也不依赖 qrserver 等外部服务。
    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(qrContent, { width: 280, margin: 2 });
    } catch (e) {
      throw new Error('养基宝二维码生成失败：' + e.message);
    }
    return {
      qr_id: qrId,
      qr_url: qrContent, // 保留供小程序做有效性校验
      qr_data_url: qrDataUrl, // data:image/png;base64,... 小程序直接展示
      qr_base64: qrDataUrl.split(',')[1] || ''
    };
  }

  async checkQRCode(qrId) {
    const data = await this._request('GET', `/qr_code_state/${encodeURIComponent(qrId)}`);
    const stateMap = {
      1: 'waiting',
      '1': 'waiting',
      2: 'confirmed',
      '2': 'confirmed',
      3: 'expired',
      '3': 'expired'
    };
    const state = stateMap[data?.state] || 'unknown';
    if (state === 'confirmed' && data.token) this._token = data.token;
    return {
      state,
      token: state === 'confirmed' ? (data.token || null) : null
    };
  }

  async fetchAccounts() {
    this._requireLogin();
    const data = await this._request('GET', '/user_account');
    const list = (data && data.list) || [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(item => item && item.id && item.title)
      .map(item => ({ account_id: String(item.id), name: String(item.title) }));
  }

  async fetchHoldings(accountId) {
    this._requireLogin();
    return (await this._fetchRawHoldings(accountId)).map(item => {
      const code = String(item.code || '');
      const share = Number(item.hold_share);
      const unitCost = Number(item.hold_cost);
      const money = Number(item.money);
      const earnings = Number(item.hold_earn || 0);
      if (!code || !Number.isFinite(share) || !Number.isFinite(unitCost)) return null;
      return {
        fund_code: code,
        fund_name: String(item.short_name || ''),
        share,
        nav: unitCost,
        amount: Number.isFinite(money) && money > 0 ? money : share * unitCost,
        earnings,
        operation_date: item.hold_day ? String(item.hold_day) : new Date().toISOString().slice(0, 10)
      };
    }).filter(Boolean);
  }

  async _fetchRawHoldings(accountId) {
    this._requireLogin();
    const data = await this._request('GET', `/fund_hold?account_id=${encodeURIComponent(accountId)}`);
    const list = Array.isArray(data) ? data : [];
    return list;
  }

  async fetch_estimate(fundCode) {
    this._requireLogin();
    try {
      const accounts = await this.fetchAccounts();
      for (const account of accounts) {
        const rawHoldings = await this._fetchRawHoldings(account.account_id);
        const holding = rawHoldings.find(item => String(item.code) === String(fundCode));
        if (!holding) continue;
        const nvInfo = holding.nv_info || {};
        const estimateNav = nvInfo.gsz || nvInfo.vgsz || nvInfo.zsgz;
        const estimateGrowth = nvInfo.gszzl || nvInfo.vgszzl || nvInfo.zsgzzl;
        if (estimateNav && estimateGrowth) {
          return {
            fund_code: String(fundCode),
            fund_name: String(holding.short_name || ''),
            estimate_nav: Number(estimateNav),
            estimate_time: new Date().toISOString(),
            estimate_growth: Number(estimateGrowth),
            trade_date: new Date().toISOString().slice(0, 10)
          };
        }
        return null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  logout() {
    this._token = null;
  }
}

module.exports = YangJiBaoProvider;
