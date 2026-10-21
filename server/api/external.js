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
  tokenStatus,
  hashToken,
  rateLimitAllowed
} = require('../services/externalTokenService');
const { listAnalysisAccounts } = require('../services/portfolioAnalysisService');
const { getFund } = require('../services/fundService');
const { getHistory } = require('../services/navService');
const { fetchProviderEstimate } = require('../services/providerEstimate');
const { calculateFundEstimate } = require('../services/estimateEngine');
const { runInRequestScope } = require('../utils/requestScope');

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
  // OPTIONS 预检提前返回（不需要请求作用域）
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return true;
  }

  // P1-7：外部 API 速率限制（滑动窗口）。key 用 token 哈希或客户端 IP，绝不记录明文 token。
  const preToken = resolveToken(request, url);
  const rlKey = preToken ? hashToken(preToken) : (request.socket && request.socket.remoteAddress) || 'anon';
  if (!rateLimitAllowed(rlKey)) {
    sendJson(response, 429, { success: false, error: '请求过于频繁，请稍后重试' });
    return true;
  }

  // 先完成鉴权，拿到 userId —— 必须在进入请求作用域之前确定，
  // 否则把 { userId } 作为 runInRequestScope 的 meta 实参时，userId 尚处于回调内部作用域，
  // 会触发 ReferenceError（生产环境该接口每次调用都会 500）。
  const token = resolveToken(request, url);
  const auth = token ? await validateToken(token) : null;
  if (!auth) {
    sendJson(response, 401, { success: false, error: '无效或已撤销的只读 Token' });
    return true;
  }
  const userId = auth.userId;

  // P0-2：整次请求包裹在请求作用域内，使多账户分析循环共享去重缓存（同基金只构建一次）；
  // 同时把 userId 写入 scope.meta，供 P0-4 账号生命周期竞态防护在写入前校验身份。
  return runInRequestScope(async () => {
  if (url.pathname === '/api/external/analysis/portfolio' && request.method === 'GET') {
    // accountId 优先于 account；两者都必须是 Token 所属用户自己的真实账户。
    // 2026-10-21：改走 getOrBuildAnalysisData 统一入口（与内部 AI / analysis/ai 同一
    // 构建入口 + 5 分钟跨请求共享缓存）；返回值仍为 buildAnalysisPortfolio 原始完整契约。
    const accountId = url.searchParams.get('accountId') || undefined;
    const accountName = url.searchParams.get('account') || undefined;
    const { getOrBuildAnalysisData } = require('../services/portfolioAnalysisService');
    const entry = await getOrBuildAnalysisData(userId, { accountId, account: accountName, timeoutMs: 90000 });
    sendJson(response, 200, { success: true, ...entry.portfolio });
    return true;
  }
  if (url.pathname === '/api/external/analysis/ai' && request.method === 'GET') {
    // 2026-10-21：改为复用统一标准 JSON（getOrBuildAnalysisData），删除原先逐基金
    // 重新拼接 enrichedHoldings / 重复推导 cost / 重复保留 15 日历史净值的冗余装配。
    // 内部 AI 与外部 AI 对同一账户、同一数据版本读取同一份标准 JSON（5 分钟共享缓存）。
    const { loadUserAccounts, getOrBuildAnalysisData } = require('../services/portfolioAnalysisService');
    const accountsList = await loadUserAccounts(userId);
    let totalAssets = 0;
    const processedAccounts = [];

    for (const acc of accountsList) {
      const entry = await getOrBuildAnalysisData(userId, { account: acc.name, timeoutMs: 90000 });
      const port = entry.portfolio;
      const accountValue = port.account ? port.account.totalValue : 0;
      totalAssets += accountValue;

      processedAccounts.push({
        accountName: acc.name,
        totalValue: accountValue,
        // —— 统一标准紧凑 JSON（与内部 AI 同一构建入口；schemaVersion=1）——
        // holdingColumns[i] 对应 holdingRows[j][i]；百分比已格式化（'—'=缺失）；账户=[名称,基金数上限,总资产]
        schemaVersion: entry.json.schemaVersion,
        account: entry.json.account,
        holdingColumns: entry.json.holdingColumns,
        holdingRows: entry.json.holdingRows,
        strategies: entry.json.strategies,
        portfolioSummary: entry.json.portfolioSummary,
        dataWarnings: entry.json.dataWarnings,
        combinationSummary: entry.json.combinationSummary,
        closedPositions: entry.json.closedPositions,
        // —— 边界兼容：Web 设置页「测试 API」仅读取 holdings[].code（app-refactor.js）——
        // 只保留轻量 {code, name} 视图，不再重复输出 cost/profitRate/history/performance 等
        // 已由 holdingColumns/holdingRows 承载的数据
        holdings: (Array.isArray(port.holdings) ? port.holdings : [])
          .map(h => ({ code: h.code, name: h.name }))
      });
    }

    sendJson(response, 200, {
      success: true,
      totalAssets,
      accounts: processedAccounts
    });
    return true;
  }
  if (url.pathname === '/api/external/analysis' && request.method === 'GET') {
    // 2026-10-21：改走 getOrBuildAnalysisData 统一入口（复用 5 分钟共享缓存，命中时不再重复
    // 构建）；本端点专属的业务数据（交易记录/份额/成本/strategyAnalysis）在边界照常叠加，
    // 响应契约不变。
    const { loadUserAccounts, getOrBuildAnalysisData } = require('../services/portfolioAnalysisService');
    const accountsList = await loadUserAccounts(userId);
    let totalAssets = 0;
    const processedAccounts = [];

    for (const acc of accountsList) {
      const entry = await getOrBuildAnalysisData(userId, { account: acc.name, timeoutMs: 90000 });
      const port = entry.portfolio;
      const accountValue = port.account ? port.account.totalValue : 0;
      totalAssets += accountValue;

      const enrichedHoldings = [];
      if (port.holdings) {
        for (const h of port.holdings) {
          const rawFund = acc.funds ? acc.funds.find(f => String(f.code) === String(h.code)) : null;
          const transactions = rawFund && Array.isArray(rawFund.transactions) ? rawFund.transactions : [];
          const shares = rawFund ? (Number(rawFund.shares) || 0) : 0;
          
          let cost = 0;
          if (rawFund) {
            if (Number.isFinite(Number(rawFund.cost)) && Number(rawFund.cost) > 0) {
              cost = Number(rawFund.cost);
            } else if (Number.isFinite(Number(rawFund.costBasis)) && Number(rawFund.costBasis) > 0) {
              cost = Number(rawFund.costBasis);
            } else {
              cost = Number(h.amount) - Number(h.profit);
            }
          } else {
            cost = Number(h.amount) - Number(h.profit);
          }

          enrichedHoldings.push({
            ...h,
            cost,
            shares,
            transactions
          });
        }
      }

      processedAccounts.push({
        name: acc.name,
        source: acc.source,
        accountTypeLabel: acc.accountTypeLabel || acc.type || (acc.source === 'sync' ? '同步账户' : '手动账户'),
        totalValue: accountValue,
        strategies: port.strategies || [],
        strategyAnalysis: port.strategy || { core: [], forbidden: [], rules: [] },
        holdings: enrichedHoldings
      });
    }

    sendJson(response, 200, {
      success: true,
      totalAssets,
      accounts: processedAccounts
    });
    return true;
  }
  if (url.pathname === '/api/external/analysis/accounts' && request.method === 'GET') {
    const accounts = await listAnalysisAccounts(userId);
    sendJson(response, 200, { success: true, accounts });
    return true;
  }

  let match;
  if ((match = url.pathname.match(/^\/api\/external\/fund\/(\d{6})$/)) && request.method === 'GET') {
    const fund = await getFund(match[1]);
    if (!fund) {
      sendJson(response, 404, { success: false, error: '基金不存在' });
      return true;
    }
    sendJson(response, 200, { success: true, fund });
    return true;
  }
  if ((match = url.pathname.match(/^\/api\/external\/fund\/(\d{6})\/history$/)) && request.method === 'GET') {
    const history = await getHistory(match[1]);
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
  }, { userId });
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
