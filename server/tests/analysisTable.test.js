// 收敛改造回归测试（2026-10-16）：
// 1) f43 精度：fltt=2 直读格式化浮点，禁止 ETF 价格放大 10 倍（生产事故 7.391442 根因）
// 2) profitRate 统一成本口径 profit/cost（与 Web/mp1 持仓页 holdingRate 一致）
// 3) sync 账户策略合并（user_data 为准，缺失如实 []）
// 4) 紧凑 AI 数据表 + Prompt 双路径（有表紧凑 / 无表回退）
// 全程只用内存桩，不连接任何数据库（含本地 sqlite）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// —— 先打桩，再 require 被测模块 ——
const fundService = require('../services/fundService');
const navService = require('../services/navService');
const portfolioService = require('../services/portfolioService');
const accountStateService = require('../services/accountStateService');
const providerEstimate = require('../services/providerEstimate');
const estimateEngine = require('../services/estimateEngine');
const dbAsync = require('../database/dbAsync');
const fundMetricsService = require('../services/fundMetricsService');

fundService.getFund = async (code) => ({ fund_name: `F${code}`, fund_type: '基金' });
navService.getHistory = async () => [{ date: '2024-01-01', nav: 1 }, { date: '2024-01-02', nav: 1.01 }];
navService.getLatestPair = async () => [{ date: '2024-01-02', nav: 1.01 }, { date: '2024-01-02', nav: 1 }];
providerEstimate.fetchProviderEstimate = async () => ({ estimate_change: 0.01 });
estimateEngine.calculateFundEstimate = async () => ({ estimate_change: 0.005 });
dbAsync.all = async () => []; // computeAccountOverlap 走内存桩，绝不触库

let syncAccounts = [];
let savedState = { active: '手动账户', accounts: {} };
portfolioService.listSyncedAccounts = async () => syncAccounts;
accountStateService.getUserState = async () => savedState;

fundMetricsService.getPerformanceHistory = async () => [
  { date: '2024-01-01', nav: 1 }, { date: '2024-01-02', nav: 1.01 }
];
fundMetricsService.getBenchmarkMetrics = async () => ({
  name: null, return1m: null, return3m: null, relativeReturn1m: null,
  dataAsOf: null, kind: null, source: null, unavailableReason: null
});

const portfolioAnalysisService = require('../services/portfolioAnalysisService');
const marketService = require('../services/marketService');

// ---------------------------------------------------------------------------
test('formatPctCell：正/负/零/空/字符串防重复格式化', () => {
  const f = portfolioAnalysisService.formatPctCell;
  assert.equal(f(-0.0105), '-1.05%');
  assert.equal(f(-0.020815), '-2.08%');
  assert.equal(f(0.050847), '+5.08%');
  assert.equal(f(-0.1566), '-15.66%');
  assert.equal(f(-0.44918), '-44.92%');
  assert.equal(f(0), '0.00%');
  assert.equal(f(null), '—');
  assert.equal(f(undefined), '—');
  assert.equal(f(''), '—');
  assert.equal(f(NaN), '—');
  assert.equal(f(Infinity), '—');
  assert.equal(f('-2.08%'), '-2.08%'); // 已格式化字符串原样透传，禁止二次转换
  assert.equal(f(0.000001), '0.00%');   // 舍入为 0 → 0.00%，不出 +0.00%
});

