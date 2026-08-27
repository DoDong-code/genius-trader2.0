/**
 * stress/pgShim.cjs — 压力测试注入垫片（仅测试用，不修改任何业务代码）
 *
 * 通过 preload（-r）或 require 加载，干两件事：
 *   1) 覆盖 require('pg') 为 SQLite 支撑的 FakePool/FakeClient（云端 DATABASE_URL 路径真正跑起来）；
 *      - 每个 FakeClient 持有独立的 node:sqlite 连接，事务隔离近似真实 PG；
 *      - 支撑 user_data / user_data_rev / sync_markers / fund / fund_nav 等全部云端表；
 *      - DDL 容错（CREATE/ALTER/SET 等失败即忽略，绝不抛错拖垮启动）；
 *      - 故障注入：poolMax 调小模拟池满、slowQueryMs 模拟慢查询/事务超时、acquireDelayMs 模拟获取超时。
 *   2) 覆盖 globalThis.fetch，对所有非 localhost 的外部 Provider 请求做故障注入（500/timeout/abort/slow）
 *      并统计 Provider 请求量（用于验证“不指数级增长 / 不删 Provider”）。
 *   3) 在【服务端进程】内每 1s 采样内存 / event loop delay / PG 池 / Provider 并发，写入 STRESS_METRICS_FILE。
 *
 * 业务代码路径（dbAsync.acquireClient / transaction / accountStateService.CAS / 路由）全部按原样执行，
 * 只是底层的 pg / fetch 被替换为可控垫片。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const STRESS_DIR = __dirname;
const CONTROL_FILE = process.env.STRESS_CONTROL_FILE || path.join(STRESS_DIR, '.stress_fault.json');
const METRICS_FILE = process.env.STRESS_METRICS_FILE || path.join(STRESS_DIR, '.stress_metrics.json');
const PG_FILE = process.env.STRESS_PG_FILE || path.join(os.tmpdir(), 'gt_stress_pg.sqlite');

// ---------- 故障控制（轮询） ----------
const fault = {
  pgMode: 'normal',       // normal | pool-full | slow-query | transaction-timeout | acquire-timeout
  slowQueryMs: 0,         // DML 查询延迟（模拟慢查询；> PG_TRANSACTION_TIMEOUT_MS 即触发事务看门狗）
  acquireDelayMs: 0,      // connect() 获取延迟（模拟获取超时）
  poolMax: 15,            // 模拟连接池上限（调小→池满 / acquire timeout）
  providerMode: 'normal', // normal | 500 | timeout | abort | slow
  providerLatencyMs: 0
};
function loadFault() {
  try {
    const f = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    Object.assign(fault, f);
  } catch (_) { /* 无控制文件则用默认 normal */ }
}
loadFault();
const faultTimer = setInterval(loadFault, 400);
if (faultTimer.unref) faultTimer.unref();

// 把故障模式对映到具体参数
function applyMode() {
  if (fault.pgMode === 'pool-full' || fault.pgMode === 'acquire-timeout') {
    fault.poolMax = Math.min(fault.poolMax || 15, 2);
    if (fault.pgMode === 'acquire-timeout') fault.acquireDelayMs = Math.max(fault.acquireDelayMs || 0, 6000);
    else fault.slowQueryMs = Math.max(fault.slowQueryMs || 0, 5000); // 让在途请求长时间占连接 → 溢出排队超 5s
  } else if (fault.pgMode === 'slow-query') {
    fault.slowQueryMs = Math.max(fault.slowQueryMs || 0, 2500);
  } else if (fault.pgMode === 'transaction-timeout') {
    fault.slowQueryMs = Math.max(fault.slowQueryMs || 0, 25000); // > PG_TRANSACTION_TIMEOUT_MS(20000)
  } else {
    fault.slowQueryMs = 0;
    fault.acquireDelayMs = 0;
  }
}
applyMode();
const applyModeTimer = setInterval(applyMode, 400);
if (applyModeTimer.unref) applyModeTimer.unref();

