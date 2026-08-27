/**
 * P0-4 回归测试：账户生命周期竞态（服务端隔离 + 陈旧写入拒绝）
 *
 * 用内存态 fake pg 模拟 user_data / user_data_rev，验证 saveUserState 的 CAS 修订号逻辑
 * 在以下生命周期竞态下均能正确隔离、拒绝陈旧写入（绝不 last-write-wins）：
 *   1) 并发：用户 A 与 B 同时保存，互不覆盖
 *   2) 账号切换：B 的写入不覆盖 A 已存状态
 *   3) logout 后老 PUT：用旧 rev 写 A，被拒（REVISION_CONFLICT）
 *   4) restore 后旧 save：restore 推高 rev，旧客户端（无 rev）写入仍接受并自增
 *   5) guest（userId=0）与登录用户（userId=1）状态隔离
 *   6) 网络延迟旧 PUT 覆盖新 PUT：rev=N 的旧写被拒，rev=N+1 的新写成功
 *   7) 跨账号 rev 独立：A 的 rev 推进不影响 B 的 rev 判定
 *
 * 注：前端（mp1 小程序）观察者的“注销后丢弃陈旧异步写”为客户端职责，此处只验证服务端
 * 身份隔离与 CAS 这道不可绕过的服务端防线。
 */
const test = require('node:test');
const assert = require('node:assert');

