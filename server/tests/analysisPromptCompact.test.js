// AI 输入紧凑格式回归测试（2026-10-21）：
// 同构对象数组 → { columns, rows }（AI 专用适配层，仅影响发给 AI 的 prompt；
// 导出 JSON / 外部 API / 前端结构不变）。全程纯内存，不连接任何数据库。
const test = require('node:test');
const assert = require('node:assert');

// AI bundle 为纯函数集合，直接 require（不触库、不发网络请求）
const ai = require('../services/ai/index.js');
const { toCompactRows, buildCompactDataBlocks, buildAnalysisPrompt } = ai;

// ─────────────────────────────────────────────
// 模拟数据：贴近真实结构（小数比率、null 缺失、0/false 有效值、字符串明细）
// ─────────────────────────────────────────────
function mockHolding(over = {}) {
  return Object.assign({
    code: '007339',
    name: '易方达沪深300ETF联接C',
    amount: 13041.93,
    cost: 14299.08,
    profit: -1257.15,
    profitRate: -0.0879,
    todayEstimate: -0.0058,
    type: '基金',
    direction: 'A股宽基',
    performance: {
      return1m: -0.073646, return3m: -0.086371, return6m: -0.104295, return1y: -0.058466,
      maxDrawdown1y: -0.159719, drawdownFromHigh1y: -0.159719, volatility20d: 0.12849,
      trend: 'down', dataAsOf: '2026-10-20', historyDays: 400
    },
    benchmark: {
      name: '沪深300指数', kind: 'auxiliary',
      return1m: -0.089844, return3m: -0.123877, return6m: -0.121859, return1y: null,
      relativeReturn1m: 0.016198, relativeReturn6m: 0.017564, relativeReturn1y: null,
      dataAsOf: '2026-10-21'
    },
    allocation: { role: 'core', sector: 'A股宽基', maxAmount: 20000, overlapWarning: false },
    topHoldings: '宁德时代(0.04%), 贵州茅台(0.02%)',
    overlapDetail: '中金黄金:本5.85%/彼010827 5.85%'
  }, over);
}

function mockPortfolio() {
  return [
    mockHolding(),
    mockHolding({ code: '018147', name: '建信新兴市场混合(QDII)C', benchmark: null, allocation: { role: 'unknown', sector: '全球科技', maxAmount: null, overlapWarning: true } }),
    mockHolding({ code: '019633', name: '国泰半导体设备ETF联接C', topHoldings: null, overlapDetail: null,
      allocation: { role: 'unknown', sector: '半导体设备', maxAmount: null, overlapWarning: null },
      performance: { return1m: -0.2, return3m: null, return6m: 0.25, return1y: 0.58, maxDrawdown1y: null, drawdownFromHigh1y: null, volatility20d: 0.37, trend: 'unknown', dataAsOf: null, historyDays: 0 } })
  ];
}

// ─────────────────────────────────────────────
// 1) toCompactRows：转换正确性 / 行列对齐 / 缺失值语义
// ─────────────────────────────────────────────
test('toCompactRows：每行长度恒等于 columns.length，列顺序与 specs 一致', () => {
  const items = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3 }];
  const specs = [{ key: 'a', value: o => o.a }, { key: 'b', value: o => o.b }];
  const t = toCompactRows(items, specs);
  assert.deepEqual(t.columns, ['a', 'b']);
  assert.equal(t.rows.length, 3);
  for (const row of t.rows) assert.equal(row.length, t.columns.length);
  assert.deepEqual(t.rows[0], [1, 'x']);
  assert.deepEqual(t.rows[1], [2, 'y']);
  assert.deepEqual(t.rows[2], [3, null]); // 缺失 → null，不删格
});

test('toCompactRows：null/0/false/空串 保留原样，undefined → null，互不混淆', () => {
  const t = toCompactRows(
    [{ a: null, b: 0, c: false, d: '', e: undefined, f: -0.0736 }],
    ['a', 'b', 'c', 'd', 'e', 'f'].map(k => ({ key: k, value: o => o[k] }))
  );
  assert.deepEqual(t.rows[0], [null, 0, false, '', null, -0.0736]);
});

