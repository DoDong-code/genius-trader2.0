const { getDatabase } = require('../database/db');
const { assertFundCode, getFund, getRealtimeFundEstimate } = require('./fundService');
const { fetchStockQuote } = require('./marketService');
const config = require('../config/estimateConfig');

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function shanghaiDate(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(value));
}

function isShanghaiPostClose(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const time = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(time.hour) * 60 + Number(time.minute) >= 15 * 60;
}

function sectorForFund(fund) {
  const mapped = config.fundSectorMap[fund.fund_code];
  if (mapped) return mapped;
  const searchable = `${fund.fund_name || ''} ${fund.fund_type || ''}`;
  return config.nameRules.find(rule => rule.pattern.test(searchable))?.sector || null;
}

function latestHoldings(fundCode) {
  return getDatabase().prepare(`
    SELECT stock_code, stock_name, weight, report_date
    FROM fund_holdings
    WHERE fund_code = ?
      AND report_date = (
        SELECT MAX(report_date) FROM fund_holdings WHERE fund_code = ?
      )
    ORDER BY weight DESC
    LIMIT 10
  `).all(fundCode, fundCode);
}

function cachedQuote(stockCode, ttlMinutes = config.quoteTtlMinutes) {
  const row = getDatabase().prepare(`
    SELECT stock_code, date, price, change_percent, updated_at
    FROM stock_price
    WHERE stock_code = ? AND date = ?
  `).get(stockCode, shanghaiDate());
  if (!row) return null;
  const age = Date.now() - new Date(`${row.updated_at.replace(' ', 'T')}Z`).getTime();
  return age <= ttlMinutes * 60_000 ? row : null;
}

async function quoteFor(stockCode, options = {}) {
  const code = String(stockCode || '').trim();
  if (!options.force) {
    const cached = cachedQuote(code);
    if (cached) return { ...cached, source: 'stock-cache' };
  }
  const quote = await fetchStockQuote(code);
  if (!quote || !Number.isFinite(quote.change_percent)) return null;
  getDatabase().prepare(`
    INSERT INTO stock_price (stock_code, date, price, change_percent, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(stock_code, date) DO UPDATE SET
      price = excluded.price,
      change_percent = excluded.change_percent,
      updated_at = datetime('now')
  `).run(code, shanghaiDate(), Number(quote.price || 0), quote.change_percent);
  return quote;
}

function cachedEstimate(fundCode) {
  const row = getDatabase().prepare(`
    SELECT calculation_json, expires_at
    FROM fund_estimate
    WHERE fund_code = ? AND trade_date = ?
  `).get(fundCode, shanghaiDate());
  if (!row) return null;
  const expired = Date.parse(row.expires_at) <= Date.now();
  // After the 15:00 close, the last calculation for the current trade date is
  // the appropriate provisional close estimate until the official fund NAV is
  // published. Before close, keep the short cache TTL for live updates.
  if (expired && !isShanghaiPostClose()) return null;
  try {
    const cached = JSON.parse(row.calculation_json);
    if (cached.fallback === 'unavailable' || !Number.isFinite(Number(cached.estimate_change))) return null;
    return { ...cached, cached: true, closing_snapshot: expired };
  } catch {
    return null;
  }
}

function confidenceFor({ holdingsCount, quotedCount, publishedWeight, sectorAvailable, fallback }) {
  if (fallback) return 'low';
  const coverage = holdingsCount ? quotedCount / holdingsCount : 0;
  if (coverage >= 0.8 && publishedWeight >= 0.35 && sectorAvailable) return 'high';
  if ((coverage >= 0.5 && publishedWeight >= 0.15) || sectorAvailable) return 'medium';
  return 'low';
}

