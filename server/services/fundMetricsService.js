/**
 * 基金量化指标服务（performance / benchmark / allocation / portfolioSummary）
 *
 * 设计原则（对齐需求 §四~§八）：
 *  - 纯计算函数与数据访问分离：纯函数可单测，绝不伪造数据。
 *  - 收益率按「日历时间」确定起止日期，取截止日（含）之前最后一个有效净值做基期，
 *    绝不把「最近 N 条」当作精确周期。
 *  - 数据不足 / 基准缺失 / 持仓不足：一律如实返回 null，禁止用 0 冒充、禁止默认沪深300。
 *  - 历史净值按需回填：数据库不足以覆盖 1 年窗口时，才从现有数据源增量补齐
 *    （ON CONFLICT DO NOTHING，绝不覆盖已确认净值），带 sync_markers 节流与并发去重。
 *  - QDII：dataAsOf 一律取数据中真实最新日期，不向「今天」对齐。
 *  - 估值不参与历史收益计算：本服务只读 fund_nav（正式净值）与 stock_price（基准行情）。
 */
const dbAsync = require('../database/dbAsync');
const { assertFundCode } = require('./fundService');
const navService = require('./navService');
const { getSyncMarker, setSyncMarker } = require('../database/dbAsync');
const profileConfig = require('../config/fundProfileConfig');

// —— 可注入的数据获取器（默认走 marketService / stockHistoryService，测试可注入 stub） ——
function defaultFetchFundHistory(code, options) {
  const { fetchHistory } = require('./marketService');
  return fetchHistory(code, options);
}
function defaultSyncBenchmarkHistory(stockCode, options) {
  const { syncStockHistory } = require('./stockHistoryService');
  return syncStockHistory(stockCode, options);
}

// 回填节流：成功 24h 内不重试；失败 2h 内不重试（避免打爆数据源）。
const BACKFILL_TTL_SUCCESS_MS = Number(process.env.PERF_BACKFILL_TTL_MS || 24 * 60 * 60 * 1000);
const BACKFILL_TTL_FAIL_MS = 2 * 60 * 60 * 1000;
// 单次回填最多拉取页数（pageSize=100/页 → 默认最多约 800 条 ≈ 3 年+）
const BACKFILL_MAX_PAGES = Math.min(Math.max(Number(process.env.PERF_BACKFILL_MAXPAGES || 8), 1), 50);
// 分析请求内等待回填完成的软上限：超时后先用现有数据返回（回填在后台继续完成，下次生效）
const BACKFILL_WAIT_MS = Number(process.env.PERF_BACKFILL_WAIT_MS || 8000);

// performance 历史窗口上限（≈ 19 个月交易日；即使按自然日数据也足以覆盖 1 年窗口）
const PERF_HISTORY_LIMIT = Math.min(Math.max(Number(process.env.PERF_HISTORY_LIMIT || 400), 60), 1000);
// 相对收益窗口对齐容差：基金净值日与基准行情日相差超过该天数 → relativeReturn 为 null
const BENCH_ALIGN_TOLERANCE_DAYS = Number(process.env.BENCH_ALIGN_TOLERANCE_DAYS || 7);

// ============================================================================
 // 纯函数：序列规范化
