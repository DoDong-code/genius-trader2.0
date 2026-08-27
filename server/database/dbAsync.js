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

let pool = null;

// 懒加载本地 SQLite 访问层：仅在非云端（无 DATABASE_URL）模式下才会真正 require，
// 避免云端启动时加载 node:sqlite 与打开本地库文件，也便于云端单元测试注入 mock。
let _localDb = null;
function getDatabase() {
  if (!_localDb) {
    _localDb = require('./db').getDatabase();
  }
  return _localDb;
}

function isCloud() {
  return Boolean(process.env.DATABASE_URL);
}

// 每条语句的超时（statement_timeout）：通过连接选项在每次物理建连时设置，
// 覆盖单行查询与事务内所有语句（等价于 query timeout / transaction timeout）。
// 用 options 一次性设置，避免每条查询额外 SET 往返。
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000);

// 获取连接时的“池满快速失败”超时：超过该时间仍未拿到连接则直接 reject（503），
// 绝不无限排队，避免请求链路永久 pending。超时后若连接稍后到达会自动 release，杜绝连接泄漏。
const ACQUIRE_TIMEOUT_MS = Number(process.env.PG_ACQUIRE_TIMEOUT_MS || 5000);

async function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 15),
      // 建连超时：从 30s 降到 10s（合理值），避免单条建连长时间挂起占用事件循环
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 60000),
      // 在物理建连时生效的会话级语句超时（覆盖 query 与 transaction 内全部语句）
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`
    });
    // P0 健壮性修复（Phase 3.1.2）：PG idle client / 连接错误若未监听会冒泡为
    // 未处理的 'error' 事件，导致 Node 进程退出（Render 自动重启）。
    // 注册错误监听，仅记录不吞掉查询异常——查询 await 失败仍按原路径抛出 → API 返回 500。
    pool.on('error', (err) => {
      console.error('[dbAsync] PostgreSQL pool idle/connection error (non-fatal, 不终止进程):', err && err.message);
    });
  }
  return pool;
}

/**
 * 从连接池获取一个客户端，并自带“池满快速失败”语义：
 * - 在 ACQUIRE_TIMEOUT_MS 内未拿到连接 → reject（code POOL_ACQUIRE_TIMEOUT, 503），绝不无限排队。
 * - 超时放弃后，若连接稍后到达会自动 release，避免连接泄漏。
 * - 返回的连接由调用方在 finally 中 release。
 */
async function acquireClient() {
  const poolInstance = await getPool();
  const connectPromise = poolInstance.connect();
  let timedOut = false;
  let timer = null;
  // 若已超时放弃，连接稍后到达时自动归还池中，避免连接泄漏。
  // 注意：成功拿到连接后本闭包不会进入 release 分支（timedOut=false）。
  connectPromise.then(
    (c) => { if (timedOut) { try { c.release(); } catch (e) {} } },
    () => {}
  );
  const timeoutPromise = new Promise((_, reject) => {
    // 严禁 unref —— 若请求是进程唯一工作，unref 会让定时器永不触发，
    // 请求无限挂起，彻底违背“池满快速失败”初衷。定时器必须在 ACQUIRE_TIMEOUT_MS 时真实触发。
    timer = setTimeout(() => {
      timedOut = true;
      const err = new Error('[dbAsync] 连接池已满，快速失败（acquire timeout）');
      err.code = 'POOL_ACQUIRE_TIMEOUT';
      err.statusCode = 503;
      reject(err);
    }, ACQUIRE_TIMEOUT_MS);
  });
  let client;
  try {
    client = await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    // 无论成功/超时/异常，都清除定时器：成功路径下定时器尚未触发，必须主动清除以杜绝定时器泄漏；
    // 超时路径下定时器已触发，clearTimeout 为 no-op，无害。
    if (timer) clearTimeout(timer);
  }
  return client;
}

// 建立连接的重试包装器（仅用于启动期 ensureCloudSchema 的冷启动/握手抖动，非请求路径）：
// 仅在连接层超时/网络错误时有限重试（默认 2 次），不重试鉴权错误，避免放大 PG 压力。
async function connectWithRetry(poolInstance) {
  let attempts = Number(process.env.PG_CONNECT_RETRIES || 2);
  while (attempts > 0) {
    try {
      return await poolInstance.connect();
    } catch (err) {
      attempts--;
      const isConnectTimeout = err && err.message && (
        err.message.includes('timeout exceeded when trying to connect') ||
        err.message.includes('timeout') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ECONNREFUSED')
      );
      if (isConnectTimeout && attempts > 0) {
        console.warn(`[dbAsync] DB connection timeout/error, retrying in 1000ms... (${attempts} attempts left):`, err.message);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      throw err;
    }
  }
}

// 统一包装云端查询，自动实现连接生命周期管理与 finally release
async function queryCloud(sql, params = []) {
  const client = await acquireClient();
  try {
    return await client.query(convertPlaceholders(sql), params);
  } finally {
    client.release();
  }
}

function convertPlaceholders(sql) {
  if (!isCloud()) return sql;
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function all(sql, params = []) {
  if (isCloud()) {
    const result = await queryCloud(sql, params);
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
    const result = await queryCloud(sql, params);
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
    await queryCloud(sql);
    return;
  }
  getDatabase().exec(sql);
}

/**
 * 事务：work 接收 { all, get, run }，统一返回 Promise
 */
async function transaction(work) {
  if (isCloud()) {
    const client = await acquireClient();
    // 事务整体超时看门狗：statement_timeout 已覆盖单语句，这里兜底“整体预算”。
    // 超预算时必须真实 reject（而非仅静默 ROLLBACK），否则一个卡死的事务会永久占用 PG client。
    const txnTimeoutMs = Number(process.env.PG_TRANSACTION_TIMEOUT_MS || 20000);
    let watchdog = null;
    const timeoutError = new Error('[dbAsync] transaction 整体超时，强制 ROLLBACK');
    timeoutError.code = 'TRANSACTION_TIMEOUT';
    timeoutError.statusCode = 504;
    try {
      await client.query('BEGIN');
      // work 包成 Promise：即使 work 内部同步抛错也能被正确 race/reject，不会泄漏。
      const workPromise = Promise.resolve().then(() => {
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
        return work(helpers);
      });
      const timeoutPromise = new Promise((_, reject) => {
        // 严禁 unref —— 保证 watchdog 在事务卡死（无其他事件）时仍能真实触发。
        watchdog = setTimeout(() => {
          reject(timeoutError);
        }, txnTimeoutMs);
      });
      const result = await Promise.race([workPromise, timeoutPromise]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (watchdog) clearTimeout(watchdog); // 成功或超时都清除定时器，杜绝泄漏
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
    // —— 当天净值缓存（P3.18-NET）：fund_nav 即当天净值缓存表（fund_code+date 唯一）；
    // source 记录净值来源（xiaobeiyangji/yangjibao/天天基金…），fetched_at 记录获取时间 ——
    `ALTER TABLE fund_nav ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE fund_nav ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ`,
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
    // —— P0-5 CAS 修订号表：user_data 写入前比对 revision，冲突即拒绝（消除 last-write-wins）——
    `CREATE TABLE IF NOT EXISTS user_data_rev (
      user_id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    )`,
    // —— P1-9 跨实例调度去重共享标记：与 SQLite sync_markers 对齐，云端也用 PG 存储「上次成功执行」时间戳 ——
    `CREATE TABLE IF NOT EXISTS sync_markers (
      key TEXT PRIMARY KEY,
      last_run BIGINT NOT NULL DEFAULT 0
    )`,
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
    )`,
    // —— 阶段3.1.2 修复（P0 架构断裂）：fund_estimate 从 SQLite 迁至 PostgreSQL ——
    // 此前 fund_estimate 落在 Render 临时 SQLite，且外键指向空的 SQLite fund 表，
    // 导致每只基金 /estimate 写入时 FOREIGN KEY constraint failed → API 500。
    // 现与 fund_nav / fund_holdings 一致使用 PG，外键指向 PG fund（始终有对应行）。
    `CREATE TABLE IF NOT EXISTS fund_estimate (
      id SERIAL PRIMARY KEY,
      fund_code TEXT NOT NULL REFERENCES fund(fund_code) ON DELETE CASCADE,
      trade_date TEXT NOT NULL,
      estimate_change REAL NOT NULL,
      holdings_change REAL,
      sector_change REAL,
      cash_adjustment REAL NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL,
      quote_coverage REAL NOT NULL DEFAULT 0,
      calculation_json TEXT,
      calculated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (fund_code, trade_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fund_estimate_code_date ON fund_estimate (fund_code, trade_date DESC)`
  ];
  // 使用专用连接执行 schema DDL（不占用连接池其它连接），并在该连接会话上
  // 设置 lock_timeout / statement_timeout，避免 DDL 在等待表锁时永久 pending、
  // 进而阻塞 server.listen() 导致 Render No open ports。
  let client;
  try {
    const poolInstance = await getPool();
    client = await connectWithRetry(poolInstance);
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '30s'");
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      try {
        await client.query(statement);
      } catch (err) {
        const code = (err && err.code) || 'UNKNOWN';
        const firstLine = String(statement).split('\n')[0].slice(0, 120);
        console.error(
          '[dbAsync] Cloud schema initialization failed\n' +
          `  index=${i}\n` +
          `  statement=${firstLine}\n` +
          `  code=${code}\n` +
          `  message=${err && err.message ? err.message : err}`
        );
        throw err; // 明确 reject，绝不永久 pending
      }
    }
    console.log('[dbAsync] PostgreSQL schema ready');
  } finally {
    if (client) client.release(); // 禁止遗漏 release
  }
}

