/**
 * navGapSync.test.js
 * 验证历史净值「缺口检测 + 缺口补偿」逻辑：
 *  - buildExpectedTradingWindow：纯交易日历，返回指定数量的升序交易日。
 *  - detectNavGaps：纯 DB 检测，仅返回存在缺失交易日的基金及其缺失日期（不访问第三方）。
 *  - syncWeeklyHistory：仅对缺口基金调用 importFund（并发 1~2、单基金串行），无缺口基金不补偿。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const serviceDir = path.resolve(__dirname, '..', 'services');
const dbAsyncPath = require.resolve(path.join(serviceDir, '..', 'database', 'dbAsync'));
const fundServicePath = require.resolve(path.join(serviceDir, 'fundService'));

// ── 注入假 DB / 假 fundService（在 require navSyncService 之前）──
const fakeNavRowsByCode = {}; // code -> ['2026-xx-xx', ...]
const fakeDb = {
  all: async (sql, params) => (fakeNavRowsByCode[params[0]] || []).map(date => ({ date })),
  get: async () => null,
  run: async () => ({})
};
const importFundCalls = [];
const fakeFundService = {
  listFunds: async () => ([
    { fund_code: '019633', fund_name: '测试基金A', fund_type: '' },
    { fund_code: '000001', fund_name: '测试基金B', fund_type: '' }
  ]),
  importFund: async (code) => {
    importFundCalls.push(code);
    return { records: 1, inserted: 1 };
  }
};
require.cache[dbAsyncPath] = { id: dbAsyncPath, filename: dbAsyncPath, loaded: true, exports: fakeDb };
require.cache[fundServicePath] = { id: fundServicePath, filename: fundServicePath, loaded: true, exports: fakeFundService };

const nav = require(path.join(serviceDir, 'navSyncService'));

// 用服务自身实现的窗口构造“完整应有记录”，再人为挖掉一个交易日模拟断档
const expectedA = nav.buildExpectedTradingWindow(60, { fund_name: '', fund_type: '' });
const MISSING = '2026-08-28'; // 周五，属应交易日
const rowsA = expectedA.filter(d => d !== MISSING);
fakeNavRowsByCode['019633'] = rowsA;
fakeNavRowsByCode['000001'] = expectedA.slice(); // 完整，无缺口

test('buildExpectedTradingWindow 返回指定数量的升序交易日', () => {
  const win = nav.buildExpectedTradingWindow(10, { fund_name: '', fund_type: '' });
  assert.strictEqual(win.length, 10);
  for (let i = 0; i < win.length; i += 1) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(win[i]), `格式非法: ${win[i]}`);
    // 均为 A 股交易日（isTradingDay 由 marketService 提供，这里仅校验升序与去重）
    if (i > 0) assert.ok(win[i] > win[i - 1], `非升序: ${win[i - 1]} -> ${win[i]}`);
  }
  assert.notStrictEqual(win.indexOf(MISSING), -1, '窗口应包含 2026-08-28');
});

test('detectNavGaps 仅标记存在缺失交易日的基金', async () => {
  const gaps = await nav.detectNavGaps({ windowDays: 60 });
  const a = gaps.find(g => g.fund_code === '019633');
  const b = gaps.find(g => g.fund_code === '000001');
  assert.ok(a, '019633 应被标记为缺口基金');
  assert.ok(a.missingDates.includes(MISSING), `019633 应缺 ${MISSING}`);
  assert.strictEqual(a.missingDates.length, 1, '019633 仅缺一个交易日');
  assert.strictEqual(b, undefined, '000001 无缺口，不应出现在结果中');
  // 整体缺口基金数量应仅为 1（不全量扫、无多余项）
  assert.strictEqual(gaps.length, 1);
});

test('syncWeeklyHistory 仅对缺口基金补偿（并发 1~2、单基金串行）', async () => {
  importFundCalls.length = 0;
  const result = await nav.syncWeeklyHistory({ concurrency: 1 });
  assert.strictEqual(result.gaps, 1, '仅 1 只基金存在缺口');
  assert.strictEqual(importFundCalls.length, 1, 'importFund 仅被调用 1 次');
  assert.strictEqual(importFundCalls[0], '019633', '仅缺口基金 019633 被补偿');
  assert.ok(!importFundCalls.includes('000001'), '无缺口基金 000001 不应被补偿');
  assert.ok(Array.isArray(result.filled) && result.filled.length === 1);
});

test('detectNavGaps 无缺口时返回空数组（不触发任何补偿）', async () => {
  fakeNavRowsByCode['019633'] = expectedA.slice(); // 补齐缺口
  const gaps = await nav.detectNavGaps({ windowDays: 60 });
  assert.strictEqual(gaps.length, 0, '补齐后不应有缺口');
  importFundCalls.length = 0;
  const result = await nav.syncWeeklyHistory({ concurrency: 1 });
  assert.strictEqual(result.gaps, 0);
  assert.strictEqual(importFundCalls.length, 0, '无缺口时不调用 importFund');
});
