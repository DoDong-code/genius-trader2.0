// 紧凑导出（buildCompactExport）回归测试（2026-10-21）：
// 端点 ?compact=1 时 holdings 对象数组 → {columns, rows} 扁平宽表。
// 全程纯内存，不连接任何数据库（测试前由 npm test 统一 unset DATABASE_URL）。
const test = require('node:test');
const assert = require('node:assert');
const svc = require('../services/portfolioAnalysisService');

const { buildCompactExport } = svc;

function mockExportPayload() {
  return {
    generatedAt: '2026-10-21T07:03:02.646Z',
    account: { name: '养基宝-权益', type: 'manual', fundCount: 2, totalValue: 92550.36 },
    strategies: ['沪深300作为核心宽基 持仓不超过2万'],
    portfolioSummary: { equityCap: 100000, cashAvailable: null, realizedProfitLoss: null },
    dataWarnings: ['007339 易方达沪深300ETF联接C: 已配置基准但基准历史不足一年'],
    holdings: [
      {
        code: '007339',
        name: '易方达沪深300ETF联接C',
        category: '基金',
        subAccount: undefined, // undefined → null
        amount: 13041.93,
        cost: 14299.08,
        profit: -1257.15,
        profitRate: -0.0879,
        todayChange: -0.0089,
        todayProfit: -116.07,
        navUpdatedAt: '2026-10-20',
        navHistory: '2026-09-22 至 2026-10-20: 1.8384, 1.6893',
        topHoldings: '宁德时代(0.04%), 贵州茅台(0.02%)',
        overlapDetail: null,
        performance: {
          return1m: -0.073646, return3m: -0.086371, return6m: -0.104295, return1y: -0.058466,
          maxDrawdown1y: -0.159719, drawdownFromHigh1y: -0.159719, volatility20d: 0.12849,
          trend: 'down', dataAsOf: '2026-10-20', historyDays: 400
        },
        benchmark: {
          name: '沪深300指数', kind: 'auxiliary',
          return1m: -0.090495, return3m: -0.124504, return6m: -0.122487, return1y: null,
          relativeReturn1m: 0.016849, relativeReturn6m: 0.018192, relativeReturn1y: null,
          dataAsOf: '2026-10-21', source: '辅助分析基准：沪深300ETF(510300) 跟踪指数代理',
          unavailableReason: 'benchmark_history_insufficient_for_1y'
        },
        allocation: { role: 'core', sector: 'A股宽基', maxAmount: 20000, overlapWarning: false }
      },
      {
        code: '022184',
        name: '富国全球科技互联网股票(QDII)C',
        category: '基金',
        amount: 12256.94,
        cost: 15857.55,
        profit: -3600.61,
        profitRate: -0.2271,
        todayChange: 0,        // 0 是有效值
        todayProfit: 0,
        navUpdatedAt: '2026-10-19',
        navHistory: '',
        topHoldings: '',
        overlapDetail: '台积电:本10.06%/彼018147 10.26%',
        performance: null,     // 整组缺失 → 该组列全 null
        benchmark: null,
        allocation: { role: null, sector: '科技成长', maxAmount: null, overlapWarning: true }
      }
    ]
  };
}

function rowToObj(compact, rowIdx) {
  const obj = {};
  compact.holdings.columns.forEach((c, i) => { obj[c] = compact.holdings.rows[rowIdx][i]; });
  return obj;
}

test('buildCompactExport：列数恒等于每行长度，列顺序固定', () => {
  const out = buildCompactExport(mockExportPayload());
  assert.ok(Array.isArray(out.holdings.columns));
  assert.equal(out.holdings.columns.length, 40);
  for (const row of out.holdings.rows) {
    assert.equal(row.length, out.holdings.columns.length);
  }
  // 列顺序由 specs 显式声明，不依赖对象属性偶然顺序
  assert.equal(out.holdings.columns[0], 'code');
  assert.equal(out.holdings.columns[13], 'overlapDetail');
  assert.equal(out.holdings.columns[14], 'return1m');
  assert.equal(out.holdings.columns[24], 'benchName');
  assert.equal(out.holdings.columns[36], 'role');
  assert.equal(out.holdings.columns[39], 'overlapWarning');
});

