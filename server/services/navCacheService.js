/**
 * P3.18-NET：当天净值缓存服务（后端唯一准源）
 *
 * 规则（网页 + 小程序统一）：
 *   - 唯一键：fund_code + trade_date（fund_nav 表 UNIQUE(fund_code, date)）
 *   - 当天净值第一次成功获取（小倍/养基宝）→ 立即写入 fund_nav 缓存
 *   - 之后当天所有场景（切 Tab/刷新/切数据源/刷新按钮/重启）→ 只读缓存，禁止重复请求
 *   - 仅进入新交易日才允许获取新净值
 *   - 收盘前（A股 15:00 前）不写缓存（避免盘中估算污染）；收盘后且 provider 返回 expected 日净值才写
 *   - 进程内并发锁：同一基金同时只有一个获取请求（防止并发重复获取）
 */
const dbAsync = require('../database/dbAsync');
const { fetchProviderEstimate } = require('./providerEstimate');
const { expectedNavDateFor } = require('./estimateStatus');
const { shanghaiDateString } = require('./marketService');

// 进程内并发锁：fund_code -> Promise（同一基金并发请求共享同一次获取）
const inFlight = new Map();

// P3.3: global concurrency limit for EXTERNAL NAV source fetches.
// Without this, when an account of N funds is loaded against a cold cache, each
// fund's ensureTodayNav fires up to 4 external requests (provider bulk, Yahoo,
// Eastmoney) simultaneously. N funds × 4 in flight at once spikes both memory
// and outbound connections on a shared Render instance → OOM. This caps the
// number of simultaneously-executing external fetches regardless of N. The
// per-fund inFlight lock above still prevents duplicate fetches for the SAME fund.
const MAX_EXTERNAL_CONCURRENCY = 6;
let activeExternal = 0;
const externalQueue = [];

function runExternal(fn) {
  return new Promise((resolve, reject) => {
    externalQueue.push({ fn, resolve, reject });
    pumpExternal();
  });
}

function pumpExternal() {
  while (activeExternal < MAX_EXTERNAL_CONCURRENCY && externalQueue.length > 0) {
    const { fn, resolve, reject } = externalQueue.shift();
    activeExternal += 1;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        activeExternal -= 1;
        pumpExternal();
      });
  }
}

function logHit(code, date) { console.log(`[NAV CACHE] hit ${code} ${date}`); }
function logMiss(code, date) { console.log(`[NAV CACHE] miss ${code} ${date}`); }
function logFetch(source, code) { console.log(`[NAV FETCH] source=${source} code=${code}`); }
function logSaved(code, date) { console.log(`[NAV CACHE] saved ${code} ${date}`); }

// A股 15:00（北京时间）收盘守卫：收盘后才允许把 provider 当天净值写入缓存
function isAfterClose(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const t = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Number(t.hour) * 60 + Number(t.minute) >= 15 * 60;
}

async function getCachedNav(fundCode, tradeDate) {
  return dbAsync.get(
    'SELECT date, nav, source, fetched_at FROM fund_nav WHERE fund_code = ? AND date = ?',
    [fundCode, tradeDate]
  );
}

/**
 * 确保当天净值存在：命中缓存直接返回；未命中且满足时间窗口时并发拉取多个数据源。
 * @param {string} fundCode
 * @param {{userId?: number}} options
 * @returns {Promise<{date:string, nav:number|null, source:string|null, fromCache:boolean, cached:boolean, reason?:string}>}
 */
