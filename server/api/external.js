/**
 * 只读外部分析 API
 *
 * 数据接口（Bearer 只读 Token）：
 *   GET /api/external/analysis/portfolio
 *   GET /api/external/fund/:code
 *   GET /api/external/fund/:code/history
 *   GET /api/external/fund/:code/estimate
 *
 * Token 管理接口（会话登录态）：
 *   GET    /api/external/token/status
 *   POST   /api/external/token
 *   POST   /api/external/token/revoke
 *   POST   /api/external/token/regenerate
 *
 * 安全：Token 仅只读；数据仅限 Token 所属用户；禁止通过 userId/accountId 越权。
 */
const {
  validateToken,
  generateToken,
  revokeTokens,
  tokenStatus
} = require('../services/externalTokenService');
const { buildAnalysisPortfolio, listAnalysisAccounts } = require('../services/portfolioAnalysisService');
const { getFund } = require('../services/fundService');
const { getHistory } = require('../services/navService');
const { fetchProviderEstimate } = require('../services/providerEstimate');
const { calculateFundEstimate } = require('../services/estimateEngine');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS
  });
  response.end(JSON.stringify(payload));
}

function bearerToken(request) {
  const auth = String(request.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// 兼容 Query 参数鉴权：GET ?token=<只读Token>（与 Authorization: Bearer 使用同一套验证）
function resolveToken(request, url) {
  const header = bearerToken(request);
  if (header) return header;
  const queryToken = url && url.searchParams ? url.searchParams.get('token') : null;
  return queryToken || null;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let chunkStr = '';
    request.on('data', chunk => { chunkStr += chunk; });
    request.on('end', () => {
      try {
        resolve(chunkStr ? JSON.parse(chunkStr) : {});
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', err => reject(err));
  });
}

/**
 * 只读数据接口（Bearer 只读 Token 鉴权）
 */
async function handleExternalApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return true;
  }
  const token = resolveToken(request, url);
  const auth = token ? await validateToken(token) : null;
  if (!auth) {
    sendJson(response, 401, { success: false, error: '无效或已撤销的只读 Token' });
    return true;
  }
  const userId = auth.userId;

  if (url.pathname === '/api/external/analysis/portfolio' && request.method === 'GET') {
    // accountId 优先于 account；两者都必须是 Token 所属用户自己的真实账户
    const accountId = url.searchParams.get('accountId') || undefined;
    const accountName = url.searchParams.get('account') || undefined;
    const data = await buildAnalysisPortfolio(userId, { accountId, account: accountName });
    sendJson(response, 200, { success: true, ...data });
    return true;
  }
  if (url.pathname === '/api/external/analysis/accounts' && request.method === 'GET') {
    const accounts = await listAnalysisAccounts(userId);
    sendJson(response, 200, { success: true, accounts });
    return true;
  }

  let match;
  if ((match = url.pathname.match(/^\/api\/external\/fund\/(\d{6})$/)) && request.method === 'GET') {
    const fund = getFund(match[1]);
    if (!fund) {
      sendJson(response, 404, { success: false, error: '基金不存在' });
      return true;
    }
    sendJson(response, 200, { success: true, fund });
    return true;
  }
  if ((match = url.pathname.match(/^\/api\/external\/fund\/(\d{6})\/history$/)) && request.method === 'GET') {
    const history = getHistory(match[1]);
    sendJson(response, 200, { success: true, fund_code: match[1], records: history.length, history });
    return true;
  }
  if ((match = url.pathname.match(/^\/api\/external\/fund\/(\d{6})\/estimate$/)) && request.method === 'GET') {
    const amount = Number(url.searchParams.get('amount')) || undefined;
    const estimate = (await fetchProviderEstimate(match[1], amount, { userId }))
      || await calculateFundEstimate(match[1], { amount });
    sendJson(response, 200, { success: true, ...estimate });
    return true;
  }

  sendJson(response, 404, { success: false, error: '接口不存在' });
  return true;
}

/**
 * Token 管理接口（会话登录态鉴权，由外部调用方传入 userId）
 */
async function handleExternalAuthApi(request, response, url, userId) {
  if (!userId) {
    sendJson(response, 401, { success: false, error: '请先登录' });
    return true;
  }
  if (url.pathname === '/api/external/token/status' && request.method === 'GET') {
    const status = await tokenStatus(userId);
    sendJson(response, 200, { success: true, ...status });
    return true;
  }
  if ((url.pathname === '/api/external/token' || url.pathname === '/api/external/token/regenerate') && request.method === 'POST') {
    const { token } = await generateToken(userId);
    sendJson(response, 200, { success: true, token, note: '只读 Token 仅显示一次，请立即复制保存；数据库仅保存哈希' });
    return true;
  }
  if (url.pathname === '/api/external/token/revoke' && request.method === 'POST') {
    await revokeTokens(userId);
    sendJson(response, 200, { success: true });
    return true;
  }
  sendJson(response, 404, { success: false, error: '接口不存在' });
  return true;
}

module.exports = {
  handleExternalApi,
  handleExternalAuthApi,
  readJsonBody
};
