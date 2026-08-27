/**
 * P0-3 回归测试：云端（生产）HTTP 路径不得触发同步 SQLite / 同步文件 IO
 *
 * 验证在 DATABASE_URL 设置（云端）下，账户状态落库与每日缓存读写等“请求路径”函数
 * 不调用任何同步原语：
 *   - node:sqlite 的 DatabaseSync（构造即视为同步 SQLite 使用）
 *   - fs.readFileSync / fs.writeFileSync / fs.mkdirSync（同步文件 IO）
 *
 * 注意：fs 守卫在「模块加载完成后」才安装，避免误捕获 Node 自身的模块加载 readFileSync。
 * 同步原语只允许在启动引导（.env 读取）与一次性迁移脚本中使用，绝不在请求热路径。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');

function makeFakePg() {
  class FakeClient {
    constructor(store) {
      this.store = store;
      this.queries = [];
      this.released = false;
    }
    async query(sql, params) {
      const s = String(sql);
      this.queries.push(s);
      if (/^\s*BEGIN/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^\s*(COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
      const p = (params || []).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x));
      if (/SELECT revision FROM user_data_rev/.test(s)) {
        const uid = Number(p[0]);
        return { rows: [{ revision: this.store.rev[uid] || 0 }], rowCount: 1 };
      }
      if (/SELECT data FROM user_data/.test(s)) {
        const uid = Number(p[0]);
        return this.store.data[uid] !== undefined
          ? { rows: [{ data: this.store.data[uid] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO user_data /.test(s)) {
        const uid = Number(p[0]);
        this.store.data[uid] = p[1];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO user_data_rev/.test(s) && /DO NOTHING/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) { this.store.rev[uid] = Number(p[1]) || 0; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE user_data_rev SET revision = revision \+ 1/.test(s)) {
        const uid = Number(p[0]);
        if (this.store.rev[uid] === undefined) this.store.rev[uid] = 0;
        this.store.rev[uid] = Number(this.store.rev[uid]) + 1;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE user_data_rev SET revision = /.test(s) && /AND revision = /.test(s)) {
        const uid = Number(p[1]);
        const expected = Number(p[2]);
        const next = Number(p[0]);
        if (this.store.rev[uid] === expected) { this.store.rev[uid] = next; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    release() { this.released = true; }
  }
  class FakePool {
    constructor(cfg) {
      this.cfg = cfg || {};
      this.store = { rev: {}, data: {} };
      FakePool._last = this;
    }
    connect() { const c = new FakeClient(this.store); this.lastClient = c; return Promise.resolve(c); }
    on() { return this; }
  }
  FakePool._last = null;
  return { Pool: FakePool };
}

const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true, exports: makeFakePg()
};

process.env.DATABASE_URL = 'postgres://fake/fake';

let syncIoCalled = false;
let sqliteConstructed = false;

// node:sqlite 守卫在 require 之前安装（构造 DatabaseSync 仅由应用代码触发，不会误捕加载器）
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node:sqlite') {
    return { DatabaseSync: class { constructor() { sqliteConstructed = true; } } };
  }
  return origLoad.apply(this, arguments);
};

// fs 守卫在模块加载完成后安装（避免误捕 Node 自身模块加载的 readFileSync）
function installFsGuard() {
  const origRead = fs.readFileSync, origWrite = fs.writeFileSync, origMkdir = fs.mkdirSync;
  fs.readFileSync = function (...a) { syncIoCalled = true; return origRead.apply(this, a); };
  fs.writeFileSync = function (...a) { syncIoCalled = true; return origWrite.apply(this, a); };
  fs.mkdirSync = function (...a) { syncIoCalled = true; return origMkdir.apply(this, a); };
  return () => { fs.readFileSync = origRead; fs.writeFileSync = origWrite; fs.mkdirSync = origMkdir; };
}

const dbAsync = require('../database/dbAsync');
const { saveUserState, getUserState } = require('../services/accountStateService');
const { readDailyCache, writeDailyCache } = require('../services/fundService');

test('云端请求路径：账户状态落库不触发同步 IO / 同步 SQLite', async () => {
  dbAsync.__resetForTest();
  const restoreFs = installFsGuard();
  syncIoCalled = false;
  sqliteConstructed = false;
  try {
    await saveUserState(1, { accounts: { 'a': { funds: [] } } });
    await getUserState(1);
    assert.strictEqual(syncIoCalled, false, '云端落库不应调用同步文件 IO（readFileSync/writeFileSync/mkdirSync）');
    assert.strictEqual(sqliteConstructed, false, '云端请求路径不应构造 DatabaseSync（同步 SQLite）');
  } finally {
    restoreFs();
  }
});

test('云端请求路径：每日缓存读写（readDailyCache/writeDailyCache）仅用异步 fs', async () => {
  const restoreFs = installFsGuard();
  syncIoCalled = false;
  sqliteConstructed = false;
  try {
    // 使用不冲突的测试 code，避免污染真实缓存
    const cached = await readDailyCache('ZZ9999');
    assert.ok(cached === null || typeof cached === 'object', 'readDailyCache 应返回缓存对象或 null（异步读取）');
    await writeDailyCache('ZZ9999', { nav: 1.23, expected: 1.25 });
    assert.strictEqual(syncIoCalled, false, '每日缓存读写不应调用同步文件 IO');
    assert.strictEqual(sqliteConstructed, false, '每日缓存读写不应构造 DatabaseSync');
  } finally {
    restoreFs();
  }
});
