/**
 * 第三方数据源 Provider 抽象基类
 *
 * 统一接口（未来新增平台只需继承本类并实现对应方法）：
 * - getLoginType(): 'qrcode' | 'phone' | 'none'
 * - getQRCode() / checkQRCode(qrId): 二维码登录
 * - sendSMS(phone) / verifySMS(phone, code): 手机号验证码登录
 * - fetchAccounts() / fetchHoldings(accountId): 账户与持仓
 * - logout(): 清除内存 token
 */
class BaseProvider {
  constructor() {
    this.sourceName = '';
    this.displayName = '';
    this._token = null;
    this._userInfo = null;
  }

  getLoginType() {
    throw new Error('未实现 getLoginType');
  }

  getQRCode() {
    throw new Error(`${this.displayName || this.sourceName} 不支持二维码登录`);
  }

  checkQRCode() {
    throw new Error(`${this.displayName || this.sourceName} 不支持二维码登录`);
  }

  sendSMS() {
    throw new Error(`${this.displayName || this.sourceName} 不支持短信登录`);
  }

  verifySMS() {
    throw new Error(`${this.displayName || this.sourceName} 不支持短信登录`);
  }

  async fetchAccounts() {
    throw new Error('未实现 fetchAccounts');
  }

  async fetchHoldings() {
    throw new Error('未实现 fetchHoldings');
  }

  logout() {
    this._token = null;
    this._userInfo = null;
  }

  setToken(token) {
    this._token = token;
  }

  getToken() {
    return this._token;
  }

  setUserInfo(info) {
    this._userInfo = info;
  }

  getUserInfo() {
    return this._userInfo;
  }

  _requireLogin() {
    if (!this._token) {
      const err = new Error(`未登录${this.displayName || this.sourceName}`);
      err.statusCode = 401;
      throw err;
    }
  }
}

module.exports = BaseProvider;
