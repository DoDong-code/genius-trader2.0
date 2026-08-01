const EASTMONEY_FUND = 'https://fund.eastmoney.com';
const EASTMONEY_FUND_API = 'https://api.fund.eastmoney.com';
const EASTMONEY_FUND_ESTIMATE = 'https://fundgz.1234567.com.cn';
const EASTMONEY_FUND_ARCHIVES = 'https://fundf10.eastmoney.com';
const EASTMONEY_STOCK_API = 'https://push2.eastmoney.com';
const EASTMONEY_STOCK_DELAY_API = 'https://push2delay.eastmoney.com';

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchText(url, options = {}) {
  let lastError;
  const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : null;
  const attempts = retryDelays ? retryDelays.length + 1 : Number(options.attempts || 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: options.accept || 'application/json,text/html,application/javascript;q=0.9,*/*;q=0.8',
          Referer: options.referer || `${EASTMONEY_FUND}/`,
          'User-Agent': 'Mozilla/5.0 GeniusTraderFundData/2.0'
        },
        signal: AbortSignal.timeout(Number(options.timeout || 15000))
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = retryDelays
          ? Number(retryDelays[attempt - 1] || 0)
          : 250 * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }
  const error = new Error(`东方财富数据请求失败：${lastError?.message || '未知错误'}`);
  error.statusCode = 502;
  error.cause = lastError;
  throw error;
}

