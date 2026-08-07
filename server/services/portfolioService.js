/**
 * 同步账户持仓权威存储（阶段1）
 *
 * 同步账户（养基宝-* / 小倍养基-*）的持仓写入服务端 portfolio 表，
 * 前端只做展示；手动账户仍保存在浏览器 localStorage，互不干扰。
 */
const { getDatabase, transaction } = require('../database/db');
const { PARENT_PREFIX } = require('./importProvider');

const SYNC_PREFIXES = Object.values(PARENT_PREFIX); // ['养基宝', '小倍养基']

function upsertFund(fundCode, fundName) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO fund (fund_code, fund_name, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(fund_code) DO UPDATE SET fund_name = excluded.fund_name, updated_at = datetime('now')
  `).run(String(fundCode), String(fundName || fundCode));
}

/**
 * 整账户替换：先清空该同步账户的持仓，再写入最新数据（覆盖重导语义）
 * @param {string} accountName 账户名（如 养基宝-天天基金）
 * @param {Array} funds Genius Trader 基金结构
 */
function replaceSyncedAccount(accountName, funds) {
  transaction(db => {
    db.prepare('DELETE FROM portfolio WHERE account_id = ?').run(String(accountName));
    const insert = db.prepare(`
      INSERT INTO portfolio (account_id, fund_code, shares, cost, amount, category, transactions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    (funds || []).forEach(fund => {
      if (!fund || !fund.code) return;
      const amount = Number(fund.amount) || 0;
      const shares = Number(fund.shares) || 0;
      const costNav = Number(fund.costNav) || 0;
      // 成本：优先用数据源单位成本 × 份额；否则用 市值 - 收益
      const cost = costNav > 0 && shares > 0
        ? costNav * shares
        : Math.max(0, amount - (Number(fund.holdingProfit) || 0));
      upsertFund(fund.code, fund.name);
      insert.run(
        String(accountName),
        String(fund.code),
        shares,
        cost,
        amount,
        String(fund.category || '基金'),
        JSON.stringify(Array.isArray(fund.transactions) ? fund.transactions : [])
      );
    });
  });
}

/**
 * 读取全部同步账户（Genius Trader 账户结构，供前端展示）
 */
function listSyncedAccounts() {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT p.account_id, p.fund_code, p.shares, p.cost, p.amount, p.category, p.transactions,
           f.fund_name
    FROM portfolio p
    JOIN fund f ON f.fund_code = p.fund_code
    ORDER BY p.account_id, p.created_at
  `).all();

  const byAccount = new Map();
  rows.forEach(row => {
    const accountName = String(row.account_id);
    // 只返回同步账户（按前缀识别），排除历史种子数据等非同步账户
    if (!SYNC_PREFIXES.some(prefix => accountName.startsWith(prefix))) return;
    if (!byAccount.has(accountName)) {
      byAccount.set(accountName, { name: accountName, funds: [], strategy: [], closedPositions: [] });
    }
    const account = byAccount.get(accountName);
    const amount = Number(row.amount) || 0;
    const cost = Number(row.cost) || 0;
    const shares = Number(row.shares) || 0;
    const holdingProfit = amount - cost;
    const holdingRate = cost > 0 ? holdingProfit / cost : 0;
    let transactions = [];
    try { transactions = JSON.parse(row.transactions || '[]'); } catch (e) { transactions = []; }
    account.funds.push({
      code: String(row.fund_code),
      name: String(row.fund_name || row.fund_code),
      category: String(row.category || '基金'),
      amount,
      holdingProfit,
      holdingRate,
      hold: holdingRate,
      shares,
      costNav: shares > 0 ? cost / shares : 0,
      transactions,
      today: 0,
      manualToday: null,
      holdings: []
    });
  });
  return [...byAccount.values()];
}

/**
 * 清空某个同步账户
 */
function clearSyncedAccount(accountName) {
  const db = getDatabase();
  db.prepare('DELETE FROM portfolio WHERE account_id = ?').run(String(accountName));
}

module.exports = {
  replaceSyncedAccount,
  listSyncedAccounts,
  clearSyncedAccount,
  upsertFund
};