// ---------- 指标累计 ----------
const metrics = {
  startedAt: Date.now(),
  heapUsedStart: 0,
  heapUsedPeak: 0,
  heapUsedEnd: 0,
  rssPeak: 0,
  elPeakMs: 0,
  pgWaitingPeak: 0,
  providerQueuePeak: 0,
  providerTotal: 0,
  providerActiveMax: 0,
  samples: 0
};
const provider = { total: 0, active: 0 };

// ---------- 按 Provider 维度统计（host 归一化） ----------
// 用于验证：请求量 / 成功 / 错误(500) / 超时(客户端Abort触发) / 中断(shim abort) /
// fallback(该 Provider 失败从而触发服务端降级兜底的次数) / 在途(active) / 在途峰值。
// 不影响任何业务代码，仅观测。
const providerStats = {};
function newProviderStat() {
  return {
    requests: 0, success: 0, error: 0, timeout: 0, abort: 0, fallback: 0,
    active: 0, activePeak: 0
  };
}
function getProviderStat(name) {
  if (!providerStats[name]) providerStats[name] = newProviderStat();
  return providerStats[name];
}
function providerNameForHost(host) {
  if (!host) return 'other';
  if (/query1\.finance\.yahoo\.com/i.test(host)) return 'yahoo';
  if (/xiaobeiyangji\.com/i.test(host)) return 'xiaobeiyangji';
  if (/yangjibao\.com/i.test(host)) return 'yangjibao';
  if (/api\.fund\.eastmoney\.com/i.test(host)) return 'eastmoney';
  if (/eastmoney\.com/i.test(host)) return 'eastmoney';
  if (/sina\.com\.cn/i.test(host)) return 'sina';
  if (/gtimg\.qq|gu\.qq|web\.ifzq\.gtimg|qq\.com/i.test(host)) return 'tencent';
  if (/tencent\.com/i.test(host)) return 'tencent';
  return 'other';
}
function isBusyErr(e) {
  return e && /busy|locked/i.test(e && e.message ? e.message : '');
}

