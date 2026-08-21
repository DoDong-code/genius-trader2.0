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

const estimateCache = new Map(); // fund_code -> { at, value }

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
  if (!options.force) {
    const cached = estimateCache.get(String(code));
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  }

  const userId = Number(options.userId) || 0;
  // 统一 source 别名：微信端短名(xbyj/yjb) → 服务端内部名(xiaobeiyangji/yangjibao)；内部名原样透传
  const source = options.source ? (SOURCE_ALIASES[String(options.source)] || options.source) : undefined;
  // 任一 Provider 先返回有效估值即胜出，避免等待慢的那个；全部失败/超时才返回 null 走本地引擎兜底
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
    estimateCache.set(String(code), { at: Date.now(), value: hit });
  }
  return hit;
}

module.exports = {
  fetchProviderEstimate,
  tryProviderEstimate,
  normalizeProviderEstimate,
  PROVIDER_ORDER
};
