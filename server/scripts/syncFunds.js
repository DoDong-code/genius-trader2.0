const { syncAll } = require('../services/navService');
const { closeDatabase } = require('../database/db');

async function main() {
  console.log(`[fund:sync] 开始同步 ${new Date().toISOString()}`);
  const results = await syncAll({
    force: process.argv.includes('--force')
  });
  results.forEach(result => {
    if (result.success) {
      console.log(
        `[fund:sync] ${result.fund_code} 成功，新增 ${result.inserted} 条，` +
        `总计 ${result.records} 条${result.cached ? '（今日缓存）' : ''}，${result.duration_ms}ms`
      );
    } else {
      console.error(`[fund:sync] ${result.fund_code} 失败：${result.error}`);
    }
  });
  const failed = results.filter(result => !result.success).length;
  console.log(`[fund:sync] 完成：${results.length - failed} 成功，${failed} 失败`);
  closeDatabase();
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('[fund:sync] 未完成：', error);
  closeDatabase();
  process.exitCode = 1;
});
