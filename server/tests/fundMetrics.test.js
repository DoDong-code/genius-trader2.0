/**
 * 基金量化指标服务测试（数据增强需求 §四~§八、§十二）
 *
 * 覆盖：
 *  1) 近1月/3月/6月/1年收益率按日历窗口计算正确（不把「最近N条」当周期）；
 *  2) 近1年最大回撤 / 距高点跌幅逐日滚动计算正确；
 *  3) 历史数据不足时对应指标返回 null（绝不用短窗口冒充长周期）；
 *  4) 净值日期缺失、重复、乱序、异常值不导致错误指标；
 *  5) QDII 净值滞后：dataAsOf 取真实最新日期，不伪造最新交易日；
 *  6) 基准缺失时全 null，绝不默认沪深300；
 *  7) 007339 核心宽基角色与 20000 上限正确保留；
 *  8) 持仓重合只按真实持仓与阈值判定，数据不足返回 null；重合不改变核心角色；
 *  9) portfolioSummary 从策略文本解析（权益上限10万 / 核心上限2万 / 回本1.5万/12个月）；
 * 10) 历史按需回填：库内数据不足时触发回填（ON CONFLICT DO NOTHING），节流生效，
 *     回填失败不影响返回现有数据。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-metrics-test-'));
process.env.FUND_DB_PATH = path.join(temporaryDirectory, 'test.sqlite');

const { getDatabase } = require('../database/db');
const metrics = require('../services/fundMetricsService');
const profileConfig = require('../config/fundProfileConfig');

// ---------------------------------------------------------------------------
// 工具：合成序列
// ---------------------------------------------------------------------------

/** 生成从 startDate 起 n 个连续自然日的序列（单测用，不要求真实交易日） */
function dailySeries(startDate, n, valueFn) {
  const rows = [];
  const [y, m, d] = startDate.split('-').map(Number);
  for (let i = 0; i < n; i += 1) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const ds = dt.toISOString().slice(0, 10);
    rows.push({ date: ds, nav: valueFn(i, ds) });
  }
  return rows;
}

function seedNav(code, rows) {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO fund (fund_code, fund_name) VALUES (?, ?)').run(code, `测试基金${code}`);
  const insert = db.prepare('INSERT OR REPLACE INTO fund_nav (fund_code, date, nav, acc_nav) VALUES (?, ?, ?, ?)');
  for (const r of rows) insert.run(code, r.date, r.nav, r.nav);
}

// ---------------------------------------------------------------------------
// 1) 序列规范化：重复/乱序/非法日期/越界值
// ---------------------------------------------------------------------------

test('normalizeSeries：去重（后写优先）、升序重排、丢弃非法日期与越界值', () => {
  const rows = [
    { date: '2026-03-05', nav: 1.5 },
    { date: '2026-03-01', nav: 1.0 },
    { date: '2026-03-05', nav: 1.55 },      // 重复日期：保留最后一条
    { date: '2026/03/02', nav: 1.1 },       // 非法日期格式
    { date: '2026-02-30', nav: 1.2 },       // 不存在的日历日期
    { date: '2026-03-03', nav: 0 },          // 非法数值
    { date: '2026-03-04', nav: 3735971251 }, // 越界异常值（疑似解析错位）
    { date: '2026-03-02', nav: 1.2 }
  ];
  const series = metrics.normalizeSeries(rows);
  assert.deepEqual(series.map(p => p.date), ['2026-03-01', '2026-03-02', '2026-03-05']);
  assert.equal(series[2].value, 1.55);
});

// ---------------------------------------------------------------------------
// 2) 日历窗口收益率
// ---------------------------------------------------------------------------

test('calendarReturn：按日历月取基期（截止日当天或之前最后一个有效点）', () => {
  const series = metrics.normalizeSeries([
    { date: '2025-06-30', nav: 100 },
    { date: '2025-12-30', nav: 119 },
    { date: '2025-12-31', nav: 120 },
    { date: '2026-03-30', nav: 90 },
    { date: '2026-03-31', nav: 91 },
    { date: '2026-05-30', nav: 105 },
    { date: '2026-06-02', nav: 106 },
    { date: '2026-06-30', nav: 110 }
  ]);
  assert.equal(metrics.calendarReturn(series, 1), 110 / 105 - 1);   // cutoff 2026-05-30
  assert.equal(metrics.calendarReturn(series, 3), 110 / 90 - 1);    // cutoff 2026-03-30
  assert.equal(metrics.calendarReturn(series, 6), 110 / 119 - 1);   // cutoff 2025-12-30
  assert.equal(metrics.calendarReturn(series, 12), 110 / 100 - 1);  // cutoff 2025-06-30
});

