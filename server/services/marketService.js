const EASTMONEY_FUND = 'https://fund.eastmoney.com';
const EASTMONEY_FUND_API = 'https://api.fund.eastmoney.com';
const EASTMONEY_FUND_ESTIMATE = 'https://fundgz.1234567.com.cn';
const EASTMONEY_FUND_ARCHIVES = 'https://fundf10.eastmoney.com';
const EASTMONEY_STOCK_API = 'https://push2.eastmoney.com';
const EASTMONEY_STOCK_DELAY_API = 'https://push2delay.eastmoney.com';
const EASTMONEY_STOCK_HIS_API = 'https://push2his.eastmoney.com';
const EASTMONEY_STOCK_HIS_DELAY_API = 'https://push2hisdelay.eastmoney.com';

// Phase 3.3-H：全局出站并发闸门（钳制同时进行的 fetch 数量，解 OOM 主因 B/F/G）。
const { withLimit } = require('./concurrencyLimit');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchText(url, options = {}) {
  let lastError;
  const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : null;
  const attempts = retryDelays ? retryDelays.length + 1 : Number(options.attempts || 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Phase 3.3-H：真实 fetch + 响应体缓冲（response.text()）统一经全局出站闸门，
      // 钳制并发出站数量，避免大量并发请求同时驻留 response body 造成 RSS 暴涨（G 次因）。
      const result = await withLimit(async () => {
        const response = await fetch(url, {
          headers: {
            Accept: options.accept || 'application/json,text/html,application/javascript;q=0.9,*/*;q=0.8',
            Referer: options.referer || `${EASTMONEY_FUND}/`,
            'User-Agent': options.userAgent || 'Mozilla/5.0 GeniusTraderFundData/2.0',
            ...(options.extraHeaders || {}) // Phase 3.17-E：允许附加头（如 Nasdaq 的 Origin），默认行为不变
          },
          signal: AbortSignal.timeout(Number(options.timeout || 15000))
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (options.returnMeta) {
          return {
            text,
            status: response.status,
            contentType: response.headers.get('content-type') || ''
          };
        }
        return text;
      });
      return result;
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
  const error = new Error(`${options.errorLabel || '东方财富数据请求失败'}：${lastError?.message || '未知错误'}`);
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
  const parts = dateStr.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
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
  const parts = fromDateStr.split('-');
  let curr = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  while (true) {
    const yyyy = curr.getFullYear();
    const mm = String(curr.getMonth() + 1).padStart(2, '0');
    const dd = String(curr.getDate()).padStart(2, '0');
    const ds = `${yyyy}-${mm}-${dd}`;
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

const ALPHANUMERIC_MAPPING = {
  'TENCENT': '00700',
  'ALIBABA': '09988',
  'MEITUAN': '03690',
  'XIAOMI': '01810',
  'NETEASE': '09999',
  'BAIDU': '09888',
  'JD_HK': '09618',
  'LENOVO': '00992',
  'SMIC_HK': '00981',
  'BYD': '01211'
};

// 持仓代码运行时归一化（绝不修改数据库中的原始持仓代码）。
// 仅覆盖已查证的标准交易代码，其余透传：
// - JP3236330001: Kioxia Holdings(铠侠) ISIN → 东京证交所 ticker 285A
// - 285A:         Kioxia 东京证交所代码 → Yahoo Tokyo 后缀 .T
// - 000660:       SK Hynix(SK海力士) 韩国 KRX 代码 → Yahoo Korea 后缀 .KS
//   注：000660 曾为深市 *ST南华(2004 已终止上市)，本应用数据仅于 QDII 外股持仓出现，等价 SK Hynix。
const STOCK_CODE_NORMALIZATION = {
  'JP3236330001': '285A.T',
  '285A': '285A.T',
  '000660': '000660.KS'
};

function normalizeStockCode(rawCode) {
  const key = String(rawCode || '').trim().toUpperCase();
  return STOCK_CODE_NORMALIZATION[key] || key;
}

// 将（已归一化的）代码转为 Yahoo Finance 代码；无法转换返回 null。
function toYahooSymbol(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/\.(T|KS|HK|TW|SS|SZ)$/.test(c)) return c;      // 已是 Yahoo 风格后缀
  if (/^\d{4}[A-Z]$/.test(c)) return `${c}.T`;          // 东京证交所如 285A
  if (/^[A-Z]{1,5}$/.test(c)) return c;                // 美股 ticker
  if (/^\d{5}$/.test(c)) return `${c}.HK`;             // 港股 5 位
  if (/^\d{6}$/.test(c)) {
    if (/^(5|6|9)/.test(c)) return `${c}.SS`;
    if (/^(005930|000660)$/.test(c)) return `${c}.KS`; // 三星 / SK海力士
    return `${c}.SZ`;
  }
  return null;
}

// Eastmoney push2 仅可靠支持 A股/港股/美股；东京(.T)与韩国(.KS)走 Yahoo。
function isEastmoneyUnsupported(rawCode) {
  return /\.(T|KS)$/.test(normalizeStockCode(rawCode));
}

function stockSecIds(code) {
  let input = String(code || '').trim().toUpperCase();
  if (ALPHANUMERIC_MAPPING[input]) {
    input = ALPHANUMERIC_MAPPING[input];
  }
  // 如果输入已经是 secid 格式（如 1.603986 / 0.300750 / 124.HSTECH），
  // 先提取真正的标的代码（点号后的部分），再统一按代码规则判定市场，
  // 避免把传入的 1.603986 误当成 116.603986。
  const secidMatch = input.match(/^\d{1,3}\.(\d{4,6})$/);
  if (secidMatch) {
    input = secidMatch[1];
  }
  // 纯数字代码（去除任何非数字字符做保险）
  const normalized = input.replace(/[^0-9]/g, '');
  // 6 位 A 股代码：上海(5/6/9 开头)→1.xxxxxx，深圳(0/3 开头)→0.xxxxxx。
  // 注意：绝不加 116. 前缀（116. 是基金/港股市场，不是 A 股股票）。
  if (/^\d{6}$/.test(normalized)) {
    const domestic = /^(5|6|9)/.test(normalized) ? `1.${normalized}` : `0.${normalized}`;
    return [domestic];
  }
  // 5 位（基金/港股等）保留原 116. 映射，不影响股票场景
  if (/^\d{5}$/.test(normalized)) {
    return [`116.${normalized}`];
  }
  // 美股/港股字母代码
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(input)) {
    return [`105.${input}`, `106.${input}`, `107.${input}`];
  }
  return [stockSecId(input)];
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
        attempts: 2,
        timeout: 8000
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchStockQuote(code) {
  const normalized = normalizeStockCode(code);
  // 东京(.T)/韩国(.KS) Eastmoney 不可靠，直接走 Yahoo，避免误查 A股同名代码
  if (!isEastmoneyUnsupported(normalized)) {
    for (const secid of stockSecIds(normalized)) {
      try {
        const payload = await fetchStockPayload(secid);
        const data = payload?.data;
        if (!data) continue;
        return {
          stock_code: String(data.f12 || normalized),
          stock_name: data.f14 || data.f58 || null,
          price: Number.isFinite(Number(data.f43)) ? Number(data.f43) / 100 : null,
          change_percent: Number.isFinite(Number(data.f170)) ? Number(data.f170) / 10000 : null,
          source: payload?.rt === 4 ? 'push2-delay' : 'push2'
        };
      } catch (error) {
        console.warn(`[marketService] Failed to fetch stock quote for secid ${secid}:`, error.message);
      }
    }
  }
  // Yahoo Finance 兜底（东京/韩国必走此路；其余市场失败时也兜底）
  const yf = toYahooSymbol(normalized);
  if (yf) {
    try {
      const q = await fetchStockQuoteYahoo(yf);
      if (q) return q;
    } catch (error) {
      console.warn(`[marketService] Failed to fetch Yahoo quote for ${yf}:`, error.message);
    }
  }
  return null;
}

async function fetchStockQuoteYahoo(yfSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=1d&range=1d`;
  const text = await fetchText(url, {
    referer: 'https://finance.yahoo.com/',
    accept: 'application/json,*/*',
    timeout: 8000,
    attempts: 2
  });
  const json = safeJsonParse(text);
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) return null;
  const changePercent = price / prev - 1;
  return {
    stock_code: String(meta.symbol || yfSymbol),
    stock_name: meta.shortName || meta.longName || null,
    price,
    change_percent: changePercent,
    source: 'yahoo'
  };
}

// 股票代码 → 交易所前缀（腾讯/新浪接口需要 sh / sz）
function stockExchangePrefix(code) {
  const c = String(code || '').replace(/[^0-9]/g, '');
  if (/^(5|6|9)/.test(c)) return 'sh'; // 上交所：6/9 开头股票、5 开头指数/ETF
  return 'sz'; // 深交所：0/3 开头
}

/**
 * 统一校验 + 去重 + 升序 + 截断为最近 days 条。
 * - 入参 rawRows：各数据源抽取后的裸记录（{date, open, close, high, low, volume, amount?, change_percent?}）。
 * - change_percent 未提供时，按“当日收盘 / 前一日收盘 - 1”计算（小数）；第一条无前收则记 0。
 * - amount 缺失记为 null（不伪造）；其余 OHLCV 必须合法，否则该行丢弃。
 * - 验证：close/open/high/low > 0，high>=max(open,close,low)，low<=min(open,close,high)，无 NaN/Inf。
 */
function finalizeStockHistory(rawRows, code, days) {
  if (!Array.isArray(rawRows)) return [];
  const byDate = new Map();
  for (const r of rawRows) {
    if (r && r.date) byDate.set(String(r.date), r); // 后者覆盖前者 → 日期去重
  }
  const sorted = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const out = [];
  let prevClose = null;
  for (const r of sorted) {
    const date = String(r.date);
    const open = Number(r.open);
    const close = Number(r.close);
    const high = Number(r.high);
    const low = Number(r.low);
    const volume = Number(r.volume);
    let amount = (r.amount === undefined || r.amount === null) ? null : Number(r.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (![open, close, high, low, volume].every(Number.isFinite)) continue;
    if (close <= 0 || open <= 0 || high <= 0 || low <= 0 || volume < 0) continue;
    if (!(high >= Math.max(open, close, low))) continue;
    if (!(low <= Math.min(open, close, high))) continue;
    if (!Number.isFinite(amount)) amount = null;
    let changePercent;
    if (r.change_percent !== undefined && r.change_percent !== null && Number.isFinite(Number(r.change_percent))) {
      changePercent = Number(r.change_percent); // 数据源已给小数（如东方财富）
    } else if (prevClose && prevClose > 0) {
      changePercent = close / prevClose - 1;
    } else {
      changePercent = 0; // 第一条无前收
    }
    if (!Number.isFinite(changePercent)) changePercent = 0;
    out.push({ date, open, close, high, low, volume, amount, price: close, change_percent: changePercent });
    prevClose = close;
  }
  const trimmed = out.slice(-Math.max(Number(days) || 365, 1)); // 只保留最近 days 条
  return trimmed.map(r => ({ stock_code: String(code), ...r }));
}

// 腾讯财经 qfq 日 K 通用实现（公开、无需 key；symbol 形如 sh600988 / hk01787）
async function fetchStockHistoryTencentSymbol(symbol, days) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
  const text = await fetchText(url, {
    accept: 'application/json,*/*',
    referer: 'https://gu.qq.com/',
    userAgent: 'Mozilla/5.0',
    attempts: 2,
    timeout: 8000
  });
  const json = safeJsonParse(text) || parseJsonp(text);
  if (!json || json.code !== 0) throw new Error('腾讯返回 code!=0 或解析失败');
  const node = json.data && json.data[symbol];
  if (!node) throw new Error('腾讯无该标的节点');
  const series = node.qfqday || node.day || node.kline;
  if (!Array.isArray(series) || !series.length) throw new Error('腾讯无 qfqday 数据');
  // 腾讯 qfqday 数组顺序：[date, open, close, high, low, volume(手), amount?]
  return series.map(arr => {
    if (Array.isArray(arr)) {
      return {
        date: String(arr[0]),
        open: arr[1], close: arr[2], high: arr[3], low: arr[4],
        volume: Number(arr[5]) * 100, // 手→股，与数据契约一致
        amount: arr[6]
      };
    }
    if (arr && arr.day) {
      return { date: arr.day, open: arr.open, close: arr.close, high: arr.high, low: arr.low, volume: arr.volume, amount: arr.amount };
    }
    return null;
  }).filter(Boolean);
}

// 数据源 1：腾讯财经 qfq 日 K（A股 sh/sz 前缀，Phase 3.17-B 起 A股链路不变）
async function fetchStockHistoryTencent(code, days) {
  return fetchStockHistoryTencentSymbol(`${stockExchangePrefix(code)}${code}`, days);
}

// Phase 3.17-E：腾讯港股日 K（hk<5位代码>，免 Key、实测可覆盖 2 年历史；source=tencent-hk-kline）
async function fetchStockHistoryTencentHk(code, days) {
  return fetchStockHistoryTencentSymbol(`hk${code}`, days);
}

// 数据源 2：新浪财经日 K（公开、无需 key、返回真实 A 股 OHLCV，含命名字段）
async function fetchStockHistorySina(code, days) {
  const prefix = stockExchangePrefix(code);
  const symbol = `${prefix}${code}`;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${days}`;
  const text = await fetchText(url, {
    accept: 'application/json,*/*',
    referer: 'https://finance.sina.com.cn/',
    userAgent: 'Mozilla/5.0',
    attempts: 2,
    timeout: 8000
  });
  const arr = safeJsonParse(text);
  if (!Array.isArray(arr) || !arr.length) throw new Error('新浪无数据');
  // 新浪字段：day, open, high, low, close, volume(股)
  return arr.map(o => ({
    date: String(o.day),
    open: o.open, close: o.close, high: o.high, low: o.low,
    volume: o.volume, amount: o.amount
  }));
}

// 数据源 3：东方财富历史 K 线（保留为最后的 fallback；Render 公网常返回首页 HTML，需识别为失败）
async function fetchStockHistoryEastmoney(code, days, secid) {
  const begDate = new Date(Date.now() - days * 86400000);
  const beg = shanghaiDateString(begDate.getTime()).replace(/-/g, '');
  const endpoints = [
    ['push2his', EASTMONEY_STOCK_HIS_API],
    ['push2hisdelay', EASTMONEY_STOCK_HIS_DELAY_API]
  ];
  let lastError = null;
  let lastEmptyReason = null;
  for (const [baseName, base] of endpoints) {
    try {
      const url = new URL('/api/qt/stock/kline/get', base);
      url.searchParams.set('secid', secid);
      url.searchParams.set('ut', 'fa5fd1943c7b386f172d6893dbfba10b');
      url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
      url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
      url.searchParams.set('klt', '101'); // 日 K
      url.searchParams.set('fqt', '1');   // 前复权
      url.searchParams.set('beg', beg);   // 历史开始日期
      url.searchParams.set('end', '20500101');
      url.searchParams.set('lmt', String(days));
      const meta = await fetchText(url, {
        accept: 'application/json,*/*',
        referer: 'https://quote.eastmoney.com/',
        userAgent: 'Mozilla/5.0',
        attempts: 2,
        timeout: 8000,
        returnMeta: true
      });
      const text = meta.text;
      // 东方财富在 Render 公网常返回首页 HTML（非 JSON），必须识别为失败，不得解析、不得当空数据
      const trimmedText = String(text || '').trimStart();
      if (/^<!DOCTYPE html|^<html/i.test(trimmedText)) {
        console.warn(`[stock-history] source=eastmoney status=failed reason=html_response endpoint=${baseName}`);
        lastEmptyReason = `[${baseName}] html_response`;
        continue;
      }
      const payload = parseJsonp(text) || safeJsonParse(text);
      const data = payload && payload.data;
      const klines = data && data.klines;
      if (!Array.isArray(klines) || klines.length === 0) {
        const reason = payload && payload.rc !== 0 ? `rc=${payload.rc}` : 'data.klines 为空或缺失';
        const respText = String(text || '');
        console.warn(`[stock-history-debug] secid=${secid} status=200 content-type=${meta.contentType} response_length=${respText.length} response_prefix=${respText.slice(0, 300)}`);
        console.warn(`[stock-history] source=eastmoney secid=${secid} endpoint=${baseName} status=200 error=${reason}`);
        lastEmptyReason = `[${baseName}] ${reason}`;
        continue;
      }
      // 东方财富 kline 字段：f51=日期, f52=开, f53=收, f54=高, f55=低, f56=成交量, f57=成交额, f59=涨跌幅(百分比)
      return klines.map(line => {
        const p = String(line).split(',');
        return {
          date: p[0], open: p[1], close: p[2], high: p[3], low: p[4], volume: p[5], amount: p[6],
          change_percent: p[8] !== undefined ? Number(p[8]) / 100 : undefined // 东方财富给百分比，转小数
        };
      });
    } catch (error) {
      console.warn(`[stock-history] source=eastmoney secid=${secid} endpoint=${baseName} status=error error=${error.message}`);
      lastError = error;
    }
  }
  const errMsg = lastEmptyReason || (lastError && lastError.message) || '东方财富无可用历史行情';
  throw new Error(errMsg);
}

// Yahoo Historical（港美日韩 fallback；A股绝不用 Yahoo）。
// 复用 fetchStockQuoteYahoo 的请求/解析基础设施；返回统一历史记录格式（date/open/close/high/low/volume/amount）。
async function fetchStockHistoryYahoo(yfSymbol, days) {
  const range = days <= 120 ? '6mo' : days <= 250 ? '1y' : '2y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=1d&range=${range}`;
  const text = await fetchText(url, {
    referer: 'https://finance.yahoo.com/',
    accept: 'application/json,*/*',
    timeout: 8000,
    attempts: 2,
    errorLabel: 'Yahoo 数据请求失败' // Phase 3.17-B：Yahoo 错误不再混入 Eastmoney 文案
  });
  const json = safeJsonParse(text);
  if (json && json.chart && json.chart.error) {
    throw new Error(`Yahoo error: ${json.chart.error.code || ''} ${json.chart.error.description || ''}`.trim());
  }
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  const timestamps = result && result.timestamp;
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!Array.isArray(timestamps) || !timestamps.length || !quote) throw new Error('Yahoo 无有效历史数据');
  const records = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close[i];
    if (close === null || close === undefined) continue; // 剔除无效/null
    records.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: quote.open[i], close,
      high: quote.high[i], low: quote.low[i],
      volume: quote.volume[i], amount: null
    });
  }
  if (!records.length) throw new Error('Yahoo 校验后无有效记录');
  records.sort((a, b) => String(a.date).localeCompare(String(b.date))); // 日期升序
  return records;
}

