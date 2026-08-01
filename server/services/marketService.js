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
    source: 'fundgz'
  };
}

async function fetchRealtimeEstimate(code) {
  const source = await fetchText(`${EASTMONEY_FUND_ESTIMATE}/js/${code}.js`, {
    referer: `${EASTMONEY_FUND}/${code}.html`,
    attempts: 2,
    timeout: 8000
  });
  const estimate = parseEstimate(source);
  if (!estimate) {
    const error = new Error(`基金 ${code} 暂无实时估值`);
    error.statusCode = 404;
    throw error;
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
    const history = await fetchEastmoneyHistory(code, options);
    if (!history.length) throw new Error('Eastmoney returned no NAV records');
    return options.withMeta ? { history, source: 'eastmoney-lsjz', fallback: false } : history;
  } catch (primaryError) {
    const history = await fetchTiantianHistory(code, options);
    if (!history.length) {
      const error = new Error(`No historical NAV records available for ${code}`);
      error.statusCode = 502;
      error.cause = primaryError;
      throw error;
    }
    return options.withMeta
      ? { history, source: 'tiantian-f10', fallback: true, primaryError: primaryError.message }
      : history;
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