test('buildAnalysisTable：列数一致、行严格对齐 columns、空值 —', () => {
  const holdings = [{
    code: '013309', name: '易方达恒生科技C', amount: 11137.08, cost: 15910.48,
    profit: -4773.40, profitRate: -0.30, todayEstimate: 0.0097,
    performance: {
      return1m: -0.0573, return3m: -0.1450, return6m: -0.1802, return1y: -0.3567,
      maxDrawdown1y: -0.3653, drawdownFromHigh1y: -0.3653, trend: 'down', dataAsOf: '2026-10-15'
    },
    benchmark: { relativeReturn1m: -0.0321 },
    allocation: { role: 'sector', sector: '恒生科技', maxAmount: null, overlapWarning: null }
  }, {
    code: '007339', name: '易方达沪深300ETF联接C', amount: 18500, cost: 0, profit: 500,
    profitRate: null, todayEstimate: null,
    performance: {}, benchmark: {}, allocation: {}
  }];
  const table = portfolioAnalysisService.buildAnalysisTable(holdings);
  assert.deepEqual(table.columns, [
    'code', 'name', 'amount', 'cost', 'profit', 'profitPct', 'todayPct',
    '1m', '3m', '6m', '1y', 'mdd', 'ddHigh', 'trend', 'rel1m', 'rel6m', 'rel1y',
    'navDate', 'topHoldings', 'overlapDetail'
  ]);
  assert.equal(table.funds.length, 2);
  for (const row of table.funds) assert.equal(row.length, table.columns.length);
  const r0 = table.funds[0];
  assert.equal(r0[0], '013309');
  assert.equal(r0[5], '-30.00%');   // profitPct（成本口径预格式化）
  assert.equal(r0[6], '+0.97%');    // todayPct
  assert.equal(r0[7], '-5.73%');    // 1m
  assert.equal(r0[14], '-3.21%');   // rel1m
  assert.equal(r0[15], '—');        // rel6m（stub 未提供 → —）
  assert.equal(r0[16], '—');        // rel1y
  assert.equal(r0[17], '2026-10-15'); // navDate
  assert.equal(r0[18], '无数据');   // topHoldings 缺失 → 明确标注，不冒充
  assert.equal(r0[19], '无数据');   // overlapDetail 缺失 → 明确标注
  const r1 = table.funds[1];
  assert.equal(r1[5], '—');   // profitRate=null → —，禁止 0.00% 冒充
  assert.equal(r1[7], '—');
  assert.equal(r1[13], 'unknown');
  assert.equal(r1[17], '');
});

test('buildAnalysisTable：topHoldings/overlapDetail 有数据时原样透传（不重复格式化）', () => {
  const holdings = [{
    code: '007339', name: '易方达沪深300ETF联接C', amount: 100, cost: 100, profit: 0,
    performance: {}, benchmark: { relativeReturn6m: 0.031 },
    topHoldings: '贵州茅台 5.2%、宁德时代 3.1%',
    overlapDetail: '贵州茅台:本5.2%/彼013309 3.1%'
  }];
  const table = portfolioAnalysisService.buildAnalysisTable(holdings);
  const row = table.funds[0];
  assert.equal(row[15], '+3.10%');  // rel6m 数值 → 格式化为百分数
  assert.equal(row[18], '贵州茅台 5.2%、宁德时代 3.1%'); // 摘要串原样透传
  assert.equal(row[19], '贵州茅台:本5.2%/彼013309 3.1%'); // 明细串原样透传（服务端已保证无 | 分隔符）
});

test('formatOverlapDetail：空/缺失 → null；多条 → 「；」分隔且不含表格分隔符', () => {
  const f = portfolioAnalysisService.formatOverlapDetail;
  assert.equal(f(null), null);
  assert.equal(f(undefined), null);
  assert.equal(f([]), null);
  const s = f([
    { stockCode: '600519', stockName: '贵州茅台', minePct: 5.2, otherCode: '013309', otherPct: 3.1 },
    { stockCode: '300750', stockName: '宁德时代', minePct: 3.0, otherCode: '013309', otherPct: 6.0 }
  ]);
  assert.equal(s, '贵州茅台:本5.2%/彼013309 3.1%；宁德时代:本3%/彼013309 6%');
  assert.ok(!s.includes('|'));
});

test('buildDataWarnings：profitRate null / 基准不可用 / 策略缺失 如实报告', () => {
  const portfolio = {
    strategies: [],
    holdings: [
      { code: '1', name: 'A', profitRate: null, benchmark: { unavailableReason: 'benchmark_series_scale_anomaly' }, performance: { return1m: -0.01, dataAsOf: null } }
    ]
  };
  const w = portfolioAnalysisService.buildDataWarnings(portfolio);
  assert.equal(w.length, 4); // profitRate=null、基准不可用、dataAsOf 缺失、策略缺失
  assert.ok(w[0].includes('盈亏率不可用'));
  assert.ok(w[1].includes('benchmark_series_scale_anomaly'));
  assert.ok(w[2].includes('dataAsOf=null'));
  const clean = portfolioAnalysisService.buildDataWarnings({ strategies: ['x'], holdings: [] });
  assert.equal(clean.length, 0);
});

