// /api/portfolio/analysis-export 序列化层回归（2026-10-20 审计修复）：
// 审计发现 enrichFund 已计算的 overlapDetail 未进入 fundsOut 输出白名单 → 缺失在 API 层。
// 本测试桩掉 authService / portfolioAnalysisService / getFundHoldings，
// 只验证路由序列化输出（新增字段齐全、null 如实、旧字段兼容），全程不触库不触网。
const test = require('node:test');
const assert = require('node:assert');

delete process.env.DATABASE_URL;

// —— 先打桩，再 require 被测路由（fund.js 顶层解构 getFundHoldings，必须先改再 require）——
const fundService = require('../services/fundService');
fundService.getFundHoldings = async (code) => (String(code) === '013309')
  ? [{ stock_name: '腾讯控股', weight: 7.4 }]
  : [];

const authService = require('../services/authService');
authService.userFromRequest = async () => ({ id: 21 });

const pas = require('../services/portfolioAnalysisService');
pas.buildAnalysisPortfolio = async () => ({
  account: { name: '导出账户', type: 'manual', totalValue: 3000 },
  strategies: ['纪律：不追高'],
  portfolioSummary: { coreIndex: '007339', maxAmount: 20000 },
  holdings: [
    {
      code: '013309', name: '基金A', amount: 1000, cost: 900, profit: 100, profitRate: 0.1111,
      todayEstimate: 0.01, today_change: 10, type: '混合',
      history: [{ date: '2026-10-14', nav: 1 }, { date: '2026-10-15', nav: 1.01 }],
      performance: {
        return1m: 0.01, return3m: 0.02, return6m: 0.03, return1y: 0.04,
        maxDrawdown1y: -0.1, drawdownFromHigh1y: -0.05, volatility20d: 0.2, trend: 'up', dataAsOf: '2026-10-15'
      },
      benchmark: {
        name: '恒生科技指数', return1m: 0.008, return3m: 0.015, return6m: -0.02, return1y: -0.05,
        relativeReturn1m: 0.002, relativeReturn6m: 0.05, relativeReturn1y: 0.09,
        dataAsOf: '2026-10-15', kind: 'auxiliary'
      },
      allocation: { role: 'growth', sector: '恒生科技', maxAmount: null, overlapWarning: true },
      topHoldings: '腾讯控股 7.4%',
      overlapDetail: '腾讯控股:本7.4%/彼007330 5.1%'
    },
    {
      // 数据不足基金：全部如实 null，禁止 0/'' 冒充
      code: '007339', name: '基金B', amount: 2000, cost: 0, profit: 0, profitRate: null,
      todayEstimate: null, today_change: 0, type: '指数',
      history: [],
      performance: null, benchmark: null, allocation: null, topHoldings: null, overlapDetail: null
    }
  ],
  __warnings: ['007339 基金B: 测试警告']
});
pas.loadUserAccounts = async () => [
  {
    name: '导出账户', accountType: 'manual',
    funds: [
      { code: '013309', subAccount: '子1', category: '混合' },
      { code: '007339' }
    ]
  }
];
pas.buildDataWarnings = (p) => (p && p.__warnings) ? p.__warnings.slice() : [];

const { handleFundApi } = require('../api/fund');

function mockRequest(method) {
  return { method, headers: {}, on(event, cb) { if (event === 'end') cb(); } };
}
function mockResponse() {
  return {
    statusCode: null, body: '',
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; }
  };
}

