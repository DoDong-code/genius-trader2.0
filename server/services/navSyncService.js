/**
 * 冻结后台同步职责（2026-08-25）：
 *   - 每日 NAV 增量：只处理 fund_nav 中没有「今天 expected 日期」的基金，已有则跳过，
 *     避免全量重导导致的 provider 请求暴涨（ext queued 165~393 的根因之一）。
 *   - 每周历史校对：最近 35 天历史完整性由 importFund 增量补齐（只回填缺失/最新日期）。
 *   - 每季度持仓检查：仅当最新 report_date 早于当前季度起始日才强制刷新 fund_holdings。
 * 原则：缓存优先、增量优先、按需请求；绝不因后台任务清空/覆盖已有正式 NAV。
 */
const dbAsync = require('../database/dbAsync');
const { listFunds, importFund } = require('./fundService');
const { ensureTodayNav } = require('./navCacheService');
const { expectedNavDateFor, isHkFund, isHkTradingDay } = require('./estimateStatus');
const { isTradingDay, shanghaiDateString } = require('./marketService');

// 简单并发限制：避免后台任务同时打爆第三方 / 内存
async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        results[current] = { error: error && error.message ? error.message : String(error) };
      }
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(Number(concurrency) || 2, 6));
  for (let i = 0; i < n; i += 1) workers.push(run());
  await Promise.all(workers);
  return results;
}

/**
 * 每日正式 NAV 增量同步：跳过已有 today/expected 净值的基金，其余交给 ensureTodayNav
 * （缓存优先、收盘前不写、provider 无数据保留旧 NAV）。
 */
async function syncTodayNavs(options = {}) {
  const funds = await listFunds();
  const results = await mapLimit(funds, options.concurrency || 3, async (fund) => {
    const code = fund.fund_code;
    const expected = expectedNavDateFor(fund);
    const existing = await dbAsync.get(
      'SELECT date FROM fund_nav WHERE fund_code = ? AND date = ?',
      [code, expected]
    );
    if (existing) {
      return { fund_code: code, skipped: true, date: expected };
    }
    const res = await ensureTodayNav(code, {
      userId: Number(options.userId) || 0,
      preferredSource: options.preferredSource
    });
    return {
      fund_code: code,
      date: res.date,
      nav: res.nav,
      cached: Boolean(res.cached),
      reason: res.reason || null
    };
  });
  return results;
}

/**
 * 生成「截至 today、向前取 count 个交易日」的期望 NAV 日期集合。
 * - 纯交易日历计算，不访问任何第三方数据源；仅用于缺口检测。
 * - 港股/恒生基金用香港交易日历（isHkTradingDay），其余用 A 股交易日历（isTradingDay）。
 * - 返回升序（早 → 晚）。
 */
function isExpectedTradingDay(dateStr, fund) {
  return isHkFund(fund) ? isHkTradingDay(dateStr) : isTradingDay(dateStr);
}

function buildExpectedTradingWindow(count, fund, now = new Date()) {
  const window = [];
  // 窗口末端严格与 expectedNavDateFor() 对齐：
  // QDII/美股基金净值 T+1（甚至 T+2）才披露，expected 已是「上一交易日」。
  // 若末端直接取最近交易日，会把「尚未披露」的日期永久判为缺口
  // —— 回填永远补不上（第三方确实还没有），表现为每次打开都提示缺失。
  // 对非 QDII 基金 expectedNavDateFor 即最近交易日，与旧行为完全等价。
  const anchor = expectedNavDateFor(fund, now);
  const parts = String(anchor).split('-');
  let cursor = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  while (window.length < count) {
    const ds = shanghaiDateString(cursor.getTime());
    if (isExpectedTradingDay(ds, fund)) window.push(ds);
    cursor.setDate(cursor.getDate() - 1);
  }
  // 向前回溯时按“新→旧”收集，反转后返回升序（早 → 晚）；
  // expected[0] 为最早日期，供 detectNavGaps 的 `date >= ?` 正确取窗口。
  return window.reverse();
}

/**
 * detectNavGaps()：纯数据库缺口检测，不访问任何第三方数据源。
 * 对每只基金读取「最近 windowDays 个交易日」窗口内的 fund_nav 记录，与交易日历比较，
 * 仅返回存在缺失交易日的基金及其缺失日期列表。发现缺口才进入补偿队列。
 */