// ============================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 yyyy-mm-dd 且为真实日历日期 */
function isValidDateStr(dateStr) {
  if (!DATE_RE.test(String(dateStr || ''))) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 规范化净值/价格序列：
 *  - 丢弃非法日期、非法数值（0 < nav < 1e5，与 importFund 写入防火墙一致）
 *  - 重复日期保留最后一条（后写优先），乱序输入重排为升序
 *  - 输出 [{date, value}] 升序
 */
function normalizeSeries(rows, { valueField = 'nav' } = {}) {
  if (!Array.isArray(rows)) return [];
  const byDate = new Map();
  for (const row of rows) {
    if (!row) continue;
    const date = String(row.date || '');
    const raw = Number(row[valueField]);
    if (!isValidDateStr(date)) continue;
    if (!Number.isFinite(raw) || raw <= 0 || raw >= 100000) continue;
    byDate.set(date, { date, value: raw });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 序列尺度异常检测（纯函数）：
 * 逐行与此前 window 行的中位数比较，偏离超过 jumpFactor 倍（>×j 或 <÷j）判为异常行。
 * 背景（2026-10-16 生产事故）：estimateEngine 将 ETF 实时报价按 2 位小数精度换算（实际 3 位），
 * 写入 stock_price 当日行价格放大 10 倍，污染基准序列导致收益率爆炸（如 7.39 = 0.739×10 量级）。
 * 该检测同时防护：不同单位混写、单行脏数据。返回异常行日期 Set。
 */
function detectScaleAnomalies(series, { jumpFactor = 4, window = 10 } = {}) {
  const bad = new Set();
  if (!Array.isArray(series) || series.length < window + 1) return bad;
  const values = series.map(p => Number(p.value));
  for (let i = window; i < series.length; i += 1) {
    const ref = values.slice(i - window, i).filter(v => v > 0).sort((a, b) => a - b);
    if (!ref.length) continue;
    const mid = ref.length >> 1;
    const median = ref.length % 2 ? ref[mid] : (ref[mid - 1] + ref[mid]) / 2;
    if (!(median > 0)) continue;
    if (values[i] > median * jumpFactor || values[i] < median / jumpFactor) {
      bad.add(series[i].date);
    }
  }
  return bad;
}

/** 两个 yyyy-mm-dd 的自然日差（a - b） */
function dayDiff(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(dbb)) return null;
  return Math.round((da - dbb) / 86400000);
}

// ============================================================================
// 纯函数：日历窗口收益率
// ============================================================================

/** yyyy-mm-dd 减 n 个自然月（月末钳制：3-31 减 1 月 → 2-28/2-29） */
function subtractMonths(dateStr, months) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${target.getUTCFullYear()}-${mm}-${dd}`;
}

/** 序列中 date <= cutoff 的最后一个点（升序序列二分），没有则 null */
function valueOnOrBefore(series, cutoff) {
  let lo = 0, hi = series.length - 1, hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= cutoff) { hit = series[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return hit;
}

/**
 * 日历窗口收益率：latest / base - 1。
 * base = 截止日（latestDate - months 个月）当天或之前最后一个有效点。
 * 序列不足以覆盖窗口（cutoff 早于最早记录）→ null，绝不拿短窗口冒充长周期。
 */
function calendarReturn(series, months) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = series[series.length - 1];
  const cutoff = subtractMonths(latest.date, months);
  const base = valueOnOrBefore(series, cutoff);
  if (!base || !Number.isFinite(base.value) || base.value <= 0) return null;
  return latest.value / base.value - 1;
}

// ============================================================================
// 纯函数：回撤 / 波动率 / 趋势
// ============================================================================

/**
 * 近一年最大回撤与当前距高点跌幅。
 * 覆盖口径（与 calendarReturn / return1y 完全统一）：完整序列在 cutoff（latest-12 个自然月）
 * 当天或之前存在有效净值点（valueOnOrBefore 命中）即视为覆盖 1 年，且
 * 一年窗口（date >= cutoff）内有效记录数 >= oneYear.minRecords；
 * 任一不满足 → null（历史不足一年 / 窗口内有效点不足，绝不冒充）。
 * 非法日期与越界净值由 normalizeSeries 上游丢弃（净值异常不产生错误指标）。
 * 最大回撤 = min( 当日净值 / 此前窗口内最高净值 - 1 )，逐日滚动，非只比较起终点。
 */
function drawdown1y(series, oneYearCfg = profileConfig.oneYear) {
  if (!Array.isArray(series) || series.length < 2) {
    return { maxDrawdown1y: null, drawdownFromHigh1y: null, windowDays: 0 };
  }
  const latest = series[series.length - 1];
  const cutoff = subtractMonths(latest.date, 12);
  const window = series.filter(p => p.date >= cutoff);
  // 覆盖判定与 return1y（calendarReturn 基期存在性）同口径：序列在 cutoff 当天或之前有有效点。
  // 旧实现误写为 window[0].date <= cutoff —— 窗口按 date>=cutoff 过滤后恒有 window[0].date>=cutoff，
  // 等价于要求「恰有净值落在 cutoff 同一天」：A 股周一净值（cutoff=周日无记录）恒判不覆盖 → 回撤错判 null。
  const spansOneYear = !!valueOnOrBefore(series, cutoff);
  const enough = spansOneYear && window.length >= oneYearCfg.minRecords;
  if (!enough) {
    return { maxDrawdown1y: null, drawdownFromHigh1y: null, windowDays: window.length };
  }
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of window) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) {
      const dd = p.value / peak - 1;
      if (dd < maxDd) maxDd = dd;
    }
  }
  let windowHigh = -Infinity;
  for (const p of window) if (p.value > windowHigh) windowHigh = p.value;
  const fromHigh = windowHigh > 0 ? latest.value / windowHigh - 1 : null;
  return {
    maxDrawdown1y: Number(maxDd.toFixed(6)),
    drawdownFromHigh1y: fromHigh === null ? null : Number(fromHigh.toFixed(6)),
    windowDays: window.length
  };
}

/** 近 20 个有效日收益率的年化波动率（样本标准差 × sqrt(252)）；样本 < minReturns → null */
function volatility20d(series, volCfg = profileConfig.volatility) {
  if (!Array.isArray(series) || series.length < volCfg.minReturns + 1) return null;
  const returns = [];
  for (let i = series.length - 1; i >= 1 && returns.length < volCfg.window; i -= 1) {
    const prev = series[i - 1].value;
    if (prev > 0) returns.push(series[i].value / prev - 1);
  }
  if (returns.length < volCfg.minReturns) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (returns.length - 1)
    : 0;
  return Number((Math.sqrt(variance) * Math.sqrt(volCfg.annualizationFactor)).toFixed(6));
}

/** 趋势分类：优先 3 个月收益（±5%），退化到 1 个月（±3%）；均无 → unknown */
function classifyTrend(return3m, return1m) {
  if (Number.isFinite(return3m)) {
    if (return3m >= 0.05) return 'up';
    if (return3m <= -0.05) return 'down';
    return 'sideways';
  }
  if (Number.isFinite(return1m)) {
    if (return1m >= 0.03) return 'up';
    if (return1m <= -0.03) return 'down';
    return 'sideways';
  }
  return 'unknown';
}

/**
 * 由规范化净值序列计算完整 performance 对象（需求 §四 契约字段）。
 * 所有比率均为小数（-0.12 = -12%）；未知一律 null。
 */
function computePerformance(rows) {
  const series = normalizeSeries(rows);
  if (series.length === 0) {
    return {
      return1m: null, return3m: null, return6m: null, return1y: null,
      maxDrawdown1y: null, drawdownFromHigh1y: null, volatility20d: null,
      trend: 'unknown', dataAsOf: null, historyDays: 0
    };
  }
  const latest = series[series.length - 1];
  const dd = drawdown1y(series);
  const return1m = calendarReturn(series, 1);
  const return3m = calendarReturn(series, 3);
  return {
    return1m: round6(return1m),
    return3m: round6(return3m),
    return6m: round6(calendarReturn(series, 6)),
    return1y: round6(calendarReturn(series, 12)),
    maxDrawdown1y: dd.maxDrawdown1y,
    drawdownFromHigh1y: dd.drawdownFromHigh1y,
    volatility20d: volatility20d(series),
    trend: classifyTrend(return3m, return1m),
    dataAsOf: latest.date,
    historyDays: series.length
  };
}

function round6(v) {
  return Number.isFinite(v) ? Number(v.toFixed(6)) : null;
}

// ============================================================================
// 纯函数：组合摘要解析（从账户策略文本，不在多处硬编码）
// ============================================================================

function parseAmount(text) {
  const m = String(text || '').match(/(?:不超过|上限(?:为)?|≤)\s*([\d,.]+)\s*(万元?|元)/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (m[2].startsWith('万')) v *= 10000;
  return Math.round(v * 100) / 100;
}

function parseRecoveryAmount(text) {
  const m = String(text || '').match(/回本\s*([\d,.]+)\s*(万元?|元)/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (m[2].startsWith('万')) v *= 10000;
  return Math.round(v * 100) / 100;
}

/**
 * 从账户策略文本解析 portfolioSummary（需求 §八）。
 * - equityCap：含「权益」行的不超过/上限金额
 * - coreIndex：人工配置优先（profileConfig.portfolioDefaults.coreIndexFundCode，需在持仓中存在），
 *   否则按基金名称匹配沪深300
 * - coreIndexCap：含「沪深300/核心宽基」行的不超过/上限金额
 * - recoveryTarget / recoveryHorizonMonths：含「回本」行的金额与期限
 * - cashAvailable / realizedProfitLoss：当前无可靠数据来源，恒为 null
 * - recoveryDefinitionStatus：'pending-confirmation'（15000 元是累计亏损修复还是额外盈利，
 *   现有系统无法判定，保留策略原文、不擅自定义）
 * 解析失败的字段如实返回 null。
 */
function parsePortfolioSummary(strategyList, holdings) {
  const lines = (Array.isArray(strategyList) ? strategyList : []).map(s => String(s || ''));
  const funds = Array.isArray(holdings) ? holdings : [];

  let equityCap = null;
  let coreIndexCap = null;
  let recoveryTarget = null;
  let recoveryHorizonMonths = null;

  for (const line of lines) {
    if (equityCap === null && /权益/.test(line)) equityCap = parseAmount(line);
    if (coreIndexCap === null && /沪深300|核心宽基/.test(line)) coreIndexCap = parseAmount(line);
    if (recoveryTarget === null && /回本/.test(line)) {
      recoveryTarget = parseRecoveryAmount(line);
      if (/一年以内|12\s*个月/.test(line)) recoveryHorizonMonths = 12;
      else {
        const m = line.match(/(\d+)\s*个月/);
        if (m) recoveryHorizonMonths = parseInt(m[1], 10);
      }
    }
  }

  let coreIndex = null;
  const defaultCode = profileConfig.portfolioDefaults.coreIndexFundCode;
  if (defaultCode && funds.some(f => String(f.code) === defaultCode)) {
    coreIndex = defaultCode;
  } else {
    const hit = funds.find(f => /沪深300/.test(String(f.name || '')));
    if (hit) coreIndex = String(hit.code);
  }

  return {
    equityCap,
    coreIndex,
    coreIndexCap,
    recoveryTarget,
    recoveryHorizonMonths,
    cashAvailable: null,
    realizedProfitLoss: null,
    recoveryDefinitionStatus: 'pending-confirmation',
    recoveryDefinitionNote: '回本目标定义未确认（累计亏损修复额或额外盈利目标），以 strategies 原文为准。'
  };
}

// ============================================================================
// 纯函数：持仓重合判定
// ============================================================================

/**
 * 依据真实前十大持仓判定基金间重合。
 * @param {Map<string, Array<{stockCode:string, stockName?:string|null, weightPct:number}>>} holdingsByFund
 *   每只基金最新报告期的前十大持仓（weightPct 为归一化百分数，5 = 5%）
 * @param {object} [overlapCfg] 重合阈值配置
 * @param {Map<string, Array<{stockCode:string, stockName:string|null, minePct:number, otherCode:string, otherPct:number}>>} [detailOut]
 *   可选输出容器：传入 Map 时，把每只基金的真实重合明细（按本方权重降序，最多 3 条）写入该 Map。
 *   与重合判定共用同一次遍历，不重复计算；未传入时行为与旧版完全一致。
 * @returns {Map<string, boolean|null>} code → true(存在真实重合) / false(有数据且无重合) / null(数据不足)
 * 规则：同一股票在两只基金中占比均 >= overlap.minWeightPct 才算真实重合；
 * 持仓数据齐全的基金少于 2 只时一律 null（无法判定，绝不默认「无重合」）。
 */
function computeOverlapMap(holdingsByFund, overlapCfg = profileConfig.overlap, detailOut = null) {
  const result = new Map();
  const withData = [...holdingsByFund.keys()].filter(code => {
    const rows = holdingsByFund.get(code);
    return Array.isArray(rows) && rows.length > 0;
  });
  for (const code of holdingsByFund.keys()) result.set(code, null);
  if (detailOut) for (const code of holdingsByFund.keys()) detailOut.set(code, null);
  if (withData.length < 2) return result;

  // stock → [{code, pct, name}]
  const byStock = new Map();
  for (const code of withData) {
    for (const row of holdingsByFund.get(code)) {
      if (!row || !row.stockCode) continue;
      if (!byStock.has(row.stockCode)) byStock.set(row.stockCode, []);
      byStock.get(row.stockCode).push({ code, pct: row.weightPct, name: row.stockName || null });
    }
  }

  for (const code of withData) {
    const matches = [];
    for (const [stockCode, holders] of byStock.entries()) {
      if (holders.length < 2) continue;
      const mine = holders.find(h => h.code === code);
      if (!mine || mine.pct < overlapCfg.minWeightPct) continue;
      const others = holders.filter(h => h.code !== code && h.pct >= overlapCfg.minWeightPct);
      if (others.length === 0) continue;
      // 取对方权重最高的一只作为明细代表（明细展示用；判定只看是否存在）
      const topOther = others.reduce((a, b) => (b.pct > a.pct ? b : a));
      matches.push({
        stockCode,
        stockName: mine.name || topOther.name || stockCode,
        minePct: mine.pct,
        otherCode: topOther.code,
        otherPct: topOther.pct
      });
    }
    result.set(code, matches.length > 0);
    if (detailOut) {
      matches.sort((a, b) => b.minePct - a.minePct);
      detailOut.set(code, matches.slice(0, 3));
    }
  }
  return result;
}

/** fund_holdings 行 → 归一化前十大数据（weight<1 视为小数自动 ×100，与前端导出规则一致；保留股票名供重合明细输出） */
function normalizeHoldingRows(rows, topN = profileConfig.overlap.topN) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => {
      const w = Number(r.weight);
      const pct = Number.isFinite(w) ? (w < 1 ? w * 100 : w) : null;
      const name = String(r.stock_name || r.stockName || '') || null;
      return { stockCode: String(r.stock_code || r.stockCode || ''), stockName: name, weightPct: pct };
    })
    .filter(r => r.stockCode && r.weightPct !== null)
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, topN);
}

// ============================================================================
// 纯函数：allocation 构建
// ============================================================================

/**
 * allocation 对象（需求 §七）。
 * - role / sector / maxAmount 仅来自人工配置（fundProfiles）；未配置 → role 'unknown'、其余 null。
 * - overlapWarning 由 computeOverlapMap 的真实持仓计算结果传入，数据不足为 null。
 */
function buildAllocation(fundCode, overlapWarning) {
  const profile = profileConfig.fundProfiles[String(fundCode)] || null;
  return {
    role: (profile && profile.role) || 'unknown',
    sector: (profile && profile.sector) || null,
    maxAmount: (profile && profile.maxAmount !== undefined) ? profile.maxAmount : null,
    overlapWarning: overlapWarning === undefined ? null : overlapWarning
  };
}

// ============================================================================
// 数据访问：历史净值（含按需回填）
// ============================================================================

async function readNavSeries(code, limit = PERF_HISTORY_LIMIT) {
  const fundCode = assertFundCode(code);
  const capped = Math.min(Math.max(Number(limit) || PERF_HISTORY_LIMIT, 10), 1000);
  // 统一走 navService.getHistory（与原分析路径同一数据访问层；返回升序 {date, nav, acc_nav}）
  return navService.getHistory(fundCode, { limit: capped });
}

/** 序列是否覆盖 1 年指标窗口（时间跨度 >= 1 年 且 记录数达标） */
function coversOneYear(series) {
  if (!Array.isArray(series) || series.length < profileConfig.oneYear.minRecords) return false;
  const latest = series[series.length - 1].date;
  const earliest = series[0].date;
  return earliest <= subtractMonths(latest, 12);
}

const backfillInFlight = new Map(); // fundCode → Promise

/**
 * 按需回填历史净值：仅当数据库不足以覆盖 1 年窗口时触发。
 * - sync_markers 节流：成功 24h / 失败 2h 内不重复；
 * - 进程内 in-flight 去重：同一基金并发只跑一次；
 * - 写入用 ON CONFLICT DO NOTHING：绝不覆盖已有确认净值，绝不伪造缺失日期；
 * - fetcher 可注入（默认 marketService.fetchHistory），失败静默返回，不影响调用方。
 */
async function backfillPerformanceHistory(fundCode, fetcher = defaultFetchFundHistory) {
  const code = assertFundCode(fundCode);
  if (backfillInFlight.has(code)) return backfillInFlight.get(code);
  const promise = (async () => {
    const markerKey = `perf_history:${code}`;
    const lastRun = Number(await getSyncMarker(markerKey)) || 0;
    if (Date.now() - lastRun < BACKFILL_TTL_FAIL_MS) {
      return { skipped: true, reason: 'throttled' };
    }
    // 先占位（失败节流窗口），成功后刷新为成功 TTL
    await setSyncMarker(markerKey, Date.now());
    try {
      const history = await fetcher(code, { pageSize: 100, maxPages: BACKFILL_MAX_PAGES });
      const rows = Array.isArray(history) ? history : (history && history.history) || [];
      const safe = normalizeSeries(rows.map(r => ({ date: r.date, nav: r.nav })));
      let inserted = 0;
      for (const row of safe) {
        const res = await dbAsync.run(
          `INSERT INTO fund_nav (fund_code, date, nav, acc_nav) VALUES (?, ?, ?, ?)
           ON CONFLICT (fund_code, date) DO NOTHING`,
          [code, row.date, row.value, row.value]
        );
        if (res && res.changes) inserted += res.changes;
      }
      await setSyncMarker(markerKey, Date.now()); // 成功 → 24h 节流（覆盖占位）
      return { skipped: false, fetched: safe.length, inserted };
    } catch (err) {
      // 失败：保留 2h 节流占位，不抛出（历史数据获取失败不得影响原有功能）
      return { skipped: false, error: err && err.message ? err.message : String(err) };
    } finally {
      backfillInFlight.delete(code);
    }
  })();
  backfillInFlight.set(code, promise);
  return promise;
}

/**
 * 读取用于 performance 计算的历史净值：
 * 1) 读库（最新 PERF_HISTORY_LIMIT 条，升序）；
 * 2) 若不足以覆盖 1 年窗口且节流窗口已过 → 触发按需回填；
 *    等待最多 BACKFILL_WAIT_MS，超时先用现有数据返回（回填后台完成，下次请求生效）；
 * 3) 返回升序 [{date, nav}]（可能仍不足 —— 调用方据实计算，缺啥返回 null）。
 */
async function getPerformanceHistory(code) {
  const fundCode = assertFundCode(code);
  let series = await readNavSeries(fundCode);
  // 尺度异常防护（8 倍保守阈值：开放式基金单日净值不会跳 8 倍；份额折算类真实跳变
  // 通常 ≤ 5 倍不会被误剔）。异常行剔除而非返回污染指标。
  const bad = detectScaleAnomalies(series, { jumpFactor: 8, window: 10 });
  if (bad.size) series = series.filter(p => !bad.has(p.date));
  if (coversOneYear(series)) return series;
  try {
    const backfill = backfillPerformanceHistory(fundCode);
    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), BACKFILL_WAIT_MS));
    await Promise.race([backfill, timeout]);
    series = await readNavSeries(fundCode);
  } catch (err) {
    // 回填失败不影响返回现有数据
  }
  return series;
}

// ============================================================================
// 数据访问：业绩基准
// ============================================================================

async function readBenchmarkSeries(stockCode, limit = 450) {
  const rows = await dbAsync.all(
    'SELECT date, price FROM stock_price WHERE stock_code = ? ORDER BY date DESC LIMIT ?',
    [String(stockCode), Math.min(Math.max(Number(limit) || 450, 30), 2000)]
  );
  return rows.reverse();
}

const benchInFlight = new Map();

async function ensureBenchmarkHistory(stockCode, syncer = defaultSyncBenchmarkHistory, { force = false } = {}) {
  if (benchInFlight.has(stockCode)) return benchInFlight.get(stockCode);
  const promise = (async () => {
    const markerKey = `bench_history:${stockCode}`;
    const lastRun = Number(await getSyncMarker(markerKey)) || 0;
    if (!force && Date.now() - lastRun < BACKFILL_TTL_FAIL_MS) return { skipped: true };
    await setSyncMarker(markerKey, Date.now());
    try {
      const res = await syncer(stockCode, { days: 450 });
      await setSyncMarker(markerKey, Date.now());
      return { ok: !res || !res.error, error: res && res.error ? res.error : null };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      benchInFlight.delete(stockCode);
    }
  })();
  benchInFlight.set(stockCode, promise);
  return promise;
}

/**
 * 基准同期指标（需求 §六）。基准来自人工配置的辅助分析基准（fundProfiles）。
 * 未配置基准 → 返回全 null 对象（绝不默认沪深300）。
 * 污染防护：先检测尺度异常行（如 10 倍污染的实时报价行）→ 强制重同步覆盖 →
 * 仍异常则剔除异常行计算；剔除后仍异常 → 明确返回不可用（unavailableReason），绝不返回污染收益率。
 * @param {string} fundCode
 * @param {number|null} fundReturn1m 基金近1月收益（算 relativeReturn 用）
 * @param {number|null} fundReturn3m
 * @param {string|null} fundDataAsOf 基金净值日期（相对收益窗口对齐校验用）
 * @param {number|null} [fundReturn6m] 基金近6月收益（算 relativeReturn6m 用）
 * @param {number|null} [fundReturn1y] 基金近1年收益（算 relativeReturn1y 用）
 */
async function getBenchmarkMetrics(fundCode, fundReturn1m, fundReturn3m, fundDataAsOf, fundReturn6m, fundReturn1y) {
  const empty = {
    name: null, return1m: null, return3m: null, return6m: null, return1y: null,
    relativeReturn1m: null, relativeReturn6m: null, relativeReturn1y: null,
    dataAsOf: null, kind: null, source: null, unavailableReason: null
  };
  const profile = profileConfig.fundProfiles[String(fundCode)];
  const bench = profile && profile.benchmark;
  if (!bench || !bench.stockCode) return empty;

  const BENCH_JUMP_FACTOR = 4; // 指数/ETF 代理单日不会跳 4 倍；超过即视为污染行
  const readNorm = async () => normalizeSeries(
    (await readBenchmarkSeries(bench.stockCode)).map(r => ({ date: r.date, nav: r.price }))
  );

  let norm = await readNorm();
  // 基准行情不足 3 个月窗口（< 45 条）或未覆盖 1 年窗口（6m/1y 收益需要）时按需补齐（带节流，失败不影响返回）
  if (norm.length < 45 || !coversOneYear(norm)) {
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), BACKFILL_WAIT_MS));
      await Promise.race([ensureBenchmarkHistory(bench.stockCode), timeout]);
      norm = await readNorm();
    } catch (err) { /* 忽略，用现有数据 */ }
  }

  // 尺度污染防护：发现异常行 → 强制重同步（绕过节流，用真实 qfq 收盘覆盖污染行）
  let anomalies = detectScaleAnomalies(norm, { jumpFactor: BENCH_JUMP_FACTOR, window: 10 });
  if (anomalies.size) {
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), BACKFILL_WAIT_MS));
      await Promise.race([ensureBenchmarkHistory(bench.stockCode, defaultSyncBenchmarkHistory, { force: true }), timeout]);
      norm = await readNorm();
      anomalies = detectScaleAnomalies(norm, { jumpFactor: BENCH_JUMP_FACTOR, window: 10 });
    } catch (err) { /* 重同步失败：走剔除路径 */ }
  }
  if (anomalies.size) norm = norm.filter(p => !anomalies.has(p.date));
  // 剔除后仍异常 → 数据源本身不可信，明确不可用（P0：禁止伪造收益率）
  if (detectScaleAnomalies(norm, { jumpFactor: BENCH_JUMP_FACTOR, window: 10 }).size) {
    return { ...empty, unavailableReason: 'benchmark_series_scale_anomaly' };
  }
  if (norm.length < 2) {
    return { ...empty, unavailableReason: 'benchmark_history_insufficient' };
  }

  const r1m = calendarReturn(norm, 1);
  const r3m = calendarReturn(norm, 3);
  const r6m = calendarReturn(norm, 6);
  const r1y = calendarReturn(norm, 12);
  const benchAsOf = norm[norm.length - 1].date;
  // 相对收益只在基金与基准数据日期对齐（±7 天）时计算，禁止跨窗口错配比较
  const gap = (fundDataAsOf && benchAsOf) ? Math.abs(dayDiff(fundDataAsOf, benchAsOf)) : null;
  const aligned = gap !== null && gap <= BENCH_ALIGN_TOLERANCE_DAYS;
  const relReturn = (fundRet, benchRet) => {
    const f = round6(fundRet);
    const b = round6(benchRet);
    return (aligned && f !== null && b !== null) ? Number((f - b).toFixed(6)) : null;
  };
  // 已配置基准但历史不足 1 年（r1y=null：序列在 cutoff 前无有效净值点）→ 明确标注原因，
  // 与「未配置基准」（kind=null、reason=null）和「窗口错位」区分；return1y/relativeReturn1y 保持 null。
  // 优先级：1y 历史短板 > 窗口错位（结构性缺失优先暴露）。
  const oneYearShort = r1y === null;
  return {
    name: bench.name || null,
    return1m: round6(r1m),
    return3m: round6(r3m),
    return6m: round6(r6m),
    return1y: round6(r1y),
    relativeReturn1m: relReturn(fundReturn1m, r1m),
    relativeReturn6m: relReturn(fundReturn6m, r6m),
    relativeReturn1y: relReturn(fundReturn1y, r1y),
    dataAsOf: benchAsOf,
    kind: bench.kind || 'auxiliary',
    source: bench.source || null,
    unavailableReason: oneYearShort
      ? 'benchmark_history_insufficient_for_1y'
      : (aligned ? null : (gap === null ? 'fund_data_asof_missing' : 'window_misaligned'))
  };
}

// ============================================================================
// 导出辅助：精简 navHistory 字符串（与现有导出格式一致）
// ============================================================================

function compactNavHistoryString(rows, limit = 15) {
  const series = normalizeSeries(rows).slice(-limit);
  if (!series.length) return '';
  const navs = series.map(p => p.value).join(', ');
  return `${series[0].date} 至 ${series[series.length - 1].date}: ${navs}`;
}

module.exports = {
  // 纯函数
  normalizeSeries,
  subtractMonths,
  valueOnOrBefore,
  calendarReturn,
  drawdown1y,
  volatility20d,
  classifyTrend,
  computePerformance,
  parsePortfolioSummary,
  parseAmount,
  parseRecoveryAmount,
  computeOverlapMap,
  normalizeHoldingRows,
  buildAllocation,
  compactNavHistoryString,
  coversOneYear,
  detectScaleAnomalies,
  dayDiff,
  // 数据访问
  readNavSeries,
  getPerformanceHistory,
  backfillPerformanceHistory,
  readBenchmarkSeries,
  ensureBenchmarkHistory,
  getBenchmarkMetrics,
  PERF_HISTORY_LIMIT
};
