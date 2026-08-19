const { getDatabase } = require('../database/db');
const dbAsync = require('../database/dbAsync');
const { assertFundCode, getFund, getRealtimeFundEstimate } = require('./fundService');
const { fetchStockQuote, toYahooSymbol, normalizeStockCode } = require('./marketService');
const { calibrateFund } = require('./calibrationEngine');
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

async function latestHoldings(fundCode) {
  return await dbAsync.all(`
    SELECT stock_code, stock_name, weight, report_date
    FROM fund_holdings
    WHERE fund_code = ?
      AND report_date = (
        SELECT MAX(report_date) FROM fund_holdings WHERE fund_code = ?
      )
    ORDER BY weight DESC
    LIMIT 10
  `, [fundCode, fundCode]);
}

// stock_price 读写统一走 dbAsync（生产 PostgreSQL / 本地 SQLite 回退）。
// Phase 3.15 修复：此前 cachedQuote/quoteFor 经 getDatabase() 直接读写本地 SQLite，
// 与 calibrateFund 读取的 PostgreSQL 分裂，导致生产 stock_price 恒为空、pairedSamples 恒为 0。
async function cachedQuote(stockCode, ttlMinutes = config.quoteTtlMinutes) {
  const row = await dbAsync.get(`
    SELECT stock_code, date, price, change_percent, updated_at
    FROM stock_price
    WHERE stock_code = ? AND date = ?
  `, [stockCode, shanghaiDate()]);
  if (!row) return null;
  const age = Date.now() - new Date(`${String(row.updated_at).replace(' ', 'T')}Z`).getTime();
  return age <= ttlMinutes * 60_000 ? row : null;
}

async function quoteFor(stockCode, options = {}) {
  const code = String(stockCode || '').trim();
  if (!options.force) {
    const cached = await cachedQuote(code);
    if (cached) return { ...cached, source: 'stock-cache' };
  }
  const quote = await fetchStockQuote(code);
  if (!quote || !Number.isFinite(quote.change_percent)) return null;
  await dbAsync.run(`
    INSERT INTO stock_price (stock_code, date, price, change_percent, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(stock_code, date) DO UPDATE SET
      price = excluded.price,
      change_percent = excluded.change_percent,
      updated_at = CURRENT_TIMESTAMP
  `, [code, shanghaiDate(), Number(quote.price || 0), quote.change_percent]);
  return quote;
}

function isQdiiFund(fund) {
  const type = fund.fund_type || '';
  const name = fund.fund_name || '';
  return type.includes('QDII') || type.includes('海外') || name.includes('QDII');
}

function isBondFund(fund) {
  const type = fund.fund_type || '';
  const name = fund.fund_name || '';
  return type.includes('债券') || type.includes('纯债') || name.includes('债券') || name.includes('纯债');
}

function dampBondChange(change) {
  if (change === null || change === undefined || !Number.isFinite(change)) return change;
  const abs = Math.abs(change);
  if (abs <= 0.001) return change;
  const sign = Math.sign(change);
  const damped = 0.001 + (abs - 0.001) * 0.1;
  return sign * Math.min(damped, 0.003);
}

function getNextTradingDay(dateStr) {
  const parts = dateStr.split('-');
  let curr = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  while (true) {
    curr.setDate(curr.getDate() + 1);
    const yyyy = curr.getFullYear();
    const mm = String(curr.getMonth() + 1).padStart(2, '0');
    const dd = String(curr.getDate()).padStart(2, '0');
    const ds = `${yyyy}-${mm}-${dd}`;
    
    let isTrade = true;
    const dayOfWeek = curr.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      isTrade = false;
    } else {
      const holidays = [
        '2026-01-01', '2026-01-02',
        '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
        '2026-04-06',
        '2026-05-01', '2026-05-04', '2026-05-05',
        '2026-06-19',
        '2026-09-25',
        '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'
      ];
      if (holidays.includes(ds)) {
        isTrade = false;
      }
    }
    if (isTrade) return ds;
  }
}

function isUsMarketSessionStartedToday() {
  const nyDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = nyDate.getDay();
  if (day === 0 || day === 6) return false;
  
  const hour = nyDate.getHours();
  const minute = nyDate.getMinutes();
  const minutes = hour * 60 + minute;
  return minutes >= (9 * 60 + 30);
}

function getYahooSymbol(stockCode) {
  // 统一走 marketService 的归一化 + Yahoo 代码转换（已覆盖 JP3236330001→285A.T、285A→285A.T、000660→000660.KS）
  return toYahooSymbol(normalizeStockCode(stockCode));
}

