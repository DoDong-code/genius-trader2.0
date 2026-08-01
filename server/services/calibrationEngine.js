const { getDatabase } = require('../database/db');
const { assertFundCode, getFund } = require('./fundService');
const config = require('../config/estimateConfig');

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function getStoredCalibration(fundCode) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT fund_code, optimal_holdings_weight, optimal_sector_weight,
           cash_adjustment, mae, rmse, direction_accuracy, sample_size, calibrated_at
    FROM fund_calibration
    WHERE fund_code = ?
  `).get(fundCode);
  return row || null;
}

function saveCalibration(record) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO fund_calibration (
      fund_code, optimal_holdings_weight, optimal_sector_weight, cash_adjustment,
      mae, rmse, direction_accuracy, sample_size, calibrated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(fund_code) DO UPDATE SET
      optimal_holdings_weight = excluded.optimal_holdings_weight,
      optimal_sector_weight = excluded.optimal_sector_weight,
      cash_adjustment = excluded.cash_adjustment,
      mae = excluded.mae,
      rmse = excluded.rmse,
      direction_accuracy = excluded.direction_accuracy,
      sample_size = excluded.sample_size,
      calibrated_at = datetime('now')
  `).run(
    record.fund_code,
    record.optimal_holdings_weight,
    record.optimal_sector_weight,
    record.cash_adjustment,
    record.mae,
    record.rmse,
    record.direction_accuracy,
    record.sample_size
  );
}

/**
 * Calibrates the estimation weights and cash adjustment using historical NAVs.
 * Evaluates model accuracy (MAE, RMSE, direction hit rate) against real historical NAVs.
 */
