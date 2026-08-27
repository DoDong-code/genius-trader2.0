// P1-7 回归测试：Token 校验缓存 / 节流 / 撤销失效 / 速率限制
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const dbAsync = require('../database/dbAsync');
let getCalls = 0;
let runCalls = 0;
const rowsByHash = new Map();

dbAsync.get = async (sql, params) => {
  getCalls += 1;
  if (sql.includes('read_tokens')) return rowsByHash.get(params[0]) || null;
  return null;
};
dbAsync.run = async () => { runCalls += 1; };

const tokenSvc = require('../services/externalTokenService');

function seedRow(userId, opts = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = tokenSvc.hashToken(token);
  rowsByHash.set(hash, {
    id: 1,
    user_id: userId,
    created_at: opts.createdAt || new Date(),
    last_used_at: opts.lastUsedAt || null,
    revoked_at: opts.revokedAt || null
  });
  return token;
}

test('validation cache avoids repeated DB reads', async () => {
  getCalls = 0; runCalls = 0;
  const token = seedRow(7, { lastUsedAt: new Date(Date.now() - 120000) }); // 2 分钟前，触发首次 UPDATE
  const r1 = await tokenSvc.validateToken(token);
  assert.strictEqual(r1.userId, 7);
  const afterFirst = getCalls;
  const r2 = await tokenSvc.validateToken(token); // 缓存命中
  assert.strictEqual(r2.userId, 7);
  assert.strictEqual(getCalls, afterFirst, '缓存命中不应再次查询 DB');
});

test('last_used_at update is throttled (no UPDATE when recent)', async () => {
  getCalls = 0; runCalls = 0;
  const token = seedRow(8, { lastUsedAt: new Date() }); // 刚刚，未超过节流窗口
  await tokenSvc.validateToken(token);
  assert.strictEqual(runCalls, 0, '近期已写入 last_used_at，本次不应再 UPDATE');
});

test('revoke clears validation cache', async () => {
  getCalls = 0;
  const token = seedRow(9, { lastUsedAt: new Date(Date.now() - 120000) });
  await tokenSvc.validateToken(token);
  assert.ok(getCalls >= 1);
  tokenSvc.clearValidationCache();
  const before = getCalls;
  await tokenSvc.validateToken(token); // 缓存已清，需重新查询
  assert.ok(getCalls > before, '撤销清缓存后，再次校验应重新查询 DB');
});

test('rate limit rejects after window exceeded', () => {
  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < 200; i += 1) {
    if (tokenSvc.rateLimitAllowed('rl-test-key')) allowed += 1; else denied += 1;
  }
  assert.ok(allowed > 0, '窗口内应允许一部分');
  assert.ok(denied > 0, '超过上限应拒绝');
});
