// Phase 3.3-H 验收压测（mock 驱动，不触发真实网络/数据库）。
// 用 require.cache 注入 mock 依赖后加载真实 estimateEngine / providerEstimate，
// 产出用户要求的 5 组指标，并验证所有 queue/inFlight/active 在测试后回落到 0。
//
// 运行：node --expose-gc _verify_h.js

'use strict';

const path = require('path');
const SERVER = path.resolve(__dirname, '..');

function inject(rel, exportsObj) {
  const abs = path.join(SERVER, rel + '.js');
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

// ---------- 全局计数 / 采样 ----------
let stockQuoteRequested = 0;
let stockQuoteConcurrent = 0;
let stockQuoteMaxConcurrent = 0;
let queueMaxObserved = 0;
let sampler = null;

function resetCounters() {
  stockQuoteRequested = 0;
  stockQuoteConcurrent = 0;
  stockQuoteMaxConcurrent = 0;
  queueMaxObserved = 0;
}

function startSampler(externalStats) {
  sampler = setInterval(() => {
    const s = externalStats();
    if (s.queued > queueMaxObserved) queueMaxObserved = s.queued;
  }, 2);
  if (sampler.unref) sampler.unref();
}
function stopSampler() {
  if (sampler) { clearInterval(sampler); sampler = null; }
}

// ---------- mock 依赖 ----------
const { externalConcurrencyStats } = require(path.join(SERVER, 'services/concurrencyLimit'));

let stockSeq = 0;
let dbGetCalls = 0;
let dbAllCalls = 0;
const marketServiceMock = {
  fetchStockQuote: async (code) => {
    stockQuoteRequested += 1;
    stockQuoteConcurrent += 1;
    if (stockQuoteConcurrent > stockQuoteMaxConcurrent) stockQuoteMaxConcurrent = stockQuoteConcurrent;
    await new Promise(r => setTimeout(r, 3)); // 模拟出网耗时 + 让出事件循环
    stockQuoteConcurrent -= 1;
    return { price: 1.23, change_percent: 0.5 };
  },
  toYahooSymbol: (c) => c,
  normalizeStockCode: (c) => c,
  stockSecIds: () => [],
  shanghaiDateString: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
  fetchHistory: async () => []
};

const dbAsyncMock = {
  get: async () => { dbGetCalls += 1; return null; }, // 冷缓存：cachedQuote / cachedEstimate 一律 miss
  run: async () => {},   // stock_price / fund_estimate 写入 no-op
  all: async () => {     // latestHoldings：每只基金返回 5 个持仓，股票代码全局唯一（避免去重压低 requested）
    dbAllCalls += 1;
    const out = [];
    for (let i = 0; i < 5; i += 1) {
      // 用 6 位数字代码，避免命中 calculateFundEstimate 的美股跳过分支（/^[A-Za-z]/）
      out.push({ stock_code: String(600000 + stockSeq++), stock_name: `STK${i}`, weight: 0.2 });
    }
    return out;
  }
};

let portfolioQueryCount = 0;
const dbMock = {
  prepare: (sql) => ({
    all: (...args) => {
      if (/portfolio/.test(sql)) {
        portfolioQueryCount += 1;
        const positions = [];
        for (let i = 0; i < 100; i += 1) {
          positions.push({ fund_code: `F${i}`, amount: 10000, cost: 9000, fund_name: `Fund${i}` });
        }
        return positions;
      }
      return [];
    }
  })
};

const fundServiceMock = {
  assertFundCode: (c) => String(c).trim(),
  getFund: async (code) => ({ fund_code: code, fund_name: `Fund${code}`, fund_type: '股票型', latest_nav: null }),
  getRealtimeFundEstimate: async () => null,
  importFund: async () => {}
};

const calibrationMock = {
  calibrateFund: async () => ({
    holdings_weight: 0.8, sector_weight: 0.15, cash_adjustment: 0.02,
    calibrated: false, mae: null, rmse: null, direction_accuracy: null, sample_size: 0, calibrated_at: null
  })
};

const configMock = {
  quoteTtlMinutes: 5,
  estimateTtlMinutes: 5,
  fundSectorMap: {},
  nameRules: [],
  sectorBenchmarks: {}, // 空 → 无板块基准 → 不触发 fetchHistoricalChange
  holdingsWeight: 0.8,
  sectorWeight: 0.15,
  cashAdjustment: 0.02
};

inject('services/marketService', marketServiceMock);
inject('database/db', { getDatabase: () => dbMock });
inject('database/dbAsync', dbAsyncMock);
inject('services/fundService', fundServiceMock);
inject('services/calibrationEngine', calibrationMock);
inject('config/estimateConfig', configMock);

// providerEstimate 的 mock 依赖（用于 Test 3 缓存上限验证）
inject('services/sourceCredentials', { getCredential: async () => ({ status: 'connected', token: 't' }) });
inject('providers/registry', {
  getProvider: () => ({
    sourceName: 'yangjibao', displayName: '养基宝', setToken() {},
    fetch_estimate: async () => ({ estimate_growth: 1.2, estimate_nav: 1.5, estimate_time: new Date().toISOString(), trade_date: '2026-08-24' }),
    _getOptionalChangeNav: async () => [],
    fetchAccounts: async () => [],
    _fetchRawHoldings: async () => [],
    _request: async () => ({})
  })
});

// ---------- 加载真实模块 ----------
const estimateEngine = require(path.join(SERVER, 'services/estimateEngine'));
const providerEstimate = require(path.join(SERVER, 'services/providerEstimate'));

const results = {};

async function run() {
  const m0 = process.memoryUsage();

  // 探针：直接验证 marketService mock 是否接进 estimateEngine.quoteFor
  stockQuoteRequested = 0;
  const probeQ = await estimateEngine.quoteFor('ZZ999');
  console.log('[PROBE] quoteFor(ZZ999) =>', probeQ && probeQ.change_percent, ' stockQuoteRequested =', stockQuoteRequested);
  if (stockQuoteRequested !== 1) {
    console.log('[PROBE] WARN: mock 未接上，fetchStockQuote 未被调用');
  }
  // 探针2：直接调 calculateFundEstimate，确认是否进入 stock quote 分支
  stockQuoteRequested = 0;
  const cf = await estimateEngine.calculateFundEstimate('F0', { amount: 10000 });
  console.log('[PROBE2] calculateFundEstimate(F0): quote_coverage=', cf.quote_coverage,
    ' estimate_change=', cf.estimate_change, ' req=', stockQuoteRequested,
    ' dbGetCalls=', dbGetCalls, ' dbAllCalls=', dbAllCalls);
  resetCounters();

  // ===== Test 1：100 基金冷缓存 =====
  resetCounters();
  startSampler(externalConcurrencyStats);
  const t1 = await estimateEngine.calculateAccountEstimate('acc1');
  stopSampler();
  results.test1 = {
    funds: 100,
    fundsReturned: Array.isArray(t1.funds) ? t1.funds.length : 0,
    sampleChange: t1.funds && t1.funds[0] ? t1.funds[0].estimate_change : null,
    stockQuoteRequested: stockQuoteRequested,
    maxConcurrent: stockQuoteMaxConcurrent,
    queueMax: queueMaxObserved,
    maxGate: externalConcurrencyStats().max
  };

  // ===== Test 2：同一账户 10 次并发 estimate =====
  portfolioQueryCount = 0;
  resetCounters();
  startSampler(externalConcurrencyStats);
  const t2 = await Promise.all(Array.from({ length: 10 }, () => estimateEngine.calculateAccountEstimate('acc1')));
  stopSampler();
  results.test2 = {
    concurrentCalls: 10,
    actualExecutions: portfolioQueryCount, // 内部持仓查询次数 = 真实计算次数（per-account 合并后应为 1）
    stockQuoteRequested: stockQuoteRequested,
    inFlightPeak: stockQuoteMaxConcurrent,
    allEqual: t2.every(r => JSON.stringify(r.calculated_at) === JSON.stringify(t2[0].calculated_at))
  };

  // ===== Test 3：连续刷新/估值 100 次 + 缓存上限验证 =====
  const beforeCache = providerEstimate.stats().estimateCacheSize;
  for (let i = 0; i < 100; i += 1) {
    await providerEstimate.fetchProviderEstimate(`C${i}`, undefined, { source: 'yangjibao', userId: 1, force: false });
  }
  const after100 = providerEstimate.stats().estimateCacheSize;
  // 继续压到 2100 个不同基金代码，验证 MAX_SIZE=2000 硬上限
  for (let i = 0; i < 2000; i += 1) {
    await providerEstimate.fetchProviderEstimate(`D${i}`, undefined, { source: 'yangjibao', userId: 1, force: false });
  }
  const after2100 = providerEstimate.stats().estimateCacheSize;
  results.test3 = {
    cacheInitial: beforeCache,
    cacheAfter100: after100,
    cacheAfter2100: after2100,
    estimateCacheMax: providerEstimate.stats().estimateCacheMax,
    growsUnbounded: after2100 > providerEstimate.stats().estimateCacheMax
  };

  // ===== Test 4：连续运行 heapUsed / rss =====
  if (global.gc) global.gc();
  const m1 = process.memoryUsage();
  results.test4 = {
    heapUsedInitialMB: Math.round(m0.heapUsed / 1048576),
    heapUsedFinalMB: Math.round(m1.heapUsed / 1048576),
    rssInitialMB: Math.round(m0.rss / 1048576),
    rssFinalMB: Math.round(m1.rss / 1048576)
  };

  // ===== Test 5：所有 queue / inFlight / active 回落到 0 =====
  const ext = externalConcurrencyStats();
  const est = estimateEngine.stats();
  const prov = providerEstimate.stats();
  results.test5 = {
    externalActive: ext.active,
    externalQueued: ext.queued,
    pendingQuotes: est.pendingQuotesSize,
    pendingAccountEstimates: est.pendingAccountEstimatesSize,
    pendingBulkFetches: prov.pendingBulkFetchesSize,
    allZero: ext.active === 0 && ext.queued === 0 && est.pendingQuotesSize === 0 &&
             est.pendingAccountEstimatesSize === 0 && prov.pendingBulkFetchesSize === 0
  };

  // ===== Provider 模块加载冒烟（确认 _request 网关改动未破坏模块加载）=====
  let providerLoadOk = true;
  try {
    require(path.join(SERVER, 'providers/yangjibao'));
    require(path.join(SERVER, 'providers/xiaobeiyangji'));
  } catch (e) {
    providerLoadOk = false;
    results.providerLoadError = e.message;
  }
  results.providerLoadOk = providerLoadOk;

  console.log('\\n========== PHASE 3.3-H VERIFY ==========');
  console.log(JSON.stringify(results, null, 2));

  // 断言
  const checks = [];
  checks.push(['T1 maxConcurrent <= 6', results.test1.maxConcurrent <= 6]);
  checks.push(['T1 requested == 500 (100x5)', results.test1.stockQuoteRequested === 500]);
  checks.push(['T2 executions == 1 (per-account merge)', results.test2.actualExecutions === 1]);
  checks.push(['T2 inFlightPeak <= 6', results.test2.inFlightPeak <= 6]);
  checks.push(['T2 stockQuoteRequested == 500', results.test2.stockQuoteRequested === 500]);
  checks.push(['T3 cache bounded (2100 -> 2000)', results.test3.cacheAfter2100 === results.test3.estimateCacheMax && !results.test3.growsUnbounded]);
  checks.push(['T5 all queue/inFlight/active == 0', results.test5.allZero]);
  checks.push(['Provider modules load OK', results.providerLoadOk]);
  console.log('\\n---------- ASSERTIONS ----------');
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log(`\\nRESULT: ${allPass ? 'ALL PASS' : 'SOME FAIL'}`);
  process.exit(allPass ? 0 : 1);
}

run().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
