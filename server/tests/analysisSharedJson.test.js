// 统一标准 JSON + 5 分钟跨请求共享缓存回归（2026-10-21）：
// 1) 标准紧凑 JSON（holdingColumns/holdingRows）与 analysisTable 同源、行列严格对齐；
// 2) 内部 AI（useActive）与外部 AI（account）命中同一份缓存 JSON；
// 3) single-flight 并发只构建一次；失败不污染缓存；不同用户/账户不串数据；
// 4) 策略/持仓/净值版本变化立即换键重建（不等 5 分钟）；
// 5) 标准 JSON 体积显著小于旧 enrichedHoldings 手工装配。
// 全程只用内存桩，不连接任何数据库（含本地 sqlite）。
const test = require('node:test');
const assert = require('node:assert');

delete process.env.DATABASE_URL;

// —— 先打桩，再 require 被测模块（portfolioAnalysisService 顶层解构绑定）——
const fundService = require('../services/fundService');
const navService = require('../services/navService');
const portfolioService = require('../services/portfolioService');
const accountStateService = require('../services/accountStateService');
const providerEstimate = require('../services/providerEstimate');
const estimateEngine = require('../services/estimateEngine');
const dbAsync = require('../database/dbAsync');
const fundMetricsService = require('../services/fundMetricsService');

let estimateCalls = 0;
providerEstimate.fetchProviderEstimate = async () => { estimateCalls += 1; return { estimate_change: 0.01 }; };
estimateEngine.calculateFundEstimate = async () => ({ estimate_change: 0.005 });
navService.getHistory = async () => [];
navService.getLatestPair = async () => [{ date: '2026-01-02', nav: 1.01 }, { date: '2026-01-01', nav: 1 }];
fundService.getFund = async (code) => ({ fund_name: `F${code}`, fund_type: '基金' });
dbAsync.all = async () => []; // computeAccountOverlap 内存桩

// 数据版本桩（getOrBuildAnalysisData 缓存键的两个 MAX 查询）
let navVersion = '2026-01-02';
let holdVersion = '2026-06-30';
dbAsync.get = async (sql) => {
  if (sql.includes('fund_nav')) return { d: navVersion };
  if (sql.includes('fund_holdings')) return { d: holdVersion };
  return { d: null };
};