test('loadUserAccounts：sync 账户合并 user_data 策略；缺失时如实 []', async () => {
  syncAccounts = [{
    name: '养基宝-权益', source_name: 'yangjibao', strategy: [], closedPositions: [],
    funds: [{ code: '013309', amount: 1000, holdingProfit: -100, holdingRate: -0.1, cost: 1100, today: 0 }]
  }];
  savedState = {
    active: '养基宝-权益',
    accounts: {
      '养基宝-权益': { accountType: 'sync', strategy: ['沪深300作为核心宽基 持仓不超过2万', '一年以内回本15000元'], targetRecovery: 15000, maxFunds: 10 }
    }
  };
  let accounts = await portfolioAnalysisService.loadUserAccounts(1);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].source, 'sync');
  assert.equal(accounts[0].strategy.length, 2);           // user_data 策略被合并
  assert.equal(accounts[0].targetRecovery, 15000);
  assert.equal(accounts[0].maxFunds, 10);
  // user_data 无该账户（换名/未保存）→ 保持 []，不伪造
  savedState = { active: 'x', accounts: {} };
  accounts = await portfolioAnalysisService.loadUserAccounts(1);
  assert.deepEqual(accounts[0].strategy, []);
  assert.equal(accounts[0].targetRecovery, undefined);
});

test('buildAnalysisPortfolio：profitRate 成本口径 profit/cost（同源 AI 与导出）', async () => {
  syncAccounts = [];
  savedState = {
    active: '手动账户',
    accounts: {
      '手动账户': {
        accountType: 'local', name: '手动账户',
        strategy: ['权益持仓不超过10万元'],
        funds: [
          { code: '019633', amount: 1936.00, cost: 6707.00, holdingProfit: -4771.00, today: 0.01 },
          { code: '013309', amount: 11137.08, cost: 15910.48, holdingProfit: -4773.40, today: 0.02 }
        ]
      }
    }
  };
  const portfolio = await portfolioAnalysisService.buildAnalysisPortfolio(1, { accountId: '手动账户', timeoutMs: 5000 });
  const h0 = portfolio.holdings.find(x => x.code === '019633');
  const h1 = portfolio.holdings.find(x => x.code === '013309');
  // 成本口径：-4771/6707 ≈ -0.7114（旧市值口径会得出 -2.4645）
  assert.ok(Math.abs(h0.profitRate - (-4771 / 6707)) < 1e-6, `profitRate=${h0.profitRate}`);
  assert.ok(Math.abs(h1.profitRate - (-4773.40 / 15910.48)) < 1e-6);
  // 紧凑表随 portfolio 输出，且行内 profitPct 与 profitRate 同源
  assert.ok(portfolio.analysisTable && portfolio.analysisTable.funds.length === 2);
  const row0 = portfolio.analysisTable.funds[0];
  assert.equal(row0[0], '019633');
  assert.equal(row0[5], '-71.13%');
});

test('buildAnalysisPortfolio：前十大重仓摘要与重合明细从 fund_holdings 传入 AI 输入', async () => {
  syncAccounts = [];
  savedState = {
    active: '手动账户',
    accounts: {
      '手动账户': {
        accountType: 'local', name: '手动账户', strategy: ['x'],
        funds: [
          { code: '019633', amount: 1000, cost: 1000, holdingProfit: 0, today: 0 },
          { code: '013309', amount: 1000, cost: 1000, holdingProfit: 0, today: 0 }
        ]
      }
    }
  };
  // 临时接管 dbAsync.all：返回真实形状的 fund_holdings 行（019633 与 013309 在贵州茅台重合）
  const realAll = dbAsync.all;
  dbAsync.all = async (sql, params) => {
    if (/FROM fund_holdings/i.test(sql)) {
      assert.deepEqual([...params].sort(), ['013309', '019633']);
      return [
        { fund_code: '019633', stock_code: '600519', stock_name: '贵州茅台', weight: 0.052, report_date: '2026-09-30' },
        { fund_code: '019633', stock_code: '000001', stock_name: '平安银行', weight: 0.031, report_date: '2026-09-30' },
        { fund_code: '013309', stock_code: '600519', stock_name: '贵州茅台', weight: 0.048, report_date: '2026-09-30' }
      ];
    }
    return [];
  };
  try {
    const portfolio = await portfolioAnalysisService.buildAnalysisPortfolio(1, { accountId: '手动账户', timeoutMs: 8000 });
    const h0 = portfolio.holdings.find(x => x.code === '019633');
    const h1 = portfolio.holdings.find(x => x.code === '013309');
    // 前十大摘要（weight<1 自动 ×100，降序）
    assert.equal(h0.topHoldings, '贵州茅台 5.2%、平安银行 3.1%');
    // 重合明细：贵州茅台双方均 ≥3% → 一条明细
    assert.equal(h0.overlapDetail, '贵州茅台:本5.2%/彼013309 4.8%');
    assert.equal(h1.overlapDetail, '贵州茅台:本4.8%/彼019633 5.2%');
    // 紧凑表新列承载（rel6m=15 / rel1y=16 / topHoldings=18 / overlapDetail=19）
    const row0 = portfolio.analysisTable.funds.find(r => r[0] === '019633');
    assert.equal(row0[18], '贵州茅台 5.2%、平安银行 3.1%');
    assert.equal(row0[19], '贵州茅台:本5.2%/彼013309 4.8%');
    // 历史绩效仍存在（performance/historySummary 不被新字段挤掉）
    assert.ok(h0.performance && 'return1m' in h0.performance);
    assert.ok(typeof h0.historySummary === 'string');
  } finally {
    dbAsync.all = realAll;
  }
  // 无持仓数据（db 返回空）→ topHoldings/overlapDetail 如实 null，不冒充
  dbAsync.all = async () => [];
  const emptyPortfolio = await portfolioAnalysisService.buildAnalysisPortfolio(1, { accountId: '手动账户', timeoutMs: 8000 });
  const eh0 = emptyPortfolio.holdings.find(x => x.code === '019633');
  assert.equal(eh0.topHoldings, null);
  assert.equal(eh0.overlapDetail, null);
  const emptyRow = emptyPortfolio.analysisTable.funds.find(r => r[0] === '019633');
  assert.equal(emptyRow[18], '无数据');
  assert.equal(emptyRow[19], '无数据');
});