// ── Phase 3.17-E：Nasdaq 公开历史 API（免 Key，仅美股 ticker；source=nasdaq-kline）──
// 实测（Phase 3.17-D）：单发稳定；连续快速请求会触发风控并返回误导性 "Symbol not exists"，
// 因此强制相邻请求间隔 >= 1500ms，不做并发。
let lastNasdaqRequestAt = 0;
const NASDAQ_MIN_INTERVAL_MS = 1500;

// Nasdaq 日期格式 MM/DD/YYYY → YYYY-MM-DD（finalizeStockHistory 契约）
function nasdaqToIsoDate(value) {
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// Nasdaq 数值为字符串（可能带 $ 与千分位逗号），统一清洗为有限数；非法返回 NaN（由 finalize 校验丢弃）
function toFiniteNumber(value) {
  if (value === null || value === undefined) return NaN;
  const n = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

async function fetchStockHistoryNasdaq(ticker, days) {
  const waitMs = NASDAQ_MIN_INTERVAL_MS - (Date.now() - lastNasdaqRequestAt);
  if (waitMs > 0) await sleep(waitMs); // 保守限速，防风控
  lastNasdaqRequestAt = Date.now();
  const toDate = new Date();
  const fromDate = new Date(Date.now() - days * 86400000 * 2); // 2 倍余量，确保取满 days 个交易日
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical?assetclass=stocks&fromdate=${fromDate.toISOString().slice(0, 10)}&todate=${toDate.toISOString().slice(0, 10)}&limit=${days + 30}`;
  const text = await fetchText(url, {
    accept: 'application/json,text/plain, */*',
    referer: 'https://www.nasdaq.com/',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    extraHeaders: { Origin: 'https://www.nasdaq.com' },
    attempts: 2,
    timeout: 10000,
    errorLabel: 'Nasdaq 数据请求失败'
  });
  const json = safeJsonParse(text);
  const rows = json && json.data && json.data.tradesTable && json.data.tradesTable.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Nasdaq 无有效历史数据');
  const out = [];
  for (const r of rows) {
    const date = nasdaqToIsoDate(r && r.date);
    if (!date) continue;
    out.push({
      date,
      open: toFiniteNumber(r.open), close: toFiniteNumber(r.close),
      high: toFiniteNumber(r.high), low: toFiniteNumber(r.low),
      volume: toFiniteNumber(r.volume), amount: null
    });
  }
  if (!out.length) throw new Error('Nasdaq 校验后无有效记录');
  return out; // 排序/去重/校验由 finalizeStockHistory 统一完成
}

/**
 * 获取个股历史日 K 线（用于校准所需的 stock_price 历史行情）。
 * 多数据源 fallback（Phase 3.17-E 起按市场路由）：
 * - A股（6 位数字）：tencent → sina → eastmoney（不变，绝不进 Yahoo/Nasdaq）
 * - 港股（5 位纯数字）：tencent-hk(hk<code>) → eastmoney(116.xxxxx) → yahoo
 * - 美股（字母 ticker）：nasdaq → eastmoney(105./106./107.) → yahoo
 * - 日韩（.T/.KS，含 000660/285A/JP3236330001）：跳过三源只走 Yahoo（杜绝跨市场误同步）
 * 任一可用即返回；全部失败返回 records:[]（绝不伪造）。
 * 返回 { records: [{ stock_code, date, open, close, high, low, volume, amount, price, change_percent }], source, secid }。
 * - price 始终 = 收盘价（与 stockPrice upsert 契约一致）；change_percent 存小数（1.23% => 0.0123）。
 * - 超时策略：每个数据源 timeout=8000ms、最多 2 次尝试；数据源依次尝试，不无限重试，单源失败不阻塞整体。
 * - 关键错误处理：HTML 响应 / 空数据 / 解析错误一律视为该数据源失败，记录 [stock-history] 日志；全部失败记录 all_sources_failed。
 * - 防误同步（Phase 3.17-B/E）：先按归一化代码判定市场，绝不通过“请求成功”反推市场归属；
 *   某源成功后立即返回，不再请求后续数据源。
 */
async function fetchStockHistory(code, options = {}) {
  const days = Math.min(Math.max(Number(options.days || options.limit || 365), 1), 2000);
  const secids = stockSecIds(code); // 仍用于东方财富 secid（如 1.603986 / 116.01787 / 105.AMD）
  const normalized = normalizeStockCode(code);
  const isJpKr = /\.(T|KS)$/.test(normalized); // 日韩：Eastmoney 不可靠，直接 Yahoo（与 fetchStockQuote 一致）
  const raw = String(code).trim();
  const isAStock = /^\d{6}$/.test(raw) && !isJpKr;            // A股：6 位纯数字
  const isHkStock = /^\d{5}$/.test(raw) && !isJpKr;           // 港股：5 位纯数字 → 腾讯 hk<code>
  const isUsStock = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(raw.toUpperCase()) && !isJpKr; // 美股：字母 ticker → Nasdaq
  const sources = [];
  if (isAStock) {
    sources.push(
      { name: 'tencent', run: () => fetchStockHistoryTencent(code, days) },
      { name: 'sina', run: () => fetchStockHistorySina(code, days) },
      { name: 'eastmoney', run: () => fetchStockHistoryEastmoney(code, days, secids[0]) }
    );
  } else if (isHkStock) {
    sources.push(
      { name: 'tencent-hk', run: () => fetchStockHistoryTencentHk(code, days) },
      { name: 'eastmoney', run: () => fetchStockHistoryEastmoney(code, days, secids[0]) }
    );
  } else if (isUsStock) {
    sources.push(
      { name: 'nasdaq', run: () => fetchStockHistoryNasdaq(code, days) },
      { name: 'eastmoney', run: () => fetchStockHistoryEastmoney(code, days, secids[0]) }
    );
  }
  // Yahoo Historical fallback：仅港美日韩（A股 6 位数字绝不用 Yahoo）
  const yf = toYahooSymbol(normalized);
  if (!isAStock && yf) {
    sources.push({ name: 'yahoo', run: () => fetchStockHistoryYahoo(yf, days) });
  }
  let lastError = null;
  for (const src of sources) {
    try {
      const raw = await src.run();
      if (!Array.isArray(raw) || !raw.length) {
        console.warn(`[stock-history] source=${src.name} status=failed error=无有效原始数据`);
        continue;
      }
      const records = finalizeStockHistory(raw, code, days);
      if (!records.length) {
        console.warn(`[stock-history] source=${src.name} status=failed error=校验后无有效记录`);
        continue;
      }
      console.log(`[stock-history] source=${src.name} secid=${secids[0]} records=${records.length} start=${records[0].date} end=${records[records.length - 1].date}`);
      return { records, source: `${src.name}-kline`, secid: secids[0] };
    } catch (error) {
      console.warn(`[stock-history] source=${src.name} status=failed error=${error.message}`);
      lastError = error;
    }
  }
  // 所有数据源失败：返回明确失败状态，不要伪造 records
  console.error(`[stock-history] code=${code} status=failed error=all_sources_failed`);
  return { records: [], source: null, error: 'all_sources_failed' };
}

function safeJsonParse(source) {
  try {
    return JSON.parse(String(source || ''));
  } catch {
    return null;
  }
}

// 主要指数行情（东方财富 secid）
const INDEX_SECIDS = {
  '上证指数': '1.000001',
  '沪深300': '1.000300',
  '深证成指': '0.399001',
  '科创50': '1.000688',
  '创业板指': '0.399006',
  '恒生科技': '124.HSTECH',
  '纳斯达克': '100.NDX',
  '标普500': '100.SPX'
};

let indexQuotesCache = { data: null, at: 0 };
const INDEX_CACHE_MS = 30 * 1000;

async function fetchIndexQuotes(force = false) {
  if (!force && indexQuotesCache.data && Date.now() - indexQuotesCache.at < INDEX_CACHE_MS) {
    return indexQuotesCache.data;
  }
  const entries = await Promise.all(Object.entries(INDEX_SECIDS).map(async ([name, secid]) => {
    try {
      const payload = await fetchStockPayload(secid);
      const data = payload && payload.data;
      return {
        name,
        price: data && Number.isFinite(Number(data.f43)) ? Number(data.f43) / 100 : null,
        changePercent: data && Number.isFinite(Number(data.f170)) ? Number(data.f170) / 10000 : null,
        ok: Boolean(data && Number.isFinite(Number(data.f43)))
      };
    } catch (error) {
      return { name, price: null, changePercent: null, ok: false };
    }
  }));
  indexQuotesCache = { data: entries, at: Date.now() };
  return entries;
}

module.exports = {
  fetchText,
  parseEstimate,
  fetchRealtimeEstimate,
  isTradingDay,
  shanghaiDateString,
  parseHistoryPayload,
  parseTiantianHistory,
  fetchHistory,
  fetchEastmoneyHistory,
  fetchTiantianHistory,
  parseHoldings,
  fetchHoldings,
  stockSecId,
  stockSecIds,
  normalizeStockCode,
  toYahooSymbol,
  fetchStockQuote,
  fetchStockHistory,
  fetchIndexQuotes,
  getLatestTradingDay
};