// ---------- 支撑 SQLite（每 FakeClient 独立连接） ----------
let seeded = false;
function ensureSchema(db) {
  db.exec('PRAGMA journal_mode=WAL;');
  // 注意：单文件 SQLite(WAL) 只允许一个写者。若 busy_timeout 设得过大（如 8000ms），
  // 并发写者会阻塞数秒才返回 SQLITE_BUSY，再叠加应用层重试会触发 20s 事务看门狗误报。
  // 真实 PostgreSQL 走 MVCC，无单文件写锁，从不向应用抛“locked”。
  // 这里把 busy_timeout 调小，让 SQLite 立即返回 BUSY，交由应用层 _runWithRetry（30×5ms）兜底，
  // 既复现“并发不抛错”的真实 PG 行为，又把单语句延迟限制在 ~几十 ms 内，避免看门狗误判。
  db.exec('PRAGMA busy_timeout=50;');
  const ddl = [
    'CREATE TABLE IF NOT EXISTS user_data (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS user_data_rev (user_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS sync_markers (key TEXT PRIMARY KEY, last_run INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS fund (id INTEGER PRIMARY KEY AUTOINCREMENT, fund_code TEXT UNIQUE NOT NULL, fund_name TEXT NOT NULL, fund_type TEXT, company TEXT, created_at TEXT NOT NULL DEFAULT \'\', updated_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS fund_nav (id INTEGER PRIMARY KEY AUTOINCREMENT, fund_code TEXT NOT NULL, date TEXT NOT NULL, nav REAL NOT NULL, acc_nav REAL, source TEXT NOT NULL DEFAULT \'\', fetched_at TEXT, UNIQUE(fund_code,date))',
    'CREATE TABLE IF NOT EXISTS fund_holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, fund_code TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT, weight REAL NOT NULL DEFAULT 0, report_date TEXT NOT NULL, UNIQUE(fund_code,stock_code,report_date))',
    'CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, account_id TEXT NOT NULL, fund_code TEXT NOT NULL, shares REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, source_name TEXT NOT NULL DEFAULT \'\', converted_at TEXT, category TEXT NOT NULL DEFAULT \'基金\', transactions TEXT NOT NULL DEFAULT \'[]\', is_synced INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT \'\', updated_at TEXT NOT NULL DEFAULT \'\', UNIQUE(user_id,account_id,fund_code))',
    'CREATE TABLE IF NOT EXISTS source_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, source_name TEXT NOT NULL, token TEXT NOT NULL DEFAULT \'\', refresh_token TEXT NOT NULL DEFAULT \'\', cookie TEXT NOT NULL DEFAULT \'\', user_info TEXT, status TEXT NOT NULL DEFAULT \'disconnected\', created_at TEXT NOT NULL DEFAULT \'\', updated_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT \'\', expires_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS read_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT \'\', last_used_at TEXT, revoked_at TEXT)',
    'CREATE TABLE IF NOT EXISTS account_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, account_count INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS stock_price (id INTEGER PRIMARY KEY AUTOINCREMENT, stock_code TEXT NOT NULL, date TEXT NOT NULL, price REAL NOT NULL, change_percent REAL, UNIQUE(stock_code,date))',
    'CREATE TABLE IF NOT EXISTS fund_calibration (fund_code TEXT PRIMARY KEY, optimal_holdings_weight REAL NOT NULL, optimal_sector_weight REAL NOT NULL, cash_adjustment REAL NOT NULL DEFAULT 0, mae REAL, rmse REAL, direction_accuracy REAL, sample_size INTEGER NOT NULL DEFAULT 0, calibrated_at TEXT NOT NULL DEFAULT \'\')',
    'CREATE TABLE IF NOT EXISTS fund_estimate (id INTEGER PRIMARY KEY AUTOINCREMENT, fund_code TEXT NOT NULL, trade_date TEXT NOT NULL, estimate_change REAL NOT NULL, holdings_change REAL, sector_change REAL, cash_adjustment REAL NOT NULL DEFAULT 0, confidence TEXT NOT NULL, quote_coverage REAL NOT NULL DEFAULT 0, calculation_json TEXT, calculated_at TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(fund_code,trade_date))'
  ];
  for (const s of ddl) {
    try { db.exec(s); } catch (e) { /* 已存在等良性错误忽略 */ }
  }
  if (!seeded) {
    try {
      const cnt = db.prepare('SELECT COUNT(*) c FROM fund').get().c;
      if (cnt === 0) seedFunds(db);
    } catch (e) { /* ignore */ }
    seeded = true;
  }
}
function seedFunds(db) {
  const codes = ['019633', '008702', '110011', '161725', '005827', '003096', '012348', '001632', '002001', '003095'];
  const fstmt = db.prepare('INSERT OR IGNORE INTO fund (fund_code,fund_name,fund_type,company) VALUES (?,?,?,?)');
  for (const c of codes) fstmt.run(c, '基金' + c, '混合型', '示例公司');
  const nstmt = db.prepare('INSERT OR IGNORE INTO fund_nav (fund_code,date,nav,acc_nav,source,fetched_at) VALUES (?,?,?,?,?,?)');
  const today = Date.now();
  for (const c of codes) {
    let nav = 1.0;
    for (let d = 0; d < 60; d++) {
      const t = today - d * 86400000;
      nav = nav * (1 + Math.sin(d) * 0.002);
      nstmt.run(c, new Date(t).toISOString().slice(0, 10), +nav.toFixed(4), +nav.toFixed(4), 'seed', new Date(t).toISOString());
    }
  }
  // 穿透基金：只种 30 天前结束的历史 NAV，故意“今天 NAV 缺失” → ensureTodayNav 缓存未命中 → 强制穿透 Yahoo/Eastmoney。
  const penCodes = ['000001', '000002'];
  for (const c of penCodes) {
    fstmt.run(c, '穿透基金' + c, '混合型', '示例公司');
    let nav = 1.0;
    for (let d = 30; d < 60; d++) {
      const t = today - d * 86400000;
      nav = nav * (1 + Math.sin(d) * 0.002);
      nstmt.run(c, new Date(t).toISOString().slice(0, 10), +nav.toFixed(4), +nav.toFixed(4), 'seed', new Date(t).toISOString());
    }
  }
  const pfmt = db.prepare('INSERT OR IGNORE INTO portfolio (user_id,account_id,fund_code,shares,cost,amount,category) VALUES (?,?,?,?,?,?,?)');
  for (const c of codes.slice(0, 3)) pfmt.run(0, 'account2', c, 100, 10000, 10000, '基金');
}

