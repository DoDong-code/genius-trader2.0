const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// 使用独立临时数据库（必须在 require db 相关模块前设置）
process.env.FUND_DB_PATH = path.join(os.tmpdir(), `provider-test-${process.pid}.sqlite`);

const { encryptText, decryptText } = require('../utils/crypto');
const registry = require('../providers/registry');
const BaseProvider = require('../providers/baseProvider');
const {
  getCredential,
  saveCredential,
  disconnectCredential,
  deleteCredential
} = require('../services/sourceCredentials');
const { normalizeProviderAccounts } = require('../services/importProvider');
const { handleProviderApi } = require('../api/provider');
const {
  fetchProviderEstimate,
  normalizeProviderEstimate
} = require('../services/providerEstimate');
const {
  replaceSyncedAccount,
  listSyncedAccounts,
  clearSyncedAccount
} = require('../services/portfolioService');

test('AES 加密解密往返', () => {
  const plain = 'sk-test-123456';
  const encrypted = encryptText(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(decryptText(encrypted), plain);
  assert.equal(decryptText(''), '');
  assert.equal(decryptText('broken:data:here'), '');
});

test('Provider 注册表自动加载', () => {
  const names = registry.listProviders();
  assert.ok(names.includes('yangjibao'));
  assert.ok(names.includes('xiaobeiyangji'));
  assert.equal(registry.getProvider('yangjibao').getLoginType(), 'qrcode');
  assert.equal(registry.getProvider('xiaobeiyangji').getLoginType(), 'phone');
});

test('凭证加密落库', async () => {
  deleteCredential('yangjibao');
  saveCredential({
    source_name: 'yangjibao',
    token: 'secret-token-abc',
    refresh_token: 'refresh-xyz',
    user_info: { name: '测试' },
    status: 'connected'
  });
  const cred = getCredential('yangjibao');
  assert.equal(cred.token, 'secret-token-abc');
  assert.equal(cred.refresh_token, 'refresh-xyz');
  assert.deepEqual(cred.user_info, { name: '测试' });
  assert.equal(cred.status, 'connected');

  disconnectCredential('yangjibao');
  const after = getCredential('yangjibao');
  assert.equal(after.status, 'disconnected');
  assert.equal(after.token, '');
  deleteCredential('yangjibao');
  assert.equal(getCredential('yangjibao'), null);
});

class StubProvider extends BaseProvider {
  constructor() {
    super();
    this.sourceName = 'stub';
    this.displayName = '测试数据源';
  }
  getLoginType() { return 'qrcode'; }
  async getQRCode() { return { qr_id: 'qr-1', qr_url: 'https://example.com/qr' }; }
  async checkQRCode() { return { state: 'confirmed', token: 'stub-token-1' }; }
  async fetchAccounts() { return [{ account_id: 'a1', name: '测试账户' }]; }
  async fetchHoldings() {
    return [{
      fund_code: '000001',
      fund_name: '测试基金',
      share: 100,
      nav: 1.1,
      amount: 110,
      earnings: 10,
      operation_date: '2026-08-01'
    }];
  }
}

test('导入归一化映射（养基宝模式）', async () => {
  const provider = new StubProvider();
  const payload = await normalizeProviderAccounts(provider);
  assert.equal(payload.provider, 'stub');
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0].name, '养基宝-测试账户');
  const fund = payload.accounts[0].funds[0];
  assert.equal(fund.code, '000001');
  assert.equal(fund.amount, 110);
  assert.equal(fund.holdingProfit, 10);
  assert.equal(fund.holdingRate, 10 / 100);
  assert.equal(fund.shares, 100);
  assert.equal(fund.costNav, 1.1); // 养基宝模式：优先采用数据源单位成本
  assert.equal(fund.transactions[0].type, 'buy');
  assert.equal(fund.transactions[0].date, '2026-08-01');
});

test('成本净值反推（无数据源单位成本时用 成本/份额）', async () => {
  const { buildFund } = require('../services/importProvider');
  const fund = buildFund({
    fund_code: '000002',
    fund_name: '测试基金2',
    share: 200,
    nav: 0.9,
    amount: 220,
    earnings: 20,
    operation_date: '2026-08-01'
  });
  assert.equal(fund.costNav, (220 - 20) / 200);
  assert.equal(fund.holdingRate, 20 / 200);
});

function mockRequest(method, body) {
  return {
    method,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body));
      if (event === 'end') cb();
    }
  };
}

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; }
  };
}

function apiUrl(route) {
  return new URL(`http://localhost${route}`);
}

