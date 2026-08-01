const { importFund } = require('../services/fundService');
const { upsertPosition } = require('../services/estimateService');
const { closeDatabase } = require('../database/db');

const seedFunds = [
  { code: '019633', amount: 10000 },
  { code: '008702', amount: 15000 }
];

async function main() {
  for (const seed of seedFunds) {
    console.log(`[fund:seed] 导入 ${seed.code}`);
    const result = await importFund(seed.code);
    upsertPosition({
      account_id: 'account2',
      fund_code: seed.code,
      shares: 0,
      cost: seed.amount,
      amount: seed.amount
    });
    console.log(
      `[fund:seed] ${seed.code} ${result.fund}，净值 ${result.records} 条，新增 ${result.inserted} 条`
    );
  }
  closeDatabase();
}

main().catch(error => {
  console.error('[fund:seed] 导入失败：', error);
  closeDatabase();
  process.exitCode = 1;
});
