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
      '账户1': { name: '账户1', accountType: 'local', syncSource: null, funds: [{ code: '000001', name: '测试基金', amount: 1000, today: 0.01, hold: 0.1, category: '混合', transactions: [] }], strategy: [], closedPositions: [] }
    },
    active: '账户1'
  });
  const t1 = (await generateToken(1)).token;
  const t2 = (await generateToken(2)).token;

  // 用户1 的 Token 能看到自己的账户
  const req1 = mockRequest('GET');
  req1.headers.authorization = `Bearer ${t1}`;
  const res1 = mockResponse();
  await handleExternalApi(req1, res1, apiUrl('/api/external/analysis/portfolio'));
  assert.equal(res1.statusCode, 200);
  assert.equal(json(res1).account.name, '账户1');
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

test('只读 Token：重新生成后旧 Token 失效', async () => {
  const oldToken = (await generateToken(5)).token;
  const newToken = (await generateToken(5)).token;
  assert.notEqual(oldToken, newToken);
  assert.equal(await validateToken(oldToken), null);
  assert.ok(await validateToken(newToken));
  await revokeTokens(5);
});
