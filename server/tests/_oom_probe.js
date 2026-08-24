/**
 * Phase 3.3-G OOM 探针（只读 / mock，不修改生产代码）
 *
 * 目的：用 mock fetcher 实测两条估值链路的并发放大，取得硬证据。
 *   A. navCacheService.ensureTodayNav 路径（P3.3 已加 MAX_EXTERNAL_CONCURRENCY=6）
 *   B. estimateEngine.calculateAccountEstimate 路径（Promise.all(positions.map) -> Promise.all(holdings.map(quoteFor))，无并发限制）
 *
 * 不发起任何真实网络请求。仅测并发结构与峰值内存。
 */
const path = require('path');

let globalActive = 0;
let globalMaxActive = 0;
let globalRequested = 0;
let globalCompleted = 0;

function mockExternal(delayMs) {
  return async function () {
    globalRequested += 1;
    globalActive += 1;
    if (globalActive > globalMaxActive) globalMaxActive = globalActive;
    await new Promise((r) => setTimeout(r, delayMs));
    globalActive -= 1;
    globalCompleted += 1;
    return null;
  };
}

function startSampler(tag) {
  const samples = [];
  const t = setInterval(() => {
    const m = process.memoryUsage();
    samples.push({ rss: m.rss, heapUsed: m.heapUsed });
  }, 10);
  if (t.unref) t.unref();
  return {
    stop() {
      clearInterval(t);
      let peakRss = 0, peakHeap = 0;
      for (const s of samples) {
        if (s.rss > peakRss) peakRss = s.rss;
        if (s.heapUsed > peakHeap) peakHeap = s.heapUsed;
      }
      return { peakRss, peakHeap, samples: samples.length };
    }
  };
}

// ---- Scenario A: real navCacheService scheduler via require-cache injection ----
async function runScenarioA(N) {
  globalActive = globalMaxActive = globalRequested = globalCompleted = 0;

  const dbAsyncPath = path.resolve(__dirname, '../database/dbAsync.js');
  const providerEstimatePath = path.resolve(__dirname, '../services/providerEstimate.js');

  // mock dbAsync: 任意 fund 返回一行；fund_nav 无缓存；run 空操作
  require.cache[dbAsyncPath] = {
    id: dbAsyncPath, filename: dbAsyncPath, loaded: true,
    exports: {
      get: async (sql) => {
        if (String(sql).includes('fund_nav')) return null;
        return { fund_type: '股票型', fund_name: 'Probe Fund' };
      },
      run: async () => {},
      all: async () => []
    }
  };
  // mock providerEstimate: fetchProviderEstimate 返回 null（模拟 provider miss，走 yahoo/eastmoney）
  require.cache[providerEstimatePath] = {
    id: providerEstimatePath, filename: providerEstimatePath, loaded: true,
    exports: { fetchProviderEstimate: mockExternal(2) }
  };

  // mock global fetch（yahoo / eastmoney 路径）
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({})
  }));

  // 重新加载（确保注入生效）；首次 require 会缓存，故先删缓存
  delete require.cache[path.resolve(__dirname, '../services/navCacheService.js')];
  const { ensureTodayNav } = require('../services/navCacheService');

  const sampler = startSampler('A');
  const codes = Array.from({ length: N }, (_, i) => `F${i}`);
  await Promise.all(codes.map((c) => ensureTodayNav(c, { userId: 1 })));
  const mem = sampler.stop();

  return {
    scenario: 'A-navCacheService(externalQueue, MAX=6)',
    funds: N,
    externalPerFund: 4,
    theoreticalMax: N * 4,
    requested: globalRequested,
    maxConcurrent: globalMaxActive,
    completed: globalCompleted,
    peakRssMB: (mem.peakRss / 1048576) | 0,
    peakHeapMB: (mem.peakHeap / 1048576) | 0
  };
}

// ---- Scenario B: replicate estimateEngine nested Promise.all (UNGUARDED) ----
async function runScenarioB(N, holdingsPerFund = 10) {
  globalActive = globalMaxActive = globalRequested = globalCompleted = 0;

  // quoteFor: 每个持仓一次网络（mock），无并发限制 -> 全部同时发起
  async function quoteFor() {
    return mockExternal(5)();
  }
  // calculateFundEstimate 内部 Promise.all(holdings.map(quoteFor))
  async function calculateFundEstimate() {
    const holdings = Array.from({ length: holdingsPerFund }, (_, i) => `H${i}`);
    await Promise.all(holdings.map(() => quoteFor()));
  }
  // calculateAccountEstimate 内部 Promise.all(positions.map(calculateFundEstimate))
  async function calculateAccountEstimate() {
    const positions = Array.from({ length: N }, (_, i) => `P${i}`);
    await Promise.all(positions.map(() => calculateFundEstimate()));
  }

  const sampler = startSampler('B');
  await calculateAccountEstimate();
  const mem = sampler.stop();

  return {
    scenario: 'B-calculateAccountEstimate(nested Promise.all, NO limiter)',
    funds: N,
    holdingsPerFund: holdingsPerFund,
    theoreticalMax: N * holdingsPerFund,
    requested: globalRequested,
    maxConcurrent: globalMaxActive,
    completed: globalCompleted,
    peakRssMB: (mem.peakRss / 1048576) | 0,
    peakHeapMB: (mem.peakHeap / 1048576) | 0
  };
}

(async () => {
  console.log('=== Phase 3.3-G OOM 探针（mock，无真实请求）===');
  for (const N of [10, 50, 100]) {
    const a = await runScenarioA(N);
    console.log(JSON.stringify(a));
  }
  for (const N of [10, 50, 100]) {
    const b = await runScenarioB(N, 10);
    console.log(JSON.stringify(b));
  }
  console.log('=== 探针结束 ===');
  process.exit(0);
})();
