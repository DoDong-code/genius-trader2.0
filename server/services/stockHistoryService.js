/**
 * 股票历史行情同步服务（A2：修复校准"样本不足"）。
 *
 * 背景：
 *   校准引擎（calibrationEngine）依赖 stock_price 表的历史个股日行情，按
 *   「基金净值变更日期」精确匹配持仓个股当日涨跌幅，回测模型权重。
 *   此前 stock_price 仅在估值时写入"当天"一条实时行情，缺少历史数据，
 *   导致校准 pairedSamples = 0 → "样本不足"。
 *
 * 本服务：
 *   1. 取基金最新报告期的前十大持仓股票代码；
 *   2. 通过东方财富历史 K 线接口获取每只股票最近 N 天（默认 365）日行情；
 *   3. 清洗后 upsert 进 stock_price（复用现有表结构，不新增字段）；
 *   4. 幂等：唯一键 (stock_code, date) + ON CONFLICT DO UPDATE，重复同步不重复插入；
 *   5. 容错：单只股票失败不影响其他股票；API 失败不污染数据库（先取全量再写）。
 *
 * 不降低 requiredSamples，不伪造数据，不复制当天数据当历史。
 */
const { getDatabase } = require('../database/db');
const dbAsync = require('../database/dbAsync');
const { fetchStockHistory } = require('./marketService');

const DEFAULT_HISTORY_DAYS = 365;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLatestHoldings(fundCode) {
  const db = getDatabase();
  return db.prepare(`
    SELECT stock_code, stock_name, weight, report_date
    FROM fund_holdings
    WHERE fund_code = ?
      AND report_date = (SELECT MAX(report_date) FROM fund_holdings WHERE fund_code = ?)
    ORDER BY weight DESC
  `).all(fundCode, fundCode);
}

function getDistinctHeldStocks() {
  const db = getDatabase();
  return db.prepare('SELECT DISTINCT stock_code FROM fund_holdings').all().map(r => r.stock_code);
}

// 写入统一走 dbAsync：生产（DATABASE_URL）落 PostgreSQL，本地/测试无 DATABASE_URL 时回退 SQLite。
// 用 CURRENT_TIMESTAMP 取代 datetime('now')，使同一段 SQL 在 SQLite 与 PostgreSQL 均合法。
async function upsertStockPrices(records) {
  const sql = `
    INSERT INTO stock_price (stock_code, date, price, change_percent, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(stock_code, date) DO UPDATE SET
      price = excluded.price,
      change_percent = excluded.change_percent,
      updated_at = CURRENT_TIMESTAMP
  `;
  await dbAsync.transaction(async (helpers) => {
    for (const r of records) {
      await helpers.run(sql, [r.stock_code, r.date, r.price, r.change_percent]);
    }
  });
}

/**
 * 同步单只股票最近 days 天的历史日行情到 stock_price。
 * @returns {{stock_code:string,fetched:number,inserted:number,source:?string,start:?string,end:?string,error:?string}}
 */
async function syncStockHistory(stockCode, { days = DEFAULT_HISTORY_DAYS } = {}) {
  let result;
  try {
    result = await fetchStockHistory(stockCode, { limit: days });
  } catch (error) {
    return { stock_code: stockCode, fetched: 0, inserted: 0, source: null, error: error.message };
  }
  if (!result.records.length) {
    return {
      stock_code: stockCode,
      fetched: 0,
      inserted: 0,
      source: result.source,
      error: result.error || 'no-data'
    };
  }
  // 先在内存里收集全部记录，再一次性写入；任一写入异常整体回滚，绝不半写污染。
  try {
    await upsertStockPrices(result.records);
  } catch (error) {
    return { stock_code: stockCode, fetched: result.records.length, inserted: 0, source: result.source, error: error.message };
  }
  return {
    stock_code: stockCode,
    fetched: result.records.length,
    inserted: result.records.length,
    source: result.source,
    start: result.records[0].date,
    end: result.records[result.records.length - 1].date
  };
}

/**
 * 同步某只基金最新报告期全部持仓股票的历史行情。
 */
async function syncFundHoldingsHistory(fundCode, { days = DEFAULT_HISTORY_DAYS } = {}) {
  const holdings = getLatestHoldings(fundCode);
  const perStock = [];
  let totalInserted = 0;
  let failed = 0;
  for (const h of holdings) {
    // 轻微限速，避免触发东方财富限流
    const r = await syncStockHistory(h.stock_code, { days });
    perStock.push(r);
    totalInserted += r.inserted || 0;
    if (r.error) failed += 1;
    await sleep(250);
  }
  return {
    fund_code: fundCode,
    stocks: holdings.length,
    total_inserted: totalInserted,
    failed,
    per_stock: perStock
  };
}

/**
 * 同步数据库中所有出现过持仓的股票的历史行情（用于一次性补齐全部基金的校准样本）。
 */
async function syncAllHoldingsHistory({ days = DEFAULT_HISTORY_DAYS } = {}) {
  const codes = getDistinctHeldStocks();
  const perStock = [];
  let totalInserted = 0;
  let failed = 0;
  for (const code of codes) {
    const r = await syncStockHistory(code, { days });
    perStock.push(r);
    totalInserted += r.inserted || 0;
    if (r.error) failed += 1;
  }
  return {
    stocks: codes.length,
    total_inserted: totalInserted,
    failed,
    per_stock: perStock
  };
}

module.exports = {
  DEFAULT_HISTORY_DAYS,
  getLatestHoldings,
  getDistinctHeldStocks,
  upsertStockPrices,
  syncStockHistory,
  syncFundHoldingsHistory,
  syncAllHoldingsHistory
};