// ---------------------------------------------------------------------------
// marketService f43 精度（fltt=2 直读，禁止 /100 放大 ETF 价格）
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
function stubFetchOnce(respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => respond(String(url))
    };
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test('fetchStockQuote：fltt=2 下 ETF 3 位小数价格直读不放大', async () => {
  const calls = stubFetchOnce((url) => {
    assert.ok(url.includes('fltt=2'), `请求必须带 fltt=2，实际 ${url}`);
    return JSON.stringify({ data: { f12: '159915', f14: '创业板ETF易方达', f43: 2.789, f57: '159915', f58: '创业板ETF易方达', f170: -0.61 } });
  });
  const q = await marketService.fetchStockQuote('159915');
  assert.ok(calls.length >= 1);
  assert.equal(q.price, 2.789);              // 旧逻辑 /100 会得出 27.89（10 倍污染）
  assert.ok(Math.abs(q.change_percent - -0.0061) < 1e-9); // -0.61% → 小数比例
});

test('fetchStockQuote：fltt=2 下股票 2 位小数价格同样直读', async () => {
  stubFetchOnce(() => JSON.stringify({ data: { f12: '600519', f14: '贵州茅台', f43: 1329.00, f57: '600519', f58: '贵州茅台', f170: 1.22 } }));
  const q = await marketService.fetchStockQuote('600519');
  assert.equal(q.price, 1329.00);            // 旧逻辑 /100 会得出 13.29
  assert.ok(Math.abs(q.change_percent - 0.0122) < 1e-9);
});

test('fetchIndexQuotes：指数价格 fltt=2 直读', async () => {
  stubFetchOnce(() => JSON.stringify({ data: { f12: '000300', f14: '沪深300', f43: 3956.12, f57: '000300', f58: '沪深300', f170: 0.35 } }));
  const rows = await marketService.fetchIndexQuotes(true);
  const hs300 = rows.find(r => r.name === '沪深300' || r.price === 3956.12);
  assert.ok(hs300, '应包含沪深300行');
  assert.equal(hs300.price, 3956.12);
  assert.ok(Math.abs(hs300.changePercent - 0.0035) < 1e-9);
});

// ---------------------------------------------------------------------------
// AI bundle 双路径（文本级新鲜度检查：防止遗漏 npm run build:ai）
// ---------------------------------------------------------------------------
test('AI bundle：含紧凑数据表路径 + 保留无表回退路径', () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '../services/ai/index.js'), 'utf8');
  assert.ok(bundle.includes('持仓数据表'), 'bundle 应包含紧凑数据表标题');
  assert.ok(bundle.includes('analysisTable'), 'bundle 应读取 analysisTable 字段');
  assert.ok(bundle.includes('profitPct=盈亏率(成本口径=盈亏/成本)'), 'bundle 应包含成本口径列说明');
  assert.ok(bundle.includes('严禁编造或重复换算'), '应禁止 AI 重复换算百分比');
  // 回退路径（客户端自带 portfolio、无 analysisTable 时仍可用）
  assert.ok(bundle.includes('【当前持仓（金额 / 成本 / 盈亏 / 今日）】'), '应保留旧结构回退');
  assert.ok(bundle.includes('【量化表现（performance'), '应保留 performance 回退块');
  assert.ok(bundle.includes('【业绩基准对比（benchmark'), '应保留 benchmark 回退块');
});