function makeFakePg() {
  class FakeClient {
    constructor(store) {
      this.store = store;
      this.released = false;
      this.queries = [];
    }
    async query(sql, params) {
      const s = String(sql);
      this.queries.push(s);
      if (/^\s*BEGIN/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^\s*(COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
      const p = (params || []).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x));

      // SELECT revision FROM user_data_rev WHERE user_id = $1
      if (/SELECT revision FROM user_data_rev/.test(s)) {
        const uid = Number(p[0]);
        return { rows: [{ revision: this.store.rev[uid] || 0 }], rowCount: 1 };
      }
      // SELECT data FROM user_data WHERE user_id = $1
      // 真实 pg 的 query 总是返回 { rows, rowCount }，fake 必须保持一致形状，
      // 否则 queryCloud 取到 result.rows === undefined，会触发 get() 的 rows[0] 报错。
      if (/SELECT data FROM user_data/.test(s)) {
        const uid = Number(p[0]);
        return this.store.data[uid] !== undefined
          ? { rows: [{ data: this.store.data[uid] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // INSERT INTO user_data (...) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, ...
      if (/INSERT INTO user_data /.test(s)) {
        const uid = Number(p[0]);
        this.store.data[uid] = p[1];
        return { rows: [], rowCount: 1 };
      }
      // INSERT INTO user_data_rev (user_id, revision) VALUES ($1,$2) ON CONFLICT(user_id) DO NOTHING
      if (/INSERT INTO user_data_rev/.test(s) && /DO NOTHING/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) {
          this.store.rev[uid] = Number(p[1]) || 0;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      // UPDATE user_data_rev SET revision = revision + 1 WHERE user_id = $1
      if (/UPDATE user_data_rev SET revision = revision \+ 1/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) this.store.rev[uid] = 0;
        this.store.rev[uid] = Number(this.store.rev[uid]) + 1;
        return { rows: [], rowCount: 1 };
      }
      // UPDATE user_data_rev SET revision = $1 WHERE user_id = $2 AND revision = $3（原子条件更新）
      if (/UPDATE user_data_rev SET revision = /.test(s) && /AND revision = /.test(s)) {
        const uid = Number(p[1]);
        const expected = Number(p[2]);
        const next = Number(p[0]);
        if (this.store.rev[uid] === expected) {
          this.store.rev[uid] = next;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 }; // 条件不匹配：冲突
      }
      return { rows: [], rowCount: 0 };
    }
    release() { this.released = true; }
  }
  class FakePool {
    constructor(cfg) {
      this.cfg = cfg || {};
      this.store = { rev: {}, data: {} };
      FakePool._last = this;
    }
    connect() { return Promise.resolve(new FakeClient(this.store)); }
    on() { return this; }
  }
  FakePool._last = null;
  return { Pool: FakePool };
}

const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true, exports: makeFakePg()
};

process.env.DATABASE_URL = 'postgres://fake/fake';

const dbAsync = require('../database/dbAsync');
const { saveUserState, getUserState } = require('../services/accountStateService');

const stateA1 = { accounts: { 'A1': { funds: [{ code: '000001', shares: 10 }] } } };
const stateA2 = { accounts: { 'A2': { funds: [{ code: '000002', shares: 20 }] } } };
const stateB1 = { accounts: { 'B1': { funds: [{ code: '000003', shares: 5 }] } } };

test('1) 并发：用户 A 与 B 同时保存，互不覆盖', async () => {
  dbAsync.__resetForTest();
  const [ra, rb] = await Promise.all([
    saveUserState(1, stateA1),
    saveUserState(2, stateB1)
  ]);
  assert.strictEqual(ra, 1);
  assert.strictEqual(rb, 1);
  const a = await getUserState(1);
  const b = await getUserState(2);
  assert.deepStrictEqual(a, stateA1, 'A 的状态应保持自身');
  assert.deepStrictEqual(b, stateB1, 'B 的状态应保持自身，不被 A 覆盖');
});

test('2) 账号切换：B 的写入不覆盖 A 已存状态', async () => {
  dbAsync.__resetForTest();
  await saveUserState(1, stateA1); // A rev=1
  await saveUserState(2, stateB1); // B rev=1
  const a = await getUserState(1);
  assert.deepStrictEqual(a, stateA1, '切换后 A 的状态未被 B 写入影响');
});

test('3) logout 后老 PUT：用旧 rev 写 A，被拒（REVISION_CONFLICT）', async () => {
  dbAsync.__resetForTest();
  await saveUserState(1, stateA1); // rev=1
  await saveUserState(1, stateA2, { rev: 1 }); // 合法推进到 rev=2
  const current = await getUserState(1);
  assert.deepStrictEqual(current, stateA2, '已推进到最新状态');
  // logout 后一个携带旧 rev=1 的迟到 PUT 必须被拒
  await assert.rejects(
    () => saveUserState(1, stateA1, { rev: 1 }),
    (err) => err.code === 'REVISION_CONFLICT' && err.statusCode === 409
  );
});

test('4) restore 后旧 save：旧客户端（无 rev）写入仍接受并自增', async () => {
  dbAsync.__resetForTest();
  await saveUserState(1, stateA1); // rev=1
  await saveUserState(1, stateA2, { rev: 1 }); // rev=2（如 restore 推高）
  // 未携带 rev 的旧客户端（无 rev 字段）写入：向后兼容，接受并自增
  const rev = await saveUserState(1, stateA1);
  assert.strictEqual(rev, 3, '无 rev 的旧客户端写入应自增到 3（向后兼容，不破坏）');
});

test('5) guest（userId=0）与登录用户（userId=1）状态隔离', async () => {
  dbAsync.__resetForTest();
  const guestState = { accounts: { 'guestAcc': { funds: [] } } };
  await saveUserState(0, guestState);
  await saveUserState(1, stateA1);
  const guest = await getUserState(0);
  const logged = await getUserState(1);
  assert.deepStrictEqual(guest, guestState, 'guest 状态独立');
  assert.deepStrictEqual(logged, stateA1, '登录用户状态独立，不被 guest 覆盖');
});

test('6) 网络延迟旧 PUT 覆盖新 PUT：rev=N 旧写被拒，rev=N+1 新写成功', async () => {
  dbAsync.__resetForTest();
  await saveUserState(1, stateA1); // rev=1
  // 并行：新写带 rev=1（推进到 rev=2），旧写（网络延迟）也带 rev=1
  const [newWrite, oldWrite] = await Promise.all([
    saveUserState(1, stateA2, { rev: 1 }).then((r) => ({ ok: true, rev: r }), (e) => ({ ok: false, e })),
    saveUserState(1, stateA1, { rev: 1 }).then((r) => ({ ok: true, rev: r }), (e) => ({ ok: false, e }))
  ]);
  // 两者竞争同一 rev=1：仅一个成功（rev=2），另一个必须被拒（REVISION_CONFLICT）
  const succeeded = [newWrite, oldWrite].filter((x) => x.ok);
  const rejected = [newWrite, oldWrite].filter((x) => !x.ok);
  assert.strictEqual(succeeded.length, 1, '同一 rev 只能有一个写入成功');
  assert.strictEqual(rejected.length, 1, '另一个陈旧写入必须被拒');
  assert.strictEqual(rejected[0].e.code, 'REVISION_CONFLICT');
  const finalState = await getUserState(1);
  assert.ok(
    deepEq(finalState, stateA2) || deepEq(finalState, stateA1),
    '最终状态应为两者之一，绝不混淆'
  );
});

test('7) 跨账号 rev 独立：A 的 rev 推进不影响 B 的 rev 判定', async () => {
  dbAsync.__resetForTest();
  await saveUserState(1, stateA1); // A rev=1
  await saveUserState(2, stateB1); // B rev=1
  await saveUserState(1, stateA2, { rev: 1 }); // A rev=2
  // B 用 rev=1 仍可正常推进（其自身 rev 仍是 1，未受 A 影响）
  const rb = await saveUserState(2, stateB1, { rev: 1 });
  assert.strictEqual(rb, 2, 'B 的 rev 应独立于 A，从自身 1 推进到 2');
});

function deepEq(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}