function shanghaiDateString(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function isTradingDay(dateStr = shanghaiDateString()) {
  const d = new Date(dateStr + 'T00:00:00+08:00');
  const dayOfWeek = d.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const holidays = [
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'
  ];
  return !holidays.includes(dateStr);
}

function getLatestTradingDay(fromDateStr = shanghaiDateString()) {
  let curr = new Date(fromDateStr + 'T00:00:00+08:00');
  while (true) {
    const ds = shanghaiDateString(curr);
    if (isTradingDay(ds)) return ds;
    curr.setDate(curr.getDate() - 1);
  }
}

function parseJsonp(source) {
  const match = String(source || '').match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseEstimate(source) {
  const payload = parseJsonp(source);
  if (!payload?.fundcode) return null;
  const estimateNav = Number(payload.gsz);
  const estimateChange = Number(payload.gszzl);
  return {
    fund_code: String(payload.fundcode),
    fund_name: payload.name || null,
    nav_date: payload.jzrq || null,
    nav: Number.isFinite(Number(payload.dwjz)) ? Number(payload.dwjz) : null,
    estimate_nav: Number.isFinite(estimateNav) ? estimateNav : null,
    estimate_change: Number.isFinite(estimateChange) ? estimateChange / 100 : null,
    estimate_time: payload.gztime || null,
    source: '天天基金 (主接口)'
  };
}

async function fetchRealtimeEstimate(code) {
  const todayStr = shanghaiDateString();
  const tradingDay = isTradingDay(todayStr);
  const latestTradingDay = getLatestTradingDay(todayStr);

  let estimate = null;

  // 1. Primary Source: 天天基金 pingzhongdata / fundgz
  try {
    const source = await fetchText(`${EASTMONEY_FUND}/pingzhongdata/${code}.js?v=${Date.now()}`, {
      referer: `${EASTMONEY_FUND}/${code}.html`,
      attempts: 2,
      timeout: 4000
    });
    const nameMatch = source.match(/fS_name\s*=\s*\"([^\"]+)\"/);
    const trendMatch = source.match(/Data_netWorthTrend\s*=\s*(\[[^;]+\]);/);
    if (trendMatch) {
      const arr = JSON.parse(trendMatch[1]);
      const last = arr[arr.length - 1];
      if (last) {
        const date = shanghaiDateString(Number(last.x));
        estimate = {
          fund_code: String(code),
          fund_name: nameMatch ? nameMatch[1] : null,
          nav_date: date,
          nav: Number(last.y),
          estimate_nav: Number(last.y),
          estimate_change: last.equityReturn != null ? Number(last.equityReturn) / 100 : null,
          estimate_time: date,
          source: '天天基金 (主接口)'
        };
      }
    }
  } catch (e) {
    // Try legacy fundgz
    try {
      const gzSource = await fetchText(`${EASTMONEY_FUND_ESTIMATE}/js/${code}.js`, {
        referer: `${EASTMONEY_FUND}/${code}.html`,
        attempts: 1,
        timeout: 3000
      });
      estimate = parseEstimate(gzSource);
    } catch (gzErr) {}
  }

  // 2. Backup Secondary Source: 东方财富 API
  if (!estimate || !estimate.nav_date) {
    try {
      const url = new URL('/f10/lsjz', EASTMONEY_FUND_API);
      url.searchParams.set('fundCode', code);
      url.searchParams.set('pageIndex', '1');
      url.searchParams.set('pageSize', '2');
      const text = await fetchText(url, {
        accept: 'application/json,*/*',
        referer: `${EASTMONEY_FUND}/f10/jjjz_${code}.html`,
        attempts: 2,
        timeout: 4000
      });
      const parsed = parseHistoryPayload(text);
      if (parsed.history && parsed.history[0]) {
        const top = parsed.history[0];
        estimate = {
          fund_code: String(code),
          fund_name: null,
          nav_date: top.date,
          nav: top.nav,
          estimate_nav: top.nav,
          estimate_change: top.changePercent,
          estimate_time: top.date,
          source: '东方财富 (备用接口)'
        };
      }
    } catch (secErr) {}
  }

  if (!estimate) {
    const error = new Error(`基金 ${code} 暂无可用的实时或历史行情`);
    error.statusCode = 404;
    throw error;
  }

  estimate.is_trading_day = tradingDay;
  estimate.latest_trading_day = latestTradingDay;
  if (!tradingDay || estimate.nav_date !== todayStr) {
    estimate.status_note = '非交易日，展示最近交易日数据';
  } else {
    estimate.status_note = '数据正常';
  }

  return estimate;
}

function parseHistoryPayload(source) {
  const payload = typeof source === 'string' ? JSON.parse(source) : source;
  const rows = payload?.Data?.LSJZList || [];
  return {
    total: Number(payload?.TotalCount || rows.length),
    pages: Number(payload?.PageCount || 1),
    history: rows.map(item => ({
      date: item.FSRQ,
      nav: Number(item.DWJZ),
      accNav: Number(item.LJJZ || item.DWJZ),
      changePercent: Number.isFinite(Number(item.JZZZL)) ? Number(item.JZZZL) / 100 : null
    })).filter(item => item.date && Number.isFinite(item.nav))
  };
}

function parseTiantianHistory(source) {
  const raw = String(source || '');
  const contentMatch = raw.match(/content\s*:\s*"([\s\S]*?)"\s*,\s*(?:records|pages|curpage|arryear)/i);
  if (!contentMatch?.[1]) return { total: 0, pages: 1, history: [] };
  const html = decodeJavaScriptString(contentMatch[1]);
  const history = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => decodeHtml(cell[1]));
    const dateIndex = cells.findIndex(cell => /^\d{4}-\d{2}-\d{2}$/.test(cell));
    if (dateIndex < 0) return null;
    const nav = Number(cells[dateIndex + 1]);
    const accNav = Number(cells[dateIndex + 2]);
    const changeCell = cells.slice(dateIndex + 3)
      .find(cell => /^[-+]?\d+(?:\.\d+)?%$/.test(cell));
    return {
      date: cells[dateIndex],
      nav,
      accNav: Number.isFinite(accNav) ? accNav : nav,
      changePercent: changeCell == null ? null : Number(changeCell.replace('%', '')) / 100
    };
  }).filter(item => item?.date && Number.isFinite(item.nav));
  const pages = Number(raw.match(/pages\s*:\s*['"]?(\d+)/i)?.[1] || 1);
  const total = Number(raw.match(/records\s*:\s*['"]?(\d+)/i)?.[1] || history.length);
  return { total, pages: Number.isFinite(pages) ? pages : 1, history };
}

async function fetchEastmoneyHistory(code, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 100), 1), 100);
  const maxPages = Math.min(Math.max(Number(options.maxPages || 50), 1), 50);
  const records = [];
  let pages = 1;
  for (let pageIndex = 1; pageIndex <= pages && pageIndex <= maxPages; pageIndex += 1) {
    const url = new URL('/f10/lsjz', EASTMONEY_FUND_API);
    url.searchParams.set('fundCode', code);
    url.searchParams.set('pageIndex', String(pageIndex));
    url.searchParams.set('pageSize', String(pageSize));
    const parsed = parseHistoryPayload(await fetchText(url, {
      accept: 'application/json,*/*',
      referer: `${EASTMONEY_FUND}/f10/jjjz_${code}.html`,
      // The public API occasionally rate-limits requests. Retry twice with
      // the requested 2s / 5s backoff before using the backup source.
      retryDelays: [2000, 5000]
    }));
    records.push(...parsed.history);
    pages = Math.min(parsed.pages || 1, maxPages);
  }
  const unique = new Map(records.map(item => [item.date, item]));
  return [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
}

async function fetchTiantianHistory(code, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 100), 1), 100);
  const maxPages = Math.min(Math.max(Number(options.maxPages || 50), 1), 50);
  const records = [];
  let pages = 1;
  for (let page = 1; page <= pages && page <= maxPages; page += 1) {
    const url = new URL('/f10/F10DataApi.aspx', EASTMONEY_FUND);
    url.searchParams.set('type', 'lsjz');
    url.searchParams.set('code', code);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per', String(pageSize));
    const parsed = parseTiantianHistory(await fetchText(url, {
      accept: 'application/javascript,text/html,*/*',
      referer: `${EASTMONEY_FUND}/f10/jjjz_${code}.html`,
      attempts: 2,
      timeout: 15000
    }));
    records.push(...parsed.history);
    pages = Math.min(parsed.pages || 1, maxPages);
  }
  const unique = new Map(records.map(item => [item.date, item]));
  return [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
}

async function fetchHistory(code, options = {}) {
  try {
    const history = await fetchTiantianHistory(code, options);
    if (!history.length) throw new Error('Tiantian returned no NAV records');
    return options.withMeta ? { history, source: '天天基金 (主接口)', fallback: false } : history;
  } catch (primaryError) {
    try {
      const history = await fetchEastmoneyHistory(code, options);
      if (!history.length) throw new Error('Eastmoney returned no NAV records');
      return options.withMeta
        ? { history, source: '东方财富 (备用接口)', fallback: true, primaryError: primaryError.message }
        : history;
    } catch (secondaryError) {
      const error = new Error(`未能在天天基金和东方财富获取到基金 ${code} 的历史净值`);
      error.statusCode = 502;
      error.cause = secondaryError;
      throw error;
    }
  }
}

function decodeJavaScriptString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\(["'\\/])/g, '$1');
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHoldings(source) {
  const contentMatch = String(source || '').match(/content\s*:\s*"([\s\S]*?)"\s*,\s*arryear/);
  if (!contentMatch || !contentMatch[1]) return [];
  const html = decodeJavaScriptString(contentMatch[1]);
  const reportDate = html.match(/截止至：[\s\S]*?(\d{4}-\d{2}-\d{2})/)?.[1]
    || html.match(/(\d{4})年(\d)季度/)?.slice(1).join('-Q')
    || null;
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows.map(match => {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => decodeHtml(cell[1]));
    if (cells.length < 7 || !/^\d+$/.test(cells[0])) return null;
    const percentageCells = cells.slice(3)
      .filter(cell => /^[-+]?\d+(?:\.\d+)?%$/.test(String(cell).trim()));
    const weight = Number(String(percentageCells.at(-1) || '').replace('%', ''));
    return {
      stock_code: cells[1],
      stock_name: cells[2],
      weight: Number.isFinite(weight) ? weight / 100 : null,
      report_date: reportDate
    };
  }).filter(item => item?.stock_code && item.stock_name && Number.isFinite(item.weight));
}

async function fetchHoldings(code) {
  const url = new URL('/FundArchivesDatas.aspx', EASTMONEY_FUND_ARCHIVES);
  url.searchParams.set('type', 'jjcc');
  url.searchParams.set('code', code);
  url.searchParams.set('topline', '10');
  url.searchParams.set('year', '');
  url.searchParams.set('month', '');
  url.searchParams.set('rt', String(Date.now()));
  return parseHoldings(await fetchText(url, {
    referer: `${EASTMONEY_FUND_ARCHIVES}/ccmx_${code}.html`
  }));
}

function stockSecId(code) {
  const normalized = String(code || '').trim();
  if (/^\d{5}$/.test(normalized)) return `116.${normalized}`;
  if (/^(5|6|9)/.test(normalized)) return `1.${normalized}`;
  return `0.${normalized}`;
}

function stockSecIds(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (/^\d{5}$/.test(normalized)) return [`116.${normalized}`];
  if (/^\d{6}$/.test(normalized)) {
    const domestic = /^(5|6|9)/.test(normalized) ? `1.${normalized}` : `0.${normalized}`;
    return [domestic, `116.${normalized}`];
  }
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) {
    return [`105.${normalized}`, `106.${normalized}`, `107.${normalized}`];
  }
  return [stockSecId(normalized)];
}

async function fetchStockPayload(secid) {
  let lastError;
  for (const base of [EASTMONEY_STOCK_API, EASTMONEY_STOCK_DELAY_API]) {
    const url = new URL('/api/qt/stock/get', base);
    url.searchParams.set('secid', secid);
    url.searchParams.set('ut', 'bd1d9ddb04089700cf9c27f6f7426281');
    url.searchParams.set('invt', '2');
    url.searchParams.set('fields', 'f12,f14,f43,f57,f58,f170');
    try {
      return JSON.parse(await fetchText(url, {
        accept: 'application/json,*/*',
        referer: 'https://quote.eastmoney.com/',
        attempts: 1,
        timeout: 8000
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchStockQuote(code) {
  for (const secid of stockSecIds(code)) {
    const payload = await fetchStockPayload(secid);
    const data = payload?.data;
    if (!data) continue;
    return {
      stock_code: String(data.f12 || code),
      stock_name: data.f14 || data.f58 || null,
      price: Number.isFinite(Number(data.f43)) ? Number(data.f43) / 100 : null,
      change_percent: Number.isFinite(Number(data.f170)) ? Number(data.f170) / 10000 : null,
      source: payload?.rt === 4 ? 'push2-delay' : 'push2'
    };
  }
  return null;
}

module.exports = {
  fetchText,
  parseEstimate,
  fetchRealtimeEstimate,
  parseHistoryPayload,
  parseTiantianHistory,
  fetchHistory,
  fetchEastmoneyHistory,
  fetchTiantianHistory,
  parseHoldings,
  fetchHoldings,
  stockSecId,
  stockSecIds,
  fetchStockQuote
};
