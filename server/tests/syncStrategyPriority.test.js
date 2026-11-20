// 同步账户策略合并优先级回归（2026-11-20 B 场景根因修复）：
// mp1 整包 PUT 把同步账户（含旧 strategy）留在云端 user_data.accounts，
// Web 改策略走 mergeSlimState（按设计保留云端 accounts、只更新 syncMeta）。
// 服务端 loadUserAccounts 若仍优先 accounts.strategy → Web 的新策略被永久压制，
// AI 分析 / 导出 JSON / 复制 JSON 恒为旧策略，点「生成」也无效。
// 修复后语义：syncMeta（双端约定的「策略仓库唯一出口」）优先，accounts.strategy 仅作
// legacy 兜底（syncMeta 无条目时）。本测试桩掉 getUserState / listSyncedAccounts，
// 只验证合并优先级，全程不触库不触网。
const test = require('node:test');
const assert = require('node:assert');

delete process.env.DATABASE_URL;

// —— 先挂可变转发器，再 require 被测服务（portfolioAnalysisService 顶层解构捕获引用，
//    require 之后的赋值不会生效；转发器让每个用例可在运行期切换桩数据）——
const accountStateService = require('../services/accountStateService');
const portfolioService = require('../services/portfolioService');

const SYNC_NAME = '小倍账户';
let stateStub = null; // () => ({ accounts, syncMeta }) | null
let listStub = null;  // () => [syncAccount]

accountStateService.getUserState = async () => (stateStub ? stateStub() : null);
portfolioService.listSyncedAccounts = async () => (listStub ? listStub() : []);

function stubState({ accountsStrategy, syncMetaStrategy, listStrategy }) {
  stateStub = () => ({
    accounts: accountsStrategy
      ? { [SYNC_NAME]: { accountType: 'sync', strategy: accountsStrategy, funds: [{ code: '007339' }] } }
      : {},
    syncMeta: syncMetaStrategy ? { [SYNC_NAME]: { strategy: syncMetaStrategy } } : {}
  });
  listStub = () => [
    { name: SYNC_NAME, accountType: 'sync', strategy: listStrategy || [], funds: [{ code: '007339' }] }
  ];
}

const { loadUserAccounts } = require('../services/portfolioAnalysisService');

test('B 场景：accounts 旧策略 + syncMeta 新策略 → 必须取 syncMeta（修复目标）', async () => {
  stubState({ accountsStrategy: ['旧策略（mp1 整包遗留）'], syncMetaStrategy: ['Web 修改后的新策略'] });
  const accounts = await loadUserAccounts(99);
  const acc = accounts.find(a => a.name === SYNC_NAME);
  assert.ok(acc, '同步账户必须出现在分析账户列表');
  assert.deepStrictEqual(acc.strategy, ['Web 修改后的新策略'],
    'syncMeta 优先：Web 改策略后必须生效，不得被 accounts 遗留旧策略压制');
});

test('legacy 兜底：syncMeta 无条目 → 回退 accounts.strategy', async () => {
  stubState({ accountsStrategy: ['历史策略A'], syncMetaStrategy: null });
  const accounts = await loadUserAccounts(99);
  const acc = accounts.find(a => a.name === SYNC_NAME);
  assert.ok(acc, '同步账户必须出现在分析账户列表');
  assert.deepStrictEqual(acc.strategy, ['历史策略A'],
    'syncMeta 缺条目时保持 2026-11-17 修复语义：accounts.strategy 兜底，策略不得丢失');
});

test('legacy 兜底：syncMeta 条目存在但策略为空数组 → 仍回退 accounts.strategy', async () => {
  stubState({ accountsStrategy: ['历史策略A'], syncMetaStrategy: [] });
  const accounts = await loadUserAccounts(99);
  const acc = accounts.find(a => a.name === SYNC_NAME);
  assert.ok(acc, '同步账户必须出现在分析账户列表');
  assert.deepStrictEqual(acc.strategy, ['历史策略A']);
});

test('双端一致形态（mp1 同源同值）：accounts 与 syncMeta 相同 → 取值不受优先级影响', async () => {
  stubState({ accountsStrategy: ['纪律：不追高'], syncMetaStrategy: ['纪律：不追高'] });
  const accounts = await loadUserAccounts(99);
  const acc = accounts.find(a => a.name === SYNC_NAME);
  assert.ok(acc, '同步账户必须出现在分析账户列表');
  assert.deepStrictEqual(acc.strategy, ['纪律：不追高']);
});

test('均无策略 → 如实回退服务端列表值（恒 []），不伪造', async () => {
  stubState({ accountsStrategy: null, syncMetaStrategy: null, listStrategy: [] });
  const accounts = await loadUserAccounts(99);
  const acc = accounts.find(a => a.name === SYNC_NAME);
  assert.ok(acc, '同步账户必须出现在分析账户列表');
  assert.deepStrictEqual(acc.strategy, []);
});
