/**
 * 二轮审查（项1）：登录恢复时序 —— waitForAccountRestore 统一等待出口。
 * 加载真实 persistence.js（mock auth.api 模拟恢复延迟），验证：
 *   a. 恢复进行中 waitForAccountRestore 挂起，恢复完成后以终态 resolve；
 *   b. 恢复已完成时立即 resolve（不挂起）；
 *   c. 真实恢复挂死（auth.api 永不返回）时按 timeout resolve，不永久阻塞登录 UX；
 *   d. 恢复成功后 cloudSyncReady=true（闸门语义不变）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

// ---------- 最小浏览器 shim（对齐 syncDefectVerify.test.js，增加事件派发） ----------
let fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  return { ok: true, status: 200, json: async () => ({}) };
};
const ls = new Map();
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
};
global.document = { addEventListener: () => {}, querySelector: () => null, visibilityState: 'visible' };

const auth = {
  state: { token: 'test-token' },
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
  api: () => new Promise((res) => { apiResolve = res; })
};
let apiResolve;
const listeners = {};
global.window = {
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
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
function fireAuthChanged() { (listeners['auth-changed'] || []).forEach((fn) => fn()); }

require('../../persistence.js');
const W = global.window;

test('a. 恢复进行中挂起，恢复成功后以 ready + cloudSyncReady=true resolve', async () => {
  assert.strictEqual(W.accountRestoreStatus, 'restoring', '加载即进入 restoring');
  assert.strictEqual(typeof W.waitForAccountRestore, 'function', 'waitForAccountRestore 已暴露');
  const waited = W.waitForAccountRestore();
  let settled = false;
  waited.then(() => { settled = true; });
  await delay(100);
  assert.strictEqual(settled, false, '恢复未完成前不得 resolve');
  apiResolve({ state: { accounts: { 'A': { name: 'A', funds: [] } } } });
  const outcome = await waited;
  assert.strictEqual(outcome, 'ready');
  assert.strictEqual(W.accountRestoreStatus, 'ready');
  assert.strictEqual(W.cloudSyncReady, true, '恢复成功后云端闸门必须打开');
});

test('b. 恢复已完成时 waitForAccountRestore 立即 resolve', async () => {
  const t0 = Date.now();
  const outcome = await W.waitForAccountRestore();
  assert.strictEqual(outcome, 'ready');
  assert.ok(Date.now() - t0 < 100, 'ready 状态下必须立即返回');
});

test('c. 真实恢复挂死（api 永不返回）→ 按 timeout resolve，不永久阻塞登录 UX', async () => {
  // 等上一轮恢复的待发 PUT 冲刷完毕，避免计数干扰
  await delay(700);
  fetchCalls = [];
  // 模拟再次登录且云端恢复挂死：auth.api 返回永不 resolve 的 Promise
  auth.api = () => new Promise(() => {});
  fireAuthChanged(); // persistence 的 auth-changed 监听会以新 token 状态再次 restoreCloud
  await delay(50);
  assert.strictEqual(W.accountRestoreStatus, 'restoring', '新一轮恢复应处于 restoring');
  const t0 = Date.now();
  const outcome = await W.waitForAccountRestore(300);
  const elapsed = Date.now() - t0;
  assert.strictEqual(outcome, 'timeout', '挂死恢复必须按超时返回');
  assert.ok(elapsed >= 250 && elapsed < 2000, '应在 ~300ms 超时返回，实测 ' + elapsed + 'ms');
  assert.strictEqual(fetchCalls.filter((c) => c.method === 'PUT').length, 0, '挂死期间不得有任何云端写入');
  // 清理：恢复 Promise 仍挂起（真实挂死场景），手动复位状态供后续/退出
  W.accountRestoreStatus = 'ready';
  W.cloudSyncReady = false;
});