test('toCompactRows：null 输入 / 空数组 → columns 保留、rows 为空', () => {
  const specs = [{ key: 'x', value: () => 1 }];
  assert.deepEqual(toCompactRows(null, specs), { columns: ['x'], rows: [] });
  assert.deepEqual(toCompactRows(undefined, specs), { columns: ['x'], rows: [] });
  assert.deepEqual(toCompactRows([], specs), { columns: ['x'], rows: [] });
});

// ─────────────────────────────────────────────
// 2) buildCompactDataBlocks：块结构 / 单位换算 / 字段不丢失
// ─────────────────────────────────────────────
test('buildCompactDataBlocks：5 个块齐全，所有行长度 === columns.length，关键字段无丢失', () => {
  const blocks = buildCompactDataBlocks(mockPortfolio());
  for (const name of ['holdings', 'performance', 'allocation', 'holdingsDetail']) {
    const t = blocks[name];
    assert.ok(t && Array.isArray(t.columns) && t.columns.length > 0, `${name} 块缺失`);
    for (const row of t.rows) assert.equal(row.length, t.columns.length, `${name} 行列错位`);
  }
  const h = blocks.holdings;
  assert.deepEqual(h.columns, ['code', 'name', 'amount', 'cost', 'profit', 'profitRatePct', 'todayEstimatePct', 'direction']);
  const r0 = h.rows.find(r => r[0] === '007339');
  assert.deepEqual(r0, ['007339', '易方达沪深300ETF联接C', 13041.93, 14299.08, -1257.15, -8.79, -0.58, 'A股宽基']);
  // 持仓代码全部在各个块中出现（不允许丢基金）
  const codes = ['007339', '018147', '019633'];
  for (const name of ['holdings', 'performance', 'allocation', 'holdingsDetail']) {
    const col0 = blocks[name].rows.map(r => r[0]);
    for (const c of codes) assert.ok(col0.includes(c), `${name} 块丢失基金 ${c}`);
  }
});

test('buildCompactDataBlocks：百分数换算 = 小数×100 保留 2 位；null 缺失保持 null', () => {
  const blocks = buildCompactDataBlocks(mockPortfolio());
  const perf = blocks.performance;
  const r0 = perf.rows.find(r => r[0] === '007339');
  assert.equal(perf.columns[1], 'return1mPct');
  assert.equal(r0[1], -7.36);        // -0.073646 → -7.36（百分数数值，非小数、非字符串）
  assert.equal(r0[6], -15.97);       // maxDrawdown1yPct
  const r2 = perf.rows.find(r => r[0] === '019633');
  assert.equal(r2[2], null);         // return3m 缺失 → null
  assert.equal(r2[6], null);         // maxDrawdown1y 缺失 → null（绝不变 0）
  assert.equal(r2[9], null);         // dataAsOf 缺失 → null
  assert.equal(r2[10], 0);           // historyDays=0 是有效值，不得当缺失
});

test('buildCompactDataBlocks：benchmark 仅含已配置基准的基金；全部未配置 → null', () => {
  const blocks = buildCompactDataBlocks(mockPortfolio());
  assert.ok(blocks.benchmark, '有配置基准时 benchmark 块应存在');
  // 018147 benchmark=null → 不进块（007339 与 019633 有基准）
  assert.deepEqual(blocks.benchmark.rows.map(r => r[0]), ['007339', '019633']);
  const none = buildCompactDataBlocks([mockHolding({ benchmark: null })]);
  assert.equal(none.benchmark, null);
});

test('buildCompactDataBlocks：0/false 有效值保留；allocation role 译中文、maxAmount=null 保留', () => {
  const blocks = buildCompactDataBlocks(mockPortfolio());
  const a0 = blocks.allocation.rows.find(r => r[0] === '007339');
  assert.equal(a0[1], '核心宽基');
  assert.equal(a0[3], 20000);
  assert.equal(a0[4], false); // overlapWarning=false 有效，不得删
  const a1 = blocks.allocation.rows.find(r => r[0] === '018147');
  assert.equal(a1[1], '未确认');
  assert.equal(a1[3], null);
  assert.equal(a1[4], true);
  const a2 = blocks.allocation.rows.find(r => r[0] === '019633');
  assert.equal(a2[4], null);  // 数据不足未判定
});

