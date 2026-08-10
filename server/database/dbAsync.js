/**
 * 统一异步数据库访问层
 *
 * - 未设置 DATABASE_URL：使用本地 SQLite（node:sqlite，同步内核包成异步接口）
 * - 设置了 DATABASE_URL（如 Render PostgreSQL）：使用 PostgreSQL（pg）
 *
 * SQL 统一使用 `?` 占位符与 CURRENT_TIMESTAMP，PostgreSQL 模式自动转换为 $1/$2…
 * 账号相关的 users / sessions / user_data / portfolio / source_credentials 都走这一层，
 * 从而在 Render 上持久化；行情/估值等可重建缓存仍留在本地 SQLite。
 */
const { Pool } = require('pg');
const { getDatabase } = require('./db');

let pool = null;

function isCloud() {
  return Boolean(process.env.DATABASE_URL);
}

async function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

function convertPlaceholders(sql) {
  if (!isCloud()) return sql;
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function all(sql, params = []) {
  if (isCloud()) {
    const db = await getPool();
    const result = await db.query(convertPlaceholders(sql), params);
    return result.rows;
  }
  return getDatabase().prepare(sql).all(...params);
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

async function run(sql, params = []) {
  if (isCloud()) {
    const db = await getPool();
    const result = await db.query(convertPlaceholders(sql), params);
    return {
      changes: Number(result.rowCount || 0),
      lastInsertRowid: result.rows && result.rows[0] && result.rows[0].id != null ? Number(result.rows[0].id) : 0
    };
  }
  const result = getDatabase().prepare(sql).run(...params);
  return { changes: Number(result.changes || 0), lastInsertRowid: Number(result.lastInsertRowid || 0) };
}

async function exec(sql) {
  if (isCloud()) {
    const db = await getPool();
    await db.query(sql);
    return;
  }
  getDatabase().exec(sql);
}

/**
 * 事务：work 接收 { all, get, run }，统一返回 Promise
 */
async function transaction(work) {
  if (isCloud()) {
    const db = await getPool();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const helpers = {
        all: async (sql, params = []) => (await client.query(convertPlaceholders(sql), params)).rows,
        get: async (sql, params = []) => {
          const rows = (await client.query(convertPlaceholders(sql), params)).rows;
          return rows[0];
        },
        run: async (sql, params = []) => {
          const result = await client.query(convertPlaceholders(sql), params);
          return {
            changes: Number(result.rowCount || 0),
            lastInsertRowid: result.rows && result.rows[0] && result.rows[0].id != null ? Number(result.rows[0].id) : 0
          };
        }
      };
      const result = await work(helpers);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const helpers = {
      all: async (sql, params = []) => db.prepare(sql).all(...params),
      get: async (sql, params = []) => db.prepare(sql).get(...params),
      run: async (sql, params = []) => {
        const result = db.prepare(sql).run(...params);
        return { changes: Number(result.changes || 0), lastInsertRowid: Number(result.lastInsertRowid || 0) };
      }
    };
    const result = await work(helpers);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * PostgreSQL 云端表结构（Render 上新建库时调用；SQLite 由 db.js 负责）
 */
async function ensureCloudSchema() {
  if (!isCloud()) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS fund (
      fund_code TEXT PRIMARY KEY,
      fund_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      account_id TEXT NOT NULL,
      fund_code TEXT NOT NULL,
      shares REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      source_name TEXT NOT NULL DEFAULT '',
      converted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      category TEXT NOT NULL DEFAULT '基金',
      transactions TEXT NOT NULL DEFAULT '[]',
      is_synced INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, account_id, fund_code)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cloud_portfolio_user ON portfolio (user_id, account_id)`,
    `ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ`,
    `UPDATE portfolio SET source_name = CASE WHEN account_id LIKE '养基宝-%' THEN 'yangjibao' WHEN account_id LIKE '小倍养基-%' THEN 'xiaobeiyangji' ELSE source_name END WHERE source_name = ''`,
    `CREATE TABLE IF NOT EXISTS source_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      source_name TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      cookie TEXT NOT NULL DEFAULT '',
      user_info TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, source_name)
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  const db = await getPool();
  for (const statement of statements) {
    await db.query(statement);
  }
  console.log('[dbAsync] PostgreSQL schema ready');
}

module.exports = {
  isCloud,
  all,
  get,
  run,
  exec,
  transaction,
  ensureCloudSchema
};
