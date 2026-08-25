// Phase 3.3-H：共享出站请求并发闸门。
// 目的：钳制"同时进行的出站 fetch 数量"，杜绝 calculateAccountEstimate 的
//   Promise.all(positions.map(calculateFundEstimate))
//     → Promise.all(holdings.map(quoteFor))
//       → fetchStockQuote / fetchHistoricalChange
//         → fetch()
// 在冷缓存时制造数百~上千并发出站请求（B 刷新并发无限制 + F Promise.all 瞬时峰值），
// 进而使 fetchText 的 response.body 同时驻留内存造成 RSS 暴涨（G response 缓冲未释放）。
//
// 复用 navCacheService 的 externalQueue / 信号量思想：固定并发 + FIFO 队列，
// 队列本身不限制入队数量（由上游调用决定），但"同时驻留的 Promise / response buffer"
// 数量被钳制在 MAX_EXTERNAL_CONCURRENCY，从根本上消除瞬时内存尖峰。
//
// 与 navCacheService 的区别：这里是全局唯一的出站闸门，所有 provider（股票行情、
// 历史 K 线、基金估值、指数、Yahoo）共享同一把锁，避免多个独立队列叠加放大并发。

const MAX_EXTERNAL_CONCURRENCY = Math.max(
  1,
  Number(process.env.ESTIMATE_EXTERNAL_CONCURRENCY || 6)
);

const queue = [];
let active = 0;
// 当前调用链已持有的闸门名额数：用于识别「嵌套 withLimit」。
// 根因修复（2026-08-25）：estimateEngine.quoteFor 用 withLimit 包裹 fetchStockQuote，
// 而 fetchStockQuote → fetchText 内部又调用 withLimit —— 外层 6 个名额被占满后，
// 内层请求永远排不到队首 → 死锁（ext active=6、queued 只增不减），
// 导致 /estimate、第三方同步导入全部排队饿死（用户看到的「同步没反应」）。
// 修复：调用链已持有名额时，内层调用直接执行（不再入队），
// 并发上限仍由外层名额控制，内存/出站并发保护不变。
let heldSlots = 0;

function pump() {
  if (active >= MAX_EXTERNAL_CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  active += 1;
  heldSlots += 1;
  Promise.resolve()
    .then(next.task)
    .then(next.resolve, next.reject)
    .finally(() => {
      active -= 1;
      heldSlots -= 1;
      pump();
    });
}

/**
 * 限制 task 的并发执行数量，返回 task 的结果。
 * task 内部可安全地进行顺序的、非嵌套持有的 fetch（不会死锁）。
 * @param {Function<Promise<any>>} task
 * @returns {Promise<any>}
 */
function withLimit(task) {
  // 嵌套调用：当前调用链已持有名额，直接执行，避免自死锁（见文件头注释）
  if (heldSlots > 0) {
    return Promise.resolve().then(task);
  }
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function externalConcurrencyStats() {
  return {
    active,
    queued: queue.length,
    max: MAX_EXTERNAL_CONCURRENCY
  };
}

module.exports = {
  withLimit,
  externalConcurrencyStats,
  MAX_EXTERNAL_CONCURRENCY
};
