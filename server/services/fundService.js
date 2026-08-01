const fs = require('node:fs');
const path = require('node:path');
const { getDatabase, transaction } = require('../database/db');
const {
  fetchHistory,
  fetchHoldings,
  fetchRealtimeEstimate
} = require('./marketService');

const EASTMONEY_FUND_URL = 'https://fund.eastmoney.com';
const cacheDirectory = path.join(__dirname, '..', 'data', 'cache');

function assertFundCode(code) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    const error = new Error('基金代码必须为六位数字');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function shanghaiDate(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/html,application/javascript;q=0.9,*/*;q=0.8',
          Referer: EASTMONEY_FUND_URL,
          'User-Agent': 'Mozilla/5.0 GeniusTraderFundData/1.0'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        throw new Error(`天天基金返回 HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(300 * 2 ** (attempt - 1));
      }
    }
  }
  const error = new Error(`请求天天基金失败：${lastError?.message || '未知错误'}`);
  error.cause = lastError;
  error.statusCode = 502;
  throw error;
}

function readJavaScriptValue(source, variableName) {
  const marker = new RegExp(`\\bvar\\s+${variableName}\\s*=\\s*`);
  const match = marker.exec(source);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const first = source[start];

  if (first === '"' || first === "'") {
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (!escaped && character === first) {
        const value = source.slice(start, index + 1);
        return first === '"' ? JSON.parse(value) : value.slice(1, -1);
      }
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
    }
  }

  if (first === '[' || first === '{') {
    const closing = first === '[' ? ']' : '}';
    let depth = 0;
    let quote;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (!escaped && character === quote) quote = undefined;
        escaped = !escaped && character === '\\';
        if (character !== '\\') escaped = false;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === first) depth += 1;
      if (character === closing) depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }

  const end = source.indexOf(';', start);
  return source.slice(start, end < 0 ? undefined : end).trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '')
    .trim();
}

function parseFundProfile(html) {
  const typeMatch = html.match(/类型：\s*<a[^>]*>([^<]+)<\/a>/);
  const companyMatch = html.match(/管\s*理\s*人<\/span>：\s*<a[^>]*>([^<]+)<\/a>/);
  const latestMatch = html.match(
    /单位净值<\/a><\/span>\s*\(<\/span>(\d{4}-\d{2}-\d{2})\)<\/p><\/dt>\s*<dd class="dataNums">\s*<span[^>]*>([\d.]+)<\/span>\s*<span[^>]*>([-+]?\d+(?:\.\d+)?)%<\/span>/
  );
  const accumulatedMatch = html.match(
    /累计净值<\/a>[\s\S]{0,220}?<dd class="dataNums">\s*<span[^>]*>([\d.]+)<\/span>/
  );
  return {
    fundType: decodeHtml(typeMatch?.[1]) || null,
    company: decodeHtml(companyMatch?.[1]) || null,
    latestNav: latestMatch ? {
      date: latestMatch[1],
      nav: Number(latestMatch[2]),
      accNav: accumulatedMatch ? Number(accumulatedMatch[1]) : Number(latestMatch[2]),
      changePercent: Number(latestMatch[3]) / 100
    } : null
  };
}

function parseFundNameFromProfile(html, code) {
  const detailTitle = html.match(/class=["']fundDetail-tit["'][^>]*>\s*<div[^>]*>([^<(]+)(?:\([^<]*)?<\/div>/i)?.[1];
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]
    ?.replace(/基金净值|基金档案|天天基金网|东方财富网|[-_—|].*$/g, '');
  const name = decodeHtml(detailTitle || title);
  return name && name !== code ? name : null;
}

function parseFundScript(code, source) {
  const fundName = readJavaScriptValue(source, 'fS_name');
  const fundCode = readJavaScriptValue(source, 'fS_code');
  const navTrend = readJavaScriptValue(source, 'Data_netWorthTrend');
  const accumulatedTrend = readJavaScriptValue(source, 'Data_ACWorthTrend');
  if (!fundName || !Array.isArray(navTrend) || navTrend.length === 0) {
    const error = new Error(`未能解析基金 ${code} 的公开净值数据`);
    error.statusCode = 502;
    throw error;
  }

  const accumulatedByTime = new Map(
    (Array.isArray(accumulatedTrend) ? accumulatedTrend : [])
      .map(item => [Number(item[0]), Number(item[1])])
  );

  const history = navTrend
    .filter(item => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
    .map(item => ({
      date: shanghaiDate(Number(item.x)),
      nav: Number(item.y),
      accNav: accumulatedByTime.get(Number(item.x)) ?? Number(item.y),
      changePercent: Number.isFinite(Number(item.equityReturn))
        ? Number(item.equityReturn) / 100
        : null
    }))
    .sort((left, right) => left.date.localeCompare(right.date));

  return {
    fundCode: String(fundCode || code),
    fundName: String(fundName),
    history
  };
}

function cachePath(code) {
  return path.join(cacheDirectory, `${code}.json`);
}

function readDailyCache(code) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(code), 'utf8'));
    return cache?.version === 4 && cache?.cacheDate === shanghaiDate() ? cache.data : null;
  } catch {
    return null;
  }
}

function writeDailyCache(code, data) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath(code), JSON.stringify({
    version: 4,
    cacheDate: shanghaiDate(),
    fetchedAt: new Date().toISOString(),
    data
  }));
}

function freshSyncState(resourceKey, dataType) {
  const state = getDatabase().prepare(`
    SELECT expires_at FROM data_sync_state
    WHERE resource_key = ? AND data_type = ?
  `).get(resourceKey, dataType);
  return Boolean(state && Date.parse(state.expires_at) > Date.now());
}

function markSyncState(resourceKey, dataType, ttlMilliseconds) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMilliseconds);
  getDatabase().prepare(`
    INSERT INTO data_sync_state (resource_key, data_type, last_synced_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(resource_key, data_type) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      expires_at = excluded.expires_at
  `).run(resourceKey, dataType, now.toISOString(), expiresAt.toISOString());
}

async function collectFund(code, options = {}) {
  const fundCode = assertFundCode(code);
  if (!options.force) {
    const cached = readDailyCache(fundCode);
    if (cached) return { ...cached, fromCache: true };
  }

  const scriptUrl = `${EASTMONEY_FUND_URL}/pingzhongdata/${fundCode}.js?v=${Date.now()}`;
  const profileUrl = `${EASTMONEY_FUND_URL}/${fundCode}.html`;
  const useStoredHoldings = !options.force && freshSyncState(fundCode, 'holdings');
  const [scriptResult, profileResult, historyResult, holdingsResult] = await Promise.allSettled([
    fetchText(scriptUrl),
    fetchText(profileUrl),
    fetchHistory(fundCode, { withMeta: true }),
    useStoredHoldings ? Promise.resolve(getFundHoldings(fundCode)) : fetchHoldings(fundCode)
  ]);
  const profileSource = profileResult.status === 'fulfilled' ? profileResult.value : '';
  const profile = parseFundProfile(profileSource);
  let parsed = null;
  if (scriptResult.status === 'fulfilled') {
    try {
      parsed = parseFundScript(fundCode, scriptResult.value);
    } catch {
      parsed = null;
    }
  }
  const historyFetch = historyResult.status === 'fulfilled'
    ? historyResult.value
    : { history: [], source: null };
  const apiHistory = Array.isArray(historyFetch) ? historyFetch : historyFetch.history;
  const historyByDate = new Map((parsed?.history || []).map(item => [item.date, item]));
  apiHistory.forEach(item => historyByDate.set(item.date, item));
  const history = [...historyByDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!history.length) {
    const error = new Error(`未能获取基金 ${fundCode} 的历史净值数据`);
    error.statusCode = 502;
    throw error;
  }
  if (profile.latestNav) {
    const existing = history.findIndex(item => item.date === profile.latestNav.date);
    if (existing >= 0) history[existing] = profile.latestNav;
    else history.push(profile.latestNav);
    history.sort((left, right) => left.date.localeCompare(right.date));
  }
  const data = {
    fundCode,
    fundName: parsed?.fundName || parseFundNameFromProfile(profileSource, fundCode) || `基金 ${fundCode}`,
    history,
    holdings: holdingsResult.status === 'fulfilled' ? holdingsResult.value : [],
    fundType: profile.fundType,
    company: profile.company,
    source: {
      detail: parsed ? 'pingzhongdata' : 'fund-page',
      history: apiHistory.length ? (historyFetch.source || 'eastmoney-lsjz') : 'pingzhongdata',
      holdings: holdingsResult.status === 'fulfilled' ? 'fund-archives' : null
    }
  };
  writeDailyCache(fundCode, data);
  return { ...data, fromCache: false, refreshedHoldings: !useStoredHoldings };
}

async function importFund(code, options = {}) {
  const data = await collectFund(code, options);
  const db = getDatabase();
  const existingDates = new Set(
    db.prepare('SELECT date FROM fund_nav WHERE fund_code = ?').all(data.fundCode)
      .map(row => row.date)
  );

  transaction(database => {
    database.prepare(`
      INSERT INTO fund (fund_code, fund_name, fund_type, company)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(fund_code) DO UPDATE SET
        fund_name = excluded.fund_name,
        fund_type = COALESCE(excluded.fund_type, fund.fund_type),
        company = COALESCE(excluded.company, fund.company),
        updated_at = datetime('now')
    `).run(data.fundCode, data.fundName, data.fundType, data.company);

    const upsertNav = database.prepare(`
      INSERT INTO fund_nav (fund_code, date, nav, acc_nav)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(fund_code, date) DO UPDATE SET
        nav = excluded.nav,
        acc_nav = excluded.acc_nav
    `);
    data.history.forEach(item => {
      upsertNav.run(data.fundCode, item.date, item.nav, item.accNav);
    });

    if (data.holdings.length) {
      const upsertHolding = database.prepare(`
        INSERT INTO fund_holdings (fund_code, stock_code, stock_name, weight, report_date)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fund_code, stock_code, report_date) DO UPDATE SET
          stock_name = excluded.stock_name,
          weight = excluded.weight
      `);
      data.holdings.forEach(item => {
        upsertHolding.run(
          data.fundCode,
          item.stock_code,
          item.stock_name,
          item.weight,
          item.report_date || 'unknown'
        );
      });
    }
  });

  markSyncState(data.fundCode, 'history', 24 * 60 * 60 * 1000);
  if (data.refreshedHoldings) {
    markSyncState(data.fundCode, 'holdings', 90 * 24 * 60 * 60 * 1000);
  }

  return {
    success: true,
    fund: data.fundName,
    fund_code: data.fundCode,
    records: data.history.length,
    inserted: data.history.filter(item => !existingDates.has(item.date)).length,
    cached: data.fromCache,
    history_source: data.source.history
  };
}

async function getRealtimeFundEstimate(code) {
  const fundCode = assertFundCode(code);
  try {
    return await fetchRealtimeEstimate(fundCode);
  } catch (error) {
    const latestPair = getDatabase().prepare(`
      SELECT date, nav
      FROM fund_nav
      WHERE fund_code = ?
      ORDER BY date DESC
      LIMIT 2
    `).all(fundCode);
    const latest = latestPair[0];
    const previous = latestPair[1];
    let change = null;
    if (latest && previous && Number.isFinite(latest.nav) && Number.isFinite(previous.nav) && previous.nav > 0) {
      change = (latest.nav - previous.nav) / previous.nav;
    }
    return {
      fund_code: fundCode,
      nav_date: latest?.date || null,
      nav: latest?.nav ?? null,
      estimate_nav: latest?.nav ?? null,
      estimate_change: change,
      estimate_time: latest?.date || null,
      source: '本地数据库缓存',
      is_trading_day: false,
      status_note: '非交易日，展示最近交易日数据'
    };
  }
}

function getFund(code) {
  const fundCode = assertFundCode(code);
  const db = getDatabase();
  const fund = db.prepare(`
    SELECT id, fund_code, fund_name, fund_type, company, created_at, updated_at
    FROM fund
    WHERE fund_code = ?
  `).get(fundCode);
  if (!fund) return null;
  const latestNav = db.prepare(`
    SELECT date, nav, acc_nav
    FROM fund_nav
    WHERE fund_code = ?
    ORDER BY date DESC
    LIMIT 1
  `).get(fundCode);
  return { ...fund, latest_nav: latestNav || null };
}

function listFunds() {
  return getDatabase().prepare(`
    SELECT fund_code, fund_name, fund_type, company, updated_at
    FROM fund
    ORDER BY fund_code
  `).all();
}

function getFundHoldings(code) {
  const fundCode = assertFundCode(code);
  return getDatabase().prepare(`
    SELECT stock_code, stock_name, weight, report_date
    FROM fund_holdings
    WHERE fund_code = ?
      AND report_date = (
        SELECT MAX(report_date) FROM fund_holdings WHERE fund_code = ?
      )
    ORDER BY weight DESC
    LIMIT 10
  `).all(fundCode, fundCode);
}

module.exports = {
  assertFundCode,
  collectFund,
  importFund,
  getFund,
  getFundHoldings,
  getRealtimeFundEstimate,
  listFunds,
  parseFundScript,
  parseFundProfile,
  parseFundNameFromProfile,
  readJavaScriptValue
};
