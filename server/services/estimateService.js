const { getDatabase } = require('../database/db');
const { getLatestPair } = require('./navService');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function estimateFund(fundCode, amount) {
  const history = getLatestPair(fundCode);
  const latest = history[0] || null;
  const previous = history[1] || null;
  const todayChange = latest && previous && previous.nav
    ? latest.nav / previous.nav - 1
    : 0;
  return {
    fund_code: fundCode,
    amount: round(amount),
    nav_date: latest?.date || null,
    today_change: round(todayChange, 6),
    estimate_profit: round(amount * todayChange)
  };
}

function estimatePortfolio(accountId) {
  const normalizedAccount = String(accountId || '').trim();
  if (!normalizedAccount) {
    const error = new Error('账户 ID 不能为空');
    error.statusCode = 400;
    throw error;
  }
  const db = getDatabase();
  const positions = db.prepare(`
    SELECT p.account_id, p.fund_code, p.shares, p.cost, p.amount, f.fund_name
    FROM portfolio p
    JOIN fund f ON f.fund_code = p.fund_code
    WHERE p.account_id = ?
    ORDER BY p.fund_code
  `).all(normalizedAccount);

  const funds = positions.map(position => ({
    ...estimateFund(position.fund_code, position.amount),
    fund_name: position.fund_name,
    shares: position.shares,
    cost: position.cost,
    cumulative_profit: round(position.amount - position.cost)
  }));

  return {
    account_id: normalizedAccount,
    total_asset: round(funds.reduce((sum, item) => sum + item.amount, 0)),
    today_estimate_profit: round(funds.reduce((sum, item) => sum + item.estimate_profit, 0)),
    cumulative_profit: round(funds.reduce((sum, item) => sum + item.cumulative_profit, 0)),
    funds
  };
}

function upsertPosition(position) {
  const accountId = String(position.account_id || '').trim();
  const fundCode = String(position.fund_code || '').trim();
  if (!accountId || !/^\d{6}$/.test(fundCode)) {
    throw new Error('持仓必须包含 account_id 和六位 fund_code');
  }
  getDatabase().prepare(`
    INSERT INTO portfolio (account_id, fund_code, shares, cost, amount)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, fund_code) DO UPDATE SET
      shares = excluded.shares,
      cost = excluded.cost,
      amount = excluded.amount,
      updated_at = datetime('now')
  `).run(
    accountId,
    fundCode,
    Number(position.shares || 0),
    Number(position.cost || 0),
    Number(position.amount || 0)
  );
}

module.exports = {
  estimateFund,
  estimatePortfolio,
  upsertPosition
};
