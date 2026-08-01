const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const required = [
  'index.html',
  'server/index.js',
  'server/database/db.js',
  'server/services/fundService.js',
  'server/services/marketService.js',
  'server/services/navService.js',
  'server/services/estimateService.js',
  'server/api/fund.js'
];

required.forEach(relativePath => {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) throw new Error(`缺少文件：${relativePath}`);
});

function JavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return JavaScriptFiles(fullPath);
    }
    return entry.name.endsWith('.js') || entry.name.endsWith('.cjs') ? [fullPath] : [];
  });
}

JavaScriptFiles(root).forEach(file => {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
});

require('../server/database/db').getDatabase();
console.log(`Build check passed: ${JavaScriptFiles(root).length} JavaScript files.`);
