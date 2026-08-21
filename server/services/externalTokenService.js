/**
 * 只读外部分析 Token 服务
 *
 * - 高强度随机 Token（32 字节 base64url），数据库只保存 SHA-256 哈希，不存明文
 * - 同一用户仅保留一个有效 Token；重新生成 = 撤销旧的 + 生成新的
 * - 撤销后立即失效
 * - 记录创建时间 / 最后使用时间 / 撤销时间，不记录 Token 明文
 */
const crypto = require('node:crypto');
const { run, get } = require('../database/dbAsync');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function generateToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  // 同一用户只保留一个有效 Token：先撤销旧的
  await run(
    "UPDATE read_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND revoked_at IS NULL",
    [Number(userId)]
  );
  await run(
    'INSERT INTO read_tokens (user_id, token_hash, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
    [Number(userId), tokenHash]
  );
  return { token };
}

async function validateToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await get(
    'SELECT id, user_id, created_at, last_used_at, revoked_at FROM read_tokens WHERE token_hash = ?',
    [hashToken(token)]
  );
  if (!row || row.revoked_at) return null;

  // 生产数据只保留2小时自动删除（过期自动失效）
  let createdTime;
  if (row.created_at instanceof Date) {
    createdTime = row.created_at.getTime();
  } else {
    const createdAtStr = String(row.created_at || '');
    createdTime = new Date(createdAtStr.includes('Z') || createdAtStr.includes('+') ? createdAtStr : createdAtStr + ' UTC').getTime();
  }
  if (Date.now() - createdTime > 2 * 60 * 60 * 1000) {
    await run('UPDATE read_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    return null;
  }

  await run('UPDATE read_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
  return {
    userId: Number(row.user_id),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

async function revokeTokens(userId) {
  await run(
    "UPDATE read_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND revoked_at IS NULL",
    [Number(userId)]
  );
}

async function tokenStatus(userId) {
  const row = await get(
    "SELECT id, created_at, last_used_at FROM read_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [Number(userId)]
  );
  if (!row) {
    return { hasToken: false, createdAt: null, lastUsedAt: null };
  }

  // 生产数据只保留2小时自动删除（过期自动失效）
  let createdTime;
  if (row.created_at instanceof Date) {
    createdTime = row.created_at.getTime();
  } else {
    const createdAtStr = String(row.created_at || '');
    createdTime = new Date(createdAtStr.includes('Z') || createdAtStr.includes('+') ? createdAtStr : createdAtStr + ' UTC').getTime();
  }
  if (Date.now() - createdTime > 2 * 60 * 60 * 1000) {
    await run('UPDATE read_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    return { hasToken: false, createdAt: null, lastUsedAt: null };
  }

  return { hasToken: true, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

module.exports = {
  generateToken,
  validateToken,
  revokeTokens,
  tokenStatus,
  hashToken
};
