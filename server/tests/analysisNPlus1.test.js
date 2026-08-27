// P0-2 回归测试：Analysis N+1 去重
// 验证：同一次分析（含多账户循环）内，同一基金只构建一次——getFund/getHistory/estimate 各一次。
const test = require('node:test');
const assert = require('node:assert');

// 先 require 依赖并打桩，再 require 被测试模块（其顶部解构会在 require 时捕获已打桩的函数）。
const fundService = require('../services/fundService');
const navService = require('../services/navService');
const portfolioService = require('../services/portfolioService');
const accountStateService = require('../services/accountStateService');
const providerEstimate = require('../services/providerEstimate');
const estimateEngine = require('../services/estimateEngine');
const { runInRequestScope } = require('../utils/requestScope');

const counters = { getFund: 0, getHistory: 0, providerEstimate: 0, latestPair: 0 };
let lastHistoryLimit = null;

fundService.getFund = async (code) => { counters.getFund += 1; return { fund_name: `F${code}`, fund_type: '基金' }; };
navService.getHistory = async (code, options) => { counters.getHistory += 1; lastHistoryLimit = options && options.limit; return [{ date: '2024-01-01', nav: 1 }, { date: '2024-01-02', nav: 1.01 }]; };
navService.getLatestPair = async (code) => { counters.latestPair += 1; return [{ date: '2024-01-02', nav: 1.01 }, { date: '2024-01-01', nav: 1 }]; };
providerEstimate.fetchProviderEstimate = async (code) => { counters.providerEstimate += 1; return { estimate_change: 0.01 }; };
estimateEngine.calculateFundEstimate = async () => ({ estimate_change: 0.005 });
portfolioService.listSyncedAccounts = async () => [];
accountStateService.getUserState = async () => state;

// 3 个账户，基金代码大量重叠（唯一代码 10 个），模拟“多账户分析 + 首页打开”。
const CODES = Array.from({ length: 10 }, (_, i) => String(100000 + i));
function makeAccount(name) {
  // 注意：不提供 today，确保 resolveFundToday 走 fetchProviderEstimate 路径（验证 estimate 去重）。
  return {
    accountType: 'manual',
    strategy: [],
    funds: CODES.map(code => ({ code, amount: 1000 }))
  };
}
const state = {
  active: 'acc1',
  accounts: {
    acc1: makeAccount('acc1'),
    acc2: makeAccount('acc2'),
    acc3: makeAccount('acc3')
  }
};

const portfolioAnalysisService = require('../services/portfolioAnalysisService');

test('each fund is built exactly once across a multi-account analysis loop', async () => {
  counters.getFund = 0; counters.getHistory = 0; counters.providerEstimate = 0; counters.latestPair = 0;

  const accountsList = await portfolioAnalysisService.loadUserAccounts(1);
  assert.strictEqual(accountsList.length, 3);

  // 模拟 external.js 的多账户分析循环：同一请求作用域内共享去重缓存。
  await runInRequestScope(async () => {
    for (const acc of accountsList) {
      await portfolioAnalysisService.buildAnalysisPortfolio(1, { accountId: acc.name, timeoutMs: 5000 });
    }
  }, { userId: 1 });

  // 唯一基金 10 个；每个被 3 个账户重复引用，但去重后每个只构建一次。
  assert.strictEqual(counters.getFund, 10, `getFund 应为 10（唯一基金数），实际 ${counters.getFund}（疑似 N+1）`);
  assert.strictEqual(counters.getHistory, 10, `getHistory 应为 10，实际 ${counters.getHistory}（疑似 N+1）`);
  assert.strictEqual(counters.providerEstimate, 10, `estimate 应为 10，实际 ${counters.providerEstimate}（疑似重复计算）`);
});

test('history is capped, not full history, for analysis', async () => {
  // 验证分析路径读取历史时带 limit（ANALYSIS_HISTORY_LIMIT 默认 260）。
  counters.getHistory = 0;
  lastHistoryLimit = null;

  await runInRequestScope(async () => {
    await portfolioAnalysisService.buildAnalysisPortfolio(1, { accountId: 'acc1', timeoutMs: 5000 });
  }, { userId: 1 });

  assert.ok(lastHistoryLimit && lastHistoryLimit > 0 && lastHistoryLimit <= 260, `分析历史应限量读取，实际 limit=${lastHistoryLimit}`);
});

test('requestMemo dedups concurrent identical keys within a scope', async () => {
  const { requestMemo } = require('../utils/requestScope');
  let runs = 0;
  await runInRequestScope(async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => requestMemo('same', async () => { runs += 1; return 'v'; }))
    );
    assert.ok(results.every(r => r === 'v'));
  });
  assert.strictEqual(runs, 1, '同一 key 并发请求应只执行一次 factory');
});