// ─────────────────────────────────────────────
// 3) buildAnalysisPrompt：紧凑块进入 prompt、读取规则与数据警告可见
// ─────────────────────────────────────────────
test('buildAnalysisPrompt：无表路径渲染 columns+rows 紧凑块 + 读取规则', () => {
  const prompt = buildAnalysisPrompt({
    account: { name: '养基宝-权益', totalValue: 92550.36 },
    strategies: ['权益持仓不超过10万元'],
    holdings: mockPortfolio(),
    dataWarnings: ['007339 易方达沪深300ETF联接C: 已配置基准但基准历史不足一年']
  });
  assert.ok(prompt.includes('"columns"'));
  assert.ok(prompt.includes('"rows"'));
  assert.ok(prompt.includes('columns[i] 对应每行第 i 个值'));
  assert.ok(prompt.includes('百分数数值'));
  assert.ok(prompt.includes('null=数据缺失'));
  assert.ok(prompt.includes('数据质量警告'));
  assert.ok(prompt.includes('已配置基准但基准历史不足一年'));
  // 关键基金与字段未丢失
  assert.ok(prompt.includes('007339'));
  assert.ok(prompt.includes('profitRatePct'));
  assert.ok(prompt.includes('maxDrawdown1yPct'));
  // 行值与列数严格一致：解析每个 JSON 块校验
  const jsonTables = prompt.match(/\{"columns":\[[^\n]+\}/g) || [];
  assert.ok(jsonTables.length >= 4, `紧凑块数量不足: ${jsonTables.length}`);
  for (const s of jsonTables) {
    const t = JSON.parse(s);
    assert.ok(Array.isArray(t.columns) && Array.isArray(t.rows));
    for (const row of t.rows) assert.equal(row.length, t.columns.length);
  }
});

test('buildAnalysisPrompt：有表路径保留服务端紧凑表，allocation 改为紧凑块且 dataWarnings 渲染', () => {
  const prompt = buildAnalysisPrompt({
    account: { name: '养基宝-权益' },
    strategies: [],
    analysisTable: { columns: ['code', 'name', 'profitPct'], funds: [['007339', '易方达沪深300ETF联接C', '-8.79']] },
    holdings: mockPortfolio(),
    dataWarnings: ['019633: 收益率缺少对应净值日期']
  });
  assert.ok(prompt.includes('持仓数据表'));
  assert.ok(prompt.includes('code | name | profitPct'));
  assert.ok(prompt.includes('基金角色与仓位上限（allocation）'));
  assert.ok(prompt.includes('"columns"')); // allocation 紧凑块
  assert.ok(prompt.includes('数据质量警告'));
  assert.ok(!prompt.includes('【当前持仓（金额 / 成本 / 盈亏 / 今日）】')); // 旧冗长块已移除
});

// ─────────────────────────────────────────────
// 4) 压缩效果：同一份模拟数据，旧版对象数组 vs 新版紧凑块（JSON.stringify 长度对比）
// ─────────────────────────────────────────────
test('压缩效果：新版紧凑块序列化长度 < 旧版对象数组（以测试输出为准，不预设比例）', () => {
  const holdings = Array.from({ length: 10 }, (_, i) => mockHolding({ code: `00${600 + i}` }));
  const oldJson = JSON.stringify(holdings);
  const blocks = buildCompactDataBlocks(holdings);
  const newJson = JSON.stringify(blocks);
  // 粗略 Token 估算：中文约 1 token/字，ASCII 约 4 字符/token，统一按字符数报告
  console.log(`[压缩对比] 旧版(对象数组) ${oldJson.length} 字符 ≈ ${Math.round(oldJson.length / 3)} tokens；新版(columns+rows) ${newJson.length} 字符 ≈ ${Math.round(newJson.length / 3)} tokens；原始压缩比 ${(newJson.length / oldJson.length * 100).toFixed(1)}%`);
  assert.ok(newJson.length < oldJson.length, '新版序列化必须短于旧版');
});
