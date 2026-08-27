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
const { getDatabase } = require('../database/db');
const dbAsync = require('../database/dbAsync');
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

// AI bundle 安全加载：产物缺失或被 ensureAiBundle 标记为缺失时，显式返回 null
// （让调用方返回 503 降级），绝不抛出 500 / 崩溃。避免每次请求都 try/catch require。
function loadAiBundle() {
  if (process.env.__AI_BUNDLE_MISSING === '1') return null;
  try {
    return require('../services/ai/index');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      process.env.__AI_BUNDLE_MISSING = '1';
      return null;
    }
    throw e;
  }
}

function routeMatch(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

const MAX_BODY_BYTES = Math.max(1, Number(process.env.MAX_BODY_BYTES || 32 * 1024 * 1024)); // 32MB 硬上限，防止大 JSON 撑爆堆（解 OOM）
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        // 超过硬上限：立即拒绝并销毁连接，避免巨型 body 驻留堆中
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(buf);
    });
    request.on('end', () => {
      try {
        const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        if (total > 512 * 1024) console.log('[DIAG] large request body bytes=' + total);
        resolve(raw ? JSON.parse(raw) : {});
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
    let body;
    try { body = await readJsonBody(request); }
    catch (e) { sendJson(response, e.statusCode || 400, { success: false, error: e.message }); return true; }
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

  // ---- 云端账户状态（登录用户或匿名小程序用户持久化）----
  if (url.pathname === '/api/account/state' && request.method === 'GET') {
    const { userFromRequest } = require('../services/authService');
    const { getUserState } = require('../services/accountStateService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0; // 匿名小程序用户用 userId=0
    const state = await getUserState(userId);
    sendJson(response, 200, { success: true, state });
    return true;
  }

  if (url.pathname === '/api/account/state' && request.method === 'PUT') {
    const { userFromRequest } = require('../services/authService');
    const { getUserState, saveUserState, isEmptyStateOverwrite } = require('../services/accountStateService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0; // 匿名小程序用户用 userId=0
    let body;
    try { body = await readJsonBody(request); }
    catch (e) { sendJson(response, e.statusCode || 400, { success: false, error: e.message }); return true; }
    if (!body.state) {
      sendJson(response, 400, { success: false, error: '缺少 state' });
      return true;
    }
    // 防误覆盖保护（2026-08-26）：云端已有账户数据时，拒绝空 state 覆盖。
    const existing = await getUserState(userId);
    if (isEmptyStateOverwrite(existing, body.state)) {
      sendJson(response, 409, {
        success: false,
        error: '拒绝覆盖：云端已有账户数据，拒绝写入空/缺失账户状态',
        code: 'EMPTY_STATE_REJECTED'
      });
      return true;
    }
    try {
      await saveUserState(userId, body.state);
    } catch (e) {
      sendJson(response, e.statusCode || 500, { success: false, error: e.message, code: e.code });
      return true;
    }
    sendJson(response, 200, { success: true });
    return true;
  }

  // ---- 账户备份（最多 5 个快照）----
  if (url.pathname === '/api/account/backups' && request.method === 'GET') {
    const { userFromRequest } = require('../services/authService');
    const { listBackups } = require('../services/accountBackupService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    const backups = await listBackups(userId);
    sendJson(response, 200, { success: true, backups });
    return true;
  }

  if (url.pathname === '/api/account/backups' && request.method === 'POST') {
    const { userFromRequest } = require('../services/authService');
    const { createBackup, listBackups } = require('../services/accountBackupService');
    const user = await userFromRequest(request);
    const userId = user ? Number(user.id) : 0;
    let body;
    try { body = await readJsonBody(request); }
    catch (e) { sendJson(response, e.statusCode || 400, { success: false, error: e.message }); return true; }
    if (!body.state) {
      sendJson(response, 400, { success: false, error: '缺少 state' });
      return true;
    }
    await createBackup(userId, body.state, body.reason || 'manual');
    const backups = await listBackups(userId);
    sendJson(response, 200, { success: true, backups });
    return true;
  }

  {
    const restoreMatch = url.pathname.match(/^\/api\/account\/backups\/(\d+)\/restore$/);
    if (restoreMatch && request.method === 'POST') {
      const { userFromRequest } = require('../services/authService');
      const { getBackup } = require('../services/accountBackupService');
      const { saveUserState } = require('../services/accountStateService');
      const user = await userFromRequest(request);
      const userId = user ? Number(user.id) : 0;
      const snapshot = await getBackup(userId, restoreMatch[1]);
      if (!snapshot) {
        sendJson(response, 404, { success: false, error: '备份不存在' });
        return true;
      }
      // 恢复：写回 user_data（upsert，原子单条写入，失败不破坏现有数据）
      try {
        await saveUserState(userId, snapshot);
        sendJson(response, 200, { success: true, state: snapshot });
      } catch (e) {
        sendJson(response, e.statusCode || 500, { success: false, error: '恢复失败：' + (e.message || '未知错误'), code: e.code });
      }
      return true;
    }
  }

  // 删除备份（仅限本人）
  {
    const deleteMatch = url.pathname.match(/^\/api\/account\/backups\/(\d+)$/);
    if (deleteMatch && request.method === 'DELETE') {
      const { userFromRequest } = require('../services/authService');
      const { deleteBackup, listBackups } = require('../services/accountBackupService');
      const user = await userFromRequest(request);
      const userId = user ? Number(user.id) : 0;
      await deleteBackup(userId, deleteMatch[1]);
      const backups = await listBackups(userId);
      sendJson(response, 200, { success: true, backups });
      return true;
    }
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
        
        const ai = loadAiBundle();
        if (!ai) {
          sendJson(response, 503, { success: false, error: 'AI 服务暂不可用（构建产物缺失，请先执行 npm run build:ai）' });
          return true;
        }
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

        const ai = loadAiBundle();
        if (!ai) {
          sendJson(response, 503, { success: false, error: 'AI 服务暂不可用（构建产物缺失，请先执行 npm run build:ai）' });
          return true;
        }
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

  // 股票历史行情同步（校准依赖 stock_price 历史数据，A2）
  // 必须放在「非 GET 直接 return false」守卫之前，否则 POST 不可达
  let stockMatch = routeMatch(url.pathname, /^\/api\/stock\/sync-history$/);
  if (stockMatch && request.method === 'POST') {
    const body = await readJsonBody(request);
    const days = Number(body.days) || 365;
    const { syncFundHoldingsHistory, syncAllHoldingsHistory } = require('../services/stockHistoryService');
    const result = body.fundCode
      ? await syncFundHoldingsHistory(String(body.fundCode), { days })
      : await syncAllHoldingsHistory({ days });
    sendJson(response, 200, { success: true, ...result });
    return true;
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
    sendJson(response, 200, { success: true, funds: await listFunds() });
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
    const fund = await getFund(match[0]);
    if (!fund) {
      sendJson(response, 404, { success: false, error: '基金尚未导入' });
      return true;
    }
    const history = await getHistory(match[0], {
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
          // P3.18-ESTIMATE-STATE：标记真实来源为本地（data_status 判定不误判为 provider 当日数据）
          estimate.data_source_actual = 'local';
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
    // P3.18-ESTIMATE-STATE：统一 data_status（状态判定放后端，Web/mp1 只负责展示）
    const { resolveDataStatus, expectedNavDateFor, PROVIDER_SOURCES } = require('../services/estimateStatus');
    const navLatest = await dbAsync.get('SELECT date FROM fund_nav WHERE fund_code = ? ORDER BY date DESC LIMIT 1', [match[0]]);
    const fundRow = await dbAsync.get('SELECT fund_type, fund_name FROM fund WHERE fund_code = ?', [match[0]]);
    const confirmedNavDate = navLatest && navLatest.date;
    const expectedNavDate = expectedNavDateFor(fundRow);
    const actualSource = estimate ? (estimate.data_source_actual || estimate.source || null) : null;
    const providerTradeDate = estimate ? (estimate.trade_date || estimate.nav_date || null) : null;
    estimate.data_status = resolveDataStatus({
      confirmedNavDate,
      expectedNavDate,
      providerSource: actualSource && PROVIDER_SOURCES.has(String(actualSource)) ? String(actualSource) : null,
      providerTradeDate
    });
    sendJson(response, 200, { success: true, ...estimate });
    return true;
  }

  // P3.18-NET：当天净值（缓存优先）。前端页面加载/刷新时调用；
  // 命中 fund_nav 当天缓存 → 直接返回（不请求 provider）；未命中且收盘后 → 按小倍→养基宝获取并写缓存。
  // 幂等：即使连续点击刷新，也只会命中缓存，不会重复请求 provider。
  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})\/today-nav$/);
  if (match) {
    const { ensureTodayNav } = require('../services/navCacheService');
    const { userFromRequest } = require('../services/authService');
    const user = await userFromRequest(request);
    const source = url.searchParams.get('source') || null;
    const result = await ensureTodayNav(match[0], { userId: user ? Number(user.id) : 0, preferredSource: source });
    sendJson(response, 200, { success: true, ...result });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})\/calibration$/);
  if (match) {
    const calibration = await calibrateFund(match[0], {
      force: url.searchParams.get('recalibrate') === '1'
    });
    sendJson(response, 200, { success: true, calibration });
    return true;
  }

  stockMatch = routeMatch(url.pathname, /^\/api\/stock\/([^/]+)\/history$/);
  if (stockMatch) {
    const days = Number(url.searchParams.get('days')) || 365;
    const { fetchStockHistory } = require('../services/marketService');
    const result = await fetchStockHistory(stockMatch[0], { limit: days });
    sendJson(response, 200, {
      success: true,
      stock_code: stockMatch[0],
      records: result.records.length,
      source: result.source,
      start: result.records[0]?.date || null,
      end: result.records[result.records.length - 1]?.date || null,
      history: result.records
    });
    return true;
  }

  // 只读诊断：回读 stock_price 真实落库数据（A2→A3 写库验证用，绝不写库）
  stockMatch = routeMatch(url.pathname, /^\/api\/stock\/([^/]+)\/prices$/);
  if (stockMatch) {
    const code = stockMatch[0];
    const from = url.searchParams.get('from') || null;
    const to = url.searchParams.get('to') || null;
    const where = ['stock_code = ?'];
    const params = [code];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to) { where.push('date <= ?'); params.push(to); }
    const cond = where.join(' AND ');
    // 走 dbAsync：生产 PostgreSQL / 本地 SQLite 回退。CAST 成 INTEGER 避免 PG 的 COUNT/SUM 以 bigint 字符串返回导致 NaN。
    const agg = await dbAsync.get(`
      SELECT CAST(COUNT(*) AS INTEGER) AS total,
             CAST(COUNT(DISTINCT date) AS INTEGER) AS distinct_dates,
             MIN(date) AS min_date,
             MAX(date) AS max_date,
             CAST(COALESCE(SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END), 0) AS INTEGER) AS null_price,
             CAST(COALESCE(SUM(CASE WHEN change_percent IS NULL THEN 1 ELSE 0 END), 0) AS INTEGER) AS null_change
      FROM stock_price WHERE ${cond}
    `, params);
    const rows = await dbAsync.all(`
      SELECT stock_code, date, price, change_percent, updated_at
      FROM stock_price WHERE ${cond}
      ORDER BY date ASC
    `, params);
    sendJson(response, 200, {
      success: true,
      stock_code: code,
      total: Number(agg.total),
      distinct_dates: Number(agg.distinct_dates),
      min_date: agg.min_date,
      max_date: agg.max_date,
      null_price: Number(agg.null_price || 0),
      null_change: Number(agg.null_change || 0),
      duplicates: Number(agg.total) - Number(agg.distinct_dates),
      rows
    });
    return true;
  }

  match = routeMatch(url.pathname, /^\/api\/fund\/(\d{6})$/);
  if (match) {
    let fund = await getFund(match[0]);
    if (!fund) {
      try {
        console.log(`[auto-import] API fund details: auto-importing ${match[0]}...`);
        await importFund(match[0]);
        fund = await getFund(match[0]);
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
      fund = (await getFund(match[0])) || fund;
    }
    const history = await getHistory(match[0]);
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
      holdings: await getFundHoldings(match[0]),
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
      ...await estimatePortfolio(match[0])
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