function translate(sql) {
  // 云端 SQL 用 $1/$2；node:sqlite 用 ?
  return String(sql).replace(/\$(\d+)/g, '?');
}
function isDml(sql) {
  return /^\s*(select|insert|update|delete|with|pragma)/i.test(sql);
}

// ---------- FakeClient / FakePool ----------
class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.db = new DatabaseSync(PG_FILE);
    ensureSchema(this.db);
    this.released = false;
  }
  release() {
    if (this.released) return;
    this.released = true;
    try { this.pool._releaseClient(this); } catch (_) {}
  }
  // SQLITE_BUSY 透明重试：单文件 SQLite 在并发写入时会偶发“database is locked”，
  // 真实 PG 会串行化写入者、绝不把 locked 抛给应用层。这里复现真实 PG 行为，
  // 避免把测试环境的锁竞争误算成业务 500 / CAS 错误。最多重试 ~30 次（~150ms）。
  _retrySleep() { return new Promise((r) => setTimeout(r, 5)); }
  _execWithRetry(sql, ignore) {
    let last = null;
    for (let i = 0; i < 30; i++) {
      try { this.db.exec(sql); return; }
      catch (e) {
        last = e;
        if (isBusyErr(e) && i < 29) { /* busy：重试 */ }
        else break;
      }
    }
    if (ignore && !isBusyErr(last)) return; // 良性错误（如表已存在）忽略
    if (last && !isBusyErr(last) && !ignore) { const err = new Error('[fake-pg] ' + last.message); err.code = last.code || 'SQLITE_ERROR'; throw err; }
    if (isBusyErr(last)) {
      const err = new Error('[fake-pg] database is locked (retry exhausted)');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
  }
  async _runWithRetry(s, tsql, p) {
    let last = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        if (/^\s*select/i.test(s)) {
          const rows = this.db.prepare(tsql).all(...p);
          return { rows, rowCount: rows.length };
        }
        if (/^\s*insert/i.test(s)) {
          const res = this.db.prepare(tsql).run(...p);
          let rows = [];
          try {
            const lastId = this.db.prepare('SELECT last_insert_rowid() AS id').get();
            if (lastId && lastId.id) rows = [{ id: lastId.id }];
          } catch (_) {}
          return { rows, rowCount: res.changes };
        }
        const res = this.db.prepare(tsql).run(...p); // update / delete
        return { rows: [], rowCount: res.changes };
      } catch (e) {
        last = e;
        if (isBusyErr(e) && attempt < 29) { await this._retrySleep(); continue; }
        const err = new Error('[fake-pg] ' + (e && e.message ? e.message : e));
        err.code = (e && e.code) || 'SQLITE_ERROR';
        throw err;
      }
    }
    const err = new Error('[fake-pg] database is locked (retry exhausted)');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
  async query(sql, params) {
    const s = String(sql).trim();
    // 事务控制 / SET：直接 exec，不 delay（带 busy 重试）
    if (/^(begin|commit|rollback|set|savepoint|release)/i.test(s)) {
      this._execWithRetry(s, true);
      return { rows: [], rowCount: 0 };
    }
    // 慢查询 / 事务超时 注入（仅 DML 真实查询延迟）
    if (isDml(s) && fault.slowQueryMs > 0) {
      await new Promise((r) => setTimeout(r, fault.slowQueryMs));
    }
    const p = Array.isArray(params) ? params : [];
    const tsql = translate(s);
    if (!isDml(s)) {
      // DDL（CREATE/ALTER/DROP/...）：容错执行（带 busy 重试）
      this._execWithRetry(tsql, true);
      return { rows: [], rowCount: 0 };
    }
    return this._runWithRetry(s, tsql, p);
  }
}

