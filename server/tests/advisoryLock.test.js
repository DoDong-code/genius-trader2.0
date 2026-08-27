/**
 * P1-9 回归测试：跨实例分布式锁（withAdvisoryLock）
 *
 * 不依赖真实 DATABASE_URL，向 require 缓存注入 fake `pg`，模拟 pg_try_advisory_xact_lock：
 *   - 两个并发调用同一锁名，只有一个能 acquired（另一个 reason='pg-held' 安全跳过）
 *   - 锁随 COMMIT/ROLLBACK 自动释放，释放后其他实例可重新获取
 *   - fn 抛错（即使崩溃语义）后锁仍释放，后续调用可获取
 *   - 进程内（非云端）降级为本地 Set 去重
 */
const test = require('node:test');
const assert = require('node:assert');

// 模拟 PG 建议锁的全局持有表（进程内，仅测试用）
const heldAdvisory = new Set();

function makeFakePg() {
  class FakeClient {
    constructor() {
      this.queries = [];
      this.released = false;
      this.heldAdvisory = null;
      this._failQuery = false;
    }
    async query(sql, params) {
      this.queries.push(String(sql));
      const s = String(sql);
      if (this._failQuery) {
        const e = new Error('forced query error');
        e.code = 'XX000';
        throw e;
      }
      if (/pg_try_advisory_xact_lock/.test(s)) {
        const key = `${params[0]}:${params[1]}`;
        if (heldAdvisory.has(key)) {
          return { rows: [{ ok: false }], rowCount: 1 };
        }
        heldAdvisory.add(key);
        this.heldAdvisory = key;
        return { rows: [{ ok: true }], rowCount: 1 };
      }
      if (/^\s*(COMMIT|ROLLBACK)/i.test(s)) {
        if (this.heldAdvisory) {
          heldAdvisory.delete(this.heldAdvisory);
          this.heldAdvisory = null;
        }
        return { rows: [], rowCount: 0 };
      }
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
      this.connectDelayMs = FakePool.defaults.connectDelayMs;
      this.failAllQueries = FakePool.defaults.failAllQueries;
      this.lastClient = null;
      FakePool._last = this;
    }
    connect() {
      this.waitingCount++;
      return new Promise((resolve) => {
        const finish = () => {
          this.waitingCount = Math.max(0, this.waitingCount - 1);
          const c = new FakeClient();
          c._failQuery = this.failAllQueries;
          this.totalCount++;
          this.idleCount++;
          this.lastClient = c;
          resolve(c);
        };
        if (this.connectDelayMs > 0) setTimeout(finish, this.connectDelayMs);
        else finish();
      });
    }
    on() {
      return this;
    }
  }
  FakePool._last = null;
  FakePool.defaults = { connectDelayMs: 0, failAllQueries: false };
  return { Pool: FakePool };
}

const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: makeFakePg()
};

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.PG_STATEMENT_TIMEOUT_MS = '15000';

const dbAsync = require('../database/dbAsync');
const { withAdvisoryLock } = require('../database/lock');
const FakePool = require('pg').Pool;

function setDefaults(d) {
  Object.assign(FakePool.defaults, d);
}

test('withAdvisoryLock：两个并发调用同一锁，仅一个 acquired', async () => {
  setDefaults({ connectDelayMs: 0, failAllQueries: false });
  dbAsync.__resetForTest();
  const [r1, r2] = await Promise.all([
    withAdvisoryLock('nav-sync:weekly', async () => 'A'),
    withAdvisoryLock('nav-sync:weekly', async () => 'B')
  ]);
  const acquired = [r1, r2].filter((r) => r.acquired);
  assert.strictEqual(acquired.length, 1, '只能有一个实例获得锁');
  const skipped = [r1, r2].find((r) => !r.acquired);
  assert.strictEqual(skipped.reason, 'pg-held', '未获得者原因为 pg-held');
});

test('withAdvisoryLock：释放后其他实例可重新获取', async () => {
  setDefaults({ connectDelayMs: 0, failAllQueries: false });
  dbAsync.__resetForTest();
  const r1 = await withAdvisoryLock('nav-sync:daily', async () => 'done1');
  assert.strictEqual(r1.acquired, true);
  const r2 = await withAdvisoryLock('nav-sync:daily', async () => 'done2');
  assert.strictEqual(r2.acquired, true, 'COMMIT 释放后其他实例应可重新获取');
});

test('withAdvisoryLock：fn 抛错后锁仍释放（崩溃语义）', async () => {
  setDefaults({ connectDelayMs: 0, failAllQueries: false });
  dbAsync.__resetForTest();
  await assert.rejects(
    () => withAdvisoryLock('nav-sync:quarterly', async () => { throw new Error('boom'); }),
    (err) => err.message === 'boom'
  );
  const r2 = await withAdvisoryLock('nav-sync:quarterly', async () => 'ok');
  assert.strictEqual(r2.acquired, true, 'fn 抛错后锁必须释放，后续可获取');
});

test('withAdvisoryLock：不同锁名互不干扰', async () => {
  setDefaults({ connectDelayMs: 0, failAllQueries: false });
  dbAsync.__resetForTest();
  const [r1, r2] = await Promise.all([
    withAdvisoryLock('nav-sync:weekly', async () => 'A'),
    withAdvisoryLock('nav-sync:quarterly', async () => 'B')
  ]);
  assert.strictEqual(r1.acquired, true);
  assert.strictEqual(r2.acquired, true, '不同锁名应各自独立获取');
});
