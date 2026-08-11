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

// Automatically compile TypeScript AI services on startup
try {
  const { execSync } = require('node:child_process');
  execSync('npx esbuild src/services/ai/index.ts --bundle --platform=node --format=cjs --outfile=server/services/ai/index.js');
} catch (e) {
  console.error('[build-ai] Failed to build AI services on startup:', e.message);
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleFundApi, sendJson } = require('./api/fund');
const { getDatabase, databasePath, closeDatabase } = require('./database/db');

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
  getDatabase();
  ensureInitialSeed();
  const { ensureCloudSchema } = require('./database/dbAsync');
  await ensureCloudSchema();

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

async function startServer(port = Number(process.env.PORT || process.env.FUND_API_PORT || 3000), host = '0.0.0.0') {
  const server = await createServer();
  server.listen(port, host, () => {
    console.log(`[genius-trader] Server running on http://${host}:${port}`);
    console.log(`[genius-trader] Database: ${require('./database/dbAsync').isCloud() ? 'PostgreSQL (cloud)' : databasePath()}`);
  });
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
