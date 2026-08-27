const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const defaultDatabasePath = path.join(__dirname, '..', 'data', 'portfolio.sqlite');
let database;

function databasePath() {
  return path.resolve(process.env.FUND_DB_PATH || defaultDatabasePath);
}

function initialize(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS fund (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_code TEXT NOT NULL UNIQUE,
      fund_name TEXT NOT NULL,
      fund_type TEXT,
      company TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fund_nav (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_code TEXT NOT NULL,
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      acc_nav REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (fund_code, date),
      FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_fund_nav_code_date
      ON fund_nav (fund_code, date DESC);

    CREATE TABLE IF NOT EXISTS fund_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_code TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      weight REAL NOT NULL,
      report_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (fund_code, stock_code, report_date),
      FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stock_price (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      date TEXT NOT NULL,
      price REAL NOT NULL,
      change_percent REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (stock_code, date)
    );

    CREATE TABLE IF NOT EXISTS fund_estimate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      estimate_change REAL NOT NULL,
      holdings_change REAL,
      sector_change REAL,
      cash_adjustment REAL NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL,
      quote_coverage REAL NOT NULL DEFAULT 0,
      calculation_json TEXT,
      calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      UNIQUE (fund_code, trade_date),
      FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_fund_estimate_code_date
      ON fund_estimate (fund_code, trade_date DESC);

    CREATE TABLE IF NOT EXISTS data_sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_key TEXT NOT NULL,
      data_type TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (resource_key, data_type)
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      account_id TEXT NOT NULL,
      fund_code TEXT NOT NULL,
      shares REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      source_name TEXT NOT NULL DEFAULT '',
      converted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, account_id, fund_code),
      FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_account
      ON portfolio (account_id);

    CREATE TABLE IF NOT EXISTS fund_calibration (
      fund_code TEXT PRIMARY KEY,
      optimal_holdings_weight REAL NOT NULL,
      optimal_sector_weight REAL NOT NULL,
      cash_adjustment REAL NOT NULL DEFAULT 0,
      mae REAL,
      rmse REAL,
      direction_accuracy REAL,
      sample_size INTEGER NOT NULL DEFAULT 0,
      calibrated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      source_name TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      cookie TEXT NOT NULL DEFAULT '',
      user_info TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, source_name)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS read_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS account_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      account_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_data_rev (
      user_id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );

    -- P1-9 跨实例调度去重：共享“上次成功执行”时间戳，避免多副本各自记时导致每周/每季任务被重复触发
    CREATE TABLE IF NOT EXISTS sync_markers (
      key TEXT PRIMARY KEY,
      last_run BIGINT NOT NULL DEFAULT 0
    );
  `);

  const stockColumns = db.prepare('PRAGMA table_info(stock_price)').all();
  if (!stockColumns.some(column => column.name === 'updated_at')) {
    db.exec("ALTER TABLE stock_price ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
  }

  // P3.18-NET: fund_nav table columns source and fetched_at
  const navColumns = db.prepare('PRAGMA table_info(fund_nav)').all();
  if (!navColumns.some(column => column.name === 'source')) {
    db.exec("ALTER TABLE fund_nav ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  }
  if (!navColumns.some(column => column.name === 'fetched_at')) {
    db.exec("ALTER TABLE fund_nav ADD COLUMN fetched_at TEXT");
  }

  // 阶段1：同步账户持仓权威化 —— portfolio 表补充类别与交易流水字段
  const portfolioColumns = db.prepare('PRAGMA table_info(portfolio)').all();
  if (!portfolioColumns.some(column => column.name === 'category')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN category TEXT NOT NULL DEFAULT '基金'");
  }
  if (!portfolioColumns.some(column => column.name === 'transactions')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN transactions TEXT NOT NULL DEFAULT '[]'");
  }
  if (!portfolioColumns.some(column => column.name === 'is_synced')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN is_synced INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE portfolio SET is_synced = 1 WHERE account_id LIKE '养基宝-%' OR account_id LIKE '小倍养基-%'");
  }
  if (!portfolioColumns.some(column => column.name === 'source_name')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN source_name TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE portfolio SET source_name = CASE WHEN account_id LIKE '养基宝-%' THEN 'yangjibao' WHEN account_id LIKE '小倍养基-%' THEN 'xiaobeiyangji' ELSE '' END WHERE source_name = ''");
  }
  if (!portfolioColumns.some(column => column.name === 'converted_at')) {
    db.exec('ALTER TABLE portfolio ADD COLUMN converted_at TEXT');
  }

  // 账号功能：同步账户 / 凭证按用户隔离（user_id=0 表示未登录/本地模式）
  const credColumns = db.prepare('PRAGMA table_info(source_credentials)').all();
  if (!credColumns.some(column => column.name === 'user_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    db.exec('ALTER TABLE source_credentials RENAME TO source_credentials_legacy');
    db.exec(`
      CREATE TABLE source_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        source_name TEXT NOT NULL,
        token TEXT NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL DEFAULT '',
        cookie TEXT NOT NULL DEFAULT '',
        user_info TEXT,
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, source_name)
      )
    `);
    db.exec(`
      INSERT INTO source_credentials (user_id, source_name, token, refresh_token, cookie, user_info, status, created_at, updated_at)
      SELECT 0, source_name, token, refresh_token, cookie, user_info, status, created_at, updated_at FROM source_credentials_legacy
    `);
    db.exec('DROP TABLE source_credentials_legacy');
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
  }

  const portfolioColumnsAfter = db.prepare('PRAGMA table_info(portfolio)').all();
  if (!portfolioColumnsAfter.some(column => column.name === 'user_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    db.exec('ALTER TABLE portfolio RENAME TO portfolio_legacy');
    db.exec(`
      CREATE TABLE portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        account_id TEXT NOT NULL,
        fund_code TEXT NOT NULL,
        shares REAL NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        source_name TEXT NOT NULL DEFAULT '',
        converted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        category TEXT NOT NULL DEFAULT '基金',
        transactions TEXT NOT NULL DEFAULT '[]',
        is_synced INTEGER NOT NULL DEFAULT 0,
        UNIQUE (user_id, account_id, fund_code),
        FOREIGN KEY (fund_code) REFERENCES fund(fund_code) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO portfolio (user_id, account_id, fund_code, shares, cost, amount, source_name, converted_at, created_at, updated_at, category, transactions, is_synced)
      SELECT 0, account_id, fund_code, shares, cost, amount, COALESCE(source_name, ''), converted_at, created_at, updated_at, category, transactions, is_synced FROM portfolio_legacy
    `);
    db.exec('DROP TABLE portfolio_legacy');
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE INDEX IF NOT EXISTS idx_portfolio_account ON portfolio (account_id)');
  }

  // 自愈性检查：如果数据库之前已经执行过 user_id 迁移导致丢失了 source_name 或 converted_at 列，在此处重新补全。
  const finalPortfolioColumns = db.prepare('PRAGMA table_info(portfolio)').all();
  if (!finalPortfolioColumns.some(column => column.name === 'source_name')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN source_name TEXT NOT NULL DEFAULT ''");
  }
  if (!finalPortfolioColumns.some(column => column.name === 'converted_at')) {
    db.exec("ALTER TABLE portfolio ADD COLUMN converted_at TEXT");
  }
}

function getDatabase() {
  if (!database) {
    const file = databasePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    database = new DatabaseSync(file);
    initialize(database);
  }
  return database;
}

function transaction(work) {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function closeDatabase() {
  if (database) {
    database.close();
    database = undefined;
  }
}

module.exports = {
  getDatabase,
  transaction,
  closeDatabase,
  databasePath
};
