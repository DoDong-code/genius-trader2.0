/**
 * Provider 注册表
 *
 * 自动扫描 providers 目录下的 Provider 模块并注册：
 * - 新增平台时只需在 server/providers/ 下新增一个文件（继承 BaseProvider），
 *   无需修改核心代码。
 */
const fs = require('node:fs');
const path = require('node:path');

const registry = new Map();

function registerProvider(name, ProviderClass) {
  registry.set(name, ProviderClass);
}

function getProvider(name) {
  const ProviderClass = registry.get(name);
  return ProviderClass ? new ProviderClass() : null;
}

function listProviders() {
  return [...registry.keys()];
}

function unregisterProvider(name) {
  registry.delete(name);
}

// 自动加载并注册 providers 目录下的所有 Provider
function autoLoadProviders() {
  const dir = __dirname;
  const skipped = new Set(['baseProvider.js', 'registry.js', 'index.js']);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js') || skipped.has(file)) continue;
    const modulePath = path.join(dir, file);
    let mod;
    try {
      mod = require(modulePath);
    } catch (e) {
      console.error(`[providers] 加载 ${file} 失败:`, e.message);
      continue;
    }
    const ProviderClass = mod.default || mod;
    if (typeof ProviderClass !== 'function' || typeof ProviderClass.prototype?.getLoginType !== 'function') {
      continue;
    }
    const instance = new ProviderClass();
    if (instance.sourceName) {
      registerProvider(instance.sourceName, ProviderClass);
    }
  }
}

autoLoadProviders();

module.exports = {
  registerProvider,
  unregisterProvider,
  getProvider,
  listProviders
};
