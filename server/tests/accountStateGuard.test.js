const test = require('node:test');
const assert = require('node:assert/strict');

const { isEmptyStateOverwrite } = require('../services/accountStateService');

function existingState() {
  return {
    accounts: {
      '天才3.0': {
        name: '天才3.0',
        funds: [
          { code: '019633', name: '国泰半导体设备ETF联接C', amount: 10000 },
          { code: '008702', name: '华夏黄金ETF联接C', amount: 15000 }
        ]
      }
    },
    active: '天才3.0'
  };
}

test('防误覆盖：云端无数据时允许写入（新用户首次迁移）', () => {
  assert.equal(isEmptyStateOverwrite(null, { accounts: {} }), false);
  assert.equal(isEmptyStateOverwrite(null, { accounts: { '主账户': { name: '主账户', funds: [] } } }), false);
});

test('防误覆盖：state 为空 → 拒绝', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), {}), true);
});

test('防误覆盖：accounts 不存在 → 拒绝', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), { active: '' }), true);
});

test('防误覆盖：accounts 为数组（非法形状）→ 拒绝', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), { accounts: [] }), true);
});

test('防误覆盖：accounts = {} → 拒绝', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), { accounts: {}, active: '' }), true);
});

test('防误覆盖：云端有持仓但新 state 全部空基金账户 → 拒绝', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), {
    accounts: { '空账户': { name: '空账户', funds: [] } },
    active: '空账户'
  }), true);
});

test('防误覆盖：正常完整 state 允许写入', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), existingState()), false);
});

test('防误覆盖：空账户与有持仓账户并存 → 允许', () => {
  assert.equal(isEmptyStateOverwrite(existingState(), {
    accounts: {
      '空账户': { name: '空账户', funds: [] },
      '天才3.0': { name: '天才3.0', funds: [{ code: '019633', amount: 10000 }] }
    },
    active: '天才3.0'
  }), false);
});