/**
 * 连接池监控指标（active/idle/waiting/total），供健康探针/日志使用。
 * 未初始化时返回全 0，不会触发建连。
 */
function poolStats() {
  if (!pool) return { total: 0, idle: 0, waiting: 0, active: 0 };
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    active: pool.totalCount - pool.idleCount
  };
}

// 仅供测试：读取当前连接池 / 重置（避免跨测试串池）
function __getPool() {
  return pool;
}
function __resetForTest() {
  pool = null;
  _localDb = null;
}

/**
 * 跨实例调度共享标记（P1-9）：读写「某任务上次成功执行」的时间戳。
 * 云端走 PostgreSQL sync_markers 表；本地走 SQLite sync_markers 表（db.js 已建）。
 * 两者都用 IF NOT EXISTS 创建，且使用 upsert，绝不破坏现有数据。
 */
async function getSyncMarker(key) {
  const row = await get('SELECT last_run FROM sync_markers WHERE key = ?', [key]);
  return row ? Number(row.last_run) : 0;
}

async function setSyncMarker(key, ts) {
  await run(
    'INSERT INTO sync_markers (key, last_run) VALUES (?, ?) ' +
    'ON CONFLICT (key) DO UPDATE SET last_run = EXCLUDED.last_run',
    [key, ts]
  );
}

module.exports = {
  isCloud,
  all,
  get,
  run,
  exec,
  transaction,
  ensureCloudSchema,
  poolStats,
  acquireClient,
  getSyncMarker,
  setSyncMarker,
  __getPool,
  __resetForTest
};