test('buildCompactExport：字段值一一对应，无丢失（逐字段映射断言）', () => {
  const src = mockExportPayload();
  const out = buildCompactExport(src);
  const r0 = rowToObj(out, 0);
  const h0 = src.holdings[0];
  // 顶层字段逐一相等（undefined → null）
  for (const k of ['code', 'name', 'category', 'amount', 'cost', 'profit', 'profitRate',
    'todayChange', 'todayProfit', 'navUpdatedAt', 'navHistory', 'topHoldings', 'overlapDetail']) {
    assert.equal(r0[k], h0[k] === undefined ? null : h0[k], `顶层 ${k}`);
  }
  assert.equal(r0.subAccount, null);
  // performance 组逐一相等（dataAsOf → perfDataAsOf）
  const p0 = h0.performance;
  for (const k of ['return1m', 'return3m', 'return6m', 'return1y', 'maxDrawdown1y',
    'drawdownFromHigh1y', 'volatility20d', 'trend', 'historyDays']) {
    assert.equal(r0[k], p0[k], `performance ${k}`);
  }
  assert.equal(r0.perfDataAsOf, p0.dataAsOf);
  // benchmark 组逐一相等（bench 前缀映射）
  const b0 = h0.benchmark;
  const benchMap = {
    name: 'benchName', kind: 'benchKind', return1m: 'benchReturn1m', return3m: 'benchReturn3m',
    return6m: 'benchReturn6m', return1y: 'benchReturn1y', relativeReturn1m: 'benchRelReturn1m',
    relativeReturn6m: 'benchRelReturn6m', relativeReturn1y: 'benchRelReturn1y',
    dataAsOf: 'benchDataAsOf', source: 'benchSource', unavailableReason: 'benchUnavailableReason'
  };
  for (const [k, col] of Object.entries(benchMap)) {
    assert.equal(r0[col], b0[k], `benchmark ${k}`);
  }
  // allocation 组
  const a0 = h0.allocation;
  for (const k of ['role', 'sector', 'maxAmount', 'overlapWarning']) {
    assert.equal(r0[k], a0[k], `allocation ${k}`);
  }
  // 列数 = 顶层14 + performance10 + benchmark12 + allocation4，无孤儿列
  assert.equal(out.holdings.columns.length, 14 + 10 + 12 + 4);
});

test('buildCompactExport：performance/benchmark/allocation 拍平且列名无冲突', () => {
  const out = buildCompactExport(mockExportPayload());
  const r0 = rowToObj(out, 0);
  // performance 组（原名）
  assert.equal(r0.return1m, -0.073646);
  assert.equal(r0.maxDrawdown1y, -0.159719);
  assert.equal(r0.perfDataAsOf, '2026-10-20');
  // benchmark 组（bench 前缀，与 performance 的 return1m 区分）
  assert.equal(r0.benchName, '沪深300指数');
  assert.equal(r0.benchReturn1m, -0.090495);
  assert.equal(r0.benchReturn1y, null);          // null 缺失保留，不变 0
  assert.equal(r0.benchUnavailableReason, 'benchmark_history_insufficient_for_1y');
  // allocation 组
  assert.equal(r0.role, 'core');
  assert.equal(r0.maxAmount, 20000);
  assert.equal(r0.overlapWarning, false);        // false 保留
});

test('buildCompactExport：整组缺失（performance/benchmark=null）→ 该组列全 null', () => {
  const out = buildCompactExport(mockExportPayload());
  const r1 = rowToObj(out, 1);
  for (const c of ['return1m', 'maxDrawdown1y', 'perfDataAsOf', 'benchName', 'benchReturn1y', 'benchSource']) {
    assert.equal(r1[c], null, `${c} 应为 null`);
  }
  // 0 / 空串 / 有效值原样保留
  assert.equal(r1.todayChange, 0);
  assert.equal(r1.navHistory, '');
  assert.equal(r1.sector, '科技成长');
  assert.equal(r1.overlapWarning, true);
});

test('buildCompactExport：非数组字段（account/strategies/portfolioSummary/dataWarnings/generatedAt）原样保留', () => {
  const src = mockExportPayload();
  const out = buildCompactExport(src);
  assert.equal(out.generatedAt, src.generatedAt);
  assert.deepEqual(out.account, src.account);
  assert.deepEqual(out.strategies, src.strategies);
  assert.deepEqual(out.portfolioSummary, src.portfolioSummary);
  assert.deepEqual(out.dataWarnings, src.dataWarnings);
});

test('buildCompactExport：空持仓 / null payload 边界', () => {
  const empty = buildCompactExport({ account: { name: 'x' }, holdings: [] });
  assert.deepEqual(empty.holdings, { columns: empty.holdings.columns, rows: [] });
  assert.equal(empty.holdings.columns.length, 40);
  assert.equal(buildCompactExport(null), null);
  assert.equal(buildCompactExport(undefined), undefined);
});

test('buildCompactExport：不修改输入对象（纯函数）', () => {
  const src = mockExportPayload();
  const snapshot = JSON.stringify(src);
  buildCompactExport(src);
  assert.equal(JSON.stringify(src), snapshot);
});
