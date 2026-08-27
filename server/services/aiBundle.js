/**
 * AI bundle 构建守卫（P1-10）
 *
 * `server/services/ai/index.js` 是 AI 服务的预构建产物，必须由构建阶段 `npm run build:ai` 生成。
 * 本模块在启动时检查产物是否存在，并按环境决定行为：
 *   - 产物存在：直接复用。
 *   - 生产环境（NODE_ENV=production 或 Render）：严禁在启动时 dynamic execSync 编译 ——
 *     会阻塞启动、引入构建不确定性、扩大安全面。缺失即显式降级（设置 __AI_BUNDLE_MISSING=1，
 *     /api/ai/* 返回 503），不影响主服务。
 *   - 非生产（本地开发）：可用本地 esbuild 兜底，仅为开发便利，绝不进入生产路径。
 */
const fs = require('node:fs');
const path = require('node:path');

const AI_BUILD_TARGET = path.join(__dirname, '..', 'services', 'ai', 'index.js');

function ensureAiBundle() {
  if (fs.existsSync(AI_BUILD_TARGET)) return; // 已有预构建产物
  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  if (isProduction) {
    console.error(
      '[build-ai] 预构建产物缺失且处于生产环境：禁止运行时 execSync 编译。' +
      ' 请在构建阶段执行 `npm run build:ai` 生成 server/services/ai/index.js；' +
      ' 当前 /api/ai/* 将显式返回 503（AI 服务不可用），其余接口不受影响。'
    );
    process.env.__AI_BUNDLE_MISSING = '1';
    return;
  }
  try {
    const { execSync } = require('node:child_process');
    console.warn('[build-ai] 预构建产物缺失，开发环境尝试本地 esbuild 兜底构建...');
    execSync('node node_modules/esbuild/bin/esbuild src/services/ai/index.ts --bundle --platform=node --format=cjs --outfile=server/services/ai/index.js', {
      cwd: process.cwd(),
      stdio: 'inherit'
    });
  } catch (e) {
    console.error('[build-ai] AI 服务构建失败（仅 /api/ai/* 暂不可用）：', e.message);
    process.env.__AI_BUNDLE_MISSING = '1';
  }
}

function isAiBundleMissing() {
  return process.env.__AI_BUNDLE_MISSING === '1' || !fs.existsSync(AI_BUILD_TARGET);
}

module.exports = { ensureAiBundle, isAiBundleMissing, AI_BUILD_TARGET };
