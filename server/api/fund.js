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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-AI-API-Key'
  });
  response.end(JSON.stringify(payload));
}

function routeMatch(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function handleFundApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return true;
  }

  // 第三方 Provider API（养基宝 / 小倍养基）
  if (url.pathname.startsWith('/api/provider/')) {
    const { handleProviderApi } = require('./provider');
    await handleProviderApi(request, response, url);
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
        const portfolio = body.portfolio;
        const config = body.config || {};
        if (headerKey && !config.apiKey) {
          config.apiKey = headerKey;
        }

        const ai = require('../services/ai/index');
        try {
          const analysis = await ai.analyzePortfolio(portfolio, config);
          sendJson(response, 200, { success: true, analysis });
        } catch (err) {
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

  if (url.pathname === '/api/funds') {
    sendJson(response, 200, { success: true, funds: listFunds() });
    return true;
  }

  if (url.pathname === '/api/portfolio/accounts' && request.method === 'GET') {
    const { listSyncedAccounts } = require('../services/portfolioService');
    sendJson(response, 200, { success: true, accounts: listSyncedAccounts() });
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
    // 估值优先级：小倍养基 / 养基宝（已登录）→ 本地引擎测算（兜底）
    const { fetchProviderEstimate } = require('../services/providerEstimate');
    const estimate = (await fetchProviderEstimate(match[0], amount, { force }))
      || await calculateFundEstimate(match[0], { amount, force });
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
      await importFund(match[0], { force: true }).catch(error => {
        console.warn(`[fund-refresh] ${match[0]}: ${error.message}`);
      });
      fund = getFund(match[0]) || fund;
    }
    const history = getHistory(match[0]);
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
      estimate: url.searchParams.get('refresh') === '1'
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
