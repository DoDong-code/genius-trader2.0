// 盈亏历史序列服务回归（2026-11-20 盈亏分析抽屉）：
// 桩掉 navService.getHistory 与 loadUserAccounts，验证
//   1) 份额还原与日收益计算（shares = 当前市值 / 最新官方净值）；
//   2) 期初市值 base 口径 = 各基金首个可算日的前一日市值之和；
//   3) 缺净值日期该基金不贡献（不插值、多日缺口并入下一有净值日）；
//   4) 历史不足基金整只剔除并写入 warnings；
//   5) 账户不存在返回 null。
// 全程不触库不触网（DATABASE_URL 已删除）。
const test = require('node:test');
const assert = require('node:assert');

delete process.env.DATABASE_URL;

const navService = require('../services/navService');

// pnlHistoryService 顶层解构捕获了 getHistory 引用 → 必须在 require 它之前挂转发器，测试内切换实现
let getHistoryImpl = null;
const origGetHistory = navService.getHistory;
navService.getHistory = (code, opts) => (getHistoryImpl ? getHistoryImpl(code, opts) : origGetHistory(code, opts));

const pas = require('../services/portfolioAnalysisService');
const { buildPnlHistory, buildPnlDetail } = require('../services/pnlHistoryService');

// 份额还原基准：全部以「最新官方净值」为锚 —— 桩内每个基金的最后一行即最新净值
const NAV_A = [['2026-01-02', 1.0], ['2026-01-05', 1.1]];                        // 最新 1.1
const NAV_B = [['2026-01-02', 2.0], ['2026-01-05', 1.9], ['2026-01-06', 2.0]];   // 最新 2.0

function stubFunds(funds) {
  getHistoryImpl = (code) => {
    if (String(code) === '000001') return NAV_A.map(([date, nav]) => ({ date, nav }));
    if (String(code) === '000002') return NAV_B.map(([date, nav]) => ({ date, nav }));
    if (String(code) === '000003') return [{ date: '2026-01-05', nav: 3.0 }]; // 仅 1 个点 → 剔除
    return [];
  };
  pas.loadUserAccounts = async () => [
    { name: '测试账户', accountType: 'local', funds },
    { name: '其它账户', accountType: 'local', funds: [] }
  ];
}

test('份额还原 + 日收益/累计收益/收益率口径', async () => {
  stubFunds([
    { code: '000001', name: '基金A', amount: 1100 }, // shares = 1100/1.1 = 1000
    { code: '000002', name: '基金B', amount: 2000 }  // shares = 2000/2.0 = 1000
  ]);
  const r = await buildPnlHistory(9, '测试账户', 400);
  assert.ok(r && r.series.length === 2, '应产出 01-05 / 01-06 两天（01-02 无前一日基准，跳过）');
  // 01-05：A profit = 1000×(1.1-1.0)=100；B profit = 1000×(1.9-2.0)=-100 → 合计 0
  const d5 = r.series[0];
  assert.strictEqual(d5.date, '2026-01-05');
  assert.strictEqual(d5.profit, 0);
  assert.strictEqual(d5.value, 3000); // A=1000×1.1=1100，B=1000×1.9=1900
  // 01-06：A 无净值（不贡献）；B profit = 1000×(2.0-1.9)=+100
  const d6 = r.series[1];
  assert.strictEqual(d6.date, '2026-01-06');
  assert.strictEqual(d6.profit, 100);
  assert.strictEqual(d6.value, 2000);
  // 累计：cum(01-05)=0，cum(01-06)=100
  assert.strictEqual(d6.cum, 100);
  // base = A 首个可算日(01-05)前一日市值 1000×1.0=1000 + B 1000×2.0=2000 → 3000
  assert.strictEqual(r.base, 3000);
  assert.strictEqual(d5.cumRate, 0);
  assert.strictEqual(d6.cumRate, 0.033333); // 100/3000，服务端 round6
  // 日收益率：01-05 分母 = 期初市值 3000 → 0/3000 = 0；01-06 分母 = 01-05 市值 3000
  assert.strictEqual(d5.rate, 0);
  assert.strictEqual(d6.rate, 0.033333);
  assert.strictEqual(r.firstDate, '2026-01-05');
  assert.strictEqual(r.lastDate, '2026-01-06');
});

test('历史不足基金整只剔除并写入 warnings', async () => {
  stubFunds([
    { code: '000001', name: '基金A', amount: 1100 },
    { code: '000003', name: '新基金C', amount: 999 }
  ]);
  const r = await buildPnlHistory(9, '测试账户', 400);
  assert.ok(r.warnings.some(w => w.includes('新基金C')), '新基金C 必须出现在 warnings');
  assert.ok(r.series.every(p => p.value <= 1100 + 1), 'C 的市值不得混入序列');
});

test('账户不存在 → null；无有效持仓 → 空 series + warnings', async () => {
  stubFunds([{ code: '000001', name: '基金A', amount: 1100 }]);
  assert.strictEqual(await buildPnlHistory(9, '不存在的账户', 400), null);
  const r = await buildPnlHistory(9, '其它账户', 400);
  assert.ok(r && Array.isArray(r.series) && r.series.length === 0);
  assert.ok(r.warnings.length >= 1);
});

test('区间明细：逐日累加口径与序列一致 + 排序 + 参数校验', async () => {
  stubFunds([
    { code: '000001', name: '基金A', amount: 1100 }, // shares = 1000
    { code: '000002', name: '基金B', amount: 2000 }  // shares = 1000
  ]);
  // 全区间：明细合计 == 序列累计（0 + 100 = 100）；A=+100、B=0 → B 排在 A 前（100 > 0? A=100 排第一）
  const d = await buildPnlDetail(9, '测试账户', '2026-01-01', '2026-01-31');
  assert.ok(d && d.items.length === 2);
  assert.strictEqual(d.total, 100);            // 与 series 累计一致
  assert.strictEqual(d.items[0].name, '基金A'); // A +100 排首
  assert.strictEqual(d.items[0].profit, 100);
  assert.strictEqual(d.items[0].rate, 0.1);    // 100 / (1000×1.0) = 0.1
  assert.strictEqual(d.items[1].name, '基金B'); // B 区间 01-05 −100 与 01-06 +100 相抵 → 0
  assert.strictEqual(d.items[1].profit, 0);
  // 单日：01-05 合计 == series[0].profit == 0
  const d5 = await buildPnlDetail(9, '测试账户', '2026-01-05', '2026-01-05');
  assert.strictEqual(d5.total, 0);
  // 账户不存在 → null
  assert.strictEqual(await buildPnlDetail(9, '不存在的账户', '2026-01-01', '2026-01-31'), null);
  // 参数校验：日期格式 / 起止颠倒 → 抛 BAD_DATE / BAD_RANGE
  await assert.rejects(
    () => buildPnlDetail(9, '测试账户', '2026-1-1', '2026-01-31'),
    e => e.code === 'BAD_DATE'
  );
  await assert.rejects(
    () => buildPnlDetail(9, '测试账户', '2026-01-31', '2026-01-01'),
    e => e.code === 'BAD_RANGE'
  );
});