class FakePool {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.max = fault.poolMax;
    this._inUse = 0;
    this._created = 0;
    this._free = [];
    this._queue = [];
    // dbAsync 通过 `new Pool(cfg)` 直接构造；在此暴露给指标采样器
    poolInstance = this;
    global.__stressPool = this;
  }
  stats() {
    return { total: this._created, idle: this._free.length, waiting: this._queue.length, active: this._inUse };
  }
  connect() {
    this.max = fault.poolMax; // 跟随故障切换
    global.__stressConn = (global.__stressConn || 0) + 1;
    return new Promise((resolve, reject) => {
      const acquire = () => {
        // 活跃连接受 max 限制（故障切换池满/获取超时时生效）
        if (this._inUse < this.max) {
          this._inUse++;
          let c;
          if (this._free.length > 0) {
            c = this._free.pop(); // 复用已有物理连接（真实连接池行为）
            c.released = false;    // 关键：复用前重置 released 守卫，否则二次 release 会被 no-op 吞掉导致连接泄漏
          } else {
            c = new FakeClient(this);
            this._created++;
          }
          resolve(c);
          return;
        }
        // 队列等待（由 release 时 pump）
        this._queue.push({ resolve, reject });
      };
      if (fault.acquireDelayMs > 0) {
        setTimeout(acquire, fault.acquireDelayMs);
      } else {
        acquire();
      }
    });
  }
  _releaseClient(client) {
    global.__stressRel = (global.__stressRel || 0) + 1;
    this._inUse = Math.max(0, this._inUse - 1);
    if (this._free.length < this.max) this._free.push(client); // 归还物理连接以供复用
    while (this._queue.length && this._inUse < this.max) {
      const q = this._queue.shift();
      this._inUse++;
      let c;
      if (this._free.length > 0) { c = this._free.pop(); c.released = false; }
      else { c = new FakeClient(this); this._created++; }
      q.resolve(c);
    }
  }
  on() { return this; }
  end() { return Promise.resolve(); }
}

let poolInstance = null;
function makePool(cfg) {
  poolInstance = new FakePool(cfg);
  global.__stressPool = poolInstance;
  return poolInstance;
}

// ---------- 覆盖 require('pg') ----------
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    return { Pool: FakePool, __makePool: makePool, Client: FakePool };
  }
  return originalLoad.apply(this, arguments);
};
// 让 dbAsync.getPool() 创建的 Pool 走我们的构造（它 new Pool({...})）
const OrigPool = FakePool;
// 注意：dbAsync 用 `const { Pool } = require('pg')` 再 new Pool()；上面已返回 FakePool 作为 Pool 构造器。