async function calculateFundEstimate(code, options = {}) {
  const fundCode = assertFundCode(code);
  if (!options.force) {
    const cached = cachedEstimate(fundCode);
    if (cached) {
      cached.estimateChange = cached.estimate_change_percent;
      if (Number.isFinite(Number(options.amount))) {
        cached.amount = round(Number(options.amount), 2);
        cached.estimate_profit = round(cached.amount * cached.estimate_change, 2);
        cached.estimateProfit = cached.estimate_profit;
      }
      return cached;
    }
  }
  const fund = getFund(fundCode);
  if (!fund) {
    const error = new Error(`基金 ${fundCode} 尚未导入`);
    error.statusCode = 404;
    throw error;
  }

  const holdings = latestHoldings(fundCode);
  const quoteResults = await Promise.all(holdings.map(async holding => {
    try {
      const quote = await quoteFor(holding.stock_code, options);
      return quote ? { ...holding, change_percent: quote.change_percent } : null;
    } catch {
      return null;
    }
  }));
  const pricedHoldings = quoteResults.filter(Boolean);
  const publishedWeight = holdings.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const pricedWeight = pricedHoldings.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const holdingsChange = pricedWeight > 0 && publishedWeight >= 0.05
    ? pricedHoldings.reduce((sum, item) => sum + item.change_percent * item.weight, 0) / pricedWeight
    : null;

  const sectorKey = sectorForFund(fund);
  const benchmark = sectorKey ? config.sectorBenchmarks[sectorKey] : null;
  let sectorQuote = null;
  if (benchmark) {
    try {
      sectorQuote = await quoteFor(benchmark.stockCode, options);
    } catch {
      sectorQuote = null;
    }
  }

  let estimateChange;
  let fallback = null;
  if (Number.isFinite(holdingsChange) && Number.isFinite(sectorQuote?.change_percent)) {
    estimateChange = holdingsChange * config.holdingsWeight
      + sectorQuote.change_percent * config.sectorWeight
      - config.cashAdjustment;
  } else if (Number.isFinite(holdingsChange)) {
    estimateChange = holdingsChange - config.cashAdjustment;
  } else if (Number.isFinite(sectorQuote?.change_percent)) {
    estimateChange = sectorQuote.change_percent - config.cashAdjustment;
    fallback = 'sector-only';
  } else {
    const publicEstimate = await getRealtimeFundEstimate(fundCode);
    const publicChange = Number(publicEstimate?.estimate_change);
    if (publicEstimate?.source === 'fundgz' && Number.isFinite(publicChange)) {
      estimateChange = publicChange;
      fallback = 'public-estimate';
    } else {
      // Do not substitute the previous trading day's NAV move when live inputs
      // are unavailable.  Consumers can show a clear “待估值” state instead.
      estimateChange = null;
      fallback = 'unavailable';
    }
  }

  const confidence = confidenceFor({
    holdingsCount: holdings.length,
    quotedCount: pricedHoldings.length,
    publishedWeight,
    sectorAvailable: Number.isFinite(sectorQuote?.change_percent),
    fallback
  });
  const result = {
    fund_code: fundCode,
    name: fund.fund_name,
    trade_date: shanghaiDate(),
    estimate_change: Number.isFinite(estimateChange) ? round(estimateChange) : null,
    estimate_change_percent: Number.isFinite(estimateChange) ? round(estimateChange * 100, 2) : null,
    holdings_change: Number.isFinite(holdingsChange) ? round(holdingsChange) : null,
    sector_change: Number.isFinite(sectorQuote?.change_percent)
      ? round(sectorQuote.change_percent) : null,
    cash_adjustment: config.cashAdjustment,
    confidence,
    quote_coverage: holdings.length ? round(pricedHoldings.length / holdings.length, 4) : 0,
    holdings_weight_coverage: round(publishedWeight, 4),
    holdings_report_date: holdings[0]?.report_date || null,
    benchmark: benchmark ? { ...benchmark, sector: sectorKey } : null,
    weights: { holdings: config.holdingsWeight, sector: config.sectorWeight },
    fallback,
    calculated_at: new Date().toISOString(),
    cached: false
  };
  result.estimateChange = result.estimate_change_percent;
  if (Number.isFinite(Number(options.amount))) {
    result.amount = round(Number(options.amount), 2);
    result.estimate_profit = Number.isFinite(estimateChange)
      ? round(result.amount * estimateChange, 2)
      : null;
    result.estimateProfit = result.estimate_profit;
  }

  // There is no real-time input to calculate from.  Return the explicit empty
  // state to the UI without saving an artificial zero/previous-NAV estimate.
  if (!Number.isFinite(estimateChange)) return result;

  const expiresAt = new Date(Date.now() + config.estimateTtlMinutes * 60_000).toISOString();
  getDatabase().prepare(`
    INSERT INTO fund_estimate (
      fund_code, trade_date, estimate_change, holdings_change, sector_change,
      cash_adjustment, confidence, quote_coverage, calculation_json, calculated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fund_code, trade_date) DO UPDATE SET
      estimate_change = excluded.estimate_change,
      holdings_change = excluded.holdings_change,
      sector_change = excluded.sector_change,
      cash_adjustment = excluded.cash_adjustment,
      confidence = excluded.confidence,
      quote_coverage = excluded.quote_coverage,
      calculation_json = excluded.calculation_json,
      calculated_at = excluded.calculated_at,
      expires_at = excluded.expires_at
  `).run(
    fundCode, result.trade_date, result.estimate_change, result.holdings_change,
    result.sector_change, result.cash_adjustment, result.confidence,
    result.quote_coverage, JSON.stringify(result), result.calculated_at, expiresAt
  );
  return result;
}

async function calculateAccountEstimate(accountId, options = {}) {
  const id = String(accountId || '').trim();
  if (!id) {
    const error = new Error('账户 ID 不能为空');
    error.statusCode = 400;
    throw error;
  }
  const positions = getDatabase().prepare(`
    SELECT p.fund_code, p.amount, p.cost, f.fund_name
    FROM portfolio p JOIN fund f ON f.fund_code = p.fund_code
    WHERE p.account_id = ? ORDER BY p.fund_code
  `).all(id);
  const funds = await Promise.all(positions.map(async position => {
    const estimate = await calculateFundEstimate(position.fund_code, {
      ...options, amount: position.amount
    });
    return { ...estimate, fund_name: position.fund_name, cost: position.cost };
  }));
  const totalAmount = round(funds.reduce((sum, item) => sum + Number(item.amount || 0), 0), 2);
  const todayProfit = round(funds.reduce((sum, item) => sum + Number(item.estimate_profit || 0), 0), 2);
  return {
    account_id: id,
    total_amount: totalAmount,
    totalAmount,
    today_profit: todayProfit,
    todayProfit,
    today_change: totalAmount ? round(todayProfit / totalAmount) : 0,
    todayChange: totalAmount ? round(todayProfit / totalAmount * 100, 2) : 0,
    today_change_percent: totalAmount ? round(todayProfit / totalAmount * 100, 2) : 0,
    confidence: funds.some(item => item.confidence === 'low') ? 'low'
      : funds.some(item => item.confidence === 'medium') ? 'medium' : 'high',
    funds,
    calculated_at: new Date().toISOString()
  };
}

module.exports = {
  calculateFundEstimate,
  calculateAccountEstimate,
  latestHoldings,
  sectorForFund,
  quoteFor
};
