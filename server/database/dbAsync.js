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
    // 阶段2：补全 fund 表 id / fund_type / company（与本地 SQLite DDL 对齐；fund_code 仍为主键）
    `ALTER TABLE fund ADD COLUMN IF NOT EXISTS id SERIAL`,
    `ALTER TABLE fund ADD COLUMN IF NOT EXISTS fund_type TEXT`,
    `ALTER TABLE fund ADD COLUMN IF NOT EXISTS company TEXT`,
    // 阶段2：fund_nav / fund_holdings 持久化迁入 PostgreSQL（与 fund 共用 DATABASE_URL；本地无 DATABASE_URL 时回退 SQLite）
    `CREATE TABLE IF NOT EXISTS fund_nav (
      id SERIAL PRIMARY KEY,
      fund_code TEXT NOT NULL REFERENCES fund(fund_code) ON DELETE CASCADE,
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      acc_nav REAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (fund_code, date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fund_nav_code_date ON fund_nav (fund_code, date DESC)`,
    `CREATE TABLE IF NOT EXISTS fund_holdings (
      id SERIAL PRIMARY KEY,
      fund_code TEXT NOT NULL REFERENCES fund(fund_code) ON DELETE CASCADE,
      stock_code TEXT NOT NULL,
      stock_name TEXT,
      weight REAL NOT NULL DEFAULT 0,
      report_date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (fund_code, stock_code, report_date)
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
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE user_data DROP CONSTRAINT IF EXISTS user_data_user_id_fkey`,
    `CREATE TABLE IF NOT EXISTS read_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS account_backups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      account_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_account_backups_user ON account_backups (user_id, id DESC)`,
    // —— 持久化迁移（A3 修复）：stock_price / fund_calibration 从本地 SQLite 迁至 PostgreSQL ——
    // 此前这两张表落在 Render 的临时 SQLite，实例重启/重新部署后被清空，导致 calibration 样本归零。
    // 现与账号层共用同一 DATABASE_URL 的 PostgreSQL，保证跨重启持久。本地无 DATABASE_URL 时仍走 SQLite 回退。
    `CREATE TABLE IF NOT EXISTS stock_price (
      id SERIAL PRIMARY KEY,
      stock_code TEXT NOT NULL,
      date TEXT NOT NULL,
      price REAL NOT NULL,
      change_percent REAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (stock_code, date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stock_price_code_date ON stock_price (stock_code, date DESC)`,
    `CREATE TABLE IF NOT EXISTS fund_calibration (
      fund_code TEXT PRIMARY KEY,
      optimal_holdings_weight REAL NOT NULL,
      optimal_sector_weight REAL NOT NULL,
      cash_adjustment REAL NOT NULL DEFAULT 0,
      mae REAL,
      rmse REAL,
      direction_accuracy REAL,
      sample_size INTEGER NOT NULL DEFAULT 0,
      calibrated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
