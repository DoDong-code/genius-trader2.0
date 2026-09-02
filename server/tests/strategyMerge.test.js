// 投资策略去重合并逻辑测试（复用真实工具 strategyMerge.js）
const { test } = require('node:test');
const assert = require('node:assert');
const { dedupeStrategies } = require('../../strategyMerge.js');

// 模拟 UI 中的合并写法：目标策略 + 被删除账户策略 -> 去重合并
function mergeIntoTarget(targetArr, collected) {
  return dedupeStrategies((targetArr || []).concat(collected || []));
}

test('完全相同的策略只保留一份', () => {
  const merged = mergeIntoTarget(['权益持仓不超过10万元'], ['权益持仓不超过10万元']);
  assert.deepStrictEqual(merged, ['权益持仓不超过10万元']);
});

test('规格示例：部分相同策略正确合并', () => {
  const src = ['一年以内回本15000元', '权益持仓不超过10万元', '沪深300作为核心宽基'];
  const tgt = ['权益持仓不超过10万元', '黄金作为防御资产'];
  const merged = mergeIntoTarget(tgt, src);
  assert.deepStrictEqual(merged, [
    '权益持仓不超过10万元',
    '黄金作为防御资产',
    '一年以内回本15000元',
    '沪深300作为核心宽基'
  ]);
});

test('目标账户无策略时直接采用被删除方策略', () => {
  const merged = mergeIntoTarget([], ['纪律：不追高', '控制仓位']);
  assert.deepStrictEqual(merged, ['纪律：不追高', '控制仓位']);
});

test('被删除方无策略时不改变目标账户策略', () => {
  const merged = mergeIntoTarget(['稳健为主'], []);
  assert.deepStrictEqual(merged, ['稳健为主']);
});

test('目标账户有多条策略 + 被删除方部分重叠', () => {
  const tgt = ['A', 'B', 'C'];
  const src = ['B', 'D', 'E']; // B 重叠
  const merged = mergeIntoTarget(tgt, src);
  assert.deepStrictEqual(merged, ['A', 'B', 'C', 'D', 'E']);
});

test('首尾/中间空白不影响去重判定', () => {
  const merged = mergeIntoTarget(['  沪深300  '], ['沪深300']);
  assert.strictEqual(merged.length, 1);
});

test('空值/非数组输入安全', () => {
  assert.deepStrictEqual(dedupeStrategies(null), []);
  assert.deepStrictEqual(dedupeStrategies(undefined), []);
  assert.deepStrictEqual(dedupeStrategies('不是数组'), []);
  assert.deepStrictEqual(dedupeStrategies([null, '', '有效策略']), ['有效策略']);
});

test('多账户批量删除：所有有策略账户去重合并到单一目标', () => {
  const tgt = ['黄金作为防御资产'];
  const collected = [
    '一年以内回本15000元',
    '权益持仓不超过10万元',
    '沪深300作为核心宽基',
    '权益持仓不超过10万元', // 第二个删除账户带来重复
    '黄金作为防御资产'       // 与目标重复
  ];
  const merged = mergeIntoTarget(tgt, collected);
  assert.deepStrictEqual(merged, [
    '黄金作为防御资产',
    '一年以内回本15000元',
    '权益持仓不超过10万元',
    '沪深300作为核心宽基'
  ]);
});
