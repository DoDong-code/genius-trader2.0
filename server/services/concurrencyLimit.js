// 全局出站请求并发闸门（重写于 2026-08-26，修复 heldSlots 跨请求串号根因）。
//
// 设计目标：
//  1. 真正的全局最大并发限制：active 永远 <= MAX_EXTERNAL_CONCURRENCY。
//  2. 调用链隔离：每个异步调用链（AsyncLocalStorage）独立记录自己“持有”的 slot 层数，
//     嵌套 withLimit 直接复用当前链已持有的 slot，绝不跨请求复用别人的 slot。
//  3. 等待队列硬上限：queue 长度 >= QUEUE_MAX 时立即 reject，禁止无限 enqueue。
//  4. 零 slot 泄漏：无论 success / timeout / Abort / exception，slot 都在 finally 释放。
//
// 与原实现的关键差异：
//  原 heldSlots 是进程级全局可变计数器，不同用户/不同请求链会错误地共享同一个计数，
//  导致一个请求“持有”的 slot 会被另一个请求的嵌套调用误判为已持有 → 绕过全局限制
//  （或死锁）。新实现用 AsyncLocalStorage 把“持有层数”绑定到当前异步调用链，
//  全局 active 才是唯一的真实并发计数。

const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_EXTERNAL_CONCURRENCY = Math.max(
  1,
  Number(process.env.ESTIMATE_EXTERNAL_CONCURRENCY || 6)
);

// 等待队列硬上限：超过即立即失败，防止无限内存增长与无限 enqueue。
const QUEUE_MAX = Math.max(
  8,
  Number(process.env.ESTIMATE_EXTERNAL_QUEUE_MAX || 200)
);

// 当前真实进行中的出站任务数（唯一的全局并发计数）。
let active = 0;

// FIFO 等待队列：仅保存尚未拿到 slot 的任务。
const queue = [];

// 每个异步调用链通过 AsyncLocalStorage 记录自己持有的 slot 层数。
const slotStore = new AsyncLocalStorage();

function pump() {
  // 只要还有空余全局名额且队列非空，就尽可能多地放行。
  while (active < MAX_EXTERNAL_CONCURRENCY && queue.length > 0) {
    const next = queue.shift();
    active += 1;
    // 在本调用链上下文里运行：该链现在“持有”1 个 slot（depth=1）。
    // 内层嵌套 withLimit 会检测到这个 store 而直接执行，不再二次入队。
    slotStore.run({ depth: 1 }, () => {
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          pump(); // 释放后立即尝试放行下一个等待任务
        });
    });
  }
}

/**
 * 限制 task 的并发执行数量。
 *
 * - 若当前异步调用链已经持有 slot（嵌套调用），直接执行，复用当前链已持有的名额，
 *   既不死锁也不会再占用一个全局名额。
 * - 否则入队等待；若队列已满立即 reject（硬背压，禁止无限 enqueue）。
 *
 * @param {Function<Promise<any>>} task
 * @returns {Promise<any>}
 */
function withLimit(task) {
  const store = slotStore.getStore();
  if (store) {
    // 嵌套调用：本链已持有 slot，直接执行，不占用新的全局名额。
    return Promise.resolve().then(() => {
      store.depth += 1;
      try {
        return task();
      } finally {
        store.depth -= 1;
      }
    });
  }

  return new Promise((resolve, reject) => {
    if (queue.length >= QUEUE_MAX) {
      // 队列已满：立即失败，不让调用方无限 pending。
      const err = new Error(
        `[concurrencyLimit] 等待队列已满，拒绝入队 (queue=${queue.length}, QUEUE_MAX=${QUEUE_MAX})`
      );
      err.code = 'QUEUE_OVERFLOW';
      err.statusCode = 503;
      reject(err);
      return;
    }
    queue.push({ task, resolve, reject });
    pump();
  });
}

function externalConcurrencyStats() {
  return {
    active,
    queued: queue.length,
    max: MAX_EXTERNAL_CONCURRENCY,
    queueMax: QUEUE_MAX
  };
}

/** 仅用于测试：重置全局状态（不重置已运行中的任务）。 */
function __resetForTest() {
  active = 0;
  queue.length = 0;
}

module.exports = {
  withLimit,
  externalConcurrencyStats,
  MAX_EXTERNAL_CONCURRENCY,
  QUEUE_MAX,
  __resetForTest
};
