// Phase 3.3 只读诊断验证：模拟 Render 出网屏蔽（Eastmoney + Yahoo 均不可达），
// 确认当 holdingsChange 与 sectorChange 均不可得时，estimate_change 使用本地 NAV 历史兜底
// （source='本地数据库缓存'）得到有限值，而非 null。
// 运行：node --test server/tests/estimateFallback.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PROJ = 'C:/Users/Administrator/Desktop/Codex3 基金/genius-trader2.0/server';

// 在 require estimateEngine 之前注入 mock，模拟 Render 出网被封（Eastmoney+Yahoo 均不可达）
const fundServiceMock = {
  assertFundCode: (c) => c,
  getFund: async () => ({ fund_code: '022184', fund_name: '测试 QDII 科技', fund_type: 'QDII', latest_nav: { date: '2026-08-14' } }),
  importFund: async () => {},
  // 模拟东方财富(fundgz)被封后，getRealtimeFundEstimate 回退到本地 NAV 历史
  getRealtimeFundEstimate: async () => ({ source: '本地数据库缓存', estimate_change: 0.0123 }),
};
const calibrationMock = { calibrateFund: async () => ({ holdings_weight: 0.7, sector_weight: 0.2, cash_adjustment: 0.01, calibrated: false }) };
const dbAsyncMock = {
  all: async (sql) => sql.includes('fund_holdings')
    ? [{ stock_code: '600519', stock_name: '茅台', weight: 0.1, report_date: '2026-06-30' }, { stock_code: '000660', stock_name: 'SK海力士', weight: 0.05, report_date: '2026-06-30' }]
    : [],
  get: async () => null,
  run: async () => {},
};
const dbMock = { getDatabase: () => ({ prepare: () => ({ get: () => null, run: () => {} }) }) };

const fundPath = path.join(PROJ, 'services/fundService.js');
const calibPath = path.join(PROJ, 'services/calibrationEngine.js');
const dbAsyncPath = path.join(PROJ, 'database/dbAsync.js');
const dbPath = path.join(PROJ, 'database/db.js');
require.cache[fundPath] = { id: fundPath, filename: fundPath, loaded: true, exports: fundServiceMock };
require.cache[calibPath] = { id: calibPath, filename: calibPath, loaded: true, exports: calibrationMock };
require.cache[dbAsyncPath] = { id: dbAsyncPath, filename: dbAsyncPath, loaded: true, exports: dbAsyncMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// 模拟 Render 出网屏蔽：所有外部行情请求失败
global.fetch = async () => { throw new Error('egress blocked (simulated Render)'); };

const { calculateFundEstimate } = require(path.join(PROJ, 'services/estimateEngine.js'));

test('estimate_change 在 holdings+sector 均不可得时由本地 NAV 兜底而非 null', async () => {
  const r = await calculateFundEstimate('022184');
  assert.ok(Number.isFinite(r.estimate_change), `estimate_change 应为有限值，实际=${r.estimate_change}`);
  assert.strictEqual(r.fallback, 'public-estimate-local');
  assert.ok(Number.isFinite(r.estimate_change_percent));
  // holdings / sector 因出网屏蔽均不可得
  assert.strictEqual(r.holdings_change, null);
  assert.strictEqual(r.sector_change, null);
});