test('Provider API：登录→导入→退出 全链路（stub）', async () => {
  registry.registerProvider('stub', StubProvider);
  deleteCredential('stub');

  // 未登录导入 → 401
  const resNoLogin = mockResponse();
  await handleProviderApi(mockRequest('POST', {}), resNoLogin, apiUrl('/api/provider/stub/import'));
  assert.equal(resNoLogin.statusCode, 401);

  // 获取二维码
  const resQr = mockResponse();
  await handleProviderApi(mockRequest('POST', {}), resQr, apiUrl('/api/provider/stub/qrcode'));
  assert.equal(resQr.statusCode, 200);
  const qrData = JSON.parse(resQr.body);
  assert.equal(qrData.qr_id, 'qr-1');

  // 轮询扫码状态（stub 直接返回 confirmed，保存凭证）
  const resStatus = mockResponse();
  await handleProviderApi(mockRequest('GET'), resStatus, apiUrl('/api/provider/stub/status?qr_id=qr-1'));
  assert.equal(resStatus.statusCode, 200);
  assert.equal(JSON.parse(resStatus.body).state, 'confirmed');
  assert.equal(getCredential('stub').token, 'stub-token-1');

  // 查询凭证状态
  const resCred = mockResponse();
  await handleProviderApi(mockRequest('GET'), resCred, apiUrl('/api/provider/stub/status'));
  assert.equal(JSON.parse(resCred.body).logged_in, true);

  // 导入
  const resImport = mockResponse();
  await handleProviderApi(mockRequest('POST', { overwrite: false }), resImport, apiUrl('/api/provider/stub/import'));
  assert.equal(resImport.statusCode, 200);
  const importData = JSON.parse(resImport.body);
  assert.equal(importData.accounts.length, 1);
  assert.equal(importData.accounts[0].funds[0].code, '000001');
  // 阶段1：导入结果已持久化到服务端权威库
  const persisted = listSyncedAccounts();
  assert.ok(persisted.some(a => a.name === '养基宝-测试账户'));

  // 退出登录
  const resLogout = mockResponse();
  await handleProviderApi(mockRequest('POST', {}), resLogout, apiUrl('/api/provider/stub/logout'));
  assert.equal(JSON.parse(resLogout.body).success, true);
  assert.equal(getCredential('stub').status, 'disconnected');
  clearSyncedAccount('养基宝-测试账户');

  registry.unregisterProvider('stub');
});

test('未知数据源返回 404', async () => {
  const res = mockResponse();
  await handleProviderApi(mockRequest('GET'), res, apiUrl('/api/provider/not-exists/status'));
  assert.equal(res.statusCode, 404);
});

test('同步账户持久化与读取（portfolio 表）', () => {
  replaceSyncedAccount('养基宝-测试', [{
    code: '000001',
    name: '测试基金',
    amount: 110,
    holdingProfit: 10,
    holdingRate: 0.1,
    shares: 100,
    costNav: 1.0,
    category: '基金',
    transactions: [{ type: 'buy', amount: 100, date: '2026-08-01' }]
  }]);
  const accounts = listSyncedAccounts();
  const account = accounts.find(a => a.name === '养基宝-测试');
  assert.ok(account);
  assert.equal(account.funds.length, 1);
  const fund = account.funds[0];
  assert.equal(fund.code, '000001');
  assert.equal(fund.name, '测试基金');
  assert.equal(fund.shares, 100);
  assert.equal(fund.costNav, 1.0);
  assert.equal(fund.amount, 110);
  assert.equal(fund.transactions.length, 1);
  assert.equal(fund.transactions[0].type, 'buy');

  clearSyncedAccount('养基宝-测试');
  assert.equal(listSyncedAccounts().find(a => a.name === '养基宝-测试'), undefined);
});

test('估值归一化：百分比 → GT 内部比率结构', () => {
  const provider = { sourceName: 'xiaobeiyangji', displayName: '小倍养基' };
  const raw = {
    fund_name: '测试基金',
    estimate_nav: 2.5,
    estimate_time: '2026-08-07T08:00:00.000Z',
    estimate_growth: 1.23
  };
  const estimate = normalizeProviderEstimate(provider, raw, '000001', 1000);
  assert.equal(estimate.estimate_change, 0.0123);
  assert.equal(estimate.estimate_change_percent, 1.23);
  assert.equal(estimate.estimate_profit, 12.3);
  assert.equal(estimate.estimate_source, 'xiaobeiyangji');
});

class EstimateStubProvider extends BaseProvider {
  constructor() {
    super();
    this.sourceName = 'xiaobeiyangji';
    this.displayName = '小倍养基';
  }
  getLoginType() { return 'phone'; }
  async fetch_estimate(code) {
    return {
      fund_code: String(code),
      fund_name: '测试基金',
      estimate_nav: 2.5,
      estimate_time: new Date().toISOString(),
      estimate_growth: 1.23
    };
  }
}

test('估值优先级：Provider 有凭证时优先返回', async () => {
  const realXbyj = require('../providers/xiaobeiyangji');
  registry.registerProvider('xiaobeiyangji', EstimateStubProvider);
  deleteCredential('xiaobeiyangji');

  // 无凭证 → 返回 null（走本地引擎兜底）
  const withoutLogin = await fetchProviderEstimate('000001', 1000, { force: true });
  assert.equal(withoutLogin, null);

  // 有凭证 → 返回 Provider 估值
  saveCredential({ source_name: 'xiaobeiyangji', token: 'stub-token', status: 'connected' });
  const withLogin = await fetchProviderEstimate('000001', 1000, { force: true });
  assert.ok(withLogin);
  assert.equal(withLogin.estimate_source, 'xiaobeiyangji');
  assert.equal(withLogin.estimate_change, 0.0123);

  deleteCredential('xiaobeiyangji');
  registry.registerProvider('xiaobeiyangji', realXbyj);
});
