/**
 * 只读外部分析 Token 服务（P1-7 加固，2026-08-26）
 *
 * 安全规则（不变量）：
 *   - 数据库只保存 SHA-256 哈希，不存明文；明文 Token 绝不出现在任何日志 / error / debug 输出。
 *   - 高强度随机 Token（32 字节 base64url），同一用户仅保留一个有效 Token。
 *   - 撤销后立即失效；生产数据 2 小时自动过期。
 *
 * P1-7 性能/安全加固：
 *   1. 短 TTL 校验缓存：避免每次请求都打 DB，也避免“每次请求都 UPDATE last_used_at”。
 *   2. last_used_at 写入节流：仅在距上次写入超过 LAST_USED_THROTTLE_MS 时才落库。
 *   3. 撤销时清空该校验缓存，避免撤销后仍长期有效。
 *   4. 外部 API 速率限制（滑动窗口），超限返回 429。
 */
const crypto = require('node:crypto');
const { run, get } = require('../database/dbAsync');

const VALIDATION_CACHE_TTL_MS = Number(process.env.TOKEN_CACHE_TTL_MS || 60000);
const LAST_USED_THROTTLE_MS = Number(process.env.TOKEN_LAST_USED_THROTTLE_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.EXTERNAL_RATE_LIMIT_MAX || 120);
const RATE_LIMIT_WINDOW_MS = Number(process.env.EXTERNAL_RATE_LIMIT_WINDOW_MS || 60000);

// hash -> { userId, createdAt, lastUsedAt, expiresAt }
const validationCache = new Map();
// rate-limit key -> number[]（最近访问时间戳）
const rateLimitBuckets = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createdTimeOf(row) {
  const raw = row && row.created_at;
  if (raw instanceof Date) return raw.getTime();
  const s = String(raw || '');
  return new Date(s.includes('Z') || s.includes('+') ? s : s + ' UTC').getTime();
}

function lastUsedTimeOf(row) {
  const raw = row && row.last_used_at;
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  const s = String(raw);
  return new Date(s.includes('Z') || s.includes('+') ? s : s + ' UTC').getTime();
}

function clearValidationCache() {
  validationCache.clear();
}

// 滑动窗口速率限制；key 通常为 token 哈希或客户端标识。
function rateLimitAllowed(key) {
  const now = Date.now();
  const arr = rateLimitBuckets.get(key) || [];
  const fresh = arr.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateLimitBuckets.set(key, fresh);
  return true;
}

async function generateToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  await run(
    "UPDATE read_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND revoked_at IS NULL",
    [Number(userId)]
  );
  await run(
    'INSERT INTO read_tokens (user_id, token_hash, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
    [Number(userId), tokenHash]
  );
  clearValidationCache();
  return { token };
}

async function validateToken(token) {
  if (!token || typeof token !== 'string') return null;
  const hash = hashToken(token);

  // 1) 短 TTL 缓存命中：直接返回，避免打 DB 与写 last_used_at。
  const cached = validationCache.get(hash);
  if (cached && Date.now() < cached.expiresAt) {
    return { userId: cached.userId, createdAt: cached.createdAt, lastUsedAt: cached.lastUsedAt, cached: true };
  }

  const row = await get(
    'SELECT id, user_id, created_at, last_used_at, revoked_at FROM read_tokens WHERE token_hash = ?',
    [hash]
  );
  if (!row || row.revoked_at) {
    validationCache.delete(hash);
    return null;
  }

  // 2 小时自动失效
  if (Date.now() - createdTimeOf(row) > 2 * 60 * 60 * 1000) {
    await run('UPDATE read_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
    validationCache.delete(hash);
    return null;
  }

  // 2) last_used_at 写入节流：仅在超过节流窗口时才落库，避免每次请求都 UPDATE。
  if (Date.now() - lastUsedTimeOf(row) > LAST_USED_THROTTLE_MS) {
    await run('UPDATE read_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
  }

  const entry = {
    userId: Number(row.user_id),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS
  };
  validationCache.set(hash, entry);
  return { userId: entry.userId, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt };
}

async function revokeTokens(userId) {
  await run(
    "UPDATE read_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND revoked_at IS NULL",
    [Number(userId)]
  );
  // 3) 撤销即清空校验缓存，避免撤销后短期仍有效。
  clearValidationCache();
}

async function tokenStatus(userId) {
  const row = await get(
    "SELECT id, created_at, last_used_at FROM read_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [Number(userId)]
  );
  if (!row) return { hasToken: false, createdAt: null, lastUsedAt: null };

  if (Date.now() - createdTimeOf(row) > 2 * 60 * 60 * 1000) {
    await run('UPDATE read_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
    clearValidationCache();
    return { hasToken: false, createdAt: null, lastUsedAt: null };
  }
  return { hasToken: true, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

module.exports = {
  generateToken,
  validateToken,
  revokeTokens,
  tokenStatus,
  hashToken,
  rateLimitAllowed,
  clearValidationCache
};
