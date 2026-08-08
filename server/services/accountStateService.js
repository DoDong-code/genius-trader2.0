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

module.exports = {
  getUserState,
  saveUserState
};
