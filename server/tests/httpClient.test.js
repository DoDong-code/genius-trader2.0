// P0-6 回归测试：统一 HTTP 客户端
// 验证：timeout 真正 Abort、retry 有上限+退避、无无限 pending、异常不泄漏定时器。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchWithTimeout, fetchWithRetry } = require('../utils/httpClient');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('fetchWithTimeout aborts when server is slower than timeout', async () => {
  const server = await startServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('late'); }, 1000);
  });
  const { port } = server.address();
  const start = Date.now();
  await assert.rejects(
    () => fetchWithTimeout(`http://127.0.0.1:${port}/`, { timeout: 200 }),
    /AbortError|aborted|The operation was aborted|timeout/i
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 900, `应在超时后很快失败，实际耗时 ${elapsed}ms（疑似未真正 Abort）`);
  server.close();
});

test('fetchWithTimeout succeeds within timeout', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const { port } = server.address();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, { timeout: 2000 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'ok');
  server.close();
});

test('fetchWithRetry retries on 500 then succeeds (bounded attempts)', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200);
    res.end('recovered');
  });
  const { port } = server.address();
  const res = await fetchWithRetry(`http://127.0.0.1:${port}/`, { timeout: 1000, maxAttempts: 4, baseDelay: 20 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'recovered');
  assert.strictEqual(hits, 3, '应恰好重试到第三次成功');
  server.close();
});

test('fetchWithRetry does not infinitely retry on persistent 500', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits += 1;
    res.writeHead(502);
    res.end('down');
  });
  const { port } = server.address();
  await assert.rejects(
    () => fetchWithRetry(`http://127.0.0.1:${port}/`, { timeout: 500, maxAttempts: 3, baseDelay: 10 }),
    /已重试 3 次/
  );
  assert.strictEqual(hits, 3, '不应无限重试，应恰好 3 次');
  server.close();
});

test('fetchWithRetry does not retry 4xx (except 429)', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits += 1;
    res.writeHead(404);
    res.end('nope');
  });
  const { port } = server.address();
  const res = await fetchWithRetry(`http://127.0.0.1:${port}/`, { timeout: 500, maxAttempts: 5 });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(hits, 1, '4xx 不应重试');
  server.close();
});
