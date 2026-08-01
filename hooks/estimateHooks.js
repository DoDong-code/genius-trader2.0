const DEFAULT_API_BASE = '';

async function requestEstimate(path, options = {}) {
  const apiBase = options.apiBase || DEFAULT_API_BASE;
  const response = await fetch(`${apiBase}${path}`, {
    signal: options.signal,
    headers: { Accept: 'application/json' }
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `估值接口请求失败（${response.status}）`);
  }
  return payload;
}

function useFundEstimate(code, options = {}) {
  const query = new URLSearchParams();
  if (Number.isFinite(Number(options.amount))) query.set('amount', String(options.amount));
  if (options.force) query.set('force', '1');
  const suffix = query.size ? `?${query}` : '';
  return requestEstimate(`/api/fund/${encodeURIComponent(code)}/estimate${suffix}`, options);
}

function usePortfolioEstimate(accountId, options = {}) {
  const suffix = options.force ? '?force=1' : '';
  return requestEstimate(`/api/account/${encodeURIComponent(accountId)}/estimate${suffix}`, options);
}

const estimateHooks = { useFundEstimate, usePortfolioEstimate, requestEstimate };

if (typeof module !== 'undefined' && module.exports) module.exports = estimateHooks;
if (typeof window !== 'undefined') window.GeniusTraderEstimateHooks = estimateHooks;
