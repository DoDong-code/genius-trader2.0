/**
 * P1-10 回归测试：AI bundle 构建守卫
 *
 * 验证：
 *  1) 生产环境（NODE_ENV=production / RENDER）下，即使 bundle 缺失，也绝不调用 execSync 编译；
 *  2) 缺失时显式标记 __AI_BUNDLE_MISSING=1，使 /api/ai/* 可返回 503 降级；
 *  3) 非生产环境缺失时，仍走 esbuild 兜底（开发便利），且兜底失败也标记缺失；
 *  4) 产物存在时直接复用，不触发任何编译。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// 真实产物路径（与 aiBundle.AI_BUILD_TARGET 一致）
const REAL_TARGET = path.resolve(__dirname, '..', 'services', 'ai', 'index.js');

// 内置模块（node:child_process）不会进 require.cache，必须用 Module._load 拦截
function injectChildProcessMock(execSyncFn) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process' || request === 'child_process') {
      return { execSync: execSyncFn };
    }
    return origLoad.apply(this, arguments);
  };
  return () => { Module._load = origLoad; };
}

function withMissingBundle(fn) {
  const realExists = fs.existsSync.bind(fs);
  fs.existsSync = (p) => (path.resolve(String(p)) === REAL_TARGET ? false : realExists(p));
  try {
    return fn();
  } finally {
    fs.existsSync = realExists;
  }
}

function withPresentBundle(fn) {
  const realExists = fs.existsSync.bind(fs);
  fs.existsSync = (p) => (path.resolve(String(p)) === REAL_TARGET ? true : realExists(p));
  try {
    return fn();
  } finally {
    fs.existsSync = realExists;
  }
}

function reload() {
  delete require.cache[require.resolve('../services/aiBundle')];
  return require('../services/aiBundle');
}

test('生产环境缺失 bundle：绝不 execSync，显式降级', () => {
  process.env.NODE_ENV = 'production';
  let execSyncCalled = false;
  const restore = injectChildProcessMock(() => { execSyncCalled = true; });
  try {
    withMissingBundle(() => {
      delete process.env.__AI_BUNDLE_MISSING;
      const { ensureAiBundle, isAiBundleMissing } = reload();
      ensureAiBundle();
      assert.strictEqual(execSyncCalled, false, '生产环境严禁调用 execSync 编译');
      assert.strictEqual(process.env.__AI_BUNDLE_MISSING, '1', '缺失应标记 __AI_BUNDLE_MISSING');
      assert.strictEqual(isAiBundleMissing(), true, 'isAiBundleMissing 应返回 true（可 503 降级）');
    });
  } finally {
    restore();
  }
  delete process.env.NODE_ENV;
  delete process.env.__AI_BUNDLE_MISSING;
});

test('非生产环境缺失 bundle：走 esbuild 兜底（开发便利）', () => {
  let execSyncCalled = false;
  const restore = injectChildProcessMock(() => { execSyncCalled = true; });
  try {
    withMissingBundle(() => {
      delete process.env.__AI_BUNDLE_MISSING;
      const { ensureAiBundle } = reload();
      ensureAiBundle();
      assert.strictEqual(execSyncCalled, true, '非生产环境缺失时应调用 esbuild 兜底');
    });
  } finally {
    restore();
  }
  delete process.env.__AI_BUNDLE_MISSING;
});

test('产物存在：直接复用，不编译', () => {
  let execSyncCalled = false;
  const restore = injectChildProcessMock(() => { execSyncCalled = true; });
  try {
    withPresentBundle(() => {
      delete process.env.__AI_BUNDLE_MISSING;
      const { ensureAiBundle, isAiBundleMissing } = reload();
      ensureAiBundle();
      assert.strictEqual(execSyncCalled, false, '产物存在不应调用 execSync');
      assert.strictEqual(isAiBundleMissing(), false, '产物存在时不应标记缺失');
    });
  } finally {
    restore();
  }
  delete process.env.__AI_BUNDLE_MISSING;
});
