/**
 * 账户级历史盈亏序列服务（2026-11-20 盈亏分析抽屉）：
 * 按当前持仓 × 每只基金的历史净值日涨跌，还原账户级「日收益金额 / 日收益率 / 累计收益」序列，
 * 供 Web 盈亏分析抽屉的 收益走势 / 收益日历 使用（当日盈亏明细走前端实时估值，不走本服务）。
 *
 * 2026-11-20 二轮增强：
 * - 新增 buildPnlDetail(userId, accountName, from, to)：区间内每只基金的盈亏明细
 *   （日历点击某日/某月/某年时展示）。口径与序列完全一致：
 *   每基金 profit = Σ shares×(nav(d)−prevNav(d))，d ∈ [from,to] 且 prevNav 存在
 *   → 区间明细合计 == 日历/序列对应区间合计（逐日求和口径一致，不会出现两套数）。
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
 * 加载账户持仓并还原每只基金的份额与净值映射（buildPnlHistory / buildPnlDetail 共用）。
 * @returns {{ found: boolean, perFund: Array, warnings: string[] }}
 */
async function loadFundSeries(userId, accountName, limit) {
  // 惰性 require：与 fund.js analysis-export 同风格，避免顶层循环依赖
  const { loadUserAccounts } = require('./portfolioAnalysisService');
  const accounts = await loadUserAccounts(userId);
  const target = accounts.find(a => a && a.name === accountName);
  if (!target) return { found: false, perFund: [], warnings: [] };

  const funds = (Array.isArray(target.funds) ? target.funds : [])
    .filter(f => f && isSixDigitCode(f.code) && Number(f.amount) > 0);
  const warnings = [];
  if (!funds.length) return { found: true, perFund: [], warnings };

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
  }
  return { found: true, perFund, warnings };
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
  const limit = Math.min(Math.max(Number(days) || PNL_HISTORY_LIMIT, 20), 1000);
  const { found, perFund, warnings } = await loadFundSeries(userId, accountName, limit);
  if (!found) return null;

  if (!perFund.length) {
    return {
      account: accountName,
      firstDate: null, lastDate: null, base: 0, series: [],
      warnings: warnings.length ? warnings : ['当前账户无有效持仓（需 6 位基金代码且持有金额 > 0）']
    };
  }

  const dateSet = new Set();
  for (const f of perFund) for (const p of f.points) dateSet.add(p.date);
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 区间盈亏明细（日历点击 某日 / 某月 / 某年 → 每只基金的盈亏拆分）。
 * 口径与 buildPnlHistory 完全一致：逐日累加 shares×(nav−prevNav)，
 * 保证「明细合计 == 日历对应区间数值」。
 * @returns {null | { account, from, to, total, rateBase, items: Array<{code,name,profit,rate}> , warnings }}
 */
async function buildPnlDetail(userId, accountName, from, to) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    const err = new Error('日期格式非法（需 YYYY-MM-DD）');
    err.code = 'BAD_DATE';
    throw err;
  }
  if (String(from) > String(to)) {
    const err = new Error('区间起止颠倒');
    err.code = 'BAD_RANGE';
    throw err;
  }
  const { found, perFund, warnings } = await loadFundSeries(userId, accountName, PNL_HISTORY_LIMIT);
  if (!found) return null;

  const round2 = n => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };
  const round6 = n => { const v = Math.round(n * 1e6) / 1e6; return v === 0 ? 0 : v; };
  const items = [];
  let total = 0;
  let rateBaseSum = 0; // 区间收益率分母 ≈ 各基金区间首日的前一日市值之和
  for (const f of perFund) {
    let profit = 0;
    let rateBase = null; // 该基金区间内首个可算日的前一日市值
    for (const p of f.points) {
      if (p.date < from || p.date > to) continue;
      const prevNav = f.prevMap.get(p.date);
      if (prevNav === null || prevNav === undefined) continue;
      profit += f.shares * (p.nav - prevNav);
      if (rateBase === null) rateBase = f.shares * prevNav;
    }
    if (rateBase === null) continue; // 区间内无可算日 → 该基金不出现
    total += profit;
    rateBaseSum += rateBase;
    items.push({
      code: f.code,
      name: f.name,
      profit: round2(profit),
      rate: rateBase > 0 ? round6(profit / rateBase) : null
    });
  }
  items.sort((a, b) => b.profit - a.profit);
  return {
    account: accountName,
    from,
    to,
    total: round2(total),
    rate: rateBaseSum > 0 ? round6(total / rateBaseSum) : null,
    items,
    warnings
  };
}

module.exports = { buildPnlHistory, buildPnlDetail, PNL_HISTORY_LIMIT };
