/**
 * 登录策略同步追修回归：restoreCloud 的 cloud-empty 分支（user_data.accounts 为空，
 * Web 主用户常态）此前从不合并云端 syncMeta —— 登录后同步账户策略恒为空。
 * 验证：
 *   1. 云端 accounts={} + syncMeta 有策略 → 登录恢复后同步账户必须拿到云端策略；
 *   2. 云端该账户无策略条目 → 本地（localStorage 水合）兜底策略保留，不得清掉；
 *   3. 再次登录（云端策略更新）→ 同名账户云端权威覆盖，本地条目兜底补位。
 */
const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

let fetchCalls = [];
let apiResponse = { state: { accounts: {}, syncMeta: { '同步A': { strategy: ['云端策略A'] } } } };
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
  return { ok: true, status: 200, json: async () => apiResponse };
};
const ls = new Map();
// localStorage 预置本地策略（require 前写入，require 时水合进 syncMetaStore）
ls.set('genius-trader-portfolio-v2', JSON.stringify({
  accounts: {},
  active: '',
  syncMeta: { '同步A': { strategy: ['旧本地策略A'] }, '同步B': { strategy: ['本地兜底策略B'] } }
}));
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
};
global.document = { addEventListener: () => {}, querySelector: () => null, visibilityState: 'visible' };

const auth = {
  state: { token: 'test-token' },
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
  api: () => Promise.resolve(apiResponse)
};
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
    getActive: () => '',
    persist: () => {},
    addAccount: () => {}
  }
};
function fireAuthChanged() { (listeners['auth-changed'] || []).forEach((fn) => fn()); }

// 模拟 app-refactor refreshSyncedAccounts：按服务端权威重建同步账户壳，
// 策略从 getSyncAccountMeta（→ syncMetaStore）回填 —— 与生产语义一致
global.window.refreshSyncedAccounts = async function () {
  const S = global.window.portfolioState;
  ['同步A', '同步B'].forEach((name) => {
    const meta = global.window.getSyncAccountMeta(name);
    S.accounts[name] = {
      name, accountType: 'sync', funds: [],
      strategy: (meta && Array.isArray(meta.strategy) && meta.strategy.length) ? meta.strategy.slice() : []
    };
  });
  return [];
};

require('../../persistence.js');
const W = global.window;
const S = W.portfolioState;

test('1+2. cloud-empty 恢复：云端策略合并生效，云端缺失条目由本地兜底', async () => {
  await delay(700); // 加载期恢复链（cloud-empty 分支）完整走完
  assert.ok(S.accounts['同步A'], '同步账户壳必须已重建');
  assert.deepStrictEqual(S.accounts['同步A'].strategy, ['云端策略A'],
    '云端 syncMeta 策略必须在 cloud-empty 分支被合并并应用到同步账户（本次追修目标）');
  assert.deepStrictEqual(S.accounts['同步B'].strategy, ['本地兜底策略B'],
    '云端无该账户条目 → 本地兜底策略保留，不得清掉');
});

test('3. 再次登录（云端策略更新）→ 云端权威覆盖同名条目，本地条目兜底补位', async () => {
  await delay(500); // 冲刷上一轮待发 PUT
  fetchCalls = [];
  apiResponse = { state: { accounts: {}, syncMeta: { '同步A': { strategy: ['云端新策略A'] } } } };
  fireAuthChanged(); // 重触发 restoreCloud（模拟再次登录）
  await delay(700);
  assert.deepStrictEqual(S.accounts['同步A'].strategy, ['云端新策略A'], '同名账户云端策略权威');
  assert.deepStrictEqual(S.accounts['同步B'].strategy, ['本地兜底策略B'], '云端缺失条目由本地兜底补位');
});
