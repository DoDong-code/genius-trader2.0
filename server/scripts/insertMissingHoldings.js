const { getDatabase, transaction, closeDatabase } = require('../database/db');
const fs = require('node:fs');
const path = require('node:path');

const holdings = [
  // 019633 国泰半导体设备ETF联接C
  { fund_code: '019633', stock_code: '688012', stock_name: '中微公司', weight: 0.1502, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '002371', stock_name: '北方华创', weight: 0.1411, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688256', stock_name: '寒武纪', weight: 0.1036, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688041', stock_name: '海光信息', weight: 0.0712, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '300604', stock_name: '长川科技', weight: 0.0649, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688072', stock_name: '拓荆科技', weight: 0.0616, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688120', stock_name: '华海清科', weight: 0.0546, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688361', stock_name: '中科飞测', weight: 0.0450, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688981', stock_name: '中芯国际', weight: 0.0335, report_date: '2026-06-30' },
  { fund_code: '019633', stock_code: '688200', stock_name: '华峰测控', weight: 0.0317, report_date: '2026-06-30' },

  // 008702 华夏黄金ETF联接C
  { fund_code: '008702', stock_code: 'AU9999', stock_name: '黄金现货', weight: 0.9510, report_date: '2026-06-30' },
  { fund_code: '008702', stock_code: 'CASH', stock_name: '现金及其他', weight: 0.0490, report_date: '2026-06-30' },

  // 004253 国泰黄金ETF联接C
  { fund_code: '004253', stock_code: 'AU9999', stock_name: '黄金现货', weight: 0.9480, report_date: '2026-06-30' },
  { fund_code: '004253', stock_code: 'CASH', stock_name: '现金及其他', weight: 0.0520, report_date: '2026-06-30' },

  // 013309 易方达恒生科技ETF联接(QDII)C
  { fund_code: '013309', stock_code: 'MEITUAN', stock_name: '美团-W', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'NETEASE', stock_name: '网易', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'XIAOMI', stock_name: '小米集团-W', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'TENCENT', stock_name: '腾讯控股', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'BYD', stock_name: '比亚迪股份', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'ALIBABA', stock_name: '阿里巴巴-W', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'SMIC_HK', stock_name: '中芯国际', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'JD_HK', stock_name: '京东集团-SW', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'LENOVO', stock_name: '联想集团', weight: 0.0800, report_date: '2026-06-30' },
  { fund_code: '013309', stock_code: 'BAIDU', stock_name: '百度集团-SW', weight: 0.0800, report_date: '2026-06-30' },

  // 022184 富国全球科技互联网股票(QDII)C
  { fund_code: '022184', stock_code: 'ASMPT', stock_name: 'ASMPT', weight: 0.0562, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: '603986', stock_name: '兆易创新', weight: 0.0551, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: 'SNDK', stock_name: '闪迪', weight: 0.0504, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: '600183', stock_name: '生益科技', weight: 0.0470, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: '000660', stock_name: 'SK海力士', weight: 0.0462, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: '005930', stock_name: '三星电子', weight: 0.0458, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: 'KIOXIA', stock_name: 'KIOXIA', weight: 0.0458, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: 'MU', stock_name: '美光科技', weight: 0.0431, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: 'STX', stock_name: '希捷科技', weight: 0.0428, report_date: '2026-06-30' },
  { fund_code: '022184', stock_code: 'WDC', stock_name: '西部数据', weight: 0.0422, report_date: '2026-06-30' }
];

function main() {
  const db = getDatabase();
  const uniqueFundCodes = [...new Set(holdings.map(h => h.fund_code))];

  transaction(database => {
    // 1. Delete old 2026-06-30 holdings for these funds to prevent mixing
    const deleteStmt = database.prepare("DELETE FROM fund_holdings WHERE fund_code = ? AND report_date = '2026-06-30'");
    for (const code of uniqueFundCodes) {
      deleteStmt.run(code);
    }

    // 2. Insert fresh new holdings
    const stmt = database.prepare(`
      INSERT INTO fund_holdings (fund_code, stock_code, stock_name, weight, report_date)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const h of holdings) {
      stmt.run(h.fund_code, h.stock_code, h.stock_name, h.weight, h.report_date);
    }
  });

  console.log('[fund:holdings] Successfully inserted/updated holdings in database.');

  // 3. Clear cache files so they are regenerated
  const cacheDir = path.join(__dirname, '..', 'data', 'cache');
  for (const code of uniqueFundCodes) {
    const cacheFile = path.join(cacheDir, `${code}.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        fs.unlinkSync(cacheFile);
        console.log(`[fund:cache] Deleted cache for ${code}`);
      } catch (err) {
        console.warn(`[fund:cache] Could not delete cache for ${code}: ${err.message}`);
      }
    }
  }

  closeDatabase();
}

main();
