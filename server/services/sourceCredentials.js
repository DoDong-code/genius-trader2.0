/**
 * 第三方凭证存储服务
 *
 * - token / refresh_token / cookie 使用 AES-256-GCM 加密后落库（密钥 SOURCE_SECRET_KEY）
 * - user_info 为 JSON 字符串（同样加密存储）
 * - status: connected / disconnected
 * - user_id=0 表示未登录/本地模式；登录用户使用自己的 user_id 隔离凭证
 */
const { run, get, all } = require('../database/dbAsync');
const { encryptText, decryptText } = require('../utils/crypto');

function rowToCredential(row) {
  if (!row) return null;
  return {
    id: row.id,
    source_name: row.source_name,
    token: decryptText(row.token),
    refresh_token: decryptText(row.refresh_token),
    cookie: decryptText(row.cookie),
    user_info: row.user_info ? JSON.parse(row.user_info) : null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * 读取凭证（解密后返回）
 */
async function getCredential(sourceName, userId = 0) {
  const row = await get(
    'SELECT * FROM source_credentials WHERE user_id = ? AND source_name = ?',
    [userId, String(sourceName)]
  );
  return rowToCredential(row);
}

/**
 * 读取已连接凭证（含跨用户兜底）
 *
 * 个人应用场景：只要任意一个入口登录过第三方，估值 / 状态 / 同步即可复用该凭证。
 * 查找顺序：当前用户 → 本地用户(user_id=0) → 最近更新的任意已连接凭证。
 */
async function getConnectedCredential(sourceName, userId = 0) {
  const candidates = [];
  const primary = await getCredential(sourceName, userId);
  if (primary) candidates.push(primary);
  if (Number(userId) !== 0) {
    const guest = await getCredential(sourceName, 0);
    if (guest) candidates.push(guest);
  }
  const rows = await all(
    `SELECT * FROM source_credentials
     WHERE source_name = ? AND status = 'connected' AND token != ''
     ORDER BY updated_at DESC LIMIT 1`,
    [String(sourceName)]
  );
  if (rows && rows.length) candidates.push(rowToCredential(rows[0]));
  return candidates.find(c => c && c.status === 'connected' && c.token) || null;
}

/**
 * 保存/更新凭证（token 等敏感字段加密）
 */
async function saveCredential({ source_name, token, refresh_token, cookie, user_info, status = 'connected' }, userId = 0) {
  await run(`
    INSERT INTO source_credentials (user_id, source_name, token, refresh_token, cookie, user_info, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, source_name) DO UPDATE SET
      token = excluded.token,
      refresh_token = excluded.refresh_token,
      cookie = excluded.cookie,
      user_info = excluded.user_info,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `, [
    userId,
    String(source_name),
    encryptText(token || ''),
    encryptText(refresh_token || ''),
    encryptText(cookie || ''),
    user_info ? JSON.stringify(user_info) : null,
    status
  ]);
}

/**
 * 标记断开连接（保留记录，token 清空）
 */
async function disconnectCredential(sourceName, userId = 0) {
  await run(`
    UPDATE source_credentials
    SET status = 'disconnected', token = '', refresh_token = '', cookie = '', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND source_name = ?
  `, [userId, String(sourceName)]);
}

/**
 * 断开某数据源的全部凭证（个人应用：一份登录全局生效，退出也应全局生效）
 */
async function disconnectAllCredentials(sourceName) {
  await run(`
    UPDATE source_credentials
    SET status = 'disconnected', token = '', refresh_token = '', cookie = '', updated_at = CURRENT_TIMESTAMP
    WHERE source_name = ?
  `, [String(sourceName)]);
}

/**
 * 删除凭证
 */
async function deleteCredential(sourceName, userId = 0) {
  await run('DELETE FROM source_credentials WHERE user_id = ? AND source_name = ?', [userId, String(sourceName)]);
}

/**
 * 轻量状态（不返回敏感字段）
 */
async function listCredentialStatus(userId = 0) {
  return all(
    'SELECT source_name, status, created_at, updated_at FROM source_credentials WHERE user_id = ?',
    [userId]
  );
}

module.exports = {
  getCredential,
  getConnectedCredential,
  saveCredential,
  disconnectCredential,
  disconnectAllCredentials,
  deleteCredential,
  listCredentialStatus
};
