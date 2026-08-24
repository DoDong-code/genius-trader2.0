/**
 * Provider 估值优先链路
 *
 * 优先级：小倍养基 / 养基宝（已登录且有数据）→ 本地引擎测算（兜底）
 *
 * 说明：
 * - 两个 Provider 并行尝试，先返回有效估值者胜出
 * - 单个 Provider 有超时保护，失败不影响兜底
 * - 结果带 30 秒内存缓存，避免前端轮询频繁请求第三方
 */
const { getCredential } = require('./sourceCredentials');
const { getProvider } = require('../providers/registry');

const PROVIDER_ORDER = ['xiaobeiyangji', 'yangjibao'];
// 微信端短名 → 服务端内部名；内部名原样透传，不影响网页端现有行为
const SOURCE_ALIASES = { xbyj: 'xiaobeiyangji', yjb: 'yangjibao' };
const PROVIDER_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 300000; // 5 minutes TTL as requested
const ESTIMATE_CACHE_MAX = 2000; // P3.3: hard cap on fund codes kept in memory

// P3.3: bounded LRU + TTL cache.
// The previous implementation used a bare `Map` that grew forever: every fund
// code ever queried stayed resident for the process lifetime. On a long-lived
// Render instance this silently leaked memory until OOM. Now:
//   - cacheGet() returns null (and evicts) on TTL expiry
//   - cacheSet() evicts the oldest entry when over capacity
//   - a periodic sweeper drops expired-but-untouched entries
const estimateCache = new Map(); // fund_code -> { at, value }

function cacheGet(code) {
  const e = estimateCache.get(String(code));
  if (!e) return null;
  if (Date.now() - e.at >= CACHE_TTL_MS) {
    estimateCache.delete(String(code));
    return null;
  }
  return e;
}

function cacheSet(code, entry) {
  const key = String(code);
  if (!estimateCache.has(key) && estimateCache.size >= ESTIMATE_CACHE_MAX) {
    const oldest = estimateCache.keys().next().value;
    if (oldest !== undefined) estimateCache.delete(oldest);
  }
  estimateCache.set(key, entry);
}

// periodic sweep: drop expired entries so untouched-but-expired codes don't linger
const estimateCacheSweeper = setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [k, v] of estimateCache) {
    if (now - v.at >= CACHE_TTL_MS) { estimateCache.delete(k); evicted += 1; }
  }
  if (evicted > 0) {
    console.log(`[estimateCache] sweep evicted ${evicted}, size=${estimateCache.size}`);
  }
}, CACHE_TTL_MS);
if (estimateCacheSweeper.unref) estimateCacheSweeper.unref();

