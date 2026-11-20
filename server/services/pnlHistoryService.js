/**
 * 账户级历史盈亏序列服务（2026-11-20 盈亏分析抽屉）：
 * 按当前持仓 × 每只基金的历史净值日涨跌，还原账户级「日收益金额 / 日收益率 / 累计收益」序列，
 * 供 Web 盈亏分析抽屉的 收益走势 / 收益日历 使用（当日盈亏明细走前端实时估值，不走本服务）。
 *
 * 口径与限制（必须如实告知用户）：
 * - 份额还原为近似值：shares = 当前持有金额 / 最新官方净值。历史申购/赎回/分红时点差异
 *   不在此还原（无逐日交易流水），因此历史日收益是「假设当前持仓一直持有」的近似口径；
 *   越近的日期越准，当日以官方净值日涨跌为准。
 * - 只用官方净值（fund_nav），绝不把估值冒充历史净值（BLUE-only-official-NV 契约）。
 * - 某基金在某日期缺净值 → 该基金该日不贡献收益/市值（不插值、不冒充 0 涨跌）。
 * - 历史不足 2 个净值点的基金整只剔除并写入 warnings。
 */
const { getHistory } = require('./navService');

/** 默认还原窗口（交易日天数，约 1.5 年），env 可调；上限 1000 防止超大体量 */
const PNL_HISTORY_LIMIT = Math.min(Math.max(Number(process.env.PNL_HISTORY_LIMIT || 400), 20), 1000);

function isSixDigitCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

/**
 * @param {number} userId
 * @param {string} accountName 精确账户名（与 loadUserAccounts 输出一致）
 * @param {number} [days] 还原窗口（交易日），默认 PNL_HISTORY_LIMIT
 * @returns {null | {
 *   account: string, firstDate: string, lastDate: string,
 *   base: number, series: Array<{date, profit, value, rate, cum, cumRate}>,
 *   warnings: string[]
 * }} 账户不存在返回 null
 */
async function buildPnlHistory(userId, accountName, days) {
  // 惰性 require：与 fund.js analysis-export 同风格，避免顶层循环依赖
  const { loadUserAccounts } = require('./portfolioAnalysisService');
  const accounts = await loadUserAccounts(userId);
  const target = accounts.find(a => a && a.name === accountName);
  if (!target) return null;

  const funds = (Array.isArray(target.funds) ? target.funds : [])
    .filter(f => f && isSixDigitCode(f.code) && Number(f.amount) > 0);
  const warnings = [];
  if (!funds.length) {
    return {
      account: accountName,
      firstDate: null, lastDate: null, base: 0, series: [],
      warnings: ['当前账户无有效持仓（需 6 位基金代码且持有金额 > 0）']
    };
  }

  const limit = Math.min(Math.max(Number(days) || PNL_HISTORY_LIMIT, 20), 1000);
  const dateSet = new Set();
  const perFund = [];
  for (const f of funds) {
    let rows = null;
    try {
      rows = await getHistory(String(f.code), { limit: limit + 1 }); // +1：为窗口首日提供前一日基准
    } catch (e) {
      warnings.push(`${f.name || f.code}: 净值历史读取失败，未纳入还原`);
      continue;
    }
    const points = (Array.isArray(rows) ? rows : [])
      .map(r => ({ date: String(r.date || ''), nav: Number(r.nav) }))
      .filter(p => p.date && Number.isFinite(p.nav) && p.nav > 0);
    if (points.length < 2) {
      warnings.push(`${f.name || f.code}: 官方净值历史不足，未纳入还原`);
      continue;
    }
    const lastNav = points[points.length - 1].nav;
    const shares = Number(f.amount) / lastNav; // 近似份额还原（口径见文件头注释）
    const navMap = new Map(points.map(p => [p.date, p.nav]));
    // 每个日期的前一个净值点（严格早于该日期；缺日不插值，取最近一个更早点）
    const prevMap = new Map();
    let prevNav = null;
    for (const p of points) {
      prevMap.set(p.date, prevNav);
      prevNav = p.nav;
    }
    perFund.push({ code: String(f.code), name: String(f.name || f.code), shares, navMap, prevMap, points });
    for (const p of points) dateSet.add(p.date);
  }

  if (!perFund.length) {
    return {
      account: accountName,
      firstDate: null, lastDate: null, base: 0, series: [],
      warnings: warnings.length ? warnings : ['所有基金净值历史均不可用']
    };
  }

  const dates = Array.from(dateSet).sort();
  // 期初市值：每只基金「首个可算日」的前一日市值之和（累计收益率分母）
  let base = 0;
  for (const f of perFund) {
    for (const p of f.points) {
      const prevNav = f.prevMap.get(p.date);
      if (prevNav !== null && prevNav !== undefined) { base += f.shares * prevNav; break; }
    }
  }
  const round2 = n => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; }; // 归一化 -0
  const round6 = n => { const v = Math.round(n * 1e6) / 1e6; return v === 0 ? 0 : v; };
  const series = [];
  let cum = 0;
  let prevValue = null; // 上一有数据日期的市值（日收益率分母）
  for (const date of dates) {
    let value = 0;
    let profit = 0;
    let hasData = false;
    for (const f of perFund) {
      const nav = f.navMap.get(date);
      if (nav === undefined) continue;
      value += f.shares * nav;
      const prevNav = f.prevMap.get(date);
      if (prevNav !== null && prevNav !== undefined) {
        profit += f.shares * (nav - prevNav);
        hasData = true;
      }
    }
    if (!hasData) continue; // 该日期无任何基金可算日收益（只有孤立净值点）→ 跳过
    cum += profit;
    // 日收益率分母：首选上一有数据日期市值；首日（prevValue=null）用期初市值 base 兜底
    const denom = (prevValue !== null && prevValue > 0) ? prevValue : (base > 0 ? base : null);
    const rate = denom ? profit / denom : null;
    const cumRate = base > 0 ? cum / base : null;
    series.push({
      date,
      profit: round2(profit),
      value: round2(value),
      rate: rate === null ? null : round6(rate),
      cum: round2(cum),
      cumRate: cumRate === null ? null : round6(cumRate)
    });
    prevValue = value;
  }

  if (warnings.length) warnings.push('历史日收益按「当前持仓 × 官方净值日涨跌」近似还原，不含历史申购/赎回时点差异');
  const first = series.length ? series[0] : null;
  const last = series.length ? series[series.length - 1] : null;
  return {
    account: accountName,
    firstDate: first ? first.date : null,
    lastDate: last ? last.date : null,
    base: round2(base),
    series,
    warnings
  };
}

module.exports = { buildPnlHistory, PNL_HISTORY_LIMIT };
