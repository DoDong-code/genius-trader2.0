const dbAsync = require('../database/dbAsync');
const { assertFundCode, importFund, listFunds } = require('./fundService');

async function getHistory(code, options = {}) {
  const fundCode = assertFundCode(code);
  const limit = Math.min(Math.max(Number(options.limit) || 0, 0), 5000);
  const sql = `
    SELECT date, nav, acc_nav
    FROM fund_nav
    WHERE fund_code = ?
    ORDER BY date ${limit ? 'DESC' : 'ASC'}
    ${limit ? 'LIMIT ?' : ''}
  `;
  const rows = limit
    ? (await dbAsync.all(sql, [fundCode, limit])).reverse()
    : await dbAsync.all(sql, [fundCode]);
  return rows;
}

async function getLatestPair(code) {
  const fundCode = assertFundCode(code);
  return await dbAsync.all(`
    SELECT date, nav, acc_nav
    FROM fund_nav
    WHERE fund_code = ?
    ORDER BY date DESC
    LIMIT 2
  `, [fundCode]);
}

async function syncAll(options = {}) {
  const funds = await listFunds();
  const results = [];
  for (const fund of funds) {
    const startedAt = Date.now();
    try {
      const result = await importFund(fund.fund_code, options);
      results.push({
        fund_code: fund.fund_code,
        success: true,
        inserted: result.inserted,
        records: result.records,
        cached: result.cached,
        duration_ms: Date.now() - startedAt
      });
    } catch (error) {
      results.push({
        fund_code: fund.fund_code,
        success: false,
        error: error.message,
        duration_ms: Date.now() - startedAt
      });
    }
  }
  return results;
}

module.exports = {
  getHistory,
  getLatestPair,
  syncAll
};
