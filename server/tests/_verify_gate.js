// Phase 3.3-H 验证 harness（非破坏性，无真实请求）。
// 目标：证明新增的全局出站并发闸门 concurrencyLimit.withLimit 能钳制并发，
// 并复现 P3.3-G 探针中"100 funds × 10 holdings"路径在新闸门下的峰值。
'use strict';
const { withLimit, externalConcurrencyStats, MAX_EXTERNAL_CONCURRENCY } = require('../services/concurrencyLimit');

let active = 0;
let peak = 0;
function track(fn) {
  return async () => {
    active += 1;
    if (active > peak) peak = active;
    try { return await fn(); } finally { active -= 1; }
  };
}

async function main() {
  // 1) 纯闸门机制验证：200 个并发任务，每个 sleep 3ms
  const tasks = [];
  for (let i = 0; i < 200; i += 1) {
    tasks.push(withLimit(track(async () => { await new Promise(r => setTimeout(r, 3)); })));
  }
  await Promise.all(tasks);
  console.log('[GATE] 200 tasks, MAX=' + MAX_EXTERNAL_CONCURRENCY);
  console.log('[GATE] measured peak concurrency =', peak);
  console.log('[GATE] final stats =', JSON.stringify(externalConcurrencyStats()));
  if (peak > MAX_EXTERNAL_CONCURRENCY) {
    console.error('[GATE][FAIL] peak exceeded MAX');
    process.exit(1);
  }
  console.log('[GATE][PASS] concurrency bounded to <= ' + MAX_EXTERNAL_CONCURRENCY);

  // 2) 复现 P3.3-G 路径：100 funds × 10 holdings 经 withLimit（模拟 quoteFor 经闸门）
  peak = 0; active = 0;
  const fundTasks = [];
  for (let f = 0; f < 100; f += 1) {
    for (let h = 0; h < 10; h += 1) {
      fundTasks.push(withLimit(track(async () => {
        // 模拟一次股票行情 fetch：fetchText 现在经同一闸门
        await new Promise(r => setTimeout(r, 2));
      })));
    }
  }
  await Promise.all(fundTasks);
  console.log('[PATH] 100 funds x 10 holdings =', fundTasks.length, 'leaf calls via gate');
  console.log('[PATH] measured peak concurrency =', peak, '(P3.3-G 实测为', fundTasks.length, ', 现应 <=', MAX_EXTERNAL_CONCURRENCY, ')');
  if (peak > MAX_EXTERNAL_CONCURRENCY) {
    console.error('[PATH][FAIL] peak exceeded MAX');
    process.exit(1);
  }
  console.log('[PATH][PASS] leaf concurrency bounded to <= ' + MAX_EXTERNAL_CONCURRENCY);

  // 3) require smoke：确认 estimateEngine / marketService 可正常加载（无 require 期错误）
  require('../services/marketService');
  require('../services/estimateEngine');
  require('../services/providerEstimate');
  require('../services/navCacheService');
  console.log('[SMOKE][PASS] estimateEngine / marketService / providerEstimate / navCacheService load OK');
  console.log('[VERIFY][DONE] all checks passed');
}

main().catch(err => { console.error('[VERIFY][ERROR]', err); process.exit(1); });