async function detectNavGaps(options = {}) {
  const windowDays = Math.min(Math.max(Number(options.windowDays) || 60, 10), 120);
  const funds = await listFunds();
  const gaps = [];
  for (const fund of funds) {
    const code = fund.fund_code;
    const expected = buildExpectedTradingWindow(windowDays, fund);
    if (!expected.length) continue;
    const rows = await dbAsync.all(
      'SELECT date FROM fund_nav WHERE fund_code = ? AND date >= ? ORDER BY date ASC',
      [code, expected[0]]
    );
    const have = new Set(rows.map(r => String(r.date)));
    const missing = expected.filter(d => !have.has(d));
    if (missing.length) gaps.push({ fund_code: code, missingDates: missing });
  }
  return gaps;
}

/**
 * 历史净值缺口补偿：复用现有 importFund 增量补齐机制。
 * - 先 detectNavGaps()（纯 DB）找出缺口基金，仅对这些基金补偿，绝不全量扫所有基金；
 * - 并发 1~2，单基金内部串行（importFund 本身串行写库）；
 * - 无长期队列、无无限 retry，单只失败仅记录、不重试、不阻塞其余。
 * 目标：宁可慢一点补完，也绝不瞬时打爆第三方 / 内存。
 */
async function syncWeeklyHistory(options = {}) {
  const gaps = await detectNavGaps(options);
  if (!gaps.length) {
    return { gaps: 0, filled: [] };
  }
  const concurrency = Math.min(Math.max(Number(options.concurrency) || 1, 1), 2);
  const filled = await mapLimit(gaps, concurrency, async (gap) => {
    const code = gap.fund_code;
    try {
      const result = await importFund(code, {});
      return { fund_code: code, missingDates: gap.missingDates, records: result.records, inserted: result.inserted };
    } catch (err) {
      return { fund_code: code, missingDates: gap.missingDates, error: err && err.message ? err.message : String(err) };
    }
  });
  return { gaps: gaps.length, filled };
}

/** 当前季度起始日（yyyy-mm-dd），用于判断持仓报告是否过季 */
function currentQuarterStart(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const quarterMonth = Math.floor(month / 3) * 3;
  const mm = String(quarterMonth + 1).padStart(2, '0');
  return `${year}-${mm}-01`;
}

// 2026-11-03（D）：披露日历推算——按《公开募集证券投资基金信息披露管理办法》，
// 季报须在季度结束后 15 个工作日内披露 ≈ 22 个日历日（取 22 天留法定假日余量；
// 宁晚勿早：窗口未过时按上一报告期算，宁可多刷一次也不漏新数据）。
const DISCLOSURE_LAG_DAYS = 22;

/**
 * 当前「应已披露」的最新报告期（季末日 yyyy-mm-dd）。
 * 例：今天 2026-11-03 → Q3(09-30) 披露窗口 10-22 已过 → 返回 '2026-09-30'；
 *     今天 2026-10-05 → Q3 窗口未过 → 返回 '2026-06-30'（Q2）。
 * 注意：报告期日期=季末日，永远早于季度起始日——旧 skip 条件（latestReport >= quarterStart）
 * 因此永假，导致每次运行全量空刷上游；本函数修正了这一口径。
 */
function expectedReportDate(now = new Date()) {
  const y = now.getFullYear();
  const candidates = [];
  for (const year of [y, y - 1]) {
    for (let q = 3; q >= 0; q -= 1) {
      // q: 0→3月末, 1→6月末, 2→9月末, 3→12月末（Date month 0-based）
      candidates.push(new Date(Date.UTC(year, q * 3 + 3, 0)));
    }
  }
  candidates.sort((a, b) => b - a); // 降序：从最近一个季末往前找
  for (const end of candidates) {
    const due = new Date(end);
    due.setUTCDate(due.getUTCDate() + DISCLOSURE_LAG_DAYS);
    if (now.getTime() >= due.getTime()) {
      return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
    }
  }
  return null; // 理论不可达（最旧候选为去年 Q4，+22 天必早于今天）
}