async function fetchHistoricalChange(stockCode, date, options = {}) {
  const { stockSecIds, normalizeStockCode } = require('./marketService');
  const rawCode = normalizeStockCode(stockCode);
  const secids = stockSecIds(rawCode);
  // 东京(.T)/韩国(.KS) Eastmoney 不可靠，跳过以免误查 A股同名代码
  if (!/\.(T|KS)$/.test(rawCode)) {
    for (const secid of secids) {
      try {
        const url = `http://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=15`;
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) continue;
        const json = await response.json();
        const klines = json?.data?.klines;
        if (klines && klines.length > 0) {
          for (const line of klines) {
            const parts = line.split(',');
            if (parts[0] === date) {
              const pct = Number(parts[8]);
              if (Number.isFinite(pct)) {
                return pct / 100;
              }
            }
          }
        }
      } catch (err) {
        // ignore
      }
    }
  }

  // Fallback 1: Yahoo Finance（query1 失败/无数据则回退 query2，提升 Render 出网鲁棒性，指令 F）
  try {
    const symbol = getYahooSymbol(stockCode);
    let json = null;
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`, {
          signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
          const j = await response.json();
          if (j?.chart?.result?.[0]) { json = j; break; }
        }
      } catch (err) { /* try next host */ }
    }
    const result = json?.chart?.result?.[0];
      const timestamps = result?.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      if (timestamps && closes && timestamps.length > 0) {
        let targetIndex = -1;
        for (let i = 0; i < timestamps.length; i++) {
          const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          if (d === date) {
            targetIndex = i;
            break;
          }
        }
        if (targetIndex >= 0) {
          const targetClose = closes[targetIndex];
          if (targetClose !== null && targetClose !== undefined) {
            let prevClose = null;
            for (let j = targetIndex - 1; j >= 0; j--) {
              if (closes[j] !== null && closes[j] !== undefined) {
                prevClose = closes[j];
                break;
              }
            }
            if (prevClose !== null && prevClose > 0) {
              return (targetClose - prevClose) / prevClose;
            }
          }
        }
      }
  } catch (err) {
    // ignore
  }

  // Fallback 2: Real-time quote for the stock
  try {
    const quote = await quoteFor(stockCode, options);
    if (quote && Number.isFinite(quote.change_percent)) {
      return quote.change_percent;
    }
  } catch (err) {
    // ignore
  }

  return null;
}

async function cachedEstimate(fundCode, targetDate = shanghaiDate()) {
  const row = await dbAsync.get(`
    SELECT calculation_json, expires_at
    FROM fund_estimate
    WHERE fund_code = ? AND trade_date = ?
  `, [fundCode, targetDate]);
  if (!row) return null;
  const expired = Date.parse(row.expires_at) <= Date.now();
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
  let fund = await getFund(fundCode);
  if (!fund) {
    try {
      console.log(`[auto-import] Fund ${fundCode} not found in DB. Auto-importing...`);
      const { importFund } = require('./fundService');
      await importFund(fundCode);
      fund = await getFund(fundCode);
    } catch (importErr) {
      console.error(`[auto-import-failed] Fund ${fundCode}: ${importErr.message}`);
    }
  }
  if (!fund) {
    const error = new Error(`基金 ${fundCode} 尚未导入`);
    error.statusCode = 404;
    throw error;
  }

  const isQdii = isQdiiFund(fund);
  let targetDate = shanghaiDate();
  if (isQdii && fund.latest_nav && fund.latest_nav.date) {
    targetDate = getNextTradingDay(fund.latest_nav.date);
    if (targetDate > shanghaiDate()) {
      targetDate = shanghaiDate();
    }
  }

  if (!options.force) {
    const cached = await cachedEstimate(fundCode, targetDate);
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

  const holdings = await latestHoldings(fundCode);
  let quoteResults;

  if (targetDate === shanghaiDate()) {
    quoteResults = await Promise.all(holdings.map(async holding => {
      try {
        const isUs = /^[A-Za-z]/.test(holding.stock_code);
        if (isUs && !isUsMarketSessionStartedToday()) {
          return { ...holding, change_percent: 0 };
        }
        const quote = await quoteFor(holding.stock_code, options);
        return quote ? { ...holding, change_percent: quote.change_percent } : null;
      } catch {
        return null;
      }
    }));
  } else {
    quoteResults = await Promise.all(holdings.map(async holding => {
      try {
        const change = await fetchHistoricalChange(holding.stock_code, targetDate, options);
        return change !== null ? { ...holding, change_percent: change } : null;
      } catch {
        return null;
      }
    }));
  }

  const pricedHoldings = quoteResults.filter(Boolean);
  const publishedWeight = holdings.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const pricedWeight = pricedHoldings.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  
  const isBond = isBondFund(fund);
  const holdingsChange = pricedWeight > 0 && publishedWeight >= 0.05
    ? pricedHoldings.reduce((sum, item) => sum + item.change_percent * item.weight, 0)
    : null;

  const sectorKey = isBond ? null : sectorForFund(fund);
  const benchmark = sectorKey ? config.sectorBenchmarks[sectorKey] : null;
  let sectorChange = null;

  if (benchmark) {
    if (targetDate === shanghaiDate()) {
      try {
        const sectorQuote = await quoteFor(benchmark.stockCode, options);
        sectorChange = sectorQuote?.change_percent ?? null;
      } catch {
        sectorChange = null;
      }
    } else {
      try {
        sectorChange = await fetchHistoricalChange(benchmark.stockCode, targetDate);
      } catch {
        sectorChange = null;
      }
    }
  }

  const calibration = await calibrateFund(fundCode, { force: options.force });
  const holdingsWeight = calibration.holdings_weight ?? config.holdingsWeight;
  const sectorWeight = calibration.sector_weight ?? config.sectorWeight;
  const cashAdjustment = calibration.cash_adjustment ?? config.cashAdjustment;

  let estimateChange;
  let fallback = null;
  if (Number.isFinite(holdingsChange) && Number.isFinite(sectorChange)) {
    estimateChange = holdingsChange * holdingsWeight
      + sectorChange * sectorWeight
      - cashAdjustment;
  } else if (Number.isFinite(holdingsChange)) {
    estimateChange = holdingsChange - cashAdjustment;
  } else if (Number.isFinite(sectorChange)) {
    estimateChange = sectorChange - cashAdjustment;
    fallback = 'sector-only';
  } else {
    // holdings + sector 均不可得时的最后兜底：接受任何有限值的公开估计。
    // Render 出网屏蔽东方财富(fundgz)时，getRealtimeFundEstimate 会回退到本地 NAV 历史
    // （source='本地数据库缓存'），其 estimate_change 是有限有效值，不应因 source!=='fundgz'
    // 被丢弃而导致 estimate_change=null（指令 F：采用其他现有可用行情源作最小兜底）。
    const publicEstimate = await getRealtimeFundEstimate(fundCode);
    const publicChange = Number(publicEstimate?.estimate_change);
    if (Number.isFinite(publicChange)) {
      estimateChange = publicChange;
      fallback = publicEstimate?.source === 'fundgz' ? 'public-estimate' : 'public-estimate-local';
    } else {
      estimateChange = null;
      fallback = 'unavailable';
    }
  }

  if (isBondFund(fund) && Number.isFinite(estimateChange)) {
    estimateChange = dampBondChange(estimateChange);
  }

  const confidence = confidenceFor({
    holdingsCount: holdings.length,
    quotedCount: pricedHoldings.length,
    publishedWeight,
    sectorAvailable: Number.isFinite(sectorChange),
    fallback
  });

  const result = {
    fund_code: fundCode,
    name: fund.fund_name,
    trade_date: targetDate,
    estimate_change: Number.isFinite(estimateChange) ? round(estimateChange) : null,
    estimate_change_percent: Number.isFinite(estimateChange) ? round(estimateChange * 100, 2) : null,
    holdings_change: Number.isFinite(holdingsChange) ? round(holdingsChange) : null,
    sector_change: Number.isFinite(sectorChange) ? round(sectorChange) : null,
    cash_adjustment: cashAdjustment,
    confidence,
    quote_coverage: holdings.length ? round(pricedHoldings.length / holdings.length, 4) : 0,
    holdings_weight_coverage: round(publishedWeight, 4),
    holdings_report_date: holdings[0]?.report_date || null,
    benchmark: benchmark ? { ...benchmark, sector: sectorKey } : null,
    weights: { holdings: holdingsWeight, sector: sectorWeight },
    calibration: {
      calibrated: calibration.calibrated,
      mae: calibration.mae,
      rmse: calibration.rmse,
      direction_accuracy: calibration.direction_accuracy,
      sample_size: calibration.sample_size,
      calibrated_at: calibration.calibrated_at
    },
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

  if (!Number.isFinite(estimateChange)) return result;

  const expiresAt = new Date(Date.now() + config.estimateTtlMinutes * 60_000).toISOString();
  await dbAsync.run(`
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
  `, [
    fundCode, result.trade_date, result.estimate_change, result.holdings_change,
    result.sector_change, result.cash_adjustment, result.confidence,
    result.quote_coverage, JSON.stringify(result), result.calculated_at, expiresAt
  ]);
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
