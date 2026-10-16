/**
 * 数据精简与百分比统一改造测试（2026-10-16）
 *
 * 覆盖：
 *  1) percentFormat.formatPct：正/负/零/空/异常值/重复格式化/舍入边界/指令示例五组数值；
 *  2) 百分比字段白名单 isPercentField（含金额/净值/日期等非比例字段排除）；
 *  3) validateHolding：profitRate 与约定口径 profit/amount 不一致告警、一致无告警、空值不告警；
 *  4) buildHoldingsTable：columns 与每行长度严格一致、百分比已格式化、空值 '—'、金额为数值；
 *  5) analysisPrompt（esbuild 即时编译 TS）：紧凑数据表块渲染、回退路径、百分比带符号；
 *  6) AI bundle 新鲜度：产物包含紧凑表渲染逻辑（防止忘记 npm run build:ai）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 沙箱安全：绝不触达云端库（环境可能注入 DATABASE_URL 指向生产 Neon）
delete process.env.DATABASE_URL;

const percentFormat = require('../services/percentFormat');
const { formatPct, isPercentField, looksFormatted, validateHolding } = percentFormat;

// ---------- 1) formatPct ----------

test('formatPct：指令示例五组数值（-0.0105 → -1.05% 等）', () => {
  assert.equal(formatPct(-0.0105), '-1.05%');
  assert.equal(formatPct(-0.020815), '-2.08%');
  assert.equal(formatPct(0.050847), '+5.08%');
  assert.equal(formatPct(-0.1566), '-15.66%');
  assert.equal(formatPct(-0.44918), '-44.92%');
});

test('formatPct：零值 / -0 / 极小值（不得输出 +0.00% 或 -0.00%）', () => {
  assert.equal(formatPct(0), '0.00%');
  assert.equal(formatPct(-0), '0.00%');
  assert.equal(formatPct(0.00001), '0.00%');
  assert.equal(formatPct(-0.00001), '0.00%');
  assert.equal(formatPct(0.000001), '0.00%');
});

test('formatPct：空值/异常值一律 —（禁止 0% 冒充未知）', () => {
  for (const v of [null, undefined, '', NaN, Infinity, -Infinity, 'abc', {}, Symbol ? undefined : null]) {
    if (v === undefined) continue; // Symbol 分支跳过
    assert.equal(formatPct(v), '—', `input=${String(v)}`);
  }
  assert.equal(formatPct(null), '—');
  assert.equal(formatPct(undefined), '—');
  assert.equal(formatPct(''), '—');
  assert.equal(formatPct(NaN), '—');
  assert.equal(formatPct(Infinity), '—');
  assert.equal(formatPct('abc'), '—');
});

test('formatPct：防重复格式化（已格式化字符串原样/补 + 返回，禁止二次乘 100）', () => {
  assert.equal(formatPct('-30.00%'), '-30.00%');   // 若二次转换会变 -3000.00%
  assert.equal(formatPct('5.08%'), '+5.08%');
  assert.equal(formatPct('+2.00%'), '+2.00%');
  assert.equal(formatPct('0.00%'), '0.00%');
  assert.equal(formatPct(' -15.66% '), '-15.66%');
});

test('formatPct：数字字符串与舍入边界', () => {
  assert.equal(formatPct('0.050847'), '+5.08%');
  assert.equal(formatPct(0.012345), '+1.23%');
  assert.equal(formatPct(-0.009999), '-1.00%');
  assert.equal(formatPct(1), '+100.00%');
  assert.equal(formatPct(-0.0105, { signed: false }), '-1.05%');
});

test('looksFormatted：识别已格式化字符串', () => {
  assert.equal(looksFormatted('-30.00%'), true);
  assert.equal(looksFormatted('+5.08%'), true);
  assert.equal(looksFormatted('5.08%'), true);
  assert.equal(looksFormatted(-0.020815), false);
  assert.equal(looksFormatted('5.08'), false);
  assert.equal(looksFormatted('abc%'), false);
});

// ---------- 2) 白名单 ----------

test('isPercentField：比例字段在白名单，金额/净值/日期/份额不在', () => {
  for (const f of ['todayChange', 'todayEstimate', 'profitRate', 'holdingRate', 'hold',
    'return1m', 'return3m', 'return6m', 'return1y',
    'maxDrawdown1y', 'drawdownFromHigh1y', 'volatility20d', 'relativeReturn1m']) {
    assert.equal(isPercentField(f), true, f);
  }
  for (const f of ['amount', 'cost', 'profit', 'todayProfit', 'nav', 'accNav', 'navDate',
    'shares', 'totalValue', 'equityCap', 'generatedAt', 'name']) {
    assert.equal(isPercentField(f), false, f);
  }
});

// ---------- 3) validateHolding ----------

test('validateHolding：profitRate 与约定口径 profit/amount 不一致 → 告警', () => {
  const w = validateHolding({ code: '013309', name: '易方达恒生科技C', amount: 11137.08, profit: -4773.40, profitRate: -0.30 });
  assert.equal(w.length, 1);
  assert.ok(w[0].includes('013309'));
  assert.ok(w[0].includes('-30.00%'));
  assert.ok(w[0].includes('-42.86%'));
});

test('validateHolding：一致口径 → 无告警；空值/缺字段 → 无告警不转 0%', () => {
  assert.deepEqual(validateHolding({ code: 'x', amount: 100, profit: -15.66, profitRate: -0.1566 }), []);
  // 容差内（<0.5 个百分点）
  assert.deepEqual(validateHolding({ code: 'x', amount: 100, profit: -15.66, profitRate: -0.158 }), []);
  // 空值
  assert.deepEqual(validateHolding({ code: 'x', amount: 100, profit: null, profitRate: -0.15 }), []);
  assert.deepEqual(validateHolding({ code: 'x', amount: null, profit: -1, profitRate: -0.01 }), []);
  assert.deepEqual(validateHolding(null), []);
  assert.deepEqual(validateHolding({}), []);
});

// ---------- 4) buildHoldingsTable ----------

const portfolioAnalysisService = require('../services/portfolioAnalysisService');
const { buildHoldingsTable, TABLE_COLUMNS } = portfolioAnalysisService;

function sampleHolding(overrides = {}) {
  return Object.assign({
    code: '013309',
    name: '易方达恒生科技C',
    amount: 11137.08,
    cost: 15910.48,
    profit: -4773.40,
    profitRate: -0.30,
    todayEstimate: 0.0097,
    navDate: '2026-10-15',
    performance: {
      return1m: -0.0573, return3m: -0.1450, return6m: -0.1802, return1y: -0.3567,
      maxDrawdown1y: -0.3653, drawdownFromHigh1y: -0.3653,
      volatility20d: 0.31, trend: 'down', dataAsOf: '2026-10-15', historyDays: 245
    },
    benchmark: {
      name: '恒生科技ETF(513180)', kind: 'auxiliary',
      return1m: -0.0252, return3m: null, relativeReturn1m: -0.0321, dataAsOf: '2026-10-15'
    },
    allocation: { role: 'sector', sector: '恒生科技', maxAmount: null, overlapWarning: null }
  }, overrides);
}

test('buildHoldingsTable：columns 与每行长度严格一致（契约）', () => {
  const table = buildHoldingsTable([sampleHolding(), sampleHolding({ code: '007339' })]);
  assert.equal(Array.isArray(table.columns), true);
  assert.equal(table.columns.length, TABLE_COLUMNS.length);
  for (const row of table.funds) {
    assert.equal(row.length, table.columns.length, `row length ${row.length} != columns ${table.columns.length}`);
  }
  // 关键列名与顺序
  assert.deepEqual(table.columns.slice(0, 6), ['code', 'name', 'amount', 'cost', 'profit', 'profitPct']);
  assert.deepEqual(table.columns.slice(7, 14), ['ret1m', 'ret3m', 'ret6m', 'ret1y', 'mdd', 'ddHigh', 'trend']);
});

test('buildHoldingsTable：百分比已格式化（带符号两位小数）、空值 —、金额为数值', () => {
  const row = buildHoldingsTable([sampleHolding()]).funds[0];
  const col = name => TABLE_COLUMNS.indexOf(name);
  assert.equal(row[col('code')], '013309');
  assert.equal(row[col('amount')], 11137.08);          // 数值，禁止百分比化
  assert.equal(row[col('cost')], 15910.48);
  assert.equal(row[col('profit')], -4773.40);
  assert.equal(row[col('profitPct')], '-30.00%');
  assert.equal(row[col('todayPct')], '+0.97%');
  assert.equal(row[col('ret1m')], '-5.73%');
  assert.equal(row[col('ret1y')], '-35.67%');
  assert.equal(row[col('mdd')], '-36.53%');
  assert.equal(row[col('ddHigh')], '-36.53%');
  assert.equal(row[col('trend')], 'down');
  assert.equal(row[col('navDate')], '2026-10-15');
  assert.equal(row[col('bench')], '恒生科技ETF(513180)');
  assert.equal(row[col('rel1m')], '-3.21%');
});

test('buildHoldingsTable：数据缺失 → ' + "— 与空串（不伪造、不默认沪深300）", () => {
  const row = buildHoldingsTable([sampleHolding({
    todayEstimate: null, navDate: null,
    performance: { trend: 'unknown', dataAsOf: null },
    benchmark: { name: null, return1m: null, return3m: null, relativeReturn1m: null, dataAsOf: null }
  })]).funds[0];
  const col = name => TABLE_COLUMNS.indexOf(name);
  assert.equal(row[col('todayPct')], '—');
  assert.equal(row[col('ret1m')], '—');
  assert.equal(row[col('ret3m')], '—');
  assert.equal(row[col('mdd')], '—');
  assert.equal(row[col('trend')], 'unknown');
  assert.equal(row[col('navDate')], '');
  assert.equal(row[col('bench')], '');
  assert.equal(row[col('rel1m')], '—');
});

test('buildHoldingsTable：date 为上海时区 YYYY-MM-DD', () => {
  const table = buildHoldingsTable([]);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(table.date), table.date);
  assert.deepEqual(table.funds, []);
});

// ---------- 5) analysisPrompt（TS 即时编译） ----------

async function compileAnalysisPrompt() {
  const esbuild = require('esbuild');
  const outfile = path.join(os.tmpdir(), `analysisPrompt-test-${process.pid}-${Date.now()}.js`);
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../../src/services/ai/analysisPrompt.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  });
  return { mod: require(outfile), cleanup: () => { try { fs.unlinkSync(outfile); } catch (e) {} } };
}

test('analysisPrompt：analysisTable 存在 → 渲染紧凑数据表，不再输出逐基金冗长块', async () => {
  const { mod, cleanup } = await compileAnalysisPrompt();
  try {
    const table = buildHoldingsTable([sampleHolding()]);
    const prompt = mod.buildAnalysisPrompt({
      account: { name: '养基宝-权益', totalValue: 96249.59 },
      strategies: ['沪深300作为核心宽基 持仓不超过2万'],
      analysisTable: table,
      holdings: [sampleHolding()],
      portfolioSummary: { equityCap: 100000, coreIndex: '007339', coreIndexCap: 20000, recoveryTarget: 15000, recoveryHorizonMonths: 12 }
    });
    assert.ok(prompt.includes('【持仓数据表'), '应包含紧凑数据表块');
    assert.ok(prompt.includes('columns: code,name,amount,cost,profit,profitPct,todayPct,ret1m,ret3m,ret6m,ret1y,mdd,ddHigh,trend,navDate,bench,rel1m'));
    assert.ok(prompt.includes('013309 | 易方达恒生科技C | 11137.08 | 15910.48 | -4773.4 | -30.00% | +0.97%'));
    assert.ok(prompt.includes('-36.53%'));
    assert.ok(!prompt.includes('【量化表现'), '紧凑模式下不得再输出旧版逐基金 performance 块');
    assert.ok(!prompt.includes('【业绩基准对比'), '紧凑模式下不得再输出旧版逐基金 benchmark 块');
    // 策略目标不丢失
    assert.ok(prompt.includes('沪深300作为核心宽基 持仓不超过2万'));
    assert.ok(prompt.includes('¥20,000') || prompt.includes('20000'));
    assert.ok(prompt.includes('回本目标'));
  } finally {
    cleanup();
  }
});

test('analysisPrompt：analysisTable 缺失 → 回退旧版逐基金文本块（兼容客户端自带 portfolio）', async () => {
  const { mod, cleanup } = await compileAnalysisPrompt();
  try {
    const prompt = mod.buildAnalysisPrompt({
      account: { name: '本地', totalValue: 1000 },
      holdings: [sampleHolding()]
    });
    assert.ok(prompt.includes('【量化表现'), '回退路径应保留旧版块');
    assert.ok(prompt.includes('【业绩基准对比'));
    // 回退路径 fmtPct 也遵循带符号两位小数规范
    assert.ok(prompt.includes('-30.00%'));
    assert.ok(prompt.includes('+5.08%') || prompt.includes('+0.97%'));
  } finally {
    cleanup();
  }
});

// ---------- 6) AI bundle 新鲜度 ----------

test('AI bundle：产物包含紧凑数据表渲染（防止遗漏 npm run build:ai）', () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '../services/ai/index.js'), 'utf8');
  // esbuild 默认把非 ASCII 转成 \uXXXX，故只断言 ASCII 标识符
  assert.ok(bundle.includes('analysisTable'), 'bundle 应读取 analysisTable 字段');
  assert.ok(bundle.includes('analysisHoldingsTable_exports') || bundle.includes('rel1m'), 'bundle 应包含基准超额列说明');
  assert.ok(bundle.includes('columns'), 'bundle 应包含 columns 渲染逻辑');
});
