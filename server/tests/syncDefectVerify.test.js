/**
 * 数据同步缺陷验证（客户端闸门，加载真实 persistence.js）
 *
 * 目标：用最小 DOM shim 加载【真实】的 persistence.js，并以 mock auth.api
 * 模拟「登录后云端 restore 延迟 3~10 秒」的场景，验证 4 件事：
 *   #1  系统更新（system:true）即使已 ready 也不触发云端 PUT
 *   #3  恢复完成前（accountRestoreStatus==='restoring' / cloudSyncReady!==true）绝不 PUT；
 *       恢复成功后（ready + cloudSyncReady===true）才允许 PUT
 *   #4  切换/退出账号：clearLocalData 取消待发 PUT（防旧账号数据串写到云端）
 *
 * 服务端兜底（isEmptyStateOverwrite + CAS rev）由 accountStateGuard.test.js /
 * accountCas.test.js / accountLifecycleRace.test.js 覆盖，本文件只测客户端主闸门。
 */
const test = require('node:test');
const assert = require('node:assert');

// ---------- 最小浏览器 shim ----------
let fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  return { ok: true, status: 200, json: async () => ({}) };
};
function resetFetch() { fetchCalls = []; }

const ls = new Map();
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
};

global.document = {
  addEventListener: () => {},
  querySelector: () => null,
  visibilityState: 'visible'
};

// auth.api 可被测试手动 resolve，模拟 restore 延迟
let apiResolve;
const auth = {
  state: { token: 'test-token' },
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
  api: () => new Promise((res) => { apiResolve = res; })
};

global.window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  auth,
  fundStore: { get: () => ({}), set: () => {}, utils: {} },
  portfolioState: {
    accounts: { '主账户': { name: '主账户', funds: [] } },
    setActive: () => {},
    render: () => {},
    getActive: () => '主账户',
    persist: () => {},
    addAccount: () => {}
  }
};

// 加载真实客户端模块（IIFE 副作用：立即进入 restoring 并调用 auth.api）
require('../../persistence.js');

const W = global.window;
function putCount() {
  return fetchCalls.filter((c) => c.method === 'PUT' && c.url.includes('/api/account/state')).length;
}

test('#3 恢复期间（restoring）save 不触发任何 PUT', () => {
  assert.strictEqual(W.accountRestoreStatus, 'restoring', '加载即进入 restoring');
  assert.strictEqual(W.cloudSyncReady, false);
  resetFetch();
  W.savePortfolioState(); // 模拟恢复期间的用户编辑
  assert.strictEqual(putCount(), 0, 'restoring 期间不应有任何 PUT');
});

test('#3 恢复成功后（ready+cloudSyncReady）save 触发 PUT', async () => {
  // 用 cloud-empty 响应结束 restore（本地有 1 个账户 → 允许 save → PUT）
  apiResolve({ state: { accounts: {} } });
  await new Promise((r) => setTimeout(r, 600)); // 等防抖 400ms + 余量
  assert.strictEqual(W.accountRestoreStatus, 'ready');
  assert.strictEqual(W.cloudSyncReady, true);
  assert.ok(putCount() >= 1, '恢复完成后应有 PUT /api/account/state');
});

test('#1 系统更新（system:true）即使已 ready 也不触发 PUT', async () => {
  assert.strictEqual(W.accountRestoreStatus, 'ready');
  assert.strictEqual(W.cloudSyncReady, true);
  resetFetch();
  W.savePortfolioState({ system: true }); // 估值/水合刷新
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(putCount(), 0, 'system 更新不应 PUT 云端');
});

test('#4 切换/退出：clearLocalData 取消待发 PUT，旧账号数据不写云端', async () => {
  assert.strictEqual(W.cloudSyncReady, true);
  resetFetch();
  W.savePortfolioState(); // 排程一个 400ms 防抖 PUT
  W.clearLocalData();     // 模拟退出/切换：取消 timer + 作废代际 + 清 dirty
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(putCount(), 0, 'clearLocalData 后应取消待发 PUT，防账号串写');
  assert.ok(W.__syncGeneration >= 1, 'syncGeneration 应自增以作废旧请求');
});