// ---------- 覆盖 globalThis.fetch（Provider 故障注入 + 统计） ----------
const realFetch = globalThis.fetch;
function delaySignal(ms, signal, onAbort) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { onAbort(); return; }
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    function onAb() { cleanup(); reject(new DOMException('The operation was aborted.', 'AbortError')); }
    function cleanup() { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAb); }
    if (signal) signal.addEventListener('abort', onAb);
  });
}
function cannedProviderResponse(host, urlStr, bodyStr) {
  const u = urlStr || '';
  // ---- 小倍养基（需要 { code:200, data:... } 形态）----
  if (/xiaobeiyangji\.com/i.test(host)) {
    if (/\/get-optional-change-nav/.test(u)) {
      let code = '019633';
      try {
        const b = JSON.parse(bodyStr || '{}');
        if (Array.isArray(b.codeArr) && b.codeArr[0]) code = String(b.codeArr[0]);
      } catch (_) {}
      return { code: 200, data: [{ code, valuation: 1.2345, valuationY: 1.2, nav: 1.23, navY: 1.23 }], msg: 'ok' };
    }
    if (/\/get-fund-detail-v310/.test(u)) {
      return { code: 200, data: { name: '小倍示例基金', nav: 1.23, dailyYield: 0.0123 } };
    }
    if (/\/get-hold-list/.test(u)) return { code: 200, data: { list: [] } };
    if (/\/get-account-list/.test(u)) return { code: 200, data: { accountList: [{ accountId: 'acc1', name: '测试账户' }] } };
    return { code: 200, data: { list: [], accountList: [] } };
  }
  // ---- 养基宝（需要 { code:200, data:... } 形态）----
  if (/yangjibao\.com/i.test(host)) {
    if (/\/user_account/.test(u)) return { code: 200, data: { list: [{ id: 'acc1', title: '测试账户' }] } };
    if (/\/fund_hold/.test(u)) return { code: 200, data: [{ code: '019633', nv_info: { gsz: '1.2345', gszzl: '1.20' }, short_name: '养基宝示例基金' }] };
    if (/\/qr_code/.test(u)) return { code: 200, data: { id: 'qr1', url: 'https://example.com/qr' } };
    if (/\/qr_code_state/.test(u)) return { code: 200, data: { state: 3, token: 'stress-yjb-token' } };
    return { code: 200, data: {} };
  }
  // ---- Yahoo（NAV + 股票行情，chart.result 形态）----
  if (/query1\.finance\.yahoo\.com/i.test(host)) {
    return { chart: { result: [{ timestamp: [1690000000, 1690080000], indicators: { quote: [{ close: [1.0, 1.02] }] } }], error: null } };
  }
  // ---- 东方财富：api.fund.eastmoney.com/f10/lsjz（NAV 备用接口，JSON {Data:{LSJZList}}）----
  if (/api\.fund\.eastmoney\.com/i.test(host)) {
    return { Data: { LSJZList: [{ FSRQ: '2026-08-26', DWJZ: '1.2345', LJJZ: '1.23', JZZZL: '1.20' }] }, TotalCount: 1, PageCount: 1 };
  }
  // ---- 东方财富其它（天天基金 HTML / push2 kline）：返回无法解析的良性结构，
  //      让服务端 parse 失败 → 触发其内置 fallback（天天基金→api.fund.eastmoney，push2→Yahoo）----
  if (/eastmoney\.com/i.test(host)) {
    return { code: 0, data: { klines: [] } };
  }
  // ---- 腾讯财经 qfq 日 K ----
  if (/gtimg\.qq|gu\.qq|web\.ifzq\.gtimg/i.test(host)) {
    return { code: 0, data: { day: [['2026-08-26', '1.0', '1.1', '0.9', '1.05']] } };
  }
  // ---- 新浪财经日 K ----
  if (/sina\.com\.cn/i.test(host)) {
    return [{ day: '2026-08-26', open: '1.0', high: '1.1', low: '0.9', close: '1.05', volume: '1000' }];
  }
  return { success: true, mock: true, host };
}
function makeResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
globalThis.fetch = async function (url, opts) {
  const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
  let host = '';
  try { host = new URL(urlStr).host; } catch (_) {}
  const isLocal = host === 'localhost' || host.startsWith('127.') || host.startsWith('::1') || host === '0.0.0.0' || host === '';
  if (isLocal) return realFetch(url, opts);
  // 外部 Provider：按 Provider 维度统计 + 故障注入
  const pname = providerNameForHost(host);
  const ps = getProviderStat(pname);
  ps.requests++;
  ps.active++;
  if (ps.active > ps.activePeak) ps.activePeak = ps.active;
  provider.total++;
  provider.active++;
  if (provider.active > metrics.providerActiveMax) metrics.providerActiveMax = provider.active;
  const signal = (opts && opts.signal) || (url && url.signal);
  const bodyStr = opts && typeof opts.body === 'string' ? opts.body : (opts && opts.body ? JSON.stringify(opts.body) : '');
  const mode = fault.providerMode;
  let outcome = 'success';
  try {
    if (mode === '500') {
      outcome = 'error';
      return makeResponse({ error: 'mock provider 500' }, 500);
    }
    if (mode === 'abort') {
      outcome = 'abort';
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (mode === 'timeout') {
      // 挂起直到客户端自身 AbortController 触发（fetchWithTimeout 默认 15~30s）
      await delaySignal(60000, signal, () => {});
      return makeResponse(cannedProviderResponse(host, urlStr, bodyStr), 200);
    }
    if (mode === 'slow') {
      await delaySignal(fault.providerLatencyMs || 8000, signal, () => {});
      return makeResponse(cannedProviderResponse(host, urlStr, bodyStr), 200);
    }
    // normal：轻微延迟模拟网络
    await delaySignal(30, signal, () => {});
    return makeResponse(cannedProviderResponse(host, urlStr, bodyStr), 200);
  } catch (e) {
    // 客户端 AbortController 截断（shim 挂起被服务端超时取消）→ 记为 timeout
    if (e && e.name === 'AbortError') {
      if (mode === 'abort') outcome = 'abort';
      else outcome = 'timeout';
    }
    throw e;
  } finally {
    ps.active--;
    provider.active--;
    if (outcome === 'success') ps.success++;
    else if (outcome === 'error') ps.error++;
    else if (outcome === 'timeout') { ps.timeout++; ps.fallback++; }
    else if (outcome === 'abort') { ps.abort++; ps.fallback++; }
  }
};

// ---------- 服务端进程内指标采样 ----------
let lastTick = Date.now();
function sample() {
  try {
    const m = process.memoryUsage();
    if (metrics.heapUsedStart === 0) metrics.heapUsedStart = m.heapUsed;
    metrics.heapUsedEnd = m.heapUsed;
    if (m.heapUsed > metrics.heapUsedPeak) metrics.heapUsedPeak = m.heapUsed;
    if (m.rss > metrics.rssPeak) metrics.rssPeak = m.rss;
    const now = Date.now();
    const d = now - lastTick - 1000;
    lastTick = now;
    if (d > metrics.elPeakMs) metrics.elPeakMs = d;
    const ps = poolInstance ? poolInstance.stats() : { total: 0, idle: 0, waiting: 0, active: 0 };
    if (ps.waiting > metrics.pgWaitingPeak) metrics.pgWaitingPeak = ps.waiting;

    // Provider 队列峰值：用应用自身并发限制器（navCacheService/providerEstimate/externalConcurrency）
    let navQ = 0, navA = 0, estQ = 0, extA = 0, extQ = 0;
    try {
      const nav = require(path.resolve(__dirname, '../server/services/navCacheService')).stats();
      navA = nav.activeExternal || 0; navQ = nav.externalQueueSize || 0;
    } catch (_) {}
    try {
      const est = require(path.resolve(__dirname, '../server/services/providerEstimate')).stats();
      estQ = est.estimateQueueSize || 0;
    } catch (_) {}
    try {
      const ext = require(path.resolve(__dirname, '../server/services/concurrencyLimit')).externalConcurrencyStats();
      extA = ext.active || 0; extQ = ext.queued || 0;
    } catch (_) {}
    const providerQueue = Math.max(navQ, estQ, extQ);
    if (providerQueue > metrics.providerQueuePeak) metrics.providerQueuePeak = providerQueue;

    metrics.samples++;
    const snap = {
      t: now,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      eventLoopDelayMs: d,
      pg: ps,
      connRel: { connect: global.__stressConn || 0, release: global.__stressRel || 0 },
      provider: { active: provider.active, total: provider.total, navActive: navA, navQueue: navQ, estQueue: estQ, extActive: extA, extQueue: extQ },
      providerStats: Object.keys(providerStats).map((name) => ({ name, ...providerStats[name] })),
      peaks: {
        heapUsedPeak: metrics.heapUsedPeak,
        rssPeak: metrics.rssPeak,
        elPeakMs: metrics.elPeakMs,
        pgWaitingPeak: metrics.pgWaitingPeak,
        providerQueuePeak: metrics.providerQueuePeak,
        providerTotal: provider.total,
        providerActiveMax: metrics.providerActiveMax
      },
      pgMode: fault.pgMode,
      providerMode: fault.providerMode
    };
    fs.writeFileSync(METRICS_FILE, JSON.stringify(snap));
  } catch (_) { /* 采样失败绝不影响主流程 */ }
}
const sampleTimer = setInterval(sample, 1000);
// 注意：采样定时器保持引用（不 unref），确保压测期间持续写指标文件；
// 服务端进程由 harness 显式 kill，无需靠 unref 退出。

console.log('[stress-shim] pg + fetch shim installed (PG_FILE=' + PG_FILE + ')');

module.exports = { FakePool, FakeClient, fault, metrics, provider };
