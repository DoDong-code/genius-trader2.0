/**
 * 第三方凭证存储服务
 *
 * - token / refresh_token / cookie 使用 AES-256-GCM 加密后落库（密钥 SOURCE_SECRET_KEY）
 * - user_info 为 JSON 字符串（同样加密存储）
 * - status: connected / disconnected
 */
const { getDatabase } = require('../database/db');
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
function getCredential(sourceName) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM source_credentials WHERE source_name = ?').get(String(sourceName));
  return rowToCredential(row);
}

/**
 * 保存/更新凭证（token 等敏感字段加密）
 */
function saveCredential({ source_name, token, refresh_token, cookie, user_info, status = 'connected' }) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO source_credentials (source_name, token, refresh_token, cookie, user_info, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(source_name) DO UPDATE SET
      token = excluded.token,
      refresh_token = excluded.refresh_token,
      cookie = excluded.cookie,
      user_info = excluded.user_info,
      status = excluded.status,
      updated_at = datetime('now')
  `).run(
    String(source_name),
    encryptText(token || ''),
    encryptText(refresh_token || ''),
    encryptText(cookie || ''),
    user_info ? JSON.stringify(user_info) : null,
    status
  );
}

/**
 * 标记断开连接（保留记录，token 清空）
 */
function disconnectCredential(sourceName) {
  const db = getDatabase();
  db.prepare(`
    UPDATE source_credentials
    SET status = 'disconnected', token = '', refresh_token = '', cookie = '', updated_at = datetime('now')
    WHERE source_name = ?
  `).run(String(sourceName));
}

/**
 * 删除凭证
 */
function deleteCredential(sourceName) {
  const db = getDatabase();
  db.prepare('DELETE FROM source_credentials WHERE source_name = ?').run(String(sourceName));
}

/**
 * 轻量状态（不返回敏感字段）
 */
function listCredentialStatus() {
  const db = getDatabase();
  const rows = db.prepare('SELECT source_name, status, created_at, updated_at FROM source_credentials').all();
  return rows;
}

module.exports = {
  getCredential,
  saveCredential,
  disconnectCredential,
  deleteCredential,
  listCredentialStatus
};