// lightweight heap watchdog to observe the leak fix in Render metrics
const heapWatchdog = setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[heap] rss=${(m.rss / 1048576) | 0}MB heapUsed=${(m.heapUsed / 1048576) | 0}MB heapTotal=${(m.heapTotal / 1048576) | 0}MB estimateCache=${estimateCache.size}`);
}, CACHE_TTL_MS);
if (heapWatchdog.unref) heapWatchdog.unref();

const pendingBulkFetches = new Map(); // "sourceName:userId" -> Promise
const lastBulkFetchTime = new Map(); // "sourceName:userId" -> timestamp

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * 把 Provider 原始估值归一化为 Genius Trader 引擎输出结构
 * - estimate_growth 为百分比（如 1.23 表示 1.23%）
 * - GT 内部 estimate_change 为小数比率（0.0123）
 */
function normalizeProviderEstimate(provider, raw, code, amount) {
  const growth = Number(raw.estimate_growth);
  const nav = Number(raw.estimate_nav);
  if (!Number.isFinite(growth) || !Number.isFinite(nav)) return null;
  const change = growth / 100;
  const estimate = {
    fund_code: String(code),
    fund_name: String(raw.fund_name || ''),
    estimate_nav: nav,
    estimate_change: change,
    estimate_change_percent: round2(growth),
    estimate_profit: Number.isFinite(amount) ? round2(amount * change) : null,
    estimateProfit: Number.isFinite(amount) ? round2(amount * change) : null,
    estimate_time: raw.estimate_time || new Date().toISOString(),
    estimate_source: provider.sourceName,
    source: provider.sourceName,
    status_note: `${provider.displayName || provider.sourceName}估值`,
    trade_date: raw.trade_date || null
  };
  return estimate;
}

// 批量预拉取第三方估值并填充至全局缓存，实现 O(1) 毫秒级极速响应
async function preFetchAllProviderEstimates(sourceName, userId) {
  const cacheKey = `${sourceName}:${userId}`;
  const now = Date.now();
  // 限流保护：30秒内不重复向第三方服务器发起批量请求
  if (lastBulkFetchTime.has(cacheKey) && now - lastBulkFetchTime.get(cacheKey) < 30000) {
    return;
  }
  lastBulkFetchTime.set(cacheKey, now);

  const credential = await getCredential(sourceName, userId);
  if (!credential || credential.status !== 'connected' || !credential.token) return;

  const provider = getProvider(sourceName);
  if (!provider) return;
  provider.setToken(credential.token);

  if (sourceName === 'xiaobeiyangji') {
    try {
      // 1. 获取持仓列表以提取持仓基金代码，不消耗额外耗时
      const data = await provider._request('POST', '/yangji-api/api/get-hold-list', provider._commonBody());
      const items = ((data && data.list) || []).filter(item => item && item.money);
      if (items.length) {
        const codes = items.map(item => String(item.code));
        // 2. 一次性批量获取所有持仓基金的盘中估值
        const navList = await provider._getOptionalChangeNav(codes);
        for (const item of (navList || [])) {
          const code = String(item.code);
          const valuation = Number(item.valuation);
          const valuationY = Number(item.valuationY);
          const nav = Number(item.nav);

          let estimateNav;
          let estimateGrowth;
          if (Number.isFinite(valuation) && valuation !== 0) {
            estimateNav = valuation;
            estimateGrowth = Number.isFinite(valuationY) ? valuationY * 100 : null;
          }

          if (Number.isFinite(estimateNav) && estimateGrowth !== null) {
            const rawObj = {
              fund_code: code,
              fund_name: '',
              estimate_nav: estimateNav,
              estimate_growth: estimateGrowth,
              estimate_time: new Date().toISOString(),
              trade_date: new Date().toISOString().slice(0, 10)
            };
            const normalized = normalizeProviderEstimate(provider, rawObj, code, undefined);
            if (normalized) {
              cacheSet(code, { at: Date.now(), value: normalized });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[bulk-estimate] xiaobeiyangji bulk pre-fetch failed:', err.message);
    }
  } else if (sourceName === 'yangjibao') {
    try {
      // 1. 批量获取养基宝多账户
      const accounts = await provider.fetchAccounts();
      for (const account of accounts) {
        // 2. 获取该账户下的所有持仓（已自带估值 nv_info，单次请求即可拿全）
        const rawHoldings = await provider._fetchRawHoldings(account.account_id);
        for (const holding of rawHoldings) {
          const code = String(holding.code);
          const nvInfo = holding.nv_info || {};
          const estimateNav = nvInfo.gsz || nvInfo.vgsz || nvInfo.zsgz;
          const estimateGrowth = nvInfo.gszzl || nvInfo.vgszzl || nvInfo.zsgzzl;
          if (estimateNav && estimateGrowth) {
            const rawObj = {
              fund_code: code,
              fund_name: String(holding.short_name || ''),
              estimate_nav: Number(estimateNav),
              estimate_growth: Number(estimateGrowth),
              estimate_time: new Date().toISOString(),
              trade_date: new Date().toISOString().slice(0, 10)
            };
            const normalized = normalizeProviderEstimate(provider, rawObj, code, undefined);
            if (normalized) {
              cacheSet(code, { at: Date.now(), value: normalized });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[bulk-estimate] yangjibao bulk pre-fetch failed:', err.message);
    }
  }
}

// 采用 Promise 共享机制，防止并发请求时重复调用批量接口
function getBulkFetchPromise(sourceName, userId) {
  const cacheKey = `${sourceName}:${userId}`;
  if (pendingBulkFetches.has(cacheKey)) {
    return pendingBulkFetches.get(cacheKey);
  }

  const promise = preFetchAllProviderEstimates(sourceName, userId).finally(() => {
    pendingBulkFetches.delete(cacheKey);
  });

  pendingBulkFetches.set(cacheKey, promise);
  return promise;
}

async function tryProviderEstimate(sourceName, code, amount, userId = 0) {
  // 凭证严格按登录账户隔离：每个账号只使用自己登录的第三方
  const credential = await getCredential(sourceName, userId);
  if (!credential || credential.status !== 'connected' || !credential.token) return null;
  const provider = getProvider(sourceName);
  if (!provider || typeof provider.fetch_estimate !== 'function') return null;
  provider.setToken(credential.token);

  const value = await Promise.race([
    Promise.resolve(provider.fetch_estimate(code)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('provider-timeout')), PROVIDER_TIMEOUT_MS))
  ]);
  if (!value) return null;
  return normalizeProviderEstimate(provider, value, code, amount);
}

/**
 * 获取优先估值；无 Provider 估值时返回 null（由调用方走本地引擎兜底）
 * @param {string} code 基金代码
 * @param {number|undefined} amount 持有金额（用于估算收益）
 * @param {{force?: boolean, source?: string, userId?: number}} options
 */
async function fetchProviderEstimate(code, amount, options = {}) {
  const userId = Number(options.userId) || 0;
  // 统一 source 别名：微信端短名(xbyj/yjb) → 服务端内部名(xiaobeiyangji/yangjibao)；内部名原样透传
  const source = options.source ? (SOURCE_ALIASES[String(options.source)] || options.source) : undefined;
  const targetSources = source ? [source] : PROVIDER_ORDER;

  // 1. 如果不是强刷，且缓存存在有效数据，立即返回
  if (!options.force) {
  const cached = cacheGet(code);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      if (cached.value) {
        const copy = { ...cached.value };
        if (Number.isFinite(amount)) {
          copy.estimate_profit = round2(amount * copy.estimate_change);
          copy.estimateProfit = copy.estimate_profit;
        }
        return copy;
      }
      return cached.value;
    }
  }

  // 2. 并发安全地触发批量预拉取（Promise合并）
  for (const src of targetSources) {
    try {
      await getBulkFetchPromise(src, userId);
    } catch (e) {
      // 容错：批量预拉取异常时不阻断流程
    }
  }

  // 3. 再次查询缓存（大概率已通过批量接口预先加载）
  const cachedAfter = cacheGet(code);
  if (cachedAfter && Date.now() - cachedAfter.at < CACHE_TTL_MS) {
    if (cachedAfter.value) {
      const copy = { ...cachedAfter.value };
      if (Number.isFinite(amount)) {
        copy.estimate_profit = round2(amount * copy.estimate_change);
        copy.estimateProfit = copy.estimate_profit;
      }
      return copy;
    }
    return cachedAfter.value;
  }

  // 4. 兜底逐个拉取（若批量同步未能涵盖此基金代码）
  const hit = await new Promise(resolve => {
    const order = source ? PROVIDER_ORDER.filter(name => name === source) : PROVIDER_ORDER;
    const pending = order.map(sourceName =>
      tryProviderEstimate(sourceName, code, amount, userId).catch(() => null)
    );
    let settled = 0;
    pending.forEach(p => {
      p.then(value => {
        if (value) {
          resolve(value);
          return;
        }
        settled += 1;
        if (settled === pending.length) resolve(null);
      });
    });
  });

  if (hit && !options.force) {
    cacheSet(String(code), { at: Date.now(), value: hit });
  }
  return hit;
}

module.exports = {
  fetchProviderEstimate,
  tryProviderEstimate,
  normalizeProviderEstimate,
  PROVIDER_ORDER
};