/**
 * 每季度前十大持仓检查（2026-11-03 D 方案重写 skip 口径）：
 * - skip 条件 = 库内最新 report_date 已达到「当前应披露报告期」（expectedReportDate，披露日历驱动）。
 *   已披露基金零上游调用；未披露/上游还没给的基金每次运行重试，provider 一披露当天即入库。
 * - 调度间隔由 91 天墙钟改为 24h（index.js HOLDINGS_CHECK_MS）：skip 真正生效后，
 *   每次运行成本 = 每基金一条 SELECT MAX(report_date)，绝不打爆上游。
 * - 历史 report_date 保留（fund_holdings 按 fund_code+stock_code+report_date 唯一，不覆盖历史季度）。
 * - 库内异常值 'unknown' 与任何 yyyy-mm-dd 比较恒小，自然归入需刷新，无需特判。
 * - expected=null（理论不可达）时保持旧「全量刷新」兜底。
 */
async function syncQuarterlyHoldings(options = {}) {
  const funds = await listFunds();
  const expected = expectedReportDate();
  const results = await mapLimit(funds, options.concurrency || 2, async (fund) => {
    const code = fund.fund_code;
    const latest = await dbAsync.get(
      'SELECT MAX(report_date) AS max_report FROM fund_holdings WHERE fund_code = ?',
      [code]
    );
    const latestReport = latest && latest.max_report;
    if (expected && latestReport && String(latestReport).localeCompare(expected) >= 0) {
      return { fund_code: code, skipped: true, report_date: latestReport };
    }
    const result = await importFund(code, { forceHoldings: true });
    return { fund_code: code, refreshed: true };
  });
  return results;
}

/**
 * 一次性历史缺口审计（只读，不写库）：返回每只基金「最近 windowDays 个交易日」内的缺失日期。
 * 与 detectNavGaps 的区别：本函数允许 windowDays 超过 scheduled 的 120 天上限，用于排查长周期历史断层。
 * 不记录任何 API Key / Token / Cookie。
 */
async function auditNavGaps(options = {}) {
  const windowDays = Math.max(Number(options.windowDays) || 250, 10);
  const funds = await listFunds();
  const gaps = [];
  for (const fund of funds) {
    const code = fund.fund_code;
    const expected = buildExpectedTradingWindow(windowDays, fund);
    if (!expected.length) continue;
    const rows = await dbAsync.all(
      'SELECT date FROM fund_nav WHERE fund_code = ? AND date >= ? ORDER BY date ASC',
      [code, expected[0]]
    );
    const have = new Set(rows.map(r => String(r.date)));
    const missing = expected.filter(d => !have.has(d));
    if (missing.length) {
      gaps.push({
        fund_code: code,
        fund_name: fund.fund_name,
        missingDates: missing,
        missingCount: missing.length,
        range: missing[0] + ' ~ ' + missing[missing.length - 1]
      });
    }
  }
  return gaps;
}

/**
 * 幂等历史回填：对审计出的缺口基金调用 importFund（增量补齐，ON CONFLICT 不覆盖已有正确数据，不虚构净值）。
 * 仅补全基金实际交易日内、且第三方数据源能提供的历史净值；第三方无法提供的更早历史会如实报告，绝不伪造。
 */
async function backfillNavGaps(options = {}) {
  const gaps = await auditNavGaps(options);
  if (!gaps.length) return { gaps: 0, filled: [] };
  const concurrency = Math.min(Math.max(Number(options.concurrency) || 2, 1), 4);
  const filled = await mapLimit(gaps, concurrency, async (gap) => {
    try {
      const result = await importFund(gap.fund_code, {});
      return { fund_code: gap.fund_code, missingDates: gap.missingDates, records: result.records, inserted: result.inserted };
    } catch (err) {
      return { fund_code: gap.fund_code, missingDates: gap.missingDates, error: err && err.message ? err.message : String(err) };
    }
  });
  return { gaps: gaps.length, filled };
}

module.exports = {
  syncTodayNavs,
  syncWeeklyHistory,
  detectNavGaps,
  auditNavGaps,
  backfillNavGaps,
  buildExpectedTradingWindow,
  syncQuarterlyHoldings,
  currentQuarterStart,
  expectedReportDate
};