test('analysis-export：overlapDetail 进入输出 + 增强字段透传 + null 如实 + 旧字段兼容', async () => {
  const url = new URL('http://localhost/api/portfolio/analysis-export?account=' + encodeURIComponent('导出账户'));
  const res = mockResponse();
  const ok = await handleFundApi(mockRequest('GET'), res, url);
  assert.equal(ok, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.success, true);

  const exp = data.export;
  assert.equal(exp.account.name, '导出账户');
  assert.deepEqual(exp.portfolioSummary, { coreIndex: '007339', maxAmount: 20000 });
  assert.deepEqual(exp.dataWarnings, ['007339 基金B: 测试警告']);

  const [h0, h1] = exp.holdings;
  // 新增字段：序列化层补齐（overlapDetail 为本次修复的关键断言；
  // topHoldings 由端点自行用 getFundHoldings 格式化为「名称(权重%)」）
  assert.equal(h0.overlapDetail, '腾讯控股:本7.4%/彼007330 5.1%');
  assert.equal(h0.topHoldings, '腾讯控股(7.40%)');
  assert.equal(h0.performance.return6m, 0.03);
  assert.equal(h0.performance.return1y, 0.04);
  assert.equal(h0.benchmark.return6m, -0.02);
  assert.equal(h0.benchmark.return1y, -0.05);
  assert.equal(h0.benchmark.relativeReturn6m, 0.05);
  assert.equal(h0.benchmark.relativeReturn1y, 0.09);
  assert.equal(h0.allocation.overlapWarning, true);

  // 数据不足基金：null 如实（禁止 0 冒充）；topHoldings 空数据为端点既有契约（空串，非本轮引入）
  assert.equal(h1.overlapDetail, null);
  assert.equal(h1.topHoldings, '');
  assert.equal(h1.performance, null);
  assert.equal(h1.benchmark, null);
  assert.equal(h1.profitRate, null);

  // 旧字段兼容（既有契约不破坏）
  assert.equal(h0.code, '013309');
  assert.equal(h0.amount, 1000);
  assert.equal(h0.profit, 100);
  assert.equal(h0.profitRate, 0.1111);
  assert.ok(h0.navHistory.includes('2026-10-15'));
  assert.equal(h0.subAccount, '子1');
  assert.equal(h0.category, '混合');
});

test('analysis-export compact=1：holdings 变 {columns, rows} 宽表，端到端无 ReferenceError', async () => {
  // 回归背景：2026-10-21 线上 HTTP 500 "buildCompactExport is not defined"——
  // 解构误放 runInRequestScope 回调内而使用点在回调外；默认路径短路求值掩盖了该错误，
  // 必须用 compact=1 的端点级测试才能真正执行该分支。
  const url = new URL('http://localhost/api/portfolio/analysis-export?account=' + encodeURIComponent('导出账户') + '&compact=1');
  const res = mockResponse();
  const ok = await handleFundApi(mockRequest('GET'), res, url);
  assert.equal(ok, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.success, true);

  const exp = data.export;
  // 非数组字段原样
  assert.equal(exp.account.name, '导出账户');
  assert.deepEqual(exp.dataWarnings, ['007339 基金B: 测试警告']);

  const { columns, rows } = exp.holdings;
  assert.ok(!Array.isArray(exp.holdings), 'compact 模式下 holdings 不再是数组');
  assert.equal(columns.length, 40);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.length, columns.length);

  const colIdx = (name) => columns.indexOf(name);
  // 行0（数据齐全基金）：拍平字段与端点序列化值一致
  const r0 = rows[0];
  assert.equal(r0[colIdx('code')], '013309');
  assert.equal(r0[colIdx('profitRate')], 0.1111);
  assert.equal(r0[colIdx('topHoldings')], '腾讯控股(7.40%)');
  assert.equal(r0[colIdx('overlapDetail')], '腾讯控股:本7.4%/彼007330 5.1%');
  assert.equal(r0[colIdx('maxDrawdown1y')], -0.1);
  assert.equal(r0[colIdx('benchReturn6m')], -0.02);
  assert.equal(r0[colIdx('role')], 'growth');
  assert.equal(r0[colIdx('overlapWarning')], true);
  // 行1（数据不足基金）：整组缺失全 null，0/空串如实保留
  const r1 = rows[1];
  assert.equal(r1[colIdx('code')], '007339');
  assert.equal(r1[colIdx('profitRate')], null);
  assert.equal(r1[colIdx('maxDrawdown1y')], null);
  assert.equal(r1[colIdx('benchName')], null);
  assert.equal(r1[colIdx('todayChange')], 0);
  assert.equal(r1[colIdx('topHoldings')], '');
});