test('calendarReturn：subtractMonths 月末钳制正确', () => {
  assert.equal(metrics.subtractMonths('2026-03-31', 1), '2026-02-28');
  assert.equal(metrics.subtractMonths('2026-06-30', 12), '2025-06-30');
  assert.equal(metrics.subtractMonths('2026-01-31', 3), '2025-10-31');
});

// ---------------------------------------------------------------------------
// 3) computePerformance：完整对象 + 数据不足返回 null + QDII 滞后
// ---------------------------------------------------------------------------

test('computePerformance：仅 1 个月数据 → 短期指标可算，6月/1年/回撤如实 null', () => {
  // QDII 场景：最新净值日期明显滞后（8-07），绝不向「今天」对齐
  const rows = dailySeries('2026-07-01', 38, i => 1 + i * 0.001);
  rows.forEach(r => { r.date = r.date; });
  const perf = metrics.computePerformance(rows);
  assert.equal(perf.return1m !== null, true);
  assert.equal(perf.return3m, null);
  assert.equal(perf.return6m, null);
  assert.equal(perf.return1y, null);
  assert.equal(perf.maxDrawdown1y, null);
  assert.equal(perf.drawdownFromHigh1y, null);
  assert.equal(perf.dataAsOf, '2026-08-07'); // 真实最新日期（38 天后），QDII 滞后不伪造
  assert.equal(perf.historyDays, 38);
});

test('computePerformance：空/无数据 → 全 null + trend unknown', () => {
  const perf = metrics.computePerformance([]);
  assert.equal(perf.return1m, null);
  assert.equal(perf.maxDrawdown1y, null);
  assert.equal(perf.dataAsOf, null);
  assert.equal(perf.historyDays, 0);
  assert.equal(perf.trend, 'unknown');
});

test('computePerformance：脏数据（重复/乱序/越界）不影响指标', () => {
  const good = dailySeries('2026-01-05', 100, i => 1 + i * 0.002);
  const dirty = good.concat([
    { date: '2026-03-01', nav: 999999 },     // 越界
    { date: 'not-a-date', nav: 2 },
    good[10],                                 // 重复
    { date: '2026-02-01', nav: 1.02 }         // 乱序（重复日期后写优先）
  ]);
  const perf = metrics.computePerformance(dirty);
  const clean = metrics.computePerformance(good);
  assert.equal(perf.return1m, clean.return1m);
  assert.equal(perf.return3m, clean.return3m);
  assert.equal(perf.dataAsOf, clean.dataAsOf);
  assert.equal(perf.historyDays, 100); // 仅计有效记录
});

// ---------------------------------------------------------------------------
// 4) 回撤：1 年窗口逐日滚动
// ---------------------------------------------------------------------------

test('drawdown1y：完整 1 年数据 → 逐日滚动最大回撤与距高点跌幅正确', () => {
  // 370 天：0~199 天涨到 1.20（峰值在第 199 天），之后回落到 0.90
  const rows = dailySeries('2025-06-11', 370, i => {
    if (i <= 199) return 1 + (i / 199) * 0.2;
    return 1.2 - ((i - 199) / 170) * 0.3;
  });
  const dd = metrics.drawdown1y(metrics.normalizeSeries(rows));
  // 窗口 365 天内峰值 1.20，谷值 0.90 → maxDrawdown = 0.9/1.2 - 1 = -0.25
  assert.ok(Math.abs(dd.maxDrawdown1y - (-0.25)) < 1e-6, `maxDrawdown=${dd.maxDrawdown1y}`);
  const latest = 1.2 - ((369 - 199) / 170) * 0.3;
  assert.ok(Math.abs(dd.drawdownFromHigh1y - (latest / 1.2 - 1)) < 1e-6);
  // cutoff = latest-12个月（含当天），2025-06-11 起始 → 窗口 366 条
  assert.equal(dd.windowDays, 366);
});

