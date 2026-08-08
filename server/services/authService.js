/**
 * 账号认证服务
 *
 * - 密码使用 Node 内置 scrypt 加盐哈希（不依赖 bcrypt 原生编译）
 * - 会话为随机 Bearer token，存 sessions 表，30 天有效
 */
const crypto = require('node:crypto');
const { get, run } = require('../database/dbAsync');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const candidate = crypto.scryptSync(String(password), parts[0], 64);
  const expected = Buffer.from(parts[1], 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function register(email, password) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw httpError('请输入有效的邮箱地址', 400);
  }
  if (String(password || '').length < 6) {
    throw httpError('密码至少需要 6 位', 400);
  }
  const existing = await get('SELECT id FROM users WHERE email = ?', [normalized]);
  if (existing) {
    throw httpError('该邮箱已注册，请直接登录', 409);
  }
  const result = await run(
    'INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id',
    [normalized, hashPassword(password)]
  );
  const userId = Number(result.lastInsertRowid || 0);
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
  return { token, user: { id: userId, email: normalized } };
}

async function login(email, password) {
  const normalized = normalizeEmail(email);
  const user = await get('SELECT id, email, password_hash FROM users WHERE email = ?', [normalized]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError('邮箱或密码不正确', 401);
  }
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, expiresAt]);
  return { token, user: { id: Number(user.id), email: user.email } };
}

async function logout(token) {
  if (!token) return;
  await run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function userFromToken(token) {
  if (!token) return null;
  const session = await get('SELECT user_id, expires_at FROM sessions WHERE token = ?', [token]);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  const user = await get('SELECT id, email FROM users WHERE id = ?', [session.user_id]);
  return user || null;
}

function tokenFromRequest(request) {
  const header = (request && request.headers && request.headers.authorization) || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function userFromRequest(request) {
  return userFromToken(tokenFromRequest(request));
}

module.exports = {
  register,
  login,
  logout,
  userFromToken,
  userFromRequest,
  tokenFromRequest
};
