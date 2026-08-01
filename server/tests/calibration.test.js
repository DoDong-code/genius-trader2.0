const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temporaryDirectory = fs.mkdtempSync(path.join(__dirname, 'calibration-test-'));
process.env.FUND_DB_PATH = path.join(temporaryDirectory, 'test-calibration.sqlite');

const { getDatabase, closeDatabase } = require('../database/db');
const { calibrateFund, getStoredCalibration } = require('../services/calibrationEngine');
const { calculateFundEstimate } = require('../services/estimateEngine');

test.beforeEach(() => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO fund (fund_code, fund_name, fund_type, company)
    VALUES ('000001', '华夏成长混合', '混合型', '华夏基金')
    ON CONFLICT(fund_code) DO NOTHING
  `).run();

  db.prepare(`
    INSERT INTO fund_holdings (fund_code, stock_code, stock_name, weight, report_date)
    VALUES ('000001', '600519', '贵州茅台', 0.8, '2026-06-30')
    ON CONFLICT DO NOTHING
  `).run();

  // Insert historical NAVs
  const insertNav = db.prepare(`
    INSERT INTO fund_nav (fund_code, date, nav, acc_nav)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  insertNav.run('000001', '2026-07-25', 2.0, 2.0);
  insertNav.run('000001', '2026-07-26', 2.04, 2.04); // +2%
  insertNav.run('000001', '2026-07-27', 2.0196, 2.0196); // -1%
  insertNav.run('000001', '2026-07-28', 2.080188, 2.080188); // +3%

  // Insert historical stock prices for 600519
  const insertPrice = db.prepare(`
    INSERT INTO stock_price (stock_code, date, price, change_percent, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT DO NOTHING
  `);
  insertPrice.run('600519', '2026-07-26', 1800, 0.025); // stock move +2.5% -> fund move +2.0%
  insertPrice.run('600519', '2026-07-27', 1782, -0.0125); // stock move -1.25% -> fund move -1.0%
  insertPrice.run('600519', '2026-07-28', 1848, 0.0375); // stock move +3.75% -> fund move +3.0%
});

test('calibrates optimal weights using historical NAV and stock holdings', () => {
  const result = calibrateFund('000001', { force: true });
  assert.equal(result.calibrated, true);
  assert.equal(result.sample_size, 3);
  assert.equal(result.holdings_weight, 0.8); // 0.025 * 0.8 = 0.020 (exact match for 2% NAV change)
  assert.ok(Number.isFinite(result.mae));
  assert.ok(Number.isFinite(result.direction_accuracy));
  assert.equal(result.direction_accuracy, 1.0); // 100% directional hit rate

  const stored = getStoredCalibration('000001');
  assert.equal(stored.optimal_holdings_weight, 0.8);
  assert.equal(stored.direction_accuracy, 1.0);
});

test('estimate engine attaches calibration metadata', async () => {
  const estimate = await calculateFundEstimate('000001');
  assert.ok(estimate.calibration);
  assert.equal(estimate.calibration.calibrated, true);
  assert.equal(estimate.calibration.sample_size, 3);
  assert.equal(estimate.weights.holdings, 0.8);
});

test.after(() => {
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