test('drawdown1y：数据不足 1 年（或记录数不足）→ null', () => {
  const short = dailySeries('2026-05-01', 60, i => 1 + i * 0.001);
  const dd = metrics.drawdown1y(metrics.normalizeSeries(short));
  assert.equal(dd.maxDrawdown1y, null);
  assert.equal(dd.drawdownFromHigh1y, null);
  // 时间跨度够但记录稀疏（跨度 400 天、仅 100 条 < 180）→ null
  const sparse = [];
  for (let i = 0; i < 100; i += 1) {
    const dt = new Date(Date.UTC(2025, 4, 1 + Math.floor(i * 4)));
    sparse.push({ date: dt.toISOString().slice(0, 10), nav: 1 + i * 0.001 });
  }
  const dd2 = metrics.drawdown1y(metrics.normalizeSeries(sparse));
  assert.equal(dd2.maxDrawdown1y, null);
});

// ---------------------------------------------------------------------------
// 5) 波动率 / 趋势
// ---------------------------------------------------------------------------

test('volatility20d：恒定日收益 → 0；样本不足 → null；交替收益按样本标准差年化', () => {
  // 每日收益恒为 +1% → 标准差 0 → 年化波动率 0
  const rows = [];
  let nav = 1;
  for (let i = 0; i < 40; i += 1) { rows.push({ date: `d${String(i).padStart(3, '0')}`, nav }); nav *= 1.01; }
  // 用真实日期替换（normalizeSeries 校验日期格式）
  rows.forEach((r, i) => { r.date = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10); });
  assert.equal(metrics.volatility20d(metrics.normalizeSeries(rows)), 0);
  assert.equal(metrics.volatility20d(metrics.normalizeSeries(rows.slice(0, 3))), null);
  // 交替 ±1% 精确构造：r_odd=+1%, r_even=-1%（由 nav 比值精确产生），验证公式 = 样本标准差×sqrt(252)
  const alt = [];
  let nav2 = 1;
  for (let i = 0; i < 40; i += 1) {
    alt.push({ date: new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10), nav: nav2 });
    nav2 *= (i % 2 === 0 ? 1.01 : 0.99);
  }
  const series = metrics.normalizeSeries(alt);
  const returns = [];
  for (let i = series.length - 1; i >= 1 && returns.length < 20; i -= 1) {
    returns.push(series[i].value / series[i - 1].value - 1);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const expected = Math.sqrt(variance) * Math.sqrt(252);
  const vol = metrics.volatility20d(series);
  assert.ok(Math.abs(vol - expected) < 1e-6, `vol=${vol} expected=${expected}`);
});

test('classifyTrend：3月优先(±5%)，退化 1 月(±3%)，无数据 unknown', () => {
  assert.equal(metrics.classifyTrend(0.06, null), 'up');
  assert.equal(metrics.classifyTrend(-0.06, null), 'down');
  assert.equal(metrics.classifyTrend(0.01, null), 'sideways');
  assert.equal(metrics.classifyTrend(null, 0.04), 'up');
  assert.equal(metrics.classifyTrend(null, -0.04), 'down');
  assert.equal(metrics.classifyTrend(null, 0.01), 'sideways');
  assert.equal(metrics.classifyTrend(null, null), 'unknown');
});

// ---------------------------------------------------------------------------
// 6) portfolioSummary：策略文本解析
// ---------------------------------------------------------------------------

test('parsePortfolioSummary：从真实策略文本解析上限/回本目标', () => {
  const strategy = [
    '沪深300作为核心宽基 持仓不超过2万',
    '一年以内回本15000元',
    '权益持仓不超过10万元，根据历史净值趋势，可以适时做T',
    '浦银安盛全球智能科技(QDII)C  暂停申购，可以自由卖出',
    '精简持仓，海外暂时不用精简'
  ];
  const holdings = [
    { code: '007339', name: '易方达沪深300ETF联接C' },
    { code: '019633', name: '国泰半导体设备ETF联接C' }
  ];
  const ps = metrics.parsePortfolioSummary(strategy, holdings);
  assert.equal(ps.equityCap, 100000);
  assert.equal(ps.coreIndex, '007339');
  assert.equal(ps.coreIndexCap, 20000);
  assert.equal(ps.recoveryTarget, 15000);
  assert.equal(ps.recoveryHorizonMonths, 12);
  assert.equal(ps.cashAvailable, null);
  assert.equal(ps.realizedProfitLoss, null);
  assert.equal(ps.recoveryDefinitionStatus, 'pending-confirmation');
});

