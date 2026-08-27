/**
 * 统一出站 HTTP 客户端（P0-6，2026-08-26 新增）。
 *
 * 所有出站网络请求（基金/股票/估值/历史/Provider/AI 外部 API）统一经由此模块，
 * 严禁在业务代码中再写“裸 fetch(...)”。本模块保证：
 *   - 每次请求都有 timeout，且超时真正 Abort（AbortController），绝不无限 pending。
 *   - retry 有最大次数 + 指数退避 + 抖动；不允许无限 retry。
 *   - Abort / 异常 / 成功路径都不会泄漏定时器和悬挂 Promise。
 *   - 不改变任何数据源、数据源优先级、市场路由或 fallback 调度（调用方的选择逻辑不变）。
 *
 * 注意：并发闸门（concurrencyLimit.withLimit）由调用方在“批量/扇出”场景下自行包裹，
 * 本模块只负责单条请求的 timeout/abort/retry。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_CLIENT_TIMEOUT_MS || 15000);
const DEFAULT_MAX_ATTEMPTS = Number(process.env.HTTP_CLIENT_MAX_ATTEMPTS || 3);
const DEFAULT_BASE_DELAY_MS = Number(process.env.HTTP_CLIENT_BASE_DELAY_MS || 300);
const DEFAULT_MAX_DELAY_MS = Number(process.env.HTTP_CLIENT_MAX_DELAY_MS || 8000);

function randomJitter(base) {
  // 0.5x ~ 1.5x 抖动，避免大量请求同步重试形成惊群。
  return base * (0.5 + Math.random());
}

/**
 * 单次请求：带 timeout 的 fetch，超时真正 Abort。
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout] 覆盖默认超时（ms）
 * @param {AbortSignal} [options.signal] 外部已提供信号则不另建（但本模块仍会叠加自身超时）
 * @param {RequestInit} [options] 其余透传给 fetch（method/headers/body 等）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const timeout = Number(options.timeout || DEFAULT_TIMEOUT_MS);
  const externalSignal = options.signal || null;

  const controller = new AbortController();
  // 叠加超时：若调用方已传 signal，用 AbortSignal.any（Node 20+）合并，否则仅用本超时。
  let combinedSignal = controller.signal;
  let timer = null;

  try {
    if (externalSignal) {
      if (typeof AbortSignal.any === 'function') {
        combinedSignal = AbortSignal.any([controller.signal, externalSignal]);
      } else if (!externalSignal.aborted) {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    timer = setTimeout(() => controller.abort(), timeout);
    // 严禁 unref —— 若本次请求是进程唯一工作，unref 会让定时器永不触发，
    // 请求将无限挂起，彻底违背“超时真实 Abort”初衷。

    const { signal, timeout: _ignore, ...fetchInit } = options;
    const response = await fetch(url, { ...fetchInit, signal: combinedSignal });
    return response;
  } finally {
    if (timer) clearTimeout(timer);
    // controller 不再需要主动 abort：请求已完成（成功或抛错）。
  }
}

/**
 * 带重试 + 指数退避的请求。仅对“可重试”错误重试（网络错误 / 5xx / 429 / 超时 Abort），
 * 对 4xx（除 429）不重试。
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const baseDelay = Number(options.baseDelay || DEFAULT_BASE_DELAY_MS);
  const maxDelay = Number(options.maxDelay || DEFAULT_MAX_DELAY_MS);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      // 成功 / 4xx（除 429）：不重试，直接返回。
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response;
      }
      // 5xx / 429：可重试，抛出进入退避。
      lastError = new Error(`HTTP ${response.status}`);
      lastError.status = response.status;
      lastError.retryable = true;
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, randomJitter(delay)));
    }
  }
  const error = new Error(`请求失败（已重试 ${maxAttempts} 次）：${lastError && lastError.message ? lastError.message : '未知错误'}`);
  error.cause = lastError;
  error.statusCode = 502;
  throw error;
}

/**
 * 便捷：fetch + 取文本，自动重试。
 */
async function getText(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

/**
 * 便捷：fetch + 取 JSON，自动重试。
 */
async function getJson(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  return response.json();
}

module.exports = {
  fetchWithTimeout,
  fetchWithRetry,
  getText,
  getJson,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS
};
