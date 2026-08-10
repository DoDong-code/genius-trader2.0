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
const { getConnectedCredential } = require('./sourceCredentials');
const { getProvider } = require('../providers/registry');

const PROVIDER_ORDER = ['xiaobeiyangji', 'yangjibao'];
const PROVIDER_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30000;

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
    status_note: `${provider.displayName || provider.sourceName}估值`
  };
  return estimate;
}

async function tryProviderEstimate(sourceName, code, amount, userId = 0) {
  const credential = await getConnectedCredential(sourceName, userId);
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
 * @param {{force?: boolean}} options
 */
async function fetchProviderEstimate(code, amount, options = {}) {
  if (!options.force) {
    const cached = estimateCache.get(String(code));
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  }

  const userId = Number(options.userId) || 0;
  const attempts = PROVIDER_ORDER.map(sourceName =>
    tryProviderEstimate(sourceName, code, amount, userId).catch(() => null)
  );
  const results = await Promise.all(attempts);
  const hit = results.find(value => value) || null;

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