let historyRows = [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-02', nav: 1.01 }];
fundMetricsService.getPerformanceHistory = async () => historyRows;
fundMetricsService.getBenchmarkMetrics = async () => ({
  name: null, return1m: null, return3m: null, return6m: null, return1y: null,
  relativeReturn1m: null, relativeReturn6m: null, relativeReturn1y: null,
  dataAsOf: null, kind: null, source: null, unavailableReason: null
});

const states = new Map();
accountStateService.getUserState = async (uid) => states.get(Number(uid)) || null;
portfolioService.listSyncedAccounts = async () => [];

const pas = require('../services/portfolioAnalysisService');

function setState(uid, accounts, active) {
  states.set(Number(uid), { accounts, active });
}
function localAccount(name, funds, strategy) {
  return { name, accountType: 'local', syncSource: null, funds, strategy: strategy || [], closedPositions: [] };
}
// today=0：强制走 provider 估值链，便于用 estimateCalls 计数验证「构建只发生一次」
const baseFunds = () => [{ code: '000001', name: '测试基金A', amount: 3000, today: 0, profit: 300, category: '混合', transactions: [] }];

test('标准 JSON：columns/rows 严格对齐，与 analysisTable 同源；百分比/约定正确', async () => {
  pas.invalidateAnalysisDataCache();
  setState(101, { 'A账户': localAccount('A账户', baseFunds(), ['纪律：不追高']) }, 'A账户');
  const { portfolio, json } = await pas.getOrBuildAnalysisData(101, { account: 'A账户' });
  assert.equal(json.schemaVersion, pas.STANDARD_ANALYSIS_JSON_SCHEMA_VERSION);
  assert.deepEqual(json.account, ['A账户', 1, 3000]);
  // 字段映射唯一来源 = buildAnalysisTable（内部 AI 表格与标准 JSON 逐值一致）
  assert.deepEqual(json.holdingColumns, portfolio.analysisTable.columns);
  assert.deepEqual(json.holdingRows, portfolio.analysisTable.funds);
  json.holdingRows.forEach(row => assert.equal(row.length, json.holdingColumns.length));
  const i = c => json.holdingColumns.indexOf(c);
  assert.equal(json.holdingRows[0][i('code')], '000001');
  assert.equal(json.holdingRows[0][i('name')], '测试基金A');
  // 盈亏率成本口径 profit/cost = 300/2700 → +11.11%（服务端唯一格式化点）
  assert.equal(json.holdingRows[0][i('profitPct')], '+11.11%');
  assert.ok(Array.isArray(json.strategies) && json.strategies.length === 1);
  assert.ok(Array.isArray(json.dataWarnings));
  assert.ok('portfolioSummary' in json);
  assert.ok('combinationSummary' in json);
});

test('缓存：首次构建一次，5 分钟内命中（同一对象引用、不重复获取数据）', async () => {
  pas.invalidateAnalysisDataCache();
  estimateCalls = 0;
  setState(102, { 'A账户': localAccount('A账户', baseFunds()) }, 'A账户');
  const first = await pas.getOrBuildAnalysisData(102, { account: 'A账户' });
  assert.equal(first.cacheState, 'miss');
  const countAfterFirst = estimateCalls;
  assert.ok(countAfterFirst >= 1);
  const second = await pas.getOrBuildAnalysisData(102, { account: 'A账户' });
  assert.equal(second.cacheState, 'hit');
  assert.equal(estimateCalls, countAfterFirst); // 命中：不重复调用估值链
  assert.strictEqual(second.json, first.json);   // 命中：不重复构建/序列化
  assert.strictEqual(second.portfolio, first.portfolio);
});

test('内外互通：useActive（内部）与 account（外部）互相命中同一份 JSON（双向）', async () => {
  pas.invalidateAnalysisDataCache();
  setState(103, { 'A账户': localAccount('A账户', baseFunds(), ['纪律：不追高']) }, 'A账户');
  // 内部先、外部后
  const viaActive = await pas.getOrBuildAnalysisData(103, { useActive: true });
  assert.equal(viaActive.cacheState, 'miss');
  const viaAccount = await pas.getOrBuildAnalysisData(103, { account: 'A账户' });
  assert.equal(viaAccount.cacheState, 'hit');
  assert.strictEqual(viaAccount.json, viaActive.json);
  // 外部先、内部后
  pas.invalidateAnalysisDataCache();
  const first = await pas.getOrBuildAnalysisData(103, { account: 'A账户' });
  assert.equal(first.cacheState, 'miss');
  const second = await pas.getOrBuildAnalysisData(103, { useActive: true });
  assert.equal(second.cacheState, 'hit');
  assert.strictEqual(second.json, first.json);
});

test('single-flight：同键并发只触发一次实际构建', async () => {
  pas.invalidateAnalysisDataCache();
  estimateCalls = 0;
  setState(104, { 'A账户': localAccount('A账户', baseFunds()) }, 'A账户');
  const [r1, r2] = await Promise.all([
    pas.getOrBuildAnalysisData(104, { account: 'A账户' }),
    pas.getOrBuildAnalysisData(104, { account: 'A账户' })
  ]);
  // 单基金 → 估值链恰好调用 1 次（不是 2 次）
  assert.equal(estimateCalls, 1);
  const missCount = [r1.cacheState, r2.cacheState].filter(s => s === 'miss').length;
  assert.equal(missCount, 1);
  assert.ok(['shared', 'hit'].includes(r1.cacheState === 'miss' ? r2.cacheState : r1.cacheState));
  assert.strictEqual(r2.json, r1.json);
});

test('隔离：不同用户、不同账户不串数据', async () => {
  pas.invalidateAnalysisDataCache();
  setState(105, { 'A账户': localAccount('A账户', baseFunds(), ['用户甲策略']) }, 'A账户');
  setState(106, { 'B账户': localAccount('B账户', baseFunds(), ['用户乙策略']) }, 'B账户');
  const a = await pas.getOrBuildAnalysisData(105, { useActive: true });
  const b = await pas.getOrBuildAnalysisData(106, { useActive: true });
  assert.equal(a.cacheState, 'miss');
  assert.equal(b.cacheState, 'miss');
  assert.equal(a.json.account[0], 'A账户');
  assert.equal(b.json.account[0], 'B账户');
  assert.deepEqual(a.json.strategies, ['用户甲策略']);
  assert.deepEqual(b.json.strategies, ['用户乙策略']);
  assert.equal((await pas.getOrBuildAnalysisData(105, { useActive: true })).cacheState, 'hit');
  assert.equal((await pas.getOrBuildAnalysisData(106, { useActive: true })).cacheState, 'hit');
});

test('失效：策略修改 → 立即换键重建，不返回旧策略', async () => {
  pas.invalidateAnalysisDataCache();
  const acc = localAccount('A账户', baseFunds(), ['旧策略']);
  setState(107, { 'A账户': acc }, 'A账户');
  const first = await pas.getOrBuildAnalysisData(107, { account: 'A账户' });
  assert.deepEqual(first.json.strategies, ['旧策略']);
  acc.strategy = ['新策略：控制回撤'];
  const second = await pas.getOrBuildAnalysisData(107, { account: 'A账户' });
  assert.equal(second.cacheState, 'miss');
  assert.deepEqual(second.json.strategies, ['新策略：控制回撤']);
});

test('失效：持仓金额变化 → 立即重建（不等 5 分钟）', async () => {
  pas.invalidateAnalysisDataCache();
  const acc = localAccount('A账户', baseFunds());
  setState(108, { 'A账户': acc }, 'A账户');
  await pas.getOrBuildAnalysisData(108, { account: 'A账户' });
  acc.funds[0].amount = 5000;
  const second = await pas.getOrBuildAnalysisData(108, { account: 'A账户' });
  assert.equal(second.cacheState, 'miss');
});

test('失效：净值数据版本变化（fund_nav MAX(date) 前移）→ 重建', async () => {
  pas.invalidateAnalysisDataCache();
  setState(109, { 'A账户': localAccount('A账户', baseFunds()) }, 'A账户');
  await pas.getOrBuildAnalysisData(109, { account: 'A账户' });
  navVersion = '2026-01-03';
  const second = await pas.getOrBuildAnalysisData(109, { account: 'A账户' });
  assert.equal(second.cacheState, 'miss');
});

test('失败不污染缓存：构建失败被清理，后续可重试成功', async () => {
  pas.invalidateAnalysisDataCache();
  setState(110, { 'A账户': localAccount('A账户', baseFunds()) }, 'A账户');
  // 桩内加入延迟，保证 1ms 软超时先触发（模拟真实构建耗时）
  const originalHistory = fundMetricsService.getPerformanceHistory;
  fundMetricsService.getPerformanceHistory = async () => {
    await new Promise(r => setTimeout(r, 50));
    return historyRows;
  };
  try {
    await assert.rejects(
      () => pas.getOrBuildAnalysisData(110, { account: 'A账户', timeoutMs: 1 }),
      /Analysis timeout/
    );
  } finally {
    fundMetricsService.getPerformanceHistory = originalHistory;
  }
  // 失败未写入缓存 → 重试是新构建而非命中旧值
  const retry = await pas.getOrBuildAnalysisData(110, { account: 'A账户' });
  assert.equal(retry.cacheState, 'miss');
  assert.equal(retry.json.account[0], 'A账户');
  assert.equal((await pas.getOrBuildAnalysisData(110, { account: 'A账户' })).cacheState, 'hit');
});

test('bypass：多账户未指定不缓存（needsAccount），绝不猜测账户', async () => {
  pas.invalidateAnalysisDataCache();
  setState(111, {
    'A账户': localAccount('A账户', baseFunds()),
    'B账户': localAccount('B账户', baseFunds())
  }, 'A账户');
  const r = await pas.getOrBuildAnalysisData(111, {});
  assert.equal(r.cacheState, 'bypass');
  assert.equal(r.portfolio.needsAccount, true);
  assert.equal(r.json.account, null);
});

test('体积对比：标准 JSON 显著小于旧 enrichedHoldings 手工装配（打印实测字节数）', async () => {
  pas.invalidateAnalysisDataCache();
  historyRows = Array.from({ length: 260 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
    return { date: d.toISOString().slice(0, 10), nav: Number((1 + (i % 7) * 0.003).toFixed(4)) };
  });
  setState(112, {
    'A账户': localAccount('A账户', [
      { code: '000001', name: '易方达蓝筹精选混合', amount: 3000.55, today: 0.01, profit: 300, category: '混合', transactions: [] },
      { code: '000002', name: '华夏沪深300ETF联接C', amount: 5000.25, today: -0.005, profit: -250, category: '指数', transactions: [] },
      { code: '013309', name: '易方达恒生科技ETF联接C', amount: 11137.08, today: 0.012, profit: -4773, category: 'QDII', transactions: [] }
    ], ['纪律：不追高', '单只不超过 30%'])
  }, 'A账户');
  const { portfolio, json } = await pas.getOrBuildAnalysisData(112, { account: 'A账户' });

  // 旧 /api/external/analysis/ai 逐基金装配（cost 推导 + 15 日 history + 增强字段透传）
  const legacyPayload = {
    totalAssets: portfolio.account.totalValue,
    accounts: [{
      accountName: 'A账户',
      totalValue: portfolio.account.totalValue,
      strategies: portfolio.strategies || [],
      portfolioSummary: portfolio.portfolioSummary || null,
      dataWarnings: pas.buildDataWarnings(portfolio) || [],
      holdings: portfolio.holdings.map(h => ({
        code: h.code, name: h.name, amount: h.amount, cost: h.cost, profit: h.profit,
        profitRate: Number((h.profitRate || 0).toFixed(4)),
        todayEstimate: h.todayEstimate || 0,
        todayChange: Number((h.today_change || 0).toFixed(2)),
        type: h.type,
        history: Array.isArray(h.history) ? h.history.slice(-15).map(r => ({ date: r.date, nav: r.nav })) : [],
        performance: h.performance === undefined ? null : h.performance,
        benchmark: h.benchmark === undefined ? null : h.benchmark,
        allocation: h.allocation === undefined ? null : h.allocation,
        topHoldings: h.topHoldings === undefined ? null : h.topHoldings,
        overlapDetail: h.overlapDetail === undefined ? null : h.overlapDetail
      }))
    }]
  };
  const newPayload = {
    totalAssets: portfolio.account.totalValue,
    accounts: [{
      accountName: 'A账户',
      totalValue: portfolio.account.totalValue,
      ...json,
      holdings: portfolio.holdings.map(h => ({ code: h.code, name: h.name }))
    }]
  };
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacyPayload));
  const stdBytes = Buffer.byteLength(JSON.stringify(newPayload));
  console.log(`[体积对比] 3 只基金 × 260 日历史：旧装配 ${legacyBytes} B → 标准 JSON ${stdBytes} B（-${Math.round((1 - stdBytes / legacyBytes) * 100)}%）`);
  assert.ok(stdBytes < legacyBytes, '标准 JSON 必须小于旧装配');
});
