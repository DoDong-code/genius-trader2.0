/**
 * 二轮审查（项3）：stripStarterDemoAccounts 精确匹配规则 + 云同步安全。
 * 验证：
 *   a. 演示指纹（名称=主账户 且 基金代码恰为 008702+019633 两只）被精确清除；
 *   b. 真实账户绝不通杀：同名但基金更多 / 不同基金 / 同基金但不同账户名，一律保留；
 *   c. 云端为空 + 清理后无账户 → 不触发任何 PUT（不把清理动作写回云端）；
 *   d. 云端为空 + 清理后仍有真实账户 → 恢复流程正常落盘（PUT 只含真实账户）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

let fetchCalls = [];
let apiResponse = { state: { accounts: {} } }; // 默认云端为空
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
  return { ok: true, status: 200, json: async () => apiResponse };
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
  api: () => Promise.resolve(apiResponse)
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
function demoFunds(extra) {
  const base = [
    { code: '019633', name: '国泰半导体设备ETF联接C', amount: 10000 },
    { code: '008702', name: '华夏黄金ETF联接C', amount: 5000 }
  ];
  return extra ? base.concat(extra) : base;
}

test('a. 演示指纹被精确清除（同名 + 恰好两只演示基金）', () => {
  S.accounts = { '主账户': { name: '主账户', funds: demoFunds() } };
  W.stripStarterDemoAccounts();
  assert.ok(!('主账户' in S.accounts), '演示主账户应被清除');
});

test('b1. 同名但基金更多（真实增持）→ 不删除', () => {
  S.accounts = { '主账户': { name: '主账户', funds: demoFunds([{ code: '161725', name: '招商中证白酒', amount: 30000 }]) } };
  W.stripStarterDemoAccounts();
  assert.ok('主账户' in S.accounts, '真实账户（基金数不一致）不得删除');
});

test('b2. 同名但基金不同 → 不删除', () => {
  S.accounts = { '主账户': { name: '主账户', funds: [{ code: '007339', name: '易方达中证A500', amount: 20000 }] } };
  W.stripStarterDemoAccounts();
  assert.ok('主账户' in S.accounts, '真实账户（基金代码不一致）不得删除');
});

test('b3. 基金相同但账户名不同 → 不删除', () => {
  S.accounts = { '我的定投': { name: '我的定投', funds: demoFunds() } };
  W.stripStarterDemoAccounts();
  assert.ok('我的定投' in S.accounts, '非演示名账户不得删除');
});

test('c. 云端为空 + 清理后无账户 → 全程零 PUT（清理不写回云端）', async () => {
  await delay(700); // 冲刷加载期恢复的待发 PUT，避免计数干扰
  fetchCalls = [];
  apiResponse = { state: { accounts: {} } };
  S.accounts = { '主账户': { name: '主账户', funds: demoFunds() } };
  W.accountRestoreStatus = 'ready';
  W.cloudSyncReady = true;
  // 模拟登录恢复 cloud-empty 分支的核心链路：strip → 无账户则不 save
  W.stripStarterDemoAccounts();
  await delay(600);
  assert.ok(Object.keys(S.accounts).length === 0);
  assert.strictEqual(putCount(), 0, '清理演示账户后不得触发云端 PUT');
});

test('d. 云端为空 + 清理后仍有真实账户 → 恢复完成允许 PUT，且只含真实账户', async () => {
  await delay(700); // 冲刷上一个用例的延迟窗口
  fetchCalls = [];
  apiResponse = { state: { accounts: {} } };
  S.accounts = {
    '主账户': { name: '主账户', funds: demoFunds() },
    '实盘': { name: '实盘', funds: [{ code: '007339', amount: 20000 }] }
  };
  W.accountRestoreStatus = 'ready';
  W.cloudSyncReady = true;
  W.stripStarterDemoAccounts();
  S.persist && S.persist(); // 等价 cloud-empty 分支「本地仍有账户 → save()」
  await delay(600);
  const puts = fetchCalls.filter((c) => c.method === 'PUT' && c.url.includes('/api/account/state') && typeof c.body === 'string');
  assert.ok(puts.length >= 1, '本地有真实账户时应正常落盘/上云');
  // 取最后一次 PUT（加载期陈旧 PUT 已在冲刷窗口落地，时序上本次 save 的 PUT 必然最后）
  const body = JSON.parse(puts[puts.length - 1].body);
  assert.ok(!('主账户' in body.state.accounts), '演示账户不得进入云端 payload');
  assert.ok('实盘' in body.state.accounts, '真实账户必须保留');
});
