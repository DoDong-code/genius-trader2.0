/**
 * 同步账户持仓权威存储（阶段1）
 *
 * 同步账户（养基宝-* / 小倍养基-*）的持仓写入服务端 portfolio 表，
 * 前端只做展示；手动账户仍保存在浏览器 localStorage，互不干扰。
 *
 * user_id=0 表示未登录/本地模式；登录用户使用自己的 user_id 隔离数据。
 */
const { run, all, transaction } = require('../database/dbAsync');

function fundUpsertSql() {
  return `
    INSERT INTO fund (fund_code, fund_name, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(fund_code) DO UPDATE SET fund_name = excluded.fund_name, updated_at = CURRENT_TIMESTAMP
  `;
}

async function upsertFund(fundCode, fundName) {
  await run(fundUpsertSql(), [String(fundCode), String(fundName || fundCode)]);
}

/**
 * 整账户替换：先清空该用户的同步账户持仓，再写入最新数据（覆盖重同步语义）
 * @param {string} accountName 账户名称（如 养基宝-天天基金）
 * @param {Array} funds Genius Trader 基金结构
 * @param {number} userId 用户 ID，默认 0（未登录）
 */
async function replaceSyncedAccount(accountName, funds, userId = 0, sourceName = '') {
  await transaction(async ({ run: txRun }) => {
    await txRun('DELETE FROM portfolio WHERE user_id = ? AND account_id = ?', [userId, String(accountName)]);
    for (const fund of funds || []) {
      if (!fund || !fund.code) continue;
      const amount = Number(fund.amount) || 0;
      const shares = Number(fund.shares) || 0;
      const costNav = Number(fund.costNav) || 0;
      // 成本：优先用数据源单位成本 × 份额；否则用 市值 - 收益
      const cost = costNav > 0 && shares > 0
        ? costNav * shares
        : Math.max(0, amount - (Number(fund.holdingProfit) || 0));
      await txRun(fundUpsertSql(), [String(fund.code), String(fund.name || fund.code)]);
      await txRun(`
        INSERT INTO portfolio (user_id, account_id, fund_code, shares, cost, amount, category, transactions, is_synced, source_name, converted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        userId,
        String(accountName),
        String(fund.code),
        shares,
        cost,
        amount,
        String(fund.category || '基金'),
        JSON.stringify(Array.isArray(fund.transactions) ? fund.transactions : []),
        String(sourceName || '')
      ]);
    }
  });
}

/**
 * 读取某用户的全部同步账户（Genius Trader 账户结构，供前端展示）
 */
async function listSyncedAccounts(userId = 0) {
  const rows = await all(`
    SELECT p.account_id, p.fund_code, p.shares, p.cost, p.amount, p.category, p.transactions,
           p.source_name, f.fund_name
    FROM portfolio p
    JOIN fund f ON f.fund_code = p.fund_code
    WHERE p.is_synced = 1 AND p.converted_at IS NULL AND p.user_id = ?
    ORDER BY p.account_id, p.created_at
  `, [userId]);

  const byAccount = new Map();
  rows.forEach(row => {
    const accountName = String(row.account_id);
    if (!byAccount.has(accountName)) {
      byAccount.set(accountName, {
        name: accountName,
        source_name: String(row.source_name || ''),
        funds: [],
        strategy: [],
        closedPositions: []
      });
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
 * 清空某用户的同步账户
 */
async function clearSyncedAccount(accountName, userId = 0) {
  await run('DELETE FROM portfolio WHERE user_id = ? AND account_id = ?', [userId, String(accountName)]);
}

/**
 * 退出第三方数据源时，删除该数据源的全部同步账户（个人应用：一份登录全局生效）
 */
async function clearSyncedAccountsBySource(sourceName) {
  await run('DELETE FROM portfolio WHERE source_name = ?', [String(sourceName)]);
}

/**
 * 用户主动修改同步账户（改名/移动）后，将其标记为“已转换”，
 * 原记录保留（休眠），不再参与同步列表，也不会被自动恢复。
 */
async function markSyncedAccountConverted(accountName, userId = 0) {
  await run(
    'UPDATE portfolio SET converted_at = COALESCE(converted_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND account_id = ?',
    [userId, String(accountName)]
  );
}

module.exports = {
  replaceSyncedAccount,
  listSyncedAccounts,
  clearSyncedAccount,
  clearSyncedAccountsBySource,
  markSyncedAccountConverted,
  upsertFund
};
