/**
 * 请求级上下文（P0-2 / P0-4，2026-08-26 新增）。
 *
 * 基于 AsyncLocalStorage，把“一次 HTTP 请求 / 一次分析任务”内的共享状态绑定到当前异步调用链：
 *   - requestCache：本次请求内共享的 Map，用于 Analysis 去重（同基金只构建一次）、
 *     metadata / history / estimate 按 code 复用，杜绝 N+1。
 *   - meta：请求身份标签（如 userId、requestId、generation），供账号生命周期竞争防护（P0-4）
 *     在写入前校验“当前请求是否仍属于有效账号”。
 *
 * 无作用域时（如单测直接调用），requestMemo 退化为“直接执行，不缓存”，保证行为安全。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();

function runInRequestScope(fn, meta = {}) {
  const store = {
    cache: new Map(),
    meta: { requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...meta },
    startedAt: Date.now()
  };
  return scope.run(store, fn);
}

function getScope() {
  return scope.getStore() || null;
}

function requestCache() {
  const s = scope.getStore();
  return s ? s.cache : null;
}

/**
 * 本次请求内按 key 去重：同一 key 只执行一次 factory（含并发共享同一 Promise）。
 * @param {string} key
 * @param {Function<Promise<any>>} factory
 */
async function requestMemo(key, factory) {
  const cache = requestCache();
  if (!cache) return Promise.resolve().then(factory);
  if (cache.has(key)) return cache.get(key);
  const promise = Promise.resolve().then(factory);
  cache.set(key, promise);
  // 失败时移除，避免污染（下次重新计算）
  promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  return promise;
}

module.exports = {
  runInRequestScope,
  getScope,
  requestCache,
  requestMemo
};