test('parsePortfolioSummary：007339 不在持仓时按名称匹配；无策略文本 → null', () => {
  const ps = metrics.parsePortfolioSummary(
    ['沪深300作为核心宽基 持仓不超过2万'],
    [{ code: '000961', name: '某沪深300指数基金' }]
  );
  assert.equal(ps.coreIndex, '000961');
  const empty = metrics.parsePortfolioSummary([], []);
  assert.equal(empty.equityCap, null);
  assert.equal(empty.coreIndex, null);
  assert.equal(empty.coreIndexCap, null);
  assert.equal(empty.recoveryTarget, null);
});

// ---------------------------------------------------------------------------
// 7) allocation / overlap
// ---------------------------------------------------------------------------

test('buildAllocation：007339 核心宽基 + 20000 上限正确保留；未配置基金 → unknown', () => {
  const a = metrics.buildAllocation('007339', false);
  assert.equal(a.role, 'core');
  assert.equal(a.sector, 'A股宽基');
  assert.equal(a.maxAmount, 20000);
  assert.equal(a.overlapWarning, false);
  const b = metrics.buildAllocation('999999', true);
  assert.equal(b.role, 'unknown');
  assert.equal(b.sector, null);
  assert.equal(b.maxAmount, null);
  assert.equal(b.overlapWarning, true);
});

test('computeOverlapMap：真实重合(≥3%)判定 true；低于阈值 false；数据不足 null', () => {
  const byFund = new Map([
    ['111111', [{ stockCode: '600519', weightPct: 8 }, { stockCode: '000001', weightPct: 5 }]],
    ['222222', [{ stockCode: '600519', weightPct: 5 }, { stockCode: '300750', weightPct: 6 }]],
    ['333333', [{ stockCode: '601318', weightPct: 4 }]]
  ]);
  const m = metrics.computeOverlapMap(byFund);
  assert.equal(m.get('111111'), true);
  assert.equal(m.get('222222'), true);
  assert.equal(m.get('333333'), false);

  // 个别低权重重合（<3%）不触发
  const low = new Map([
    ['111111', [{ stockCode: '600519', weightPct: 2 }]],
    ['222222', [{ stockCode: '600519', weightPct: 1.5 }]]
  ]);
  const m2 = metrics.computeOverlapMap(low);
  assert.equal(m2.get('111111'), false);
  assert.equal(m2.get('222222'), false);

  // 仅 1 只有数据 → 全 null（不默认「无重合」）
  const one = new Map([
    ['111111', [{ stockCode: '600519', weightPct: 8 }]],
    ['222222', []]
  ]);
  const m3 = metrics.computeOverlapMap(one);
  assert.equal(m3.get('111111'), null);
  assert.equal(m3.get('222222'), null);
});

test('normalizeHoldingRows：weight<1 视为小数自动×100，按权重降序截取前10', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    stock_code: `ST${String(i).padStart(2, '0')}`,
    weight: i < 2 ? (0.09 - i * 0.01) : (10 - i) // 前 2 条为小数（9%、8%）
  }));
  const norm = metrics.normalizeHoldingRows(rows);
  assert.equal(norm.length, 10);
  assert.equal(norm[0].stockCode, 'ST00');
  assert.equal(norm[0].weightPct, 9);
  assert.equal(norm[1].weightPct, 8);
});

// ---------------------------------------------------------------------------
// 8) 历史读取 + 按需回填（SQLite 临时库 + 可注入 fetcher）
// ---------------------------------------------------------------------------

test('getPerformanceHistory：库内已覆盖 1 年 → 直接返回，不触发回填', async () => {
  seedNav('111333', dailySeries('2025-01-02', 600, i => 1 + i * 0.001));
  const series = await metrics.getPerformanceHistory('111333');
  assert.equal(series.length, metrics.PERF_HISTORY_LIMIT); // 窗口上限
  assert.equal(series[0].date <= series[series.length - 1].date, true);
  assert.equal(metrics.coversOneYear(series), true);
});

