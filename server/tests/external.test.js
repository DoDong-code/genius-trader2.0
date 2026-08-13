const test = require('node:test');
const assert = require('node:assert');

const { generateToken, validateToken, revokeTokens } = require('../services/externalTokenService');
const { handleExternalApi, handleExternalAuthApi } = require('../api/external');
const { saveUserState } = require('../services/accountStateService');

function mockRequest(method, body) {
  return {
    method,
    headers: {},
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
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

function apiUrl(route) {
  return new URL(`http://localhost${route}`);
}

function json(res) {
  return JSON.parse(res.body);
}

test('只读 Token：生成 → 读取 → 撤销后失效', async () => {
  const resGen = mockResponse();
  await handleExternalAuthApi(mockRequest('POST', {}), resGen, apiUrl('/api/external/token'), 1);
  assert.equal(resGen.statusCode, 200);
  const token = json(resGen).token;
  assert.ok(token && token.length >= 40);

  // 用 Token 读取组合（用户1尚无数据 → 空组合，但鉴权通过）
  const resPortfolio = mockResponse();
  await handleExternalApi(mockRequest('GET'), resPortfolio, apiUrl('/api/external/analysis/portfolio'), undefined);
  // 需要带 Bearer 头
  const resAuth = mockResponse();
  const req = mockRequest('GET');
  req.headers.authorization = `Bearer ${token}`;
  await handleExternalApi(req, resAuth, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(resAuth.statusCode, 200);
  assert.ok(Array.isArray(json(resAuth).holdings));

  // 撤销后立即失效
  await revokeTokens(1);
  const resRevoked = mockResponse();
  const req2 = mockRequest('GET');
  req2.headers.authorization = `Bearer ${token}`;
  await handleExternalApi(req2, resRevoked, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(resRevoked.statusCode, 401);
});

test('只读 Token：无法读取其他用户数据，且不允许写操作', async () => {
  await saveUserState(1, {
    accounts: {
      '我的账户': { name: '我的账户', accountType: 'local', syncSource: null, funds: [{ code: '000001', name: '测试基金', amount: 1000, today: 0.01, hold: 0.1, category: '混合', transactions: [] }], strategy: [], closedPositions: [] }
    },
    active: '我的账户'
  });
  const t1 = (await generateToken(1)).token;
  const t2 = (await generateToken(2)).token;

  // 用户1 的 Token 能看到自己的账户
  const req1 = mockRequest('GET');
  req1.headers.authorization = `Bearer ${t1}`;
  const res1 = mockResponse();
  await handleExternalApi(req1, res1, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(res1.statusCode, 200);
  assert.equal(json(res1).account.name, '我的账户');
  assert.equal(json(res1).holdings.length, 1);

  // 用户2 的 Token 看不到用户1 的数据
  const req2 = mockRequest('GET');
  req2.headers.authorization = `Bearer ${t2}`;
  const res2 = mockResponse();
  await handleExternalApi(req2, res2, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(res2.statusCode, 200);
  assert.equal(json(res2).account, null);

  // 写操作（POST）被拒绝
  const reqWrite = mockRequest('POST', {});
  reqWrite.headers.authorization = `Bearer ${t1}`;
  const resWrite = mockResponse();
  await handleExternalApi(reqWrite, resWrite, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(resWrite.statusCode, 404);

  await revokeTokens(1);
  await revokeTokens(2);
});

test('只读 Token：账户列表 + 多账户需明确指定 + accountId 优先', async () => {
  await saveUserState(3, {
    accounts: {
      '核心账户': { name: '核心账户', accountType: 'local', syncSource: null, funds: [{ code: '000001', name: '测试基金', amount: 2000, today: 0.01, hold: 0.1, category: '混合', transactions: [] }], strategy: [], closedPositions: [] },
      '观察账户': { name: '观察账户', accountType: 'local', syncSource: null, funds: [], strategy: [], closedPositions: [] }
    },
    active: '核心账户'
  });
  const token = (await generateToken(3)).token;
  const req = (t) => { const r = mockRequest('GET'); r.headers.authorization = `Bearer ${t}`; return r; };

  // /accounts：返回全部真实账户
  const resAccounts = mockResponse();
  await handleExternalApi(req(token), resAccounts, apiUrl('/api/external/analysis/accounts'));
  assert.equal(resAccounts.statusCode, 200);
  const names = json(resAccounts).accounts.map(a => a.name).sort();
  assert.deepEqual(names, ['核心账户', '观察账户']);
  assert.ok(json(resAccounts).accounts.every(a => a.id === a.name));

  // 多账户未指定 → 不猜测，返回 needsAccount
  const resMulti = mockResponse();
  await handleExternalApi(req(token), resMulti, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(json(resMulti).needsAccount, true);
  assert.equal(json(resMulti).account, null);
  assert.equal(json(resMulti).accounts.length, 2);

  // 指定 accountId → 返回该账户
  const resId = mockResponse();
  await handleExternalApi(req(token), resId, apiUrl('/api/external/analysis/portfolio?accountId=' + encodeURIComponent('核心账户')));
  assert.equal(json(resId).account.name, '核心账户');
  assert.equal(json(resId).holdings.length, 1);

  // 指定 account（名称）→ 同样有效
  const resName = mockResponse();
  await handleExternalApi(req(token), resName, apiUrl('/api/external/analysis/portfolio?account=' + encodeURIComponent('观察账户')));
  assert.equal(json(resName).account.name, '观察账户');
  assert.equal(json(resName).holdings.length, 0);

  // 不存在/越权的账户名 → 不返回其他用户数据
  const resBad = mockResponse();
  await handleExternalApi(req(token), resBad, apiUrl('/api/external/analysis/portfolio?account=' + encodeURIComponent('不存在的账户')));
  assert.equal(json(resBad).account, null);

  await revokeTokens(3);
});

test('只读 Token：重新生成后旧 Token 失效', async () => {
  const oldToken = (await generateToken(5)).token;
  const newToken = (await generateToken(5)).token;
  assert.notEqual(oldToken, newToken);
  assert.equal(await validateToken(oldToken), null);
  assert.ok(await validateToken(newToken));
  await revokeTokens(5);
});

test('只读 Token：GET /api/external/analysis 统一接口返回完整的真实数据', async () => {
  await saveUserState(10, {
    accounts: {
      '核心账户': { name: '核心账户', accountType: 'local', syncSource: null, funds: [{ code: '000001', name: '测试基金A', amount: 3000, today: 0.01, profit: 300, category: '混合', transactions: [{ type: 'buy', amount: 3000, date: '2026-08-01' }] }], strategy: ['只买大盘股'], closedPositions: [] },
      '理财账户': { name: '理财账户', accountType: 'local', syncSource: null, funds: [{ code: '000002', name: '测试基金B', amount: 2000, today: -0.005, profit: -50, category: '债券', transactions: [] }], strategy: [], closedPositions: [] }
    }
  });

  const token = (await generateToken(10)).token;
  const req = mockRequest('GET');
  req.headers.authorization = `Bearer ${token}`;
  const res = mockResponse();

  await handleExternalApi(req, res, apiUrl('/api/external/analysis'));
  assert.equal(res.statusCode, 200);
  const data = json(res);
  
  assert.equal(data.success, true);
  assert.equal(data.totalAssets, 5000);
  assert.equal(data.accounts.length, 2);

  const acc1 = data.accounts.find(a => a.name === '核心账户');
  assert.ok(acc1);
  assert.equal(acc1.totalValue, 3000);
  assert.deepEqual(acc1.strategies, ['只买大盘股']);
  assert.equal(acc1.holdings.length, 1);
  assert.equal(acc1.holdings[0].code, '000001');
  assert.equal(acc1.holdings[0].name, '测试基金A');
  assert.equal(acc1.holdings[0].cost, 2700); // 3000 - 300
  assert.deepEqual(acc1.holdings[0].transactions, [{ type: 'buy', amount: 3000, date: '2026-08-01' }]);

  const acc2 = data.accounts.find(a => a.name === '理财账户');
  assert.ok(acc2);
  assert.equal(acc2.totalValue, 2000);
  assert.equal(acc2.holdings.length, 1);
  assert.equal(acc2.holdings[0].code, '000002');
  assert.equal(acc2.holdings[0].cost, 2050); // 2000 - (-50)

  await revokeTokens(10);
});

