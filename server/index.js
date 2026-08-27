// 本地开发：加载根目录 .env（密钥不入库，.gitignore 已忽略）
try {
  const envPath = require('node:path').join(__dirname, '..', '.env');
  if (require('node:fs').existsSync(envPath)) {
    require('node:fs').readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const trimmed = String(line).trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    });
    console.log('[env] 已加载根目录 .env');
  }
} catch (e) { /* 忽略 .env 读取失败 */ }

const fs = require('node:fs');
const path = require('node:path');

// AI 服务预构建守卫：见 server/services/aiBundle.js（P1-10，生产环境禁止运行时 execSync 编译）
const { ensureAiBundle } = require('./services/aiBundle');
ensureAiBundle();

const http = require('node:http');
const { handleFundApi, sendJson } = require('./api/fund');
const { getDatabase, databasePath, closeDatabase } = require('./database/db');
// Phase 3.3-H：[MEMORY] 诊断所需的只读统计（不改变运行时行为）。
const { externalConcurrencyStats } = require('./services/concurrencyLimit');
const { stats: navStats } = require('./services/navCacheService');
const { stats: estimateStats } = require('./services/providerEstimate');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function ensureInitialSeed() {
  try {
    const db = getDatabase();
    const countRow = db.prepare('SELECT COUNT(*) as count FROM fund').get();
    if (!countRow || countRow.count === 0) {
      console.log('[fund-api] Database empty, seeding initial funds...');
      const { importFund } = require('./services/fundService');
      const { upsertPosition } = require('./services/estimateService');
      const seedFunds = [
        { code: '019633', amount: 10000 },
        { code: '008702', amount: 15000 }
      ];
      Promise.all(seedFunds.map(async (seed) => {
        try {
          await importFund(seed.code);
          upsertPosition({
            account_id: 'account2',
            fund_code: seed.code,
            shares: 0,
            cost: seed.amount,
            amount: seed.amount
          });
          console.log(`[fund-api] Seeded fund ${seed.code}`);
        } catch (e) {
          console.warn(`[fund-api] Seed fund ${seed.code} warning: ${e.message}`);
        }
      })).then(() => {
        console.log('[fund-api] Initial seed complete.');
      });
    }
  } catch (e) {
    console.warn('[fund-api] Seed check error:', e.message);
  }
}

function serveStatic(request, response, url) {
  const rootDir = process.cwd();
  let relPath = url.pathname === '/' ? 'index.html' : url.pathname;
  let filePath = path.join(rootDir, relPath);

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for single-page routing
      const indexPath = path.join(rootDir, 'index.html');
      fs.readFile(indexPath, (indexErr, data) => {
        if (indexErr) {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('Not found');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        response.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        response.writeHead(500);
        response.end('Server error');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      response.end(data);
    });
  });
}

async function createServer() {
  const { isCloud } = require('./database/dbAsync');
  // 云模式（PostgreSQL）下：SQLite 仅用作可重建缓存，其初始化失败不得拖垮 Postgres 服务
  try {
    getDatabase();
  } catch (e) {
    console.warn('[server] SQLite 缓存初始化失败（非致命，缓存功能降级）：', e.message);
  }
  // 生产/云环境禁止自动写入示例账户与示例基金，避免污染 PostgreSQL 或产生游离数据。
  // 仅在「非云模式」且「非 production」时（即纯本地开发）才做 SQLite 示例基金 seed；
  // CloudBase 容器通过 Dockerfile 的 NODE_ENV=production 关闭此行为，保证空环境部署不写入游离数据。
  if (!isCloud() && process.env.NODE_ENV !== 'production') {
    ensureInitialSeed();
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health') {
        const { isCloud } = require('./database/dbAsync');
        sendJson(response, 200, {
          success: true,
          service: 'fund-data',
          database: isCloud() ? 'postgres' : databasePath(),
          time: new Date().toISOString()
        });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const handled = await handleFundApi(request, response, url);
        if (!handled) {
          sendJson(response, 404, { success: false, error: '接口不存在' });
        }
        return;
      }

      // Serve static frontend files
      serveStatic(request, response, url);
    } catch (error) {
      console.error('[server]', request.method, url.pathname, error);
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, error.statusCode || 500, {
          success: false,
          error: error.message || '服务器内部错误'
        });
      } else {
        response.writeHead(500);
        response.end('Server Internal Error');
      }
    }
  });
}