test('getPerformanceHistory：库内不足 → 注入 fetcher 回填补齐（DO NOTHING 不覆盖已有）', async () => {
  // 库内仅 30 条（2026-06-01 起）
  const existing = dailySeries('2026-06-01', 30, i => 2 + i * 0.001);
  seedNav('222444', existing);
  // 注入 fetcher：返回此前一年的历史（含 5 条与库内重复的日期，验证不覆盖已有值）
  const backfillRows = dailySeries('2025-06-01', 335, i => 1 + i * 0.001)
    .concat(existing.slice(0, 5).map(r => ({ date: r.date, nav: 999 }))); // 冲突日期（不得覆盖 2.x）
  let fetchCalls = 0;
  const fakeFetcher = async () => { fetchCalls += 1; return backfillRows; };
  await metrics.backfillPerformanceHistory('222444', fakeFetcher);
  assert.equal(fetchCalls, 1);
  const series = await metrics.getPerformanceHistory('222444');
  assert.equal(series.length, 30 + 335); // 5 条冲突日期未重复插入
  assert.equal(series[0].date, '2025-06-01');
  // 已有净值未被回填覆盖（getPerformanceHistory 返回原始行 {date, nav}，与 getHistory 契约一致）
  const kept = series.find(p => p.date === existing[0].date);
  assert.ok(kept && Math.abs(kept.nav - existing[0].nav) < 1e-9, `kept=${JSON.stringify(kept)}`);
  assert.equal(metrics.coversOneYear(series), true);
});

test('backfillPerformanceHistory：失败后节流（2h 内不重试），不影响调用方', async () => {
  const existing = dailySeries('2026-06-01', 20, i => 3 + i * 0.001);
  seedNav('333555', existing);
  let calls = 0;
  const failingFetcher = async () => { calls += 1; throw new Error('provider down'); };
  const r1 = await metrics.backfillPerformanceHistory('333555', failingFetcher);
  assert.equal(r1.error, 'provider down');
  const r2 = await metrics.backfillPerformanceHistory('333555', failingFetcher);
  assert.equal(r2.skipped, true);
  assert.equal(calls, 1); // 节流生效
  // 数据获取失败不影响读取现有数据
  const series = await metrics.getPerformanceHistory('333555');
  assert.equal(series.length, 20);
  assert.equal(series[series.length - 1].date, '2026-06-20');
});

// ---------------------------------------------------------------------------
// 9) 基准：未配置 → 全 null；配置 → 从 stock_price 计算
// ---------------------------------------------------------------------------

test('getBenchmarkMetrics：未配置基准 → 全 null（绝不默认沪深300）', async () => {
  const b = await metrics.getBenchmarkMetrics('999888', 0.05, 0.1);
  assert.equal(b.name, null);
  assert.equal(b.return1m, null);
  assert.equal(b.return3m, null);
  assert.equal(b.relativeReturn1m, null);
  assert.equal(b.dataAsOf, null);
});

test('getBenchmarkMetrics：配置基准（007339→510300）→ 从 stock_price 计算同期收益', async () => {
  const db = getDatabase();
  const rows = dailySeries('2025-06-01', 380, i => 3.8 + i * 0.002);
  const insert = db.prepare('INSERT OR REPLACE INTO stock_price (stock_code, date, price, change_percent, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)');
  for (const r of rows) insert.run('510300', r.date, r.nav, 0);
  const b = await metrics.getBenchmarkMetrics('007339', 0.02, 0.05);
  assert.equal(b.name, '沪深300指数');
  assert.equal(b.kind, 'auxiliary');
  assert.ok(b.return1m !== null && b.return3m !== null);
  assert.ok(Math.abs(b.relativeReturn1m - (0.02 - b.return1m)) < 1e-6);
  assert.equal(b.dataAsOf, '2026-06-15'); // 真实最新行情日期，不伪造
});

// ---------------------------------------------------------------------------
// 10) 端到端：performance 输出小数形式契约（-0.12 = -12%）
// ---------------------------------------------------------------------------

test('computePerformance：比率均为小数形式且保留 6 位', () => {
  const rows = dailySeries('2025-06-01', 380, i => (i <= 189 ? 1 + i * 0.0005 : 1.095 - (i - 189) * 0.001));
  const perf = metrics.computePerformance(rows);
  for (const key of ['return1m', 'return3m', 'return6m', 'return1y', 'maxDrawdown1y', 'drawdownFromHigh1y', 'volatility20d']) {
    if (perf[key] !== null) {
      assert.ok(Math.abs(perf[key]) < 1, `${key} 应为小数形式`);
      assert.equal(Number.isInteger(perf[key] * 1e6), true, `${key} 最多 6 位小数`);
    }
  }
});