async function ensureTodayNav(fundCode, options = {}) {
  const fund = await dbAsync.get('SELECT fund_type, fund_name FROM fund WHERE fund_code = ?', [fundCode]);
  const expected = expectedNavDateFor(fund);

  // ① 先查缓存：当天已成功获取 → 直接返回（不请求 provider）
  const cached = await getCachedNav(fundCode, expected);
  if (cached) {
    logHit(fundCode, expected);
    return { date: expected, nav: Number(cached.nav), source: cached.source || null, fromCache: true, cached: true };
  }
  logMiss(fundCode, expected);

  // ② 收盘前：如果 expected 刚好是今天，且未过 15:00，则不允许写/请求（避免盘中估算污染当天缓存）
  // 特例：如果是 QDII（expected 是历史交易日）或者非交易日，其 expected 是历史交易日，允许随时获取
  if (expected === shanghaiDateString() && !isAfterClose()) {
    return { date: expected, nav: null, source: null, fromCache: false, cached: false, reason: 'before-close' };
  }

  // ③ 并发锁：同一基金同时只有一个获取请求
  if (inFlight.has(fundCode)) return inFlight.get(fundCode);
  const promise = (async () => {
    // 1. 小倍养基 fetcher
    async function fetchFromXiaobei() {
      logFetch('xiaobeiyangji', fundCode);
      const est = await fetchProviderEstimate(fundCode, undefined, {
        force: true,
        source: 'xiaobeiyangji',
        userId: Number(options.userId) || 0
      }).catch(() => null);
      if (!est) return null;
      const date = est.trade_date || est.nav_date || null;
      const nav = Number(est.estimate_nav);
      if (date === expected && Number.isFinite(nav) && nav > 0) {
        return { nav, date, source: 'xiaobeiyangji' };
      }
      return null;
    }

    // 2. 养基宝 fetcher
    async function fetchFromYangjibao() {
      logFetch('yangjibao', fundCode);
      const est = await fetchProviderEstimate(fundCode, undefined, {
        force: true,
        source: 'yangjibao',
        userId: Number(options.userId) || 0
      }).catch(() => null);
      if (!est) return null;
      const date = est.trade_date || est.nav_date || null;
      const nav = Number(est.estimate_nav);
      if (date === expected && Number.isFinite(nav) && nav > 0) {
        return { nav, date, source: 'yangjibao' };
      }
      return null;
    }

    // 3. Yahoo Fetcher (symbol: ${fundCode}.OF)
    async function fetchFromYahoo() {
      logFetch('yahoo', fundCode);
      try {
        const symbol = `${fundCode}.OF`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://finance.yahoo.com/'
          },
          signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) return null;
        const json = await response.json();
        const result = json?.chart?.result?.[0];
        const timestamps = result?.timestamp;
        const closes = result?.indicators?.quote?.[0]?.close;
        if (Array.isArray(timestamps) && Array.isArray(closes) && timestamps.length > 0) {
          for (let i = timestamps.length - 1; i >= 0; i--) {
            const timestamp = timestamps[i];
            const nav = Number(closes[i]);
            if (Number.isFinite(nav) && nav > 0) {
              const date = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
              }).format(new Date(timestamp * 1000));
              if (date === expected) {
                return { nav, date, source: 'yahoo' };
              }
            }
          }
        }
      } catch (err) {
        // ignore
      }
      return null;
    }

    // 4. 天天基金 (Eastmoney history) fetcher
    async function fetchFromTiantian() {
      logFetch('eastmoney', fundCode);
      try {
        const { fetchHistory } = require('./marketService');
        const res = await fetchHistory(fundCode, { pageSize: 5, maxPages: 1, withMeta: true }).catch(() => null);
        if (!res) return null;
        const history = Array.isArray(res) ? res : res.history;
        if (Array.isArray(history) && history.length > 0) {
          for (let i = history.length - 1; i >= 0; i--) {
            const item = history[i];
            const date = item.date;
            const nav = Number(item.nav);
            const accNav = Number(item.accNav);
            if (date === expected && Number.isFinite(nav) && nav > 0) {
              return { nav, date, accNav, source: 'eastmoney' };
            }
          }
        }
      } catch (err) {
        // ignore
      }
      return null;
    }

    const promises = [
      runExternal(fetchFromXiaobei),
      runExternal(fetchFromYangjibao),
      runExternal(fetchFromYahoo),
      runExternal(fetchFromTiantian)
    ];

    const result = await new Promise((resolve) => {
      let resolved = false;
      let completed = 0;
      promises.forEach(p => {
        p.then(val => {
          if (resolved) return;
          if (val) {
            resolved = true;
            resolve(val);
          } else {
            completed++;
            if (completed === promises.length) {
              resolve(null);
            }
          }
        }).catch(() => {
          if (resolved) return;
          completed++;
          if (completed === promises.length) {
            resolve(null);
          }
        });
      });
    });

    if (result) {
      const accNav = result.accNav || result.nav;
      await dbAsync.run(
        `INSERT INTO fund_nav (fund_code, date, nav, acc_nav, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (fund_code, date) DO UPDATE SET
           nav = excluded.nav,
           acc_nav = CASE WHEN excluded.acc_nav IS NOT NULL AND excluded.acc_nav > 0 THEN excluded.acc_nav ELSE fund_nav.acc_nav END,
           source = excluded.source,
           fetched_at = CURRENT_TIMESTAMP`,
        [fundCode, expected, result.nav, accNav, result.source]
      );
      logSaved(fundCode, expected);
      return { date: expected, nav: result.nav, source: result.source, fromCache: false, cached: true };
    }

    return { date: expected, nav: null, source: null, fromCache: false, cached: false, reason: 'provider-unavailable' };
  })();
  inFlight.set(fundCode, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(fundCode);
  }
}

module.exports = { ensureTodayNav, getCachedNav, isAfterClose };
