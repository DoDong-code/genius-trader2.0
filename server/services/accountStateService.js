/**
 * 云端账户状态存储：登录用户的手动账户 / 策略 / 设置（JSON 整包）
 */
const { get, run } = require('../database/dbAsync');

async function getUserState(userId) {
  const row = await get('SELECT data FROM user_data WHERE user_id = ?', [userId]);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (error) {
    return null;
  }
}

async function saveUserState(userId, state) {
  await run(
    `INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(state)]
  );
}

function accountShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function countAccounts(accounts) {
  const shape = accountShape(accounts);
  return shape ? Object.keys(shape).length : 0;
}

function countFunds(accounts) {
  const shape = accountShape(accounts);
  if (!shape) return 0;
  return Object.keys(shape).reduce((sum, name) => {
    const acc = shape[name];
    return sum + (acc && Array.isArray(acc.funds) ? acc.funds.length : 0);
  }, 0);
}

/**
 * 防误覆盖判断（2026-08-26）：云端已有账户数据时，拒绝空 state 覆盖。
 * 覆盖场景：state 为空 / accounts 不存在 / accounts 非对象（含数组）/
 * accounts={} / 云端有持仓但新 state 账户全部为空（被错误恢复成空账户）。
 * @param {object|null} existing 云端现有 state
 * @param {object|null} incoming 待写入的新 state
 * @returns {boolean} true = 属于空覆盖，应拒绝
 */
function isEmptyStateOverwrite(existing, incoming) {
  const existingCount = countAccounts(existing && existing.accounts);
  if (existingCount === 0) return false;
  const incomingAccounts = accountShape(incoming && incoming.accounts);
  if (!incomingAccounts) return true;
  const incomingCount = Object.keys(incomingAccounts).length;
  if (incomingCount === 0) return true;
  const existingFunds = countFunds(existing && existing.accounts);
  const incomingFunds = countFunds(incomingAccounts);
  if (existingFunds > 0 && incomingFunds === 0) return true;
  return false;
}

module.exports = {
  getUserState,
  saveUserState,
  isEmptyStateOverwrite
};
