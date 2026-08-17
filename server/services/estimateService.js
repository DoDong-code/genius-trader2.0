const { getDatabase } = require('../database/db');
const dbAsync = require('../database/dbAsync');
const { getLatestPair } = require('./navService');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function dampBondChange(change) {
  if (change === null || change === undefined || !Number.isFinite(change)) return change;
  const abs = Math.abs(change);
  if (abs <= 0.001) return change;
  const sign = Math.sign(change);
  const damped = 0.001 + (abs - 0.001) * 0.1;
  return sign * Math.min(damped, 0.003);
}

async function estimateFund(fundCode, amount) {
  const history = await getLatestPair(fundCode);
  const latest = history[0] || null;
  const previous = history[1] || null;
  let todayChange = latest && previous && previous.nav
    ? latest.nav / previous.nav - 1
    : 0;

  const fund = await dbAsync.get('SELECT fund_type, fund_name FROM fund WHERE fund_code = ?', [fundCode]);
  if (fund && (fund.fund_type?.includes('债券') || fund.fund_type?.includes('纯债') || fund.fund_name?.includes('债券') || fund.fund_name?.includes('纯债'))) {
    todayChange = dampBondChange(todayChange);
  }

  return {
    fund_code: fundCode,
    amount: round(amount),
    nav_date: latest?.date || null,
    today_change: round(todayChange, 6),
    estimate_profit: round(amount * todayChange)
  };
}

async function estimatePortfolio(accountId) {
  const normalizedAccount = String(accountId || '').trim();
  if (!normalizedAccount) {
    const error = new Error('账户 ID 不能为空');
    error.statusCode = 400;
    throw error;
  }
  const positions = await dbAsync.all(`
    SELECT p.account_id, p.fund_code, p.shares, p.cost, p.amount, f.fund_name
    FROM portfolio p
    JOIN fund f ON f.fund_code = p.fund_code
    WHERE p.account_id = ?
    ORDER BY p.fund_code
  `, [normalizedAccount]);

  const funds = await Promise.all(positions.map(async position => ({
    ...await estimateFund(position.fund_code, position.amount),
    fund_name: position.fund_name,
    shares: position.shares,
    cost: position.cost,
    cumulative_profit: round(position.amount - position.cost)
  })));

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
    INSERT INTO portfolio (user_id, account_id, fund_code, shares, cost, amount)
    VALUES (0, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, account_id, fund_code) DO UPDATE SET
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