function calibrateFund(code, options = {}) {
  const fundCode = assertFundCode(code);
  const db = getDatabase();

  // If cached and not forced, return stored calibration if available
  if (!options.force) {
    const existing = getStoredCalibration(fundCode);
    if (existing) {
      return {
        calibrated: existing.sample_size > 0,
        fund_code: fundCode,
        holdings_weight: existing.optimal_holdings_weight,
        sector_weight: existing.optimal_sector_weight,
        cash_adjustment: existing.cash_adjustment,
        mae: existing.mae,
        rmse: existing.rmse,
        direction_accuracy: existing.direction_accuracy,
        sample_size: existing.sample_size,
        calibrated_at: existing.calibrated_at
      };
    }
  }

  // Retrieve historical NAVs sorted by date ascending
  const navs = db.prepare(`
    SELECT date, nav
    FROM fund_nav
    WHERE fund_code = ?
    ORDER BY date ASC
  `).all(fundCode);

  // If there are fewer than 2 NAV records, we cannot backtest properly
  if (navs.length < 2) {
    const defaultRecord = {
      fund_code: fundCode,
      optimal_holdings_weight: config.holdingsWeight,
      optimal_sector_weight: config.sectorWeight,
      cash_adjustment: config.cashAdjustment,
      mae: null,
      rmse: null,
      direction_accuracy: null,
      sample_size: 0
    };
    saveCalibration(defaultRecord);
    return {
      calibrated: false,
      ...defaultRecord,
      holdings_weight: defaultRecord.optimal_holdings_weight,
      sector_weight: defaultRecord.optimal_sector_weight
    };
  }

  // Calculate actual historical daily NAV changes
  const samples = [];
  for (let i = 1; i < navs.length; i++) {
    const prev = Number(navs[i - 1].nav);
    const curr = Number(navs[i].nav);
    if (prev > 0 && Number.isFinite(curr)) {
      const actualChange = curr / prev - 1;
      samples.push({
        date: navs[i].date,
        actualChange
      });
    }
  }

  // Get current holdings weights for fund
  const holdings = db.prepare(`
    SELECT stock_code, weight
    FROM fund_holdings
    WHERE fund_code = ?
      AND report_date = (SELECT MAX(report_date) FROM fund_holdings WHERE fund_code = ?)
  `).all(fundCode, fundCode);

  const totalPublishedWeight = holdings.reduce((sum, item) => sum + Number(item.weight || 0), 0);

  // Collect stock prices for historical dates to run backtest
  const stockPricesByDate = {};
  for (const h of holdings) {
    const prices = db.prepare(`
      SELECT date, change_percent, price
      FROM stock_price
      WHERE stock_code = ?
      ORDER BY date ASC
    `).all(h.stock_code);
    for (const p of prices) {
      if (!stockPricesByDate[p.date]) stockPricesByDate[p.date] = {};
      stockPricesByDate[p.date][h.stock_code] = p.change_percent;
    }
  }

  // Backtest samples where stock or sector data exists
  const pairedSamples = [];
  for (const sample of samples) {
    const datePrices = stockPricesByDate[sample.date];
    if (datePrices) {
      let pricedSum = 0;
      let totalPricedWeight = 0;
      for (const h of holdings) {
        if (datePrices[h.stock_code] !== undefined) {
          pricedSum += datePrices[h.stock_code] * h.weight;
          totalPricedWeight += h.weight;
        }
      }
      if (totalPricedWeight > 0) {
        const holdingsChange = pricedSum / totalPricedWeight;
        pairedSamples.push({
          date: sample.date,
          actual: sample.actualChange,
          holdingsChange
        });
      }
    }
  }

  // Determine optimal weights through MSE minimization over test grid
  let bestHoldingsWeight = config.holdingsWeight;
  let bestSectorWeight = config.sectorWeight;
  let bestCashAdj = config.cashAdjustment;
  let bestMse = Infinity;
  let bestMae = null;
  let bestRmse = null;
  let bestHitRate = null;

  if (pairedSamples.length >= 3) {
    // Grid search for optimal (w_h, w_s, c)
    const hSteps = [0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 1.0];
    const cSteps = [0, -0.0005, 0.0005, -0.001, 0.001];

    for (const hw of hSteps) {
      const sw = round(Math.max(0, 1 - hw), 4);
      for (const ca of cSteps) {
        let sumSqErr = 0;
        let sumAbsErr = 0;
        let hits = 0;

        for (const s of pairedSamples) {
          // Estimated change using current candidate weights
          const est = s.holdingsChange * hw - ca;
          const err = est - s.actual;
          sumSqErr += err * err;
          sumAbsErr += Math.abs(err);
          if ((est >= 0 && s.actual >= 0) || (est < 0 && s.actual < 0)) {
            hits++;
          }
        }

        const mse = sumSqErr / pairedSamples.length;
        if (mse < bestMse) {
          bestMse = mse;
          bestHoldingsWeight = hw;
          bestSectorWeight = sw;
          bestCashAdj = ca;
          bestMae = round(sumAbsErr / pairedSamples.length, 6);
          bestRmse = round(Math.sqrt(mse), 6);
          bestHitRate = round(hits / pairedSamples.length, 4);
        }
      }
    }
  } else {
    // Standard baseline fallback if insufficient historical paired stock data
    bestHoldingsWeight = config.holdingsWeight;
    bestSectorWeight = config.sectorWeight;
    bestCashAdj = config.cashAdjustment;
  }

  const record = {
    fund_code: fundCode,
    optimal_holdings_weight: bestHoldingsWeight,
    optimal_sector_weight: bestSectorWeight,
    cash_adjustment: bestCashAdj,
    mae: bestMae,
    rmse: bestRmse,
    direction_accuracy: bestHitRate,
    sample_size: pairedSamples.length
  };

  saveCalibration(record);

  return {
    calibrated: pairedSamples.length > 0,
    ...record,
    holdings_weight: record.optimal_holdings_weight,
    sector_weight: record.optimal_sector_weight,
    calibrated_at: new Date().toISOString()
  };
}

module.exports = {
  getStoredCalibration,
  calibrateFund
};
