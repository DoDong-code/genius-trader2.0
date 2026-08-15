const {
  importFund,
  getFund,
  getFundHoldings,
  getRealtimeFundEstimate,
  listFunds
} = require('../services/fundService');
const { getHistory } = require('../services/navService');
const { estimatePortfolio } = require('../services/estimateService');
const {
  calculateFundEstimate,
  calculateAccountEstimate
} = require('../services/estimateEngine');
const { calibrateFund } = require('../services/calibrationEngine');
const { fetchStockQuote } = require('../services/marketService');
const fs = require('fs');
const path = require('path');

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-AI-API-Key,Authorization'
  });
  response.end(JSON.stringify(payload));
}

function routeMatch(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.slice(1).map(decodeURIComponent) : null;
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

async function handleFundApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return true;
  }

  // ---- 只读外部分析 API（Token 管理用会话登录态；数据接口用只读 Token）----
  if (url.pathname.startsWith('/api/external/')) {
    const { handleExternalApi, handleExternalAuthApi } = require('./external');
    if (url.pathname.startsWith('/api/external/token')) {
      const { userFromRequest } = require('../services/authService');
      const user = await userFromRequest(request);
      return handleExternalAuthApi(request, response, url, user ? Number(user.id) : 0);
    }
    return handleExternalApi(request, response, url);
  }

  // ---- 账号认证 ----
  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const { register } = require('../services/authService');
    const result = await register(body.email, body.password);
    sendJson(response, 200, { success: true, ...result });
    return true;
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const { login } = require('../services/authService');
    const result = await login(body.email, body.password);
    sendJson(response, 200, { success: true, ...result });
    return true;
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const { logout, tokenFromRequest } = require('../services/authService');
    await logout(tokenFromRequest(request));
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    sendJson(response, 200, { success: true, user });
    return true;
  }

  // ---- 云端账户状态（登录后手动账户/策略持久化）----
  if (url.pathname === '/api/account/state' && request.method === 'GET') {
    const { userFromRequest } = require('../services/authService');
    const { getUserState } = require('../services/accountStateService');
    const user = await userFromRequest(request);
    if (!user) {
      sendJson(response, 401, { success: false, error: '请先登录' });
      return true;
    }
    const state = await getUserState(Number(user.id));
    sendJson(response, 200, { success: true, state });
    return true;
  }

  if (url.pathname === '/api/account/state' && request.method === 'PUT') {
    const { userFromRequest } = require('../services/authService');
    const { saveUserState } = require('../services/accountStateService');
    const user = await userFromRequest(request);
    if (!user) {
      sendJson(response, 401, { success: false, error: '请先登录' });
      return true;
    }
    const body = await readJsonBody(request);
    if (!body.state) {
      sendJson(response, 400, { success: false, error: '缺少 state' });
      return true;
    }
    await saveUserState(Number(user.id), body.state);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/portfolio/delete' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const { clearSyncedAccount } = require('../services/portfolioService');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    if (!body.account_id) {
      sendJson(response, 400, { success: false, error: '缺少 account_id' });
      return true;
    }
    await clearSyncedAccount(body.account_id, userId);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/portfolio/rename' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const { markSyncedAccountConverted } = require('../services/portfolioService');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    if (!body.from || !body.to) {
      sendJson(response, 400, { success: false, error: '缺少 from/to' });
      return true;
    }
    // 同步账户改名 = 用户主动修改：原同步账户转为休眠记录（保留数据、不再自动恢复）
    await markSyncedAccountConverted(body.from, userId);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/portfolio/update' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const { replaceSyncedAccount } = require('../services/portfolioService');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    if (!body.account_id || !Array.isArray(body.funds)) {
      sendJson(response, 400, { success: false, error: '缺少 account_id 或 funds' });
      return true;
    }
    await replaceSyncedAccount(body.account_id, body.funds, userId);
    sendJson(response, 200, { success: true });
    return true;
  }

  // 第三方 Provider API（养基宝 / 小倍养基）
  if (url.pathname.startsWith('/api/provider/')) {
    const { handleProviderApi } = require('./provider');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    await handleProviderApi(request, response, url, user ? Number(user.id) : 0);
    return true;
  }

  // Handle AI Routes
  if (url.pathname.startsWith('/api/ai/')) {
    if (url.pathname === '/api/ai/models' && request.method === 'GET') {
      sendJson(response, 200, {
        success: true,
        models: {
          "OpenAI": ["gpt-5-mini", "gpt-4o", "gpt-4o-mini"],
          "DeepSeek": ["deepseek-chat", "deepseek-coder"],
          "Google Gemini": ["gemini-2.5-pro", "gemini-2.5-flash"],
          "Moonshot Kimi": ["moonshot-v1-8k", "moonshot-v1-32k"],
          "Claude": ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
          "自定义 OpenAI Compatible": []
        }
      });
      return true;
    }

    if (request.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let chunkStr = '';
        request.on('data', chunk => { chunkStr += chunk; });
        request.on('end', () => {
          try {
            resolve(chunkStr ? JSON.parse(chunkStr) : {});
          } catch (e) {
            reject(new Error('Invalid JSON'));
          }
        });
        request.on('error', err => reject(err));
      });

      // Extract custom API key from headers if available
      const headerKey = request.headers['x-ai-api-key'];

      if (url.pathname === '/api/ai/chat') {
        const message = body.message;
        const config = body.config || {};
        if (headerKey && !config.apiKey) {
          config.apiKey = headerKey;
        }
        
        const ai = require('../services/ai/index');
        try {
          const reply = await ai.chat(message, config);
          sendJson(response, 200, { success: true, reply });
        } catch (err) {
          sendJson(response, 500, { success: false, error: err.message });
        }
        return true;
      }

      if (url.pathname === '/api/ai/analyze') {
        const config = body.config || {};
        if (headerKey && !config.apiKey) {
          config.apiKey = headerKey;
        }

        // 诊断请求日志
        try {
          fs.appendFileSync(path.join(__dirname, '..', 'ai-trace.log'),
            `[${new Date().toISOString()}] /api/ai/analyze 收到请求. provider=${config.provider} model=${config.model} hasKey=${!!(config.apiKey)} keyLen=${(config.apiKey||'').length}\n`);
        } catch (e) {}

        // 统一数据源：与持仓页面、外部分析 API 一致（服务端按当前登录用户构建）
        const { userFromRequest } = require('../services/authService');
        const user = await userFromRequest(request);
        const userId = user ? Number(user.id) : 0;
        const { buildAnalysisPortfolio } = require('../services/portfolioAnalysisService');
        let portfolio;
        try {
          // DeepSeek 内部分析：继续使用当前登录用户自己的活动账户
          portfolio = await buildAnalysisPortfolio(userId, { useActive: true });
        } catch (err) {
          // 兜底：使用客户端提供的结构，不破坏现有功能
          portfolio = body.portfolio;
        }
        if (body && body.userQuery) {
          portfolio = portfolio || {};
          portfolio.userQuery = body.userQuery;
        }

        const ai = require('../services/ai/index');
        try {
          const analysis = await ai.analyzePortfolio(portfolio, config);
          // 服务端兜底：按持仓逐只补齐 suggestions（无论 AI 是否返回）
          try {
            const _h = (portfolio && Array.isArray(portfolio.holdings)) ? portfolio.holdings : [];
            if (_h.length > 0) {
              const _exist = Array.isArray(analysis.suggestions) ? analysis.suggestions.filter(s => s && typeof s === 'object') : [];
              const _byCode = {};
              const _byName = [];
              const _norm = x => String(x || '').replace(/\s+/g, '');
              const _strip = x => _norm(x).replace(/(混合|A|C|债券|股票|基金|指数|ETF|联接|QDII|LOF|货币|精选|积极|稳健|价值|成长|灵活|配置|\(|\))/gi, '').trim();
              _exist.forEach(s => {
                if (s && s.code) _byCode[String(s.code).trim()] = s;
                if (s && (s.fund || s.name)) _byName.push(s);
              });
              // 名称模糊匹配：AI 漏填 code 时（DeepSeek 常见问题），用 fund/name 字段匹配持仓
              const _matchByName = name => {
                const ff = _norm(name), ff2 = _strip(name);
                return _byName.find(s => {
                  const sf = _norm(s.fund || s.name || '');
                  const sf2 = _strip(s.fund || s.name || '');
                  return (sf && (sf.includes(ff) || ff.includes(sf))) ||
                         (sf2 && ff2 && (sf2.includes(ff2) || ff2.includes(sf2)));
                }) || null;
              };
              analysis.suggestions = _h.map(h => {
                const _code = String((h && h.code) || '').trim();
                if (_byCode[_code]) return _byCode[_code];
                const _byNameHit = _matchByName(h.name);
                if (_byNameHit) return _byNameHit; // 命中 AI 原始建议（保留 action/reason），不被兜底覆盖
                return { fund: (h && h.name) || '', code: (h && h.code) || '', action: '持有', reason: '基于组合整体配置与投资纪律，建议维持当前持仓并继续观察。', targetPct: null };
              });
            }
          } catch (_e) {}
          try {
            fs.appendFileSync(path.join(__dirname, '..', 'ai-trace.log'),
              `[${new Date().toISOString()}] AI 成功. keys=${Object.keys(analysis).join(',')} suggestions=${Array.isArray(analysis.suggestions) ? analysis.suggestions.length : 'N/A'} firstCode=${analysis.suggestions && analysis.suggestions[0] && analysis.suggestions[0].code}\n`);
          } catch (e) {}
          sendJson(response, 200, { success: true, analysis });
        } catch (err) {
          try {
            fs.appendFileSync(path.join(__dirname, '..', 'ai-trace.log'),
              `[${new Date().toISOString()}] AI 失败: ${err.message}\n`);
          } catch (e) {}
          sendJson(response, 500, { success: false, error: err.message });
        }
        return true;
      }
    }
  }

  if (request.method !== 'GET') return false;

  if (url.pathname === '/api/market/status') {
    const { isTradingDay, shanghaiDateString } = require('../services/marketService');
    const now = new Date();
    sendJson(response, 200, {
      success: true,
      trading_day: isTradingDay(),
      date: shanghaiDateString(),
      time: new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(now)
    });
    return true;
  }

  if (url.pathname === '/api/market/indices' && request.method === 'GET') {
    const { fetchIndexQuotes } = require('../services/marketService');
    const force = url.searchParams.get('refresh') === '1';
    const indices = await fetchIndexQuotes(force);
    sendJson(response, 200, { success: true, indices });
    return true;
  }

  if (url.pathname === '/api/funds') {
    sendJson(response, 200, { success: true, funds: listFunds() });
    return true;
  }

  if (url.pathname === '/api/portfolio/accounts' && request.method === 'GET') {
    const { listSyncedAccounts } = require('../services/portfolioService');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    sendJson(response, 200, { success: true, accounts: await listSyncedAccounts(userId) });
    return true;
  }

  let match = routeMatch(url.pathname, /^\/api\/fund\/import\/(\d{6})$/);
  if (match) {
    const result = await importFund(match[0], {
      force: url.searchParams.get('force') === '1'
    });
    sendJson(response, 200, result);
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})\/history$/);
  if (match) {
    const fund = getFund(match[0]);
    if (!fund) {
      sendJson(response, 404, { success: false, error: '基金尚未导入' });
      return true;
    }
    const history = getHistory(match[0], {
      limit: url.searchParams.get('limit')
    });
    sendJson(response, 200, {
      success: true,
      fund_code: match[0],
      records: history.length,
      history
    });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})\/estimate$/);
  if (match) {
    const amount = url.searchParams.has('amount')
      ? Number(url.searchParams.get('amount')) : undefined;
    const force = url.searchParams.get('force') === '1';
    const mode = url.searchParams.get('mode');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const { fetchProviderEstimate } = require('../services/providerEstimate');
    const userId = user ? Number(user.id) : 0;
    let estimate;
    if (mode === 'provider') {
      // 仅取第三方估值（供前端在本地估值后更正）
      estimate = await fetchProviderEstimate(match[0], amount, {
        force,
        userId,
        source: url.searchParams.get('source') || undefined
      });
      if (!estimate) {
        // Provider 无数据时回退到本地引擎，但保留 source 标识
        // 让前端徽标仍显示用户选择的数据源（如"小倍"）而非"估算"
        const requestedSource = url.searchParams.get('source') || undefined;
        estimate = await calculateFundEstimate(match[0], { amount, force });
        if (estimate && requestedSource) {
          estimate.estimate_source = requestedSource;
          estimate.source = requestedSource;
        }
      }
    } else if (mode === 'local') {
      estimate = await calculateFundEstimate(match[0], { amount, force });
    } else {
      // 谁快谁先出：第三方与本地引擎并行，先返回有效值者胜出
      const providerP = fetchProviderEstimate(match[0], amount, { force, userId }).catch(() => null);
      const localP = calculateFundEstimate(match[0], { amount, force }).catch(() => null);
      estimate = await new Promise(resolve => {
        let settled = 0;
        const check = () => { if (settled >= 2) resolve(null); };
        [providerP, localP].forEach(p => {
          p.then(value => {
            if (value) {
              resolve(value);
              return;
            }
            settled += 1;
            check();
          });
        });
      });
    }
    sendJson(response, 200, { success: true, ...estimate });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})\/calibration$/);
  if (match) {
    const calibration = calibrateFund(match[0], {
      force: url.searchParams.get('recalibrate') === '1'
    });
    sendJson(response, 200, { success: true, calibration });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})$/);
  if (match) {
    let fund = getFund(match[0]);
    if (!fund) {
      try {
        console.log(`[auto-import] API fund details: auto-importing ${match[0]}...`);
        await importFund(match[0]);
        fund = getFund(match[0]);
      } catch (importErr) {
        console.error(`[auto-import] Failed to auto-import fund ${match[0]} during details request:`, importErr.message);
      }
    }
    if (!fund) {
      sendJson(response, 404, { success: false, error: '基金尚未导入' });
      return true;
    }
    if (url.searchParams.get('refresh') === '1') {
      // fast=1：立即返回缓存数据，后台异步增量刷新（持仓季度级、历史每日增量），抽屉秒开
      if (url.searchParams.get('fast') === '1') {
        importFund(match[0]).catch(error => {
          console.warn(`[fund-refresh-fast] ${match[0]}: ${error.message}`);
        });
      } else {
        await importFund(match[0], { force: true }).catch(error => {
          console.warn(`[fund-refresh] ${match[0]}: ${error.message}`);
        });
      }
      fund = getFund(match[0]) || fund;
    }
    const history = getHistory(match[0]);
    const isFast = url.searchParams.get('fast') === '1';
    sendJson(response, 200, {
      success: true,
      fund,
      latest_nav: fund.latest_nav,
      history,
      data_status: {
        history: history.length ? 'normal' : 'pending',
        label: history.length ? '数据正常' : '等待数据源'
      },
      holdings: getFundHoldings(match[0]),
      estimate: !isFast && url.searchParams.get('refresh') === '1'
        ? await getRealtimeFundEstimate(match[0])
        : null
    });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/stock\/([A-Za-z0-9.-]+)$/);
  if (match) {
    const quote = await fetchStockQuote(match[0]);
    if (!quote) {
      sendJson(response, 404, { success: false, error: '股票行情暂不可用' });
      return true;
    }
    sendJson(response, 200, { success: true, quote });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/portfolio\/([^/]+)\/estimate$/);
  if (match) {
    sendJson(response, 200, {
      success: true,
      ...estimatePortfolio(match[0])
    });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/account\/([^/]+)\/estimate$/);
  if (match) {
    const estimate = await calculateAccountEstimate(match[0], {
      force: url.searchParams.get('force') === '1'
    });
    sendJson(response, 200, { success: true, ...estimate });
    return true;
  }

  return false;
}

module.exports = {
  handleFundApi,
  sendJson
};
