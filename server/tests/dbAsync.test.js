/**
 * P1-8 回归测试：PostgreSQL 连接池 / 超时 / 释放 / 监控 / 事务看门狗
 *
 * 不依赖真实 DATABASE_URL（强制云端分支），通过向 require 缓存注入 fake `pg` 模块，
 * 验证生产行为：
 *  1) 池满（connect 延迟超过 acquire timeout）时 acquireClient 在 ACQUIRE_TIMEOUT_MS 内快速失败（503，不无限排队）
 *  2) 超时被放弃后，迟到连接自动 release（无连接泄漏）
 *  3) query 异常路径：client 在 finally 中 release
 *  4) 每条语句带 statement_timeout（通过 options 注入）
 *  5) transaction：work 抛错 → ROLLBACK + release；正常 → COMMIT + release
 *  6) transaction 卡死：watchdog 真实触发 → TRANSACTION_TIMEOUT + ROLLBACK + release（绝不永久占用 client）
 *  7) 连续 timeout 不造成 pool waiting 无限增长
 *  8) poolStats 返回预期形状
 *
 * 铁律：模拟用定时器严禁 unref —— 必须保证“无其他事件时定时器仍真实触发”，与生产一致。
 */
const test = require('node:test');
const assert = require('node:assert');

// —— 注入 fake pg ——
function makeFakePg() {
  class FakeClient {
    constructor() {
      this.queries = [];
      this.released = false;
      this._failQuery = false;
    }
    async query(sql) {
      if (this._failQuery) {
        const e = new Error('forced query error');
        e.code = 'XX000';
        throw e;
      }
      this.queries.push(sql);
      return { rows: [], rowCount: 0 };
    }
    release() {
      this.released = true;
    }
  }
  class FakePool {
    constructor(cfg) {
      this.cfg = cfg || {};
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      // 读取共享默认值（测试在构造前设置），避免“先构造后配置”的竞态
      this.connectDelayMs = FakePool.defaults.connectDelayMs;
      this.failConnect = FakePool.defaults.failConnect;
      this.failAllQueries = FakePool.defaults.failAllQueries;
      this.lastClient = null;
      FakePool._last = this;
    }
    connect() {
      this.waitingCount++;
      return new Promise((resolve, reject) => {
        const finish = () => {
          this.waitingCount = Math.max(0, this.waitingCount - 1);
          if (this.failConnect) {
            reject(new Error('ECONNREFUSED'));
            return;
          }
          const c = new FakeClient();
          c._failQuery = this.failAllQueries;
          this.totalCount++;
          this.idleCount++;
          this.lastClient = c;
          resolve(c);
        };
        // 模拟池满：connect 在 ACQUIRE_TIMEOUT 之后才返回，触发“池满快速失败”路径。
        // 严禁 unref —— 保证定时器在无其他事件时仍真实触发，与生产完全一致。
        if (this.connectDelayMs > 0) setTimeout(finish, this.connectDelayMs);
        else finish();
      });
    }
    // 与真实 pg.Pool 对齐：on('error', ...) 为 no-op，避免 getPool 注册监听时报错
    on() {
      return this;
    }
  }
  FakePool._last = null;
  FakePool.defaults = {
    connectDelayMs: 0,
    failConnect: false,
    failAllQueries: false
  };
  return { Pool: FakePool };
}

const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: makeFakePg()
};

// 强制云端模式（确保走 pg 分支而非 SQLite）
process.env.DATABASE_URL = 'postgres://fake/fake';
// acquire timeout 用较短值（模块级 const，仅能在 require 前设置一次）
process.env.PG_ACQUIRE_TIMEOUT_MS = '300';
process.env.PG_STATEMENT_TIMEOUT_MS = '15000';

const dbAsync = require('../database/dbAsync');
const FakePool = require('pg').Pool;

function setDefaults(d) {
  Object.assign(FakePool.defaults, d);
}

