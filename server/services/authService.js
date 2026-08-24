/**
 * 账号认证服务
 *
 * - 密码使用 Node 内置 scrypt 加盐哈希（不依赖 bcrypt 原生编译）
 * - 会话为随机 Bearer token，存 sessions 表，30 天有效
 */
const crypto = require('node:crypto');
const { get, run, all, transaction } = require('../database/dbAsync');

const SESSION_DAYS = 30;

async function migrateGuestData(userId) {
  if (!userId || userId === 0) return;
  
  await transaction(async ({ all: txAll, get: txGet, run: txRun }) => {
    // 1. Migrate user_data (manual accounts)
    const existingUserData = await txGet('SELECT data FROM user_data WHERE user_id = ?', [userId]);
    const guestUserData = await txGet('SELECT data FROM user_data WHERE user_id = 0');
    if (guestUserData) {
      if (!existingUserData) {
        // If the logged-in user does not have any user_data, migrate the guest user_data
        await txRun(`
          INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
        `, [userId, guestUserData.data]);
      }
      // After copying or resolving, delete the guest's user_data to avoid multiple adoptions
      await txRun('DELETE FROM user_data WHERE user_id = 0');
    }

    // 2. Migrate source_credentials (third-party connections)
    const guestCreds = await txAll('SELECT source_name, token, refresh_token, cookie, user_info, status FROM source_credentials WHERE user_id = 0');
    for (const cred of guestCreds) {
      const existingCred = await txGet('SELECT id FROM source_credentials WHERE user_id = ? AND source_name = ?', [userId, cred.source_name]);
      if (!existingCred) {
        await txRun(`
          INSERT INTO source_credentials (user_id, source_name, token, refresh_token, cookie, user_info, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [userId, cred.source_name, cred.token, cred.refresh_token, cred.cookie, cred.user_info, cred.status]);
      }
    }
    await txRun('DELETE FROM source_credentials WHERE user_id = 0');

    // 3. Migrate portfolio (synced positions)
    const guestPortfolio = await txAll('SELECT account_id, fund_code, shares, cost, amount, category, transactions, is_synced, source_name, converted_at FROM portfolio WHERE user_id = 0');
    for (const item of guestPortfolio) {
      const existingItem = await txGet('SELECT user_id FROM portfolio WHERE user_id = ? AND account_id = ? AND fund_code = ?', [userId, item.account_id, item.fund_code]);
      if (!existingItem) {
        await txRun(`
          INSERT INTO portfolio (user_id, account_id, fund_code, shares, cost, amount, category, transactions, is_synced, source_name, converted_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
          userId,
          item.account_id,
          item.fund_code,
          item.shares,
          item.cost,
          item.amount,
          item.category,
          item.transactions,
          item.is_synced,
          item.source_name,
          item.converted_at
        ]);
      }
    }
    await txRun('DELETE FROM portfolio WHERE user_id = 0');

    // 4. Migrate account_backups (backups)
    await txRun('UPDATE account_backups SET user_id = ? WHERE user_id = 0', [userId]);
  });
}

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
  
  // 注册时，将本机在游客状态下连接的三方账户凭证、同步持仓、备份等无缝合并/迁移至此正式账号
  try {
    await migrateGuestData(userId);
  } catch (e) {
    console.error('[Auth] failed to migrate guest data during register:', e);
  }

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
  
  // 登录时，将本机在游客状态下连接的三方账户凭证、同步持仓、备份等无缝合并/迁移至此正式账号
  try {
    await migrateGuestData(Number(user.id));
  } catch (e) {
    console.error('[Auth] failed to migrate guest data during login:', e);
  }

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
