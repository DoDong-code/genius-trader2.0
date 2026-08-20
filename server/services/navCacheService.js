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

// 进程内并发锁：fund_code -> Promise（同一基金并发请求共享同一次获取）
const inFlight = new Map();

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
 * 确保当天净值存在：命中缓存直接返回；未命中且收盘后 → 按 provider 优先级获取并写缓存。
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

  // ② 收盘前：只读缓存，不允许写（避免盘中估算污染当天缓存）
  if (!isAfterClose()) {
    return { date: expected, nav: null, source: null, fromCache: false, cached: false, reason: 'before-close' };
  }

  // ③ 并发锁：同一基金同时只有一个获取请求
  if (inFlight.has(fundCode)) return inFlight.get(fundCode);
  const promise = (async () => {
    // ④ provider 优先级：小倍 → 养基宝（小倍养基宝每天晚上可稳定拿到当天净值）
    const providerOrder = ['xiaobeiyangji', 'yangjibao'];
    for (const sourceName of providerOrder) {
      logFetch(sourceName, fundCode);
      const est = await fetchProviderEstimate(fundCode, undefined, {
        force: true,
        source: sourceName,
        userId: Number(options.userId) || 0
      }).catch(() => null);
      if (!est) continue;
      const tradeDate = est.trade_date || est.nav_date || null;
      if (tradeDate !== expected) continue; // 非 expected 日 → 不写当天缓存
      const nav = Number(est.estimate_nav);
      if (!Number.isFinite(nav) || nav <= 0) continue;
      // ⑤ 写缓存（fund_code + date 唯一键，ON CONFLICT 幂等更新）
      await dbAsync.run(
        `INSERT INTO fund_nav (fund_code, date, nav, acc_nav, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (fund_code, date) DO UPDATE SET
           nav = excluded.nav,
           acc_nav = COALESCE(excluded.acc_nav, fund_nav.acc_nav),
           source = excluded.source,
           fetched_at = CURRENT_TIMESTAMP`,
        [fundCode, expected, nav, nav, sourceName]
      );
      logSaved(fundCode, expected);
      return { date: expected, nav, source: sourceName, fromCache: false, cached: true };
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
