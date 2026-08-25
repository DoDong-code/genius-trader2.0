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
const { expectedNavDateFor } = require('./estimateStatus');

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
 * 每周历史完整性校对：最新净值日期早于 expected（或缺失）的基金，用 importFund 增量补齐。
 * importFund 非 force 只回填缺失日期 + 最近若干条，不做全量历史重建。
 */
async function syncWeeklyHistory(options = {}) {
  const funds = await listFunds();
  const results = await mapLimit(funds, options.concurrency || 2, async (fund) => {
    const code = fund.fund_code;
    const expected = expectedNavDateFor(fund);
    const latest = await dbAsync.get(
      'SELECT MAX(date) AS max_date FROM fund_nav WHERE fund_code = ?',
      [code]
    );
    const latestDate = latest && latest.max_date;
    if (latestDate && String(latestDate).localeCompare(String(expected)) >= 0) {
      return { fund_code: code, skipped: true };
    }
    const result = await importFund(code, {});
    return { fund_code: code, records: result.records, inserted: result.inserted };
  });
  return results;
}

/** 当前季度起始日（yyyy-mm-dd），用于判断持仓报告是否过季 */
function currentQuarterStart(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const quarterMonth = Math.floor(month / 3) * 3;
  const mm = String(quarterMonth + 1).padStart(2, '0');
  return `${year}-${mm}-01`;
}

/**
 * 每季度前十大持仓检查：最新 report_date 早于当前季度起始日的基金才强制刷新 holdings，
 * 历史 report_date 保留（fund_holdings 按 fund_code+stock_code+report_date 唯一，不会覆盖历史季度）。
 */
async function syncQuarterlyHoldings(options = {}) {
  const funds = await listFunds();
  const quarterStart = currentQuarterStart();
  const results = await mapLimit(funds, options.concurrency || 2, async (fund) => {
    const code = fund.fund_code;
    const latest = await dbAsync.get(
      'SELECT MAX(report_date) AS max_report FROM fund_holdings WHERE fund_code = ?',
      [code]
    );
    const latestReport = latest && latest.max_report;
    if (latestReport && String(latestReport).localeCompare(quarterStart) >= 0) {
      return { fund_code: code, skipped: true, report_date: latestReport };
    }
    const result = await importFund(code, { forceHoldings: true });
    return { fund_code: code, refreshed: true };
  });
  return results;
}

module.exports = {
  syncTodayNavs,
  syncWeeklyHistory,
  syncQuarterlyHoldings,
  currentQuarterStart
};
