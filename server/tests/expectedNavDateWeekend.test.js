/**
 * expectedNavDateFor 真实周末/节假日口径回归（2026-10-17 周末净值修复 · 补强）。
 * 使用真实 estimateStatus + 真实 marketService（纯日期逻辑，无网络），固定 now 到周六上午。
 * 口径：普通基金 周六 → 最近交易日（周五）；QDII 周六 → 再前一交易日（周四）；
 *       交易日当天：普通基金 → 当天，QDII → 上一交易日。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const svcDir = path.join(__dirname, '..', 'services');
const { expectedNavDateFor } = require(path.join(svcDir, 'estimateStatus'));

// 固定时钟（上海时区表达，无跨日歧义）
const SAT = new Date('2026-10-17T10:00:00+08:00');  // 周六
const SUN = new Date('2026-10-18T10:00:00+08:00');  // 周日
const FRI_AFTER_CLOSE = new Date('2026-10-16T20:00:00+08:00'); // 周五收盘后
const FRI_MORNING = new Date('2026-10-16T09:30:00+08:00');     // 周五盘中

const plainFund = { fund_type: '股票型', fund_name: '沪深300指数基金' };
const qdiiFund = { fund_type: 'QDII', fund_name: '纳斯达克100基金' };

test('周六：普通基金 expected=最近交易日（周五）', () => {
  assert.strictEqual(expectedNavDateFor(plainFund, SAT), '2026-10-16');
});

test('周日：普通基金 expected 仍为周五（周末不前进）', () => {
  assert.strictEqual(expectedNavDateFor(plainFund, SUN), '2026-10-16');
});

test('周六：QDII expected=前一交易日（周四，T+1 跨日）', () => {
  assert.strictEqual(expectedNavDateFor(qdiiFund, SAT), '2026-10-15');
});

test('交易日回归：周五收盘后普通基金 expected=当天；QDII=上一交易日（周四）', () => {
  assert.strictEqual(expectedNavDateFor(plainFund, FRI_AFTER_CLOSE), '2026-10-16');
  assert.strictEqual(expectedNavDateFor(qdiiFund, FRI_AFTER_CLOSE), '2026-10-15');
});

test('交易日回归：周五盘中普通基金 expected=当天（与周末口径区分）', () => {
  assert.strictEqual(expectedNavDateFor(plainFund, FRI_MORNING), '2026-10-16');
});
