/**
 * 二轮审查（项5）：Web 精简形态 user_data 写入的字段增量合并（mergeSlimState）。
 * 双形态契约：
 *   - Web buildCloudState：accounts 只含本地账户（同步账户持仓服务端权威）+ syncMeta；
 *   - mp1 saveStateToCloud：accounts 整包（本地 + 同步账户带持仓）+ syncMeta + providerStatus。
 * 冲突场景：同步账户-only 用户在 Web 上 PUT accounts={} → 云端（mp1 整包）有持仓 →
 * 旧逻辑 409，Web 策略永远同步不上去。合并规则：保留云端 accounts，仅合并
 * syncMeta / providerStatus / active 字段。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { isEmptyStateOverwrite, mergeSlimState } = require('../services/accountStateService');

function mp1StyleState() {
  return {
    accounts: {
      '本地C': { name: '本地C', funds: [{ code: '161725', amount: 3000 }] },
      '同步A': { name: '同步A', accountType: 'sync', funds: [{ code: '007339', amount: 20000 }] }
    },
    active: '本地C',
    syncMeta: { '同步A': { strategy: ['mp1 策略'] } },
    providerStatus: { yangjibao: { logged_in: true } },
    updatedAt: 1700000000000
  };
}

function webSlimState() {
  return {
    accounts: {}, // Web buildPersisted：同步账户-only 用户恒为空
    active: '',
    syncMeta: { '同步A': { strategy: ['Web 修改后的策略'] } }
  };
}

test('409 判定不变：mp1 整包形态 → 云端非空 + incoming 非空 → 允许直接覆盖', () => {
  assert.equal(isEmptyStateOverwrite(mp1StyleState(), mp1StyleState()), false);
});

test('Web 精简形态命中 409 路径（修复前的缺陷现场）', () => {
  assert.equal(isEmptyStateOverwrite(mp1StyleState(), webSlimState()), true,
    'accounts={} + 云端有持仓 → isEmptyStateOverwrite=true（由 mergeSlimState 在 409 路径上接管）');
});

test('mergeSlimState：保留云端 accounts（mp1 持仓不丢），syncMeta 用 Web 新值', () => {
  const merged = mergeSlimState(mp1StyleState(), webSlimState());
  assert.ok(merged, '应产出合并 state 而非 409');
  assert.ok(merged.accounts['同步A'], '云端同步账户必须保留');
  assert.equal(merged.accounts['同步A'].funds[0].amount, 20000, '同步账户持仓不丢');
  assert.ok(merged.accounts['本地C'], '云端本地账户必须保留');
  assert.deepStrictEqual(merged.syncMeta['同步A'].strategy, ['Web 修改后的策略'], 'Web 策略必须写上去（本次修复目标）');
});

test('mergeSlimState：active 仅在云端账户中存在时采纳', () => {
  const merged = mergeSlimState(mp1StyleState(), Object.assign(webSlimState(), { active: '本地C' }));
  assert.equal(merged.active, '本地C');
  const merged2 = mergeSlimState(mp1StyleState(), Object.assign(webSlimState(), { active: '不存在的账户' }));
  assert.equal(merged2.active, '本地C', 'active 指向不存在账户时保持云端原值');
});

test('mergeSlimState：不满足条件返回 null（维持 409）', () => {
  // 云端为空 → null（正常写入路径）
  assert.equal(mergeSlimState(null, webSlimState()), null);
  assert.equal(mergeSlimState({ accounts: {} }, webSlimState()), null);
  // incoming accounts 非空（整包写）→ null（走正常覆盖）
  assert.equal(mergeSlimState(mp1StyleState(), mp1StyleState()), null);
  // incoming 无 syncMeta / syncMeta 空 → null（真·空写，仍 409 拒绝）
  assert.equal(mergeSlimState(mp1StyleState(), { accounts: {}, active: '' }), null);
  assert.equal(mergeSlimState(mp1StyleState(), { accounts: {}, syncMeta: {}, active: '' }), null);
});

test('mergeSlimState：accounts 非法形状（数组）→ null（维持 409 防误覆盖）', () => {
  assert.equal(mergeSlimState(mp1StyleState(), { accounts: [], syncMeta: { a: { strategy: [] } } }), null);
});

test('mergeSlimState：providerStatus 等其它字段随 incoming 合并，updatedAt 刷新', () => {
  const merged = mergeSlimState(
    mp1StyleState(),
    Object.assign(webSlimState(), { providerStatus: { xiaobeiyangji: { logged_in: true } } })
  );
  assert.deepEqual(merged.providerStatus, { xiaobeiyangji: { logged_in: true } });
  assert.notEqual(merged.updatedAt, 1700000000000, '合并写入必须刷新 updatedAt（mp1 时间戳保护依据）');
});
