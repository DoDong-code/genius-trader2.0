#!/usr/bin/env node
/**
 * 股票历史行情同步 CLI（A2）。
 *
 * 用法：
 *   node server/scripts/syncStockHistory.js --fund <基金代码> [--days 365]
 *   node server/scripts/syncStockHistory.js --all [--days 365]
 *
 * 说明：
 *   --fund  仅同步该基金最新报告期的前十大持仓股票历史行情
 *   --all   同步数据库中出现过的全部持仓股票历史行情
 *   --days  回溯天数，默认 365（建议 >= 365 以覆盖足够校准样本）
 *
 * 注意：本脚本写入 stock_price 表（唯一键 stock_code+date，幂等）。
 *       需在部署后、对生产数据库执行；重复执行不会重复插入。
 */
const { syncFundHoldingsHistory, syncAllHoldingsHistory } = require('../services/stockHistoryService');

const args = process.argv.slice(2);
const fundIdx = args.indexOf('--fund');
const daysIdx = args.indexOf('--days');
const all = args.includes('--all');
const fundCode = fundIdx >= 0 ? args[fundIdx + 1] : null;
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 365;

(async () => {
  let result;
  if (all) {
    console.error(`[sync] syncing ALL held stocks, days=${days}`);
    result = await syncAllHoldingsHistory({ days });
  } else if (fundCode) {
    console.error(`[sync] syncing fund ${fundCode}, days=${days}`);
    result = await syncFundHoldingsHistory(fundCode, { days });
  } else {
    console.error('Usage: node server/scripts/syncStockHistory.js --fund <code> [--days 365] | --all [--days 365]');
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error('sync failed:', error);
  process.exit(1);
});
