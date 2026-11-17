/**
 * 「点持仓卡一下」修复回归：本地落盘防抖（system 级保存合并）。
 * 根因：一次进入持仓页/页面加载触发几十次 mergeFundData / fundStore.update，各自
 *   save({system:true}) 时都同步 JSON.stringify 整个 MB 级 payload（fundStore+accounts
 *   均含 history/holdings）+ localStorage.setItem —— 主线程被连续长任务阻塞。
 * 验证：
 *   a. 连续多次 system 保存（间隔 <600ms）→ 防抖窗口内零落盘，结束后恰好一次，内容为最终状态；
 *   b. system 保存后紧跟用户编辑保存 → 立即落盘（不等防抖尾随）；
 *   c. system 保存全程不触发云端 PUT（原语义保持）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

const STORAGE_KEY = 'genius-trader-portfolio-v2';
let fetchCalls = [];
let apiResponse = { state: { accounts: {} } }; // 默认云端为空
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
  return { ok: true, status: 200, json: async () => apiResponse };
};
let setItemCount = 0;
const ls = new Map();
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { setItemCount += 1; ls.set(k, String(v)); },
  removeItem: (k) => ls.delete(k)
};
global.document = { addEventListener: () => {}, querySelector: () => null, visibilityState: 'visible' };
const auth = {
  state: { token: 'test-token' },
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
  api: () => Promise.resolve(apiResponse)
};
global.window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  auth,
  fundStore: { get: () => ({}), set: () => {}, utils: {} },
  portfolioState: {
    accounts: {},
    setActive: () => {},
    render: () => {},
    getActive: () => '',
    persist: () => {},
    addAccount: () => {}
  }
};

require('../../persistence.js');
const W = global.window;
const S = W.portfolioState;
function putCount() {
  return fetchCalls.filter((c) => c.method === 'PUT' && c.url.includes('/api/account/state')).length;
}

test('a. 连续多次 system 保存 → 合并为一次尾随落盘，内容为最终状态', async () => {
  await delay(800); // 冲刷加载期恢复链的异步写入
  setItemCount = 0;
  fetchCalls = [];
  for (let i = 1; i <= 10; i++) {
    S.accounts = { '实盘': { name: '实盘', funds: [{ code: '007339', name: '易方达中证A500', amount: 1000 * i }] } };
    W.savePortfolioState({ system: true }); // 模拟行情响应逐只到达（间隔 <600ms）
    await delay(50);
  }
  assert.strictEqual(setItemCount, 0, '防抖窗口内不得逐次落盘（卡顿根因）');
  assert.strictEqual(putCount(), 0, 'system 保存不得触发云端 PUT');
  await delay(700); // 等尾随写入
  assert.strictEqual(setItemCount, 1, '防抖结束后应恰好落盘一次');
  const saved = JSON.parse(ls.get(STORAGE_KEY) || 'null');
  assert.ok(saved && saved.accounts && saved.accounts['实盘'], '落盘内容应包含最终账户');
  assert.strictEqual(saved.accounts['实盘'].funds[0].amount, 10000, '落盘应为最终状态（最后一次金额）');
});

test('b. system 保存后紧跟用户编辑保存 → 立即落盘，不等待防抖尾随', async () => {
  setItemCount = 0;
  fetchCalls = [];
  S.accounts = { '实盘': { name: '实盘', funds: [{ code: '007339', name: '易方达中证A500', amount: 12345 }] } };
  W.savePortfolioState({ system: true }); // 行情水合（挂起 600ms 尾随）
  S.accounts['实盘'].funds[0].amount = 22222;
  W.savePortfolioState(); // 用户编辑 → 应立即合并落盘
  assert.strictEqual(setItemCount, 1, '用户编辑保存必须立即落盘');
  const saved = JSON.parse(ls.get(STORAGE_KEY) || 'null');
  assert.strictEqual(saved.accounts['实盘'].funds[0].amount, 22222, '落盘应包含编辑后的最新状态');
  await delay(700); // 挂起的 system 尾随写入应已被取消，不得二次落盘
  assert.strictEqual(setItemCount, 1, '用户编辑后挂起的 system 尾随写入应被取消');
});

test('c. 用户编辑保存按既有闸门语义触发云端 PUT（回归保护）', async () => {
  // 模拟恢复完成：闸门就绪
  W.accountRestoreStatus = 'ready';
  W.cloudSyncReady = true;
  setItemCount = 0;
  fetchCalls = [];
  S.accounts = { '实盘': { name: '实盘', funds: [{ code: '007339', name: '易方达中证A500', amount: 999 }] } };
  W.savePortfolioState(); // 用户编辑 → 本地立即落盘 + 400ms 防抖 PUT
  assert.strictEqual(setItemCount, 1, '本地应立即落盘');
  await delay(600); // 等云端防抖
  assert.ok(putCount() >= 1, '恢复完成后用户编辑应照常上云');
});