// Phase 3.3-H：[MEMORY] 轻量内存诊断。每 60s 采样一次进程内存与各并发/缓存队列规模，
// 仅打点不刷屏；便于线上确认 OOM 修复后内存是否平稳（区分 heapUsed 增长 vs rss 增长 vs 峰值暴涨）。
function startMemoryDiagnostics() {
  if (process.env.DISABLE_MEMORY_DIAGNOSTICS === '1') return;
  const timer = setInterval(() => {
    try {
      const m = process.memoryUsage();
      const nav = navStats();
      const ext = externalConcurrencyStats();
      const est = estimateStats();
      console.log(
        '[MEMORY] ' +
        `rss=${(m.rss / 1048576) | 0}MB ` +
        `heapUsed=${(m.heapUsed / 1048576) | 0}MB ` +
        `heapTotal=${(m.heapTotal / 1048576) | 0}MB ` +
        `external=${(m.external / 1048576) | 0}MB ` +
        `arrayBuffers=${(m.arrayBuffers / 1048576) | 0}MB ` +
        `| nav(active=${nav.activeExternal},queue=${nav.externalQueueSize},inflight=${nav.inFlightSize},max=${nav.maxExternalConcurrency}) ` +
        `| ext(active=${ext.active},queued=${ext.queued},max=${ext.max}) ` +
        `| estimateCache=${est.estimateCacheSize}`
      );
    } catch (err) {
      /* 诊断采样失败绝不影响主流程 */
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
}

// 冻结后台同步调度（2026-08-25）：
//   - 每日 NAV 增量：每 30 分钟检查一次，仅在上海时间 18:30~23:59 的净值公布窗口内执行；
//     只处理 fund_nav 中缺少 today/expected 日期的基金，已有今日净值直接跳过。
//   - 每周历史校对：启动 1 小时后执行首次，之后按 lastRun 间隔 7 天执行。
//   - 每季度持仓检查：启动 1 小时后执行首次，之后按 lastRun 间隔 91 天执行。
// 注意：setTimeout/setInterval 上限为 32 位有符号整数（~24.8 天），91 天会溢出变成 1ms，
// 因此统一用 30 分钟 tick + 内存 lastRun 时间戳控制周期，绝不直接设 7 天/91 天定时器。
// 每个任务有独立运行锁，防止重叠；DISABLE_NAV_SYNC=1 可整体关闭。
function startNavSyncScheduler() {
  if (process.env.DISABLE_NAV_SYNC === '1') {
    console.log('[NAV-SYNC] disabled by DISABLE_NAV_SYNC=1');
    return;
  }
  const { isCloud, getSyncMarker, setSyncMarker } = require('./database/dbAsync');
  if (!isCloud() && process.env.NODE_ENV !== 'production') {
    console.log('[NAV-SYNC] disabled in local/dev mode (set NODE_ENV=production or run on cloud to enable)');
    return;
  }
  const {
    syncTodayNavs,
    syncWeeklyHistory,
    syncQuarterlyHoldings
  } = require('./services/navSyncService');
  const { withAdvisoryLock } = require('./database/lock');

  let dailyRunning = false;
  let weeklyRunning = false;
  let quarterlyRunning = false;
  let ticking = false;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const QUARTER_MS = 91 * 24 * 60 * 60 * 1000;

  // 跨实例“上次成功执行”共享标记：存在 PostgreSQL sync_markers（云端）或 SQLite sync_markers（本地）。
  // 用共享标记而非进程内 lastRun —— 多副本各自记时会导致每周/每季任务被重复触发、重复打上游。
  async function isDue(key, intervalMs) {
    return Date.now() - (await getSyncMarker(key)) >= intervalMs;
  }

  function shanghaiMinutes() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const t = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return Number(t.hour) * 60 + Number(t.minute);
  }

  function inEveningWindow() {
    const minutes = shanghaiMinutes();
    return minutes >= 18 * 60 + 30 && minutes < 24 * 60;
  }

  function summarize(results) {
    if (!Array.isArray(results)) return 'no-results';
    const ok = results.filter(r => r && !r.error).length;
    const fail = results.length - ok;
    return `${ok} ok, ${fail} failed, total ${results.length}`;
  }

  // 进程内快速去重标志（防止同一进程重复进入；跨实例去重交给 PG 建议锁）
  const dailyRef = { value: false };
  const weeklyRef = { value: false };
  const quarterlyRef = { value: false };

  /**
   * 在「进程内快速去重 + 跨实例 PG 建议锁 + 跨实例共享间隔标记」三重保护下执行一次同步任务。
   * - 进程内布尔先挡掉同进程重入；
   * - 间隔未到（读共享 sync_markers）直接跳过，避免多副本各自记时重复触发；
   * - 跨实例用 pg_try_advisory_xact_lock：被其他实例持有则立即跳过（绝不重复写库/打上游），
   *   且锁随事务结束 / 连接断开（崩溃）自动释放；
   * - 进入锁内再次确认间隔（消除抢锁窗口竞态），成功执行后才写回共享标记。
   */
  async function runGuarded(label, lockName, runningRef, intervalOk, task, markerKey) {
    if (runningRef.value) return; // 进程内快速去重
    if (intervalOk && !(await intervalOk())) return; // 间隔未到（读共享标记）
    runningRef.value = true;
    const startedAt = Date.now();
    try {
      const { acquired, reason, result } = await withAdvisoryLock(lockName, async () => {
        // 进入锁内再次确认间隔，避免多实例抢锁窗口内的竞态导致重复执行
        if (markerKey && intervalOk && !(await intervalOk())) {
          return { __skipped: true };
        }
        return await task();
      });
      if (!acquired) {
        console.log(`[NAV-SYNC] ${label} skipped: 另一实例已持有锁（${reason}），多实例去重生效`);
        return null;
      }
      if (result && result.__skipped) {
        return null; // 锁内复查间隔未到，安全跳过
      }
      // 仅在本实例成功执行后更新共享标记（跨实例去重依赖它）
      if (markerKey) {
        await setSyncMarker(markerKey, Date.now()).catch((e) => {
          console.error(`[NAV-SYNC] ${label} 更新 sync_markers 失败:`, e && e.message);
        });
      }
      console.log(`[NAV-SYNC] ${label} completed in ${Date.now() - startedAt}ms: ${summarize(result)}`);
      return result;
    } catch (err) {
      console.error(`[NAV-SYNC] ${label} failed:`, err && err.message);
    } finally {
      runningRef.value = false;
    }
  }

  async function runDailyNav() {
    if (!inEveningWindow()) return;
    await runGuarded('daily-nav', 'nav-sync:daily', dailyRef, null, () => syncTodayNavs({ concurrency: 3 }));
  }

  async function maybeWeekly() {
    await runGuarded(
      'weekly-history', 'nav-sync:weekly', weeklyRef,
      () => isDue('weekly-history', WEEK_MS),
      () => syncWeeklyHistory({ concurrency: 2 }),
      'weekly-history'
    );
  }

  async function maybeQuarterly() {
    await runGuarded(
      'quarterly-holdings', 'nav-sync:quarterly', quarterlyRef,
      () => isDue('quarterly-holdings', QUARTER_MS),
      () => syncQuarterlyHoldings({ concurrency: 2 }),
      'quarterly-holdings'
    );
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await runDailyNav();
      await maybeWeekly();
      await maybeQuarterly();
    } finally {
      ticking = false;
    }
  }

  const initialDaily = setTimeout(() => { runDailyNav(); }, 30 * 1000);
  if (initialDaily.unref) initialDaily.unref();

  // 首次维护（含每周历史 + 每季度持仓）在启动 1 小时后执行
  const initialMaintenance = setTimeout(() => { tick(); }, 60 * 60 * 1000);
  if (initialMaintenance.unref) initialMaintenance.unref();

  const tickTimer = setInterval(() => { tick(); }, 30 * 60 * 1000);
  if (tickTimer.unref) tickTimer.unref();

  console.log('[NAV-SYNC] scheduler started (daily 18:30-23:59 every 30m, weekly history, quarterly holdings via 30m tick)');
}

async function startServer(port = 3000, host = '0.0.0.0') {
  const server = await createServer();
  server.listen(port, host, () => {
    console.log(`[genius-trader] Server running on http://${host}:${port}`);
    console.log(`[genius-trader] Database: ${require('./database/dbAsync').isCloud() ? 'PostgreSQL (cloud)' : databasePath()}`);
  });
  // 后台执行 schema 初始化（dbAsync 内部已设 lock_timeout=10s / statement_timeout=30s，
  // 失败会明确记录并 reject，但绝不阻塞 server.listen —— 优先保证 Render 端口可探测）。
  const { ensureCloudSchema } = require('./database/dbAsync');
  ensureCloudSchema().catch(err => {
    console.error('[dbAsync] Cloud schema initialization failed (server running in degraded mode):', err && err.message);
  });
  // Phase 3.3-H：[MEMORY] 轻量内存诊断（每 60s 采样一次，仅打点不刷屏，
  // 不打印 response / 基金对象 / history；可被 DISABLE_MEMORY_DIAGNOSTICS=1 关闭）。
  startMemoryDiagnostics();
  // 冻结后台同步职责（2026-08-25）：每日 NAV 增量 / 每周历史校对 / 每季度持仓检查。
  // 增量优先，绝不全量重导；navCacheService.js（P3.3-H）不做任何修改。
  startNavSyncScheduler();
  const shutdown = () => {
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[genius-trader] Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  startServer
};