test('池满时 acquireClient 快速失败（不无限排队）', async () => {
  // connectDelayMs(600) > ACQUIRE_TIMEOUT(300) → 触发“池满快速失败”
  setDefaults({ connectDelayMs: 600, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const p = dbAsync.all('SELECT 1');
  const fake = FakePool._last; // 同步构造池已在 all() 内部完成
  const start = Date.now();
  await assert.rejects(
    p,
    (err) => err.code === 'POOL_ACQUIRE_TIMEOUT' && err.statusCode === 503
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `应在 ACQUIRE_TIMEOUT 内失败，实际耗时 ${elapsed}ms`);
  // 等待迟到连接到达并被自动 release（无泄漏、无悬挂）
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(fake.lastClient.released, true, '迟到连接应被自动 release（无泄漏）');
});

test('超时被放弃后迟到连接自动 release（无连接泄漏）', async () => {
  setDefaults({ connectDelayMs: 600, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const p = dbAsync.all('SELECT 1').catch(() => {});
  const fake = FakePool._last;
  await new Promise((r) => setTimeout(r, 700)); // 连接应已在 600ms 到达并自动 release
  assert.strictEqual(fake.lastClient.released, true, '超时放弃后迟到连接必须被 release');
  await p;
});

test('query 异常路径：client 在 finally 释放', async () => {
  setDefaults({ connectDelayMs: 0, failConnect: false, failAllQueries: true });
  dbAsync.__resetForTest();
  const p = dbAsync.run('INSERT INTO user_data VALUES (?, ?)', [1, '{}']);
  const fake = FakePool._last; // 同步构造池已在 run() 内部完成
  await assert.rejects(p);
  assert.strictEqual(fake.lastClient.released, true, '异常后 client 必须 release');
});

test('statement_timeout 通过 options 注入到建连', async () => {
  setDefaults({ connectDelayMs: 0, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const p = dbAsync.all('SELECT 1');
  const fake = FakePool._last;
  await p;
  assert.ok(
    /statement_timeout=15000/.test(fake.cfg.options || ''),
    `建连 options 应包含 statement_timeout=15000，实际: ${fake.cfg.options}`
  );
  assert.strictEqual(fake.lastClient.released, true);
});

test('transaction：work 抛错 → ROLLBACK + release', async () => {
  setDefaults({ connectDelayMs: 0, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const p = dbAsync.transaction(async () => {
    throw new Error('boom');
  });
  const fake = FakePool._last;
  await assert.rejects(p);
  const queries = fake.lastClient.queries.map(String);
  assert.ok(queries.some((q) => /ROLLBACK/i.test(q)), '应发出 ROLLBACK');
  assert.strictEqual(fake.lastClient.released, true, '事务结束后 client 必须 release');
});

test('transaction：成功 → COMMIT + release', async () => {
  setDefaults({ connectDelayMs: 0, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const p = dbAsync.transaction(async (db) => {
    await db.run('UPDATE user_data SET data = ? WHERE user_id = ?', ['{}', 1]);
    return 'ok';
  });
  const fake = FakePool._last;
  const result = await p;
  assert.strictEqual(result, 'ok');
  const queries = fake.lastClient.queries.map(String);
  assert.ok(queries.some((q) => /COMMIT/i.test(q)), '应发出 COMMIT');
  assert.strictEqual(fake.lastClient.released, true);
});

test('transaction 卡死：watchdog 真实触发 → TRANSACTION_TIMEOUT + ROLLBACK + release', async () => {
  setDefaults({ connectDelayMs: 0, failConnect: false, failAllQueries: false });
  process.env.PG_TRANSACTION_TIMEOUT_MS = '120'; // 看门狗极短，便于测试
  dbAsync.__resetForTest();
  const p = dbAsync.transaction(async () => {
    await new Promise(() => {}); // 永久挂起，模拟卡死的事务（无任何定时器，仅 pending promise）
  });
  const fake = FakePool._last;
  const start = Date.now();
  await assert.rejects(
    p,
    (err) => err.code === 'TRANSACTION_TIMEOUT' && err.statusCode === 504
  );
  assert.ok(Date.now() - start < 1000, 'watchdog 应在预算内触发，而非永久挂起');
  const queries = fake.lastClient.queries.map(String);
  assert.ok(queries.some((q) => /ROLLBACK/i.test(q)), '卡死后应发出 ROLLBACK');
  assert.strictEqual(fake.lastClient.released, true, '卡死后 client 必须 release（不永久占用）');
  delete process.env.PG_TRANSACTION_TIMEOUT_MS;
});

test('连续 acquire timeout 不造成 pool waiting 无限增长', async () => {
  setDefaults({ connectDelayMs: 600, failConnect: false, failAllQueries: false });
  dbAsync.__resetForTest();
  const fake = FakePool._last;
  for (let i = 0; i < 10; i++) {
    await assert.rejects(
      () => dbAsync.all('SELECT 1'),
      (err) => err.code === 'POOL_ACQUIRE_TIMEOUT'
    );
  }
  // 等待所有迟到连接 settle 并 release
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(fake.waitingCount, 0, '连续超时后 waitingCount 应回落到 0（无无限增长 / 无泄漏）');
});

test('poolStats 返回预期形状', () => {
  const stats = dbAsync.poolStats();
  assert.ok('total' in stats && 'idle' in stats && 'waiting' in stats && 'active' in stats);
  assert.strictEqual(typeof stats.total, 'number');
  assert.strictEqual(typeof stats.active, 'number');
});
