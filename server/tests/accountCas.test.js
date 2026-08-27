// P0-5 回归测试：账户状态 CAS（revision 冲突拒绝）
// 验证：同 user 顺序写入 revision 递增；传入过期 revision 的写入被拒绝（409）；
// 旧客户端（不传 rev）仍被接受；userId 隔离。
const test = require('node:test');
const assert = require('node:assert');

// 内存替身（在 require 业务模块前注入，使其捕获到的 get/run/transaction 为替身）。
const dbAsync = require('../database/dbAsync');
const store = { user_data: new Map(), user_data_rev: new Map() };

dbAsync.get = async (sql, params) => {
  if (sql.includes('user_data_rev')) {
    const rev = store.user_data_rev.get(params[0]);
    return rev !== undefined ? { revision: rev } : null;
  }
  if (sql.includes('user_data')) {
    const data = store.user_data.get(params[0]);
    return data !== undefined ? { data } : null;
  }
  return null;
};
dbAsync.run = async (sql, params) => {
  // 模拟真实 pg 的 CAS 语义（原子条件更新 / 自增），否则 revision 会被 params[1] 覆盖为 undefined。
  // INSERT ... VALUES (?, X) ON CONFLICT DO NOTHING：行不存在才写入
  if (/INSERT INTO user_data_rev/.test(sql) && /DO NOTHING/.test(sql)) {
    const uid = params[0];
    const val = Number(params[1]);
    if (!store.user_data_rev.has(uid)) { store.user_data_rev.set(uid, val); return { changes: 1 }; }
    return { changes: 0 };
  }
  // UPDATE user_data_rev SET revision = revision + 1 WHERE user_id = ?：自增
  if (/UPDATE user_data_rev SET revision = revision \+ 1/.test(sql)) {
    const uid = params[0];
    store.user_data_rev.set(uid, (store.user_data_rev.get(uid) || 0) + 1);
    return { changes: 1 };
  }
  // UPDATE user_data_rev SET revision = ? WHERE user_id = ? AND revision = ?：原子条件更新
  if (/UPDATE user_data_rev SET revision = /.test(sql) && /AND revision = /.test(sql)) {
    const next = Number(params[0]);
    const uid = params[1];
    const expected = Number(params[2]);
    if (store.user_data_rev.get(uid) === expected) { store.user_data_rev.set(uid, next); return { changes: 1 }; }
    return { changes: 0 };
  }
  // INSERT ... ON CONFLICT DO UPDATE SET revision = revision + 1：upsert 自增
  if (/INSERT INTO user_data_rev/.test(sql) && /DO UPDATE SET revision = revision \+ 1/.test(sql)) {
    const uid = params[0];
    store.user_data_rev.set(uid, (store.user_data_rev.get(uid) || 0) + 1);
    return { changes: 1 };
  }
  // user_data 写入
  if (sql.includes('user_data')) {
    store.user_data.set(params[0], params[1]);
    return { changes: 1 };
  }
  return { changes: 1 };
};
dbAsync.transaction = async (work) => work({ get: dbAsync.get, run: dbAsync.run });

const { saveUserState, getUserState, getRevision } = require('../services/accountStateService');

const stateA = { accounts: { a: { name: 'a', funds: [{ code: '1', amount: 10 }] } }, active: 'a' };

test('first save stamps revision 1', async () => {
  store.user_data.clear(); store.user_data_rev.clear();
  const rev = await saveUserState(1, stateA);
  assert.strictEqual(rev, 1);
  assert.strictEqual(await getRevision(1), 1);
  assert.deepStrictEqual(await getUserState(1), stateA);
});

test('sequential save with correct rev bumps revision', async () => {
  const rev = await saveUserState(1, { ...stateA, active: 'a' }, { rev: 1 });
  assert.strictEqual(rev, 2);
  assert.strictEqual(await getRevision(1), 2);
});

test('stale write (expired rev) is rejected with 409', async () => {
  // 当前 rev=2，但旧请求仍带着 rev=1 → 冲突
  await assert.rejects(
    () => saveUserState(1, stateA, { rev: 1 }),
    (err) => err.code === 'REVISION_CONFLICT' && err.statusCode === 409
  );
  // 拒绝后 revision 不变，旧数据未被覆盖
  assert.strictEqual(await getRevision(1), 2);
  assert.deepStrictEqual(await getUserState(1), { ...stateA, active: 'a' });
});

test('old client without rev is still accepted (backward compat)', async () => {
  const rev = await saveUserState(1, { ...stateA, active: 'changed' });
  assert.strictEqual(rev, 3);
  assert.deepStrictEqual(await getUserState(1), { ...stateA, active: 'changed' });
});

test('userId isolation: conflict on user 1 does not affect user 2', async () => {
  store.user_data_rev.delete(2); store.user_data.delete(2);
  await saveUserState(2, stateA); // user2 rev 1
  assert.strictEqual(await getRevision(2), 1);
  // user1 仍是 rev 3
  assert.strictEqual(await getRevision(1), 3);
});
