/**
 * 二轮审查（项2）：备份快照包含同步账户持仓（backupVersion=2）与历史恢复回填。
 * 验证：
 *   a. createCloudBackup 快照带 syncAccounts：同步账户的用户持仓事实（金额/交易）入快照，
 *      行情缓存字段（history/estimate/latest_nav 等）被剔除；
 *   b. restoreCloudBackup：快照带 syncAccounts 时回填历史持仓与策略（真正的历史恢复）；
 *   c. 向后兼容：旧快照（无 syncAccounts）恢复仍走「历史策略 + 当前持仓重建」原语义；
 *   d. user_data PUT（backupToCloud）不夹带 syncAccounts —— 双端兼容边界不动。
 */
const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

let fetchCalls = [];
let restoreResponse = null; // POST /api/account/backups/:id/restore 的响应
global.fetch = async (url, opts) => {
  const call = { url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body };
  fetchCalls.push(call);
  if (call.url.includes('/api/account/backups/') && call.url.includes('/restore')) {
    return { ok: true, status: 200, json: async () => restoreResponse };
  }
  return { ok: true, status: 200, json: async () => ({ success: true, backups: [] }) };
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
  api: () => Promise.resolve({ state: { accounts: {} } })
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

// 模拟 app-refactor 的 refreshSyncedAccounts：从服务端权威重建同步账户壳（持仓空），
// 策略按 syncMeta（getSyncAccountMeta → mergeSyncMeta 仓库）回填 —— 与生产语义一致
W.refreshSyncedAccounts = async function () {
  if (S.accounts['同步A']) {
    const meta = (typeof W.getSyncAccountMeta === 'function') ? W.getSyncAccountMeta('同步A') : null;
    S.accounts['同步A'] = {
      name: '同步A', accountType: 'sync', syncSource: 'xiaobeiyangji', funds: [],
      strategy: (meta && Array.isArray(meta.strategy) && meta.strategy.length) ? meta.strategy.slice() : []
    };
  }
  return [];
};

W.accountRestoreStatus = 'ready';
W.cloudSyncReady = true;

test('0. 冲刷加载期恢复 + 装配含持仓的同步账户', async () => {
  await delay(700); // 等加载期 cloud-empty 恢复链（save/PUT/stub 重建）全部落定
  fetchCalls = [];
  S.accounts = {
    '同步A': {
      name: '同步A', accountType: 'sync', syncSource: 'xiaobeiyangji',
      strategy: ['仓位不超过30%'],
      closedPositions: [{ code: '001', amount: 100, closed: true }],
      targetRecovery: null, maxFunds: 20,
      funds: [{
        code: '007339', name: '易方达中证A500', amount: 20000,
        transactions: [{ type: 'buy', amount: 20000, fee: 0, date: '2026-10-09' }],
        history: [{ date: '2026-11-14', nav: 1.02 }], latest_nav: { date: '2026-11-14', nav: 1.02 },
        estimate: { value: 0.01, date: '2026-11-17' }
      }]
    },
    '本地B': { name: '本地B', accountType: 'local', funds: [{ code: '161725', amount: 5000 }] }
  };
  assert.strictEqual(W.accountRestoreStatus, 'ready');
});

test('a. 备份快照带 syncAccounts（持仓事实入快照，行情缓存剔除）', async () => {
  fetchCalls = [];
  const ok = await W.createCloudBackup('manual');
  assert.strictEqual(ok, true, 'createCloudBackup 应成功');
  const post = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/api/account/backups'));
  assert.ok(post, '必须 POST /api/account/backups');
  const payload = JSON.parse(post.body);
  assert.strictEqual(payload.state.backupVersion, 2, '快照应标记 backupVersion=2');
  const syncA = payload.state.syncAccounts && payload.state.syncAccounts['同步A'];
  assert.ok(syncA, '快照必须包含同步账户 syncAccounts');
  assert.strictEqual(syncA.funds[0].code, '007339');
  assert.strictEqual(syncA.funds[0].amount, 20000, '历史持仓金额必须入快照');
  assert.ok(Array.isArray(syncA.funds[0].transactions), '交易记录必须入快照');
  assert.strictEqual(syncA.funds[0].history, undefined, '行情缓存 history 必须剔除');
  assert.strictEqual(syncA.funds[0].latest_nav, undefined, '行情缓存 latest_nav 必须剔除');
  assert.strictEqual(syncA.funds[0].estimate, undefined, '行情缓存 estimate 必须剔除');
  assert.deepStrictEqual(syncA.strategy, ['仓位不超过30%']);
  assert.ok(payload.state.accounts['本地B'], '本地账户照常入快照');
});

test('b. restoreCloudBackup 回填 syncAccounts 历史持仓（真正的历史恢复）', async () => {
  // 模拟当前同步账户持仓已被重建为空（服务端权威），快照里是历史持仓
  S.accounts['同步A'] = { name: '同步A', accountType: 'sync', funds: [], strategy: [] };
  restoreResponse = {
    state: {
      accounts: { '本地B': { name: '本地B', accountType: 'local', funds: [{ code: '161725', amount: 5000 }] } },
      active: '本地B',
      syncMeta: { '同步A': { strategy: ['回撤超10%减半'] } },
      backupVersion: 2,
      syncAccounts: {
        '同步A': {
          name: '同步A',
          funds: [{ code: '007339', amount: 18888, transactions: [{ type: 'buy', amount: 18888, fee: 0, date: '2026-09-01' }] }],
          strategy: ['历史策略A'],
          closedPositions: [{ code: '001', closed: true }],
          targetRecovery: null,
          maxFunds: 20
        }
      }
    }
  };
  const applied = await W.restoreCloudBackup(1);
  assert.strictEqual(applied, true);
  const acc = S.accounts['同步A'];
  assert.ok(acc, '同步账户壳必须存在');
  assert.strictEqual(acc.accountType, 'sync');
  assert.strictEqual(acc.funds.length, 1, '历史持仓必须回填');
  assert.strictEqual(acc.funds[0].amount, 18888, '历史持仓金额必须恢复');
  assert.deepStrictEqual(acc.strategy, ['历史策略A'], '快照策略优先于 syncMeta 重建值');
  assert.deepStrictEqual(acc.closedPositions, [{ code: '001', closed: true }], '已平仓记录必须恢复');
});

test('c. 向后兼容：旧快照（无 syncAccounts）保持「策略 + 当前持仓重建」原语义', async () => {
  S.accounts['同步A'] = { name: '同步A', accountType: 'sync', funds: [], strategy: [] };
  restoreResponse = {
    state: {
      accounts: { '本地B': { name: '本地B', accountType: 'local', funds: [] } },
      active: '本地B',
      syncMeta: { '同步A': { strategy: ['旧快照策略'] } }
      // 无 syncAccounts / 无 backupVersion —— 旧格式
    }
  };
  const applied = await W.restoreCloudBackup(2);
  assert.strictEqual(applied, true);
  const acc = S.accounts['同步A'];
  assert.deepStrictEqual(acc.strategy, ['旧快照策略'], '旧快照策略经 syncMeta → refreshSyncedAccounts 仍生效');
  assert.deepStrictEqual(acc.funds, [], '旧快照无持仓快照 → 保持重建空壳（服务端权威），不虚构历史持仓');
});

test('d. user_data PUT（backupToCloud）不夹带 syncAccounts', async () => {
  fetchCalls = [];
  const ok = await W.backupToCloud();
  assert.strictEqual(ok, true);
  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url.includes('/api/account/state'));
  assert.ok(put, 'backupToCloud 必须 PUT user_data');
  const payload = JSON.parse(put.body);
  assert.strictEqual(payload.state.syncAccounts, undefined, 'user_data 形态不变（双端兼容边界）');
});
