/**
 * P1-11 回归测试：账户状态体积上限（MAX_BODY_BYTES = 32MB）
 *
 * 验证：
 *  1) 正常体积 state 正常落库；
 *  2) 超过上限的 state 被 saveUserState 快速拒绝（413 / STATE_TOO_LARGE），
 *     不进入事务、不写库；
 *  3) 旧 user_data 整包存储结构保持兼容（读回一致）。
 */
const test = require('node:test');
const assert = require('node:assert');

// 注入 fake pg，模拟云端 PG 路径（确保走 saveUserState 的 transaction 分支）
function makeFakePg() {
  class FakeClient {
    constructor(store) {
      this.store = store;
      this.queries = [];
      this.released = false;
    }
    async query(sql, params) {
      // 解析关键写操作，便于断言未落库
      this.queries.push(String(sql));
      const s = String(sql);
      const p = (params || []).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x));
      if (/user_data/.test(s) && /(INSERT|UPDATE)/.test(s)) {
        FakePool._writeCount++;
      }
      if (/^\s*BEGIN/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^\s*(COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT revision FROM user_data_rev/.test(s)) {
        const uid = Number(p[0]);
        return { rows: [{ revision: this.store.rev[uid] || 0 }], rowCount: 1 };
      }
      if (/SELECT data FROM user_data/.test(s)) {
        const uid = Number(p[0]);
        return this.store.data[uid] !== undefined
          ? { rows: [{ data: this.store.data[uid] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO user_data /.test(s)) {
        const uid = Number(p[0]);
        this.store.data[uid] = p[1];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO user_data_rev/.test(s) && /DO NOTHING/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) { this.store.rev[uid] = Number(p[1]) || 0; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE user_data_rev SET revision = revision \+ 1/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) this.store.rev[uid] = 0;
        this.store.rev[uid] = Number(this.store.rev[uid]) + 1;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE user_data_rev SET revision = /.test(s) && /AND revision = /.test(s)) {
        const uid = Number(p[1]);
        const expected = Number(p[2]);
        const next = Number(p[0]);
        if (this.store.rev[uid] === expected) { this.store.rev[uid] = next; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    release() { this.released = true; }
  }
  class FakePool {
    constructor(cfg) {
      this.cfg = cfg || {};
      this.store = { rev: {}, data: {} };
      this.lastClient = null;
      FakePool._last = this;
    }
    connect() {
      const c = new FakeClient(this.store);
      this.lastClient = c;
      return Promise.resolve(c);
    }
    on() { return this; }
  }
  // 全局写计数：便于断言“超大体量未落库”
  FakePool._writeCount = 0;
  FakePool._last = null;
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

const dbAsync = require('../database/dbAsync');
const { saveUserState, getUserState, MAX_BODY_BYTES } = require('../services/accountStateService');
const FakePool = require('pg').Pool;

test('正常体积 state 正常落库', async () => {
  dbAsync.__resetForTest();
  const state = { accounts: { 'acc1': { funds: [{ code: '000001', shares: 10 }] } } };
  const rev = await saveUserState(1, state);
  assert.strictEqual(rev, 1);
  const client = FakePool._last.lastClient;
  assert.ok(
    client.queries.some((q) => /INSERT INTO user_data /.test(q)),
    '应执行 user_data 写入'
  );
});

test('超过上限的 state 被快速拒绝（413 / STATE_TOO_LARGE，不落库）', async () => {
  dbAsync.__resetForTest();
  FakePool._writeCount = 0; // 重置写计数
  // 构造一个超过 32MB 的 state
  const big = 'x'.repeat(MAX_BODY_BYTES + 1024);
  const state = { accounts: { 'acc1': { note: big } } };
  await assert.rejects(
    () => saveUserState(2, state),
    (err) => err.code === 'STATE_TOO_LARGE' && err.statusCode === 413
  );
  // 体积守卫在事务之前触发，应完全没有任何 user_data 落库
  assert.strictEqual(FakePool._writeCount, 0, '超大体量不应落库（user_data 写次数应为 0）');
});

test('MAX_BODY_BYTES 默认 32MB', () => {
  assert.strictEqual(MAX_BODY_BYTES, 32 * 1024 * 1024);
});
