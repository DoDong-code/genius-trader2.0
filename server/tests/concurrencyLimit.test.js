// P0-1 回归测试：并发闸门
// 验证：active <= MAX、嵌套调用不死锁/不越界、队列满立即失败、slot 无泄漏。
const test = require('node:test');
const assert = require('node:assert');

const Con = require('../services/concurrencyLimit');

test('active never exceeds MAX_EXTERNAL_CONCURRENCY', async () => {
  const max = Con.MAX_EXTERNAL_CONCURRENCY;
  const started = [];
  const N = max * 5;
  let peak = 0;
  const tasks = [];
  for (let i = 0; i < N; i += 1) {
    tasks.push(Con.withLimit(async () => {
      started.push(1);
      const cur = Con.externalConcurrencyStats().active;
      peak = Math.max(peak, cur);
      await new Promise(r => setTimeout(r, 5));
      return i;
    }));
  }
  await Promise.all(tasks);
  assert.ok(peak <= max, `peak active ${peak} 超过上限 ${max}`);
  const stats = Con.externalConcurrencyStats();
  assert.strictEqual(stats.active, 0, '结束后仍有活动 slot（泄漏）');
  assert.strictEqual(stats.queued, 0, '结束后队列非空（泄漏）');
});

test('nested withLimit does not deadlock and stays bounded', async () => {
  const max = Con.MAX_EXTERNAL_CONCURRENCY;
  let peak = 0;
  // 外层一次性发起 max 个任务，每个任务内部再嵌套 5 个 withLimit。
  const outer = [];
  for (let i = 0; i < max; i += 1) {
    outer.push(Con.withLimit(async () => {
      const inner = [];
      for (let j = 0; j < 5; j += 1) {
        inner.push(Con.withLimit(async () => {
          peak = Math.max(peak, Con.externalConcurrencyStats().active);
          await new Promise(r => setTimeout(r, 3));
          return j;
        }));
      }
      return Promise.all(inner);
    }));
  }
  const results = await Promise.all(outer);
  assert.strictEqual(results.length, max);
  assert.ok(peak <= max, `嵌套后峰值 ${peak} 超过上限 ${max}`);
  assert.strictEqual(Con.externalConcurrencyStats().active, 0);
});

test('rejects immediately when queue is full (no infinite enqueue)', async () => {
  // 把 max 个名额占满，每个持有 60ms（受控释放，避免测试进程挂起）。
  const holders = [];
  for (let i = 0; i < Con.MAX_EXTERNAL_CONCURRENCY; i += 1) {
    holders.push(Con.withLimit(() => new Promise(r => setTimeout(r, 60))));
  }
  await new Promise(r => setTimeout(r, 20)); // 等待 pump 把名额全部占满

  // 入队超过 QUEUE_MAX 的任务，超出部分应当很快 reject（硬背压）。
  const pending = [];
  let rejected = 0;
  for (let i = 0; i < Con.QUEUE_MAX + 5; i += 1) {
    pending.push(
      Con.withLimit(async () => 1).catch(err => {
        if (err && err.code === 'QUEUE_OVERFLOW') rejected += 1;
        return null;
      })
    );
  }
  await Promise.all(pending);
  assert.ok(rejected > 0, '队列满时未触发 QUEUE_OVERFLOW');
  assert.ok(rejected >= 5, '应至少拒绝超出 QUEUE_MAX 的 5 个任务');

  // 让 holders 释放，确保测试文件能正常结束（不留悬挂 Promise）。
  await Promise.all(holders);
  assert.strictEqual(Con.externalConcurrencyStats().active, 0, '结束后 slot 未归零');
});

test('slot released on exception', async () => {
  await assert.rejects(
    () => Con.withLimit(async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.strictEqual(Con.externalConcurrencyStats().active, 0, '异常后 slot 未释放');
});

test('stats expose queueMax', () => {
  const s = Con.externalConcurrencyStats();
  assert.ok(s.queueMax >= 8, 'queueMax 未暴露或过小');
});
