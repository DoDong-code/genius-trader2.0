/**
 * 统一 Portfolio Analysis Service
 *
 * 持仓页面 / DeepSeek AI / 外部分析 API 使用同一数据源：
 * - 本地（手动）账户：user_data JSON（与前端保存的同一份状态）
 * - 同步账户（养基宝/小倍）：portfolio 表（服务端权威）+ 实时估值链
 *
 * 不硬编码账户策略到 AI 代码：策略一律从账户配置（strategy 数组）读取。
 */
const { getUserState } = require('./accountStateService');
const { listSyncedAccounts } = require('./portfolioService');
const { getFund } = require('./fundService');
const { getHistory, getLatestPair } = require('./navService');
const { fetchProviderEstimate } = require('./providerEstimate');
const { calculateFundEstimate } = require('./estimateEngine');
const { requestMemo } = require('../utils/requestScope');
const crypto = require('crypto');
const config = require('../config/estimateConfig');
const dbAsync = require('../database/dbAsync');
const fundMetrics = require('./fundMetricsService');

// P0-2：单次分析历史数据规模上限（约 1 年交易日），禁止无条件加载完整历史。
const ANALYSIS_HISTORY_LIMIT = Number(process.env.ANALYSIS_HISTORY_LIMIT || 260);
// P0-2：Analysis 整体软超时（到点即 reject，避免请求无限挂起）。
const ANALYSIS_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS || 20000);

async function loadUserAccounts(userId) {
  const accounts = [];
  const state = await getUserState(userId);
  if (state && state.accounts && typeof state.accounts === 'object') {
    Object.keys(state.accounts).forEach(name => {
      const acc = state.accounts[name];
      if (!acc || typeof acc !== 'object') return;
      if (acc.accountType === 'sync' || (!acc.accountType && acc.__source)) return; // 同步账户单独从服务端读取
      accounts.push({ ...acc, name, source: 'local' });
    });
  }
  const synced = await listSyncedAccounts(userId);
  const savedAccounts = (state && state.accounts) || {};
  synced.forEach(acc => {
    // 策略/目标类配置以 user_data（前端保存）为准：sync 账户的 portfolio 表不存策略
    // （portfolioService 硬编码 strategy: []），此前导致 AI 与导出 JSON 的 strategies
    // 恒为空数组。仅合并策略类字段，不合并 funds（服务端权威）；
    // user_data 无该账户时保持 []（如实缺失，不伪造策略）。
    const saved = savedAccounts[acc.name] || null;
    const merged = {
      ...acc,
      strategy: Array.isArray(saved && saved.strategy)
        ? saved.strategy.slice()
        : (Array.isArray(acc.strategy) ? acc.strategy : []),
      closedPositions: Array.isArray(saved && saved.closedPositions)
        ? saved.closedPositions.slice()
        : (Array.isArray(acc.closedPositions) ? acc.closedPositions : [])
    };
    if (saved && Number.isFinite(Number(saved.targetRecovery))) merged.targetRecovery = Number(saved.targetRecovery);
    if (saved && Number.isFinite(Number(saved.maxFunds))) merged.maxFunds = Number(saved.maxFunds);
    accounts.push({ ...merged, source: 'sync' });
  });
  return accounts;
}

function directionFor(code, name) {
  const mapped = config.fundSectorMap[String(code)];
  if (mapped && config.sectorBenchmarks[mapped]) return config.sectorBenchmarks[mapped].name;
  if (mapped) return mapped;
  const rule = config.nameRules.find(r => r.pattern.test(String(name || '')));
  return rule ? rule.sector : null;
}

function parseStrategy(strategyList) {
  const rules = Array.isArray(strategyList) ? strategyList.slice() : [];
  const text = rules.join('\n');
  const keywords = ['科技', '纳斯达克', '纳指', '沪深300', '有色', '半导体', '数字经济', '新能源', '黄金', '债券', '海外', '港股', '宽基', '军工', '医药', '消费', '银行', '地产'];
  const core = [];
  const forbidden = [];
  keywords.forEach(k => {
    if (!text.includes(k)) return;
    const line = rules.find(l => l.includes(k)) || '';
    if (/禁止|不投|回避|不碰|不主动新增|暂停/.test(line)) forbidden.push(k);
    else core.push(k);
  });
  return {
    core: [...new Set(core)],
    forbidden: [...new Set(forbidden)],
    rules
  };
}

function classifyPositionType(fund, accountFunds, strategy) {
  const amount = Number(fund.amount) || 0;
  const rate = Number(fund.holdingRate ?? fund.hold ?? 0) || 0;
  const total = accountFunds.reduce((s, f) => s + (Number(f.amount) || 0), 0) || 1;
  const smallThreshold = Math.max(300, total * 0.03);
  const dir = directionFor(fund.code, fund.name);
  if (strategy.forbidden.includes(dir)) return 'reduce';
  if (amount > 0 && amount < smallThreshold) return 'observe';
  if (rate < -0.10) return 'reduce';
  if (Math.abs(Number(fund.today) || 0) >= 0.03) return 'swing';
  return 'core';
}

async function resolveFundToday(code, amount, userId, savedToday) {
  const saved = Number(savedToday);
  // 仅当云端快照里存在「非零」的有效估值时才直接采用。
  // 0 / null / undefined 一律继续走实时估值链：前端持仓页刷新的估值只落在本地（system 更新不推云端），
  // 云端快照常为 0，若此处把 0 当成有效值直接返回，就会用 0 覆盖掉本来能取到的实时估值。
  if (Number.isFinite(saved) && saved !== 0) return saved;
  try {
    const provider = await fetchProviderEstimate(String(code), amount, { userId });
    if (provider && Number.isFinite(Number(provider.estimate_change))) return Number(provider.estimate_change);
  } catch (e) { /* 忽略 */ }
  try {
    const local = await calculateFundEstimate(String(code), { amount });
    if (local && Number.isFinite(Number(local.estimate_change))) return Number(local.estimate_change);
  } catch (e) { /* 忽略 */ }
  try {
    const pair = await getLatestPair(String(code));
    if (pair.length >= 2 && Number(pair[1].nav) > 0) {
      return (Number(pair[0].nav) - Number(pair[1].nav)) / Number(pair[1].nav);
    }
  } catch (e) { /* 忽略 */ }
  return 0;
}

function periodReturn(history, days) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const latest = Number(history[history.length - 1].nav);
  const lastDate = new Date(`${history[history.length - 1].date}T00:00:00`);
  lastDate.setDate(lastDate.getDate() - days);
  const cutoff = lastDate.toISOString().slice(0, 10);
  let base = null;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    if (String(history[i].date) <= cutoff) {
      base = Number(history[i].nav);
      break;
    }
  }
  if (!base || !Number.isFinite(base) || base <= 0) return null;
  return (latest - base) / base;
}

function enrichFund(fund, accountFunds, strategy, userId) {
  const amount = Number(fund.amount) || 0;
  const profit = Number(fund.holdingProfit ?? fund.profit ?? 0) || 0;
  const today = Number(fund.today) || 0;
  // P3.19：成本基数（优先 fund.cost / costBasis；缺失时用 金额-盈亏 反推，避免为 0）
  let cost = 0;
  if (Number.isFinite(Number(fund.cost)) && Number(fund.cost) > 0) cost = Number(fund.cost);
  else if (Number.isFinite(Number(fund.costBasis)) && Number(fund.costBasis) > 0) cost = Number(fund.costBasis);
  else if (amount > 0) cost = amount - profit;
  // 盈亏率统一成本口径（与 Web / 小程序持仓页 holdingRate 显示一致）：
  // cost = 当前持仓成本，profit = 当前持仓浮动盈亏（sync 账户 portfolio 表 amount-cost；
  // manual 账户前端 holdingProfit/costBasis 同口径）。cost 无效时如实 null，禁止 0 冒充。
  const profitRate = cost > 0 ? profit / cost : null;
  // P3.19：近期交易记录（买卖），最多保留 8 条，供 AI 理解「已减多少 / 近期是否加仓」
  const transactions = Array.isArray(fund.transactions) ? fund.transactions.slice(-8) : [];
  return {
    code: String(fund.code),
    name: String(fund.name || fund.code),
    amount,
    profit,
    profitRate,
    cost,
    transactions,
    todayEstimate: today,
    today_change: amount * today,
    positionType: classifyPositionType(fund, accountFunds, strategy),
    type: String(fund.category || fund.fund_type || '基金'),
    direction: directionFor(fund.code, fund.name)
  };
}

// —— 紧凑数据表（AI 输入专用）：服务端是百分比唯一格式化点，前端/AI 不重复换算 ——
function formatPctCell(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.includes('%') ? v : (v === '' ? '—' : v);
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 10000) / 100; // 小数比例 → 百分数，保留两位
  if (rounded === 0) return '0.00%';
  const text = Math.abs(rounded).toFixed(2);
  return rounded > 0 ? `+${text}%` : `-${text}%`;
}

function formatMoneyCell(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 紧凑 AI 数据表：一次定义列名，行数据严格对齐 columns。
 * 覆盖 盈亏(成本口径)/今日/1m/3m/6m/1y/最大回撤/距高点回撤/趋势/基准超额(1m/6m/1y)/净值日期/
 * 前十大重仓摘要/重合明细，替代逐基金多层 performance/benchmark/history 冗长块。空值一律 '—'。
 */
function buildAnalysisTable(holdings) {
  const columns = [
    'code', 'name', 'amount', 'cost', 'profit', 'profitPct', 'todayPct',
    '1m', '3m', '6m', '1y', 'mdd', 'ddHigh', 'trend', 'rel1m', 'rel6m', 'rel1y',
    'navDate', 'topHoldings', 'overlapDetail'
  ];
  const funds = (Array.isArray(holdings) ? holdings : []).map(h => {
    const perf = h.performance || {};
    return [
      String(h.code || ''),
      String(h.name || ''),
      formatMoneyCell(h.amount),
      formatMoneyCell(h.cost),
      formatMoneyCell(h.profit),
      formatPctCell(h.profitRate),
      formatPctCell(h.todayEstimate),
      formatPctCell(perf.return1m),
      formatPctCell(perf.return3m),
      formatPctCell(perf.return6m),
      formatPctCell(perf.return1y),
      formatPctCell(perf.maxDrawdown1y),
      formatPctCell(perf.drawdownFromHigh1y),
      perf.trend || 'unknown',
      formatPctCell(h.benchmark && h.benchmark.relativeReturn1m),
      formatPctCell(h.benchmark && h.benchmark.relativeReturn6m),
      formatPctCell(h.benchmark && h.benchmark.relativeReturn1y),
      perf.dataAsOf || '',
      (h.topHoldings === null || h.topHoldings === undefined) ? '无数据' : String(h.topHoldings),
      (h.overlapDetail === null || h.overlapDetail === undefined) ? '无数据' : String(h.overlapDetail)
    ];
  });
  return { columns, funds };
}

/**
 * 数据校验警告（导出 JSON 与 AI 输入共用口径说明）：
 * 只报告真实数据源问题，不把口径差异当错误；缺失如实标注，不伪造。
 */
/**
 * 「复制JSON」紧凑导出（2026-10-21，用户确认后实施）：
 * holdings 对象数组 → { columns, rows } 扁平宽表（每基金一行，消除每行重复字段名）。
 * 仅结构转换：值原样直取（小数比率不换算、字符串不截断），undefined → null；
 * null / 0 / false / '' 保留原样，不重算任何业务数据。
 * 行列对齐保证：列顺序由 COMPACT_EXPORT_HOLDING_SPECS 显式声明，行值严格按 specs 取值，
 * 每行长度恒等于 columns.length；缺失占位 null，绝不删格错位。
 * 非数组字段（account / strategies / portfolioSummary / dataWarnings）保持普通对象原样。
 * 端点 ?compact=1 时启用；不带参数保持原对象数组契约（mp1 / 旧调用方不受影响）。
 */
const COMPACT_EXPORT_HOLDING_SPECS = [
  // 顶层持仓字段
  ['code', h => h.code],
  ['name', h => h.name],
  ['category', h => h.category],
  ['subAccount', h => h.subAccount],
  ['amount', h => h.amount],
  ['cost', h => h.cost],
  ['profit', h => h.profit],
  ['profitRate', h => h.profitRate],
  ['todayChange', h => h.todayChange],
  ['todayProfit', h => h.todayProfit],
  ['navUpdatedAt', h => h.navUpdatedAt],
  ['navHistory', h => h.navHistory],
  ['topHoldings', h => h.topHoldings],
  ['overlapDetail', h => h.overlapDetail],
  // performance（原名直取；dataAsOf → perfDataAsOf，与基准日期列区分）
  ['return1m', h => h.performance ? h.performance.return1m : null],
  ['return3m', h => h.performance ? h.performance.return3m : null],
  ['return6m', h => h.performance ? h.performance.return6m : null],
  ['return1y', h => h.performance ? h.performance.return1y : null],
  ['maxDrawdown1y', h => h.performance ? h.performance.maxDrawdown1y : null],
  ['drawdownFromHigh1y', h => h.performance ? h.performance.drawdownFromHigh1y : null],
  ['volatility20d', h => h.performance ? h.performance.volatility20d : null],
  ['trend', h => h.performance ? h.performance.trend : null],
  ['perfDataAsOf', h => h.performance ? h.performance.dataAsOf : null],
  ['historyDays', h => h.performance ? h.performance.historyDays : null],
  // benchmark（全部加 bench 前缀，避免与 performance 的 return1m 等列名冲突）
  ['benchName', h => h.benchmark ? h.benchmark.name : null],
  ['benchKind', h => h.benchmark ? h.benchmark.kind : null],
  ['benchReturn1m', h => h.benchmark ? h.benchmark.return1m : null],
  ['benchReturn3m', h => h.benchmark ? h.benchmark.return3m : null],
  ['benchReturn6m', h => h.benchmark ? h.benchmark.return6m : null],
  ['benchReturn1y', h => h.benchmark ? h.benchmark.return1y : null],
  ['benchRelReturn1m', h => h.benchmark ? h.benchmark.relativeReturn1m : null],
  ['benchRelReturn6m', h => h.benchmark ? h.benchmark.relativeReturn6m : null],
  ['benchRelReturn1y', h => h.benchmark ? h.benchmark.relativeReturn1y : null],
  ['benchDataAsOf', h => h.benchmark ? h.benchmark.dataAsOf : null],
  ['benchSource', h => h.benchmark ? h.benchmark.source : null],
  ['benchUnavailableReason', h => h.benchmark ? h.benchmark.unavailableReason : null],
  // allocation
  ['role', h => h.allocation ? h.allocation.role : null],
  ['sector', h => h.allocation ? h.allocation.sector : null],
  ['maxAmount', h => h.allocation ? h.allocation.maxAmount : null],
  ['overlapWarning', h => h.allocation ? h.allocation.overlapWarning : null]
];

function buildCompactExport(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const holdings = Array.isArray(payload.holdings) ? payload.holdings : [];
  const columns = COMPACT_EXPORT_HOLDING_SPECS.map(s => s[0]);
  const rows = holdings.map(h => COMPACT_EXPORT_HOLDING_SPECS.map(([, get]) => {
    const v = get(h);
    return v === undefined ? null : v;
  }));
  const out = Object.assign({}, payload);
  out.holdings = { columns, rows };
  return out;
}

// ─────────────────────────────────────────────
// 统一标准紧凑 JSON（内部 AI / 外部 AI 共用）+ 5 分钟跨请求共享缓存
// ─────────────────────────────────────────────

/** 标准 JSON 结构版本（仅随结构变更递增；参与缓存键，不作随意变化的字段） */
const STANDARD_ANALYSIS_JSON_SCHEMA_VERSION = 1;
/** 标准 JSON 跨请求复用窗口（默认 5 分钟）。构建成本 = 今日估值链 + 净值历史 + 基准 + 重合查询 */
const ANALYSIS_JSON_TTL_MS = Number(process.env.ANALYSIS_JSON_TTL_MS || 300000);
/** 单进程共享缓存：key → { expiresAt, value:{portfolio,json} }（已构建）或 { promise }（构建中） */
const analysisDataCache = new Map();
const ANALYSIS_DATA_CACHE_MAX_ENTRIES = 200;

/**
 * 统一标准紧凑 JSON（唯一构建入口，2026-10-21）：
 * - 字段映射集中复用 buildAnalysisTable（列声明唯一来源）+ buildDataWarnings，内部 AI 与
 *   外部 AI 不再各自维护字段白名单或重复拼装；
 * - holdingColumns[i] 对应 holdingRows[j][i]，行长度恒等于 columns.length（buildAnalysisTable 保证）；
 * - 百分比沿用服务端唯一格式化点 formatPctCell（-1.05%；舍入为 0 一律 '0.00%'，无 -0.00%/+0.00%）；
 *   缺失一律 '—'（与 AI 表格列说明同一既有约定），金额缺失 '—'，绝不把缺失伪装成 0；
 * - 不输出 history 大数组：以 navDate + 1m/3m/6m/1y 区间收益列呈现（复用现有精简口径，
 *   不为本次修改恢复大段历史净值）；
 * - account = [账户名, 最大基金数上限, 总资产]（结构示例经用户确认）。
 */
function buildAnalysisCompactJson(portfolio) {
  const port = portfolio || {};
  const table = buildAnalysisTable(port.holdings);
  const acc = port.account || null;
  return {
    schemaVersion: STANDARD_ANALYSIS_JSON_SCHEMA_VERSION,
    account: acc
      ? [
          String(acc.name || ''),
          Number.isFinite(Number(acc.maxFunds)) ? Number(acc.maxFunds) : null,
          Number(acc.totalValue) || 0
        ]
      : null,
    holdingColumns: table.columns,
    holdingRows: table.funds,
    strategies: Array.isArray(port.strategies) ? port.strategies.slice() : [],
    portfolioSummary: port.portfolioSummary || null,
    dataWarnings: buildDataWarnings(port) || [],
    combinationSummary: port.combinationSummary || null,
    closedPositions: Array.isArray(port.closedPositions) ? port.closedPositions.slice() : []
  };
}

/** 缓存对象只读约定：冻结顶层与数组容器（行内仅标量），调用方原地修改不会污染共享缓存 */
function freezeAnalysisJson(json) {
  if (!json || typeof json !== 'object') return json;
  Object.freeze(json);
  [json.holdingColumns, json.holdingRows, json.strategies, json.dataWarnings, json.closedPositions]
    .forEach(a => { if (Array.isArray(a)) Object.freeze(a); });
  if (Array.isArray(json.holdingRows)) json.holdingRows.forEach(r => { if (Array.isArray(r)) Object.freeze(r); });
  return json;
}

/**
 * 账户选择（_buildAnalysisPortfolio 与缓存键共用的唯一选择逻辑）：
 * accountId 优先于 account；useActive 用当前活动账户（未命中回退第一个）；
 * 未指定任何选项时返回 null，由调用方走严格模式（单账户直取 / 多账户 needsAccount）。
 */
async function selectAnalysisTarget(userId, options, accounts) {
  if (options.accountId) {
    return accounts.find(a => String(a.name) === String(options.accountId)) || null;
  }
  if (options.account) {
    return accounts.find(a => a.name === options.account) || null;
  }
  if (options.useActive) {
    const state = await getUserState(userId);
    const activeName = state && state.active;
    return accounts.find(a => a.name === activeName) || accounts[0] || null;
  }
  return null;
}

/**
 * 跨请求缓存键（命中正确性的核心，键变化即失效）：
 * - 用户 ID + 账户名（本系统的账户标识即 name）+ schemaVersion —— 不同用户/账户绝不共享；
 * - 账户配置指纹的 SHA-1：持仓 code/amount/cost/costBasis/盈亏、策略、清仓记录、
 *   回本目标、基金数上限 —— 持仓增删/金额变化/策略修改/清仓编辑 → 立即换键；
 * - 数据版本 = 账户内基金的最大净值日期 + 最大重仓报告日期 —— 净值同步/重仓数据刷新 → 立即换键；
 * - 版本查询失败时退化为一次性随机版本（宁可放弃缓存，绝不返回可能过期的结果）；
 * - 不含时间戳/随机数等每次变化字段（否则永不命中），也不含实时估值
 *   （provider 今日估算属 5 分钟复用窗口语义，命中期间最多滞后 ≤5 分钟）。
 */
async function analysisDataCacheKey(userId, target) {
  const funds = Array.isArray(target.funds) ? target.funds : [];
  const fingerprint = JSON.stringify([
    funds.map(f => f ? [f.code, f.amount, f.cost, f.costBasis, f.holdingProfit, f.profit] : null),
    Array.isArray(target.strategy) ? target.strategy : [],
    Array.isArray(target.closedPositions) ? target.closedPositions : [],
    Number(target.targetRecovery) || 0,
    Number(target.maxFunds) || 0
  ]);
  const codes = funds
    .map(f => f && f.code)
    .filter(c => /^\d{6}$/.test(String(c)));
  let dataVersion = 'no-funds';
  if (codes.length) {
    const placeholders = codes.map(() => '?').join(',');
    try {
      const navRow = await dbAsync.get(
        `SELECT MAX(date) AS d FROM fund_nav WHERE fund_code IN (${placeholders})`, codes);
      const holdRow = await dbAsync.get(
        `SELECT MAX(report_date) AS d FROM fund_holdings WHERE fund_code IN (${placeholders})`, codes);
      dataVersion = `${(navRow && navRow.d) || ''}|${(holdRow && holdRow.d) || ''}`;
    } catch (e) {
      dataVersion = `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
  }
  const cfgHash = crypto.createHash('sha1').update(fingerprint).digest('hex');
  return `v${STANDARD_ANALYSIS_JSON_SCHEMA_VERSION}|u${userId}|a${String(target.name)}|${cfgHash}|${dataVersion}`;
}

/**
 * 统一构建入口 + 5 分钟跨请求共享缓存（内部 AI / 外部 AI / 外部数据接口共用）：
 * - 命中：不重复获取基金分析数据、不重复构建标准 JSON、不重复字段映射与序列化；
 * - single-flight：同键并发请求共用同一份构建中的 Promise，只触发一次实际构建；
 * - 构建失败不缓存错误（清理失败 Promise，后续请求可立即重试）；
 * - 缓存对象冻结（freezeAnalysisJson），调用方原地修改不会污染共享缓存；
 * - 无法定位账户（needsAccount / 无账户 / 键计算异常）时绕过缓存直接构建，绝不跨账户缓存。
 * 返回 { portfolio, json, cacheState }；cacheState: hit（命中）| shared（并发共用）| miss（新构建）| bypass（绕过）。
 */
async function getOrBuildAnalysisData(userId, options = {}) {
  const accounts = await loadUserAccounts(userId);
  const target = await selectAnalysisTarget(userId, options, accounts);
  let cacheKey = null;
  if (target) {
    try {
      cacheKey = await analysisDataCacheKey(userId, target);
    } catch (e) {
      cacheKey = null; // 键计算异常：绕过缓存，行为与旧实现一致
    }
  }
  if (!cacheKey) {
    const portfolio = await buildAnalysisPortfolio(userId, options);
    return { portfolio, json: buildAnalysisCompactJson(portfolio), cacheState: 'bypass' };
  }
  const now = Date.now();
  const hit = analysisDataCache.get(cacheKey);
  if (hit && hit.value && hit.expiresAt > now) {
    return { portfolio: hit.value.portfolio, json: hit.value.json, cacheState: 'hit' };
  }
  if (hit && hit.promise) {
    // single-flight：并发/连续请求共用同一份构建中的 Promise
    const v = await hit.promise;
    return { portfolio: v.portfolio, json: v.json, cacheState: 'shared' };
  }
  const promise = (async () => {
    const portfolio = await buildAnalysisPortfolio(userId, options);
    const json = buildAnalysisCompactJson(portfolio);
    if (portfolio && portfolio.account) {
      if (analysisDataCache.size >= ANALYSIS_DATA_CACHE_MAX_ENTRIES) {
        const oldest = analysisDataCache.keys().next().value;
        if (oldest !== undefined) analysisDataCache.delete(oldest);
      }
      freezeAnalysisJson(json);
      analysisDataCache.set(cacheKey, {
        expiresAt: Date.now() + ANALYSIS_JSON_TTL_MS,
        value: { portfolio, json }
      });
    }
    return { portfolio, json };
  })();
  analysisDataCache.set(cacheKey, { promise });
  try {
    const v = await promise;
    return { portfolio: v.portfolio, json: v.json, cacheState: 'miss' };
  } catch (err) {
    // 失败不得污染缓存：清理失败的 Promise，允许后续请求重试
    const cur = analysisDataCache.get(cacheKey);
    if (cur && cur.promise === promise) analysisDataCache.delete(cacheKey);
    throw err;
  }
}

/**
 * 主动失效（当前键版本机制已覆盖持仓/策略/净值/重仓变化；此函数供未来数据变更路径按需调用）。
 * 不传参数 = 清空全部；仅传 userId = 该用户全部账户；再传 accountName = 精确账户。
 */
function invalidateAnalysisDataCache(userId, accountName) {
  if (userId == null && accountName == null) {
    analysisDataCache.clear();
    return;
  }
  const userTag = `|u${userId}|`;
  const accountTag = accountName == null ? null : `|a${String(accountName)}|`;
  for (const key of Array.from(analysisDataCache.keys())) {
    if (!key.includes(userTag)) continue;
    if (accountTag && !key.includes(accountTag)) continue;
    analysisDataCache.delete(key);
  }
}

function buildDataWarnings(portfolio) {
  const warnings = [];
  const holdings = (portfolio && Array.isArray(portfolio.holdings)) ? portfolio.holdings : [];
  for (const h of holdings) {
    if (h.profitRate === null || h.profitRate === undefined) {
      warnings.push(`${h.code || ''} ${h.name || ''}: 持仓成本无效，盈亏率不可用（profitRate=null）`);
    }
    const bench = h.benchmark;
    if (bench && bench.unavailableReason === 'benchmark_history_insufficient_for_1y') {
      warnings.push(`${h.code || ''} ${h.name || ''}: 已配置基准但基准历史不足一年，return1y/relativeReturn1y 不可用`);
    } else if (bench && bench.unavailableReason) {
      warnings.push(`${h.code || ''} ${h.name || ''}: 基准数据不可用（${bench.unavailableReason}），基准字段已置 null`);
    }
    const perf = h.performance || {};
    if (perf.dataAsOf == null && (perf.return1m != null || perf.return3m != null)) {
      warnings.push(`${h.code || ''} ${h.name || ''}: 收益率缺少对应净值日期（dataAsOf=null），请勿当作最新数据`);
    }
    // 1 年收益可算但 1 年最大回撤不可用 → 一年窗口校验未通过（窗口内有效记录数不足），提示而非静默
    if (perf.return1y != null && perf.maxDrawdown1y == null) {
      warnings.push(`${h.code || ''} ${h.name || ''}: 近一年最大回撤不可用（一年窗口数据校验未通过），maxDrawdown1y/drawdownFromHigh1y=null`);
    }
  }
  if (!portfolio || !Array.isArray(portfolio.strategies) || portfolio.strategies.length === 0) {
    warnings.push('账户策略缺失（strategies 为空）：未找到该账户的策略配置，portfolioSummary 依据不足');
  }
  return warnings;
}

// P3.19：组合关系摘要（让 AI 横向比较基金，而非孤立分析单只）
function buildCombinationSummary(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return '未提供（无持仓）';
  const dirCount = {};
  let aShare = 0, overseas = 0, other = 0;
  holdings.forEach(h => {
    const d = h.direction || h.type || '其他';
    dirCount[d] = (dirCount[d] || 0) + 1;
    const amt = Number(h.amount) || 0;
    const nm = String(h.name || '');
    if (/沪深300|半导体|产业趋势|数字经济|灵活配置|混合|权益|A股|国内|中证|蓝筹/.test(d) || /A股|国内|沪深|中证|蓝筹/.test(nm)) aShare += amt;
    else if (/海外|全球|恒生|纳指|标普|QDII|美股/.test(d) || /海外|全球|恒生|纳斯达克|美股|标普/.test(nm)) overseas += amt;
    else other += amt;
  });
  const total = aShare + overseas + other || 1;
  const pct = v => `${((v / total) * 100).toFixed(0)}%`;
  const dupRoles = Object.keys(dirCount).filter(d => dirCount[d] > 1);
  const lines = [];
  lines.push(`A股/国内暴露 ${pct(aShare)}，海外/全球暴露 ${pct(overseas)}，其他 ${pct(other)}。`);
  if (dupRoles.length) {
    lines.push(`承担相同角色（重复功能）的基金分组：${dupRoles.map(d => `${d}(${dirCount[d]}只)`).join('、')} —— 请说明哪些可互相替代、减仓时优先减哪只。`);
  } else {
    lines.push(`各基金角色区分度较好，无明显重复。`);
  }
  return lines.join('\n');
}

/**
 * 账户级持仓重合判定（真实 fund_holdings 数据，不做名称推断）：
 * - 每只基金取最新报告期的前十大持仓；
 * - 同一股票在两只基金中占比均 >= 3% 才算真实重合；
 * - 有持仓数据的基金不足 2 只 → 全部 null（无法判定，绝不默认「无重合」）。
 * 单次查询（IN），失败静默降级为全 null，不影响分析主流程。
 * @returns {{overlapMap: Map<string, boolean|null>,
 *            detailMap: Map<string, Array<{stockCode,stockName,minePct,otherCode,otherPct}>|null>,
 *            topHoldingsMap: Map<string, string|null>}}
 *   detailMap：与 overlapMap 同一次计算产出（computeOverlapMap detailOut），null=数据不足；
 *   topHoldingsMap：前十大重仓摘要串（「名称 权重%」降序），无数据 null。
 */
async function computeAccountOverlap(accountFunds) {
  const codes = (Array.isArray(accountFunds) ? accountFunds : [])
    .map(f => String(f && f.code || ''))
    .filter(c => /^\d{6}$/.test(c));
  const overlapMap = new Map(codes.map(c => [c, null]));
  const detailMap = new Map(codes.map(c => [c, null]));
  const topHoldingsMap = new Map(codes.map(c => [c, null]));
  if (codes.length < 2) return { overlapMap, detailMap, topHoldingsMap };
  try {
    const placeholders = codes.map(() => '?').join(',');
    const rows = await dbAsync.all(
      `SELECT fund_code, stock_code, stock_name, weight, report_date
       FROM fund_holdings WHERE fund_code IN (${placeholders})`,
      codes
    );
    const latestReport = new Map();
    const byFund = new Map();
    for (const r of rows) {
      const code = String(r.fund_code);
      if (!byFund.has(code)) byFund.set(code, []);
      byFund.get(code).push(r);
      const prev = latestReport.get(code);
      if (!prev || String(r.report_date) > prev) latestReport.set(code, String(r.report_date));
    }
    const normalized = new Map();
    for (const [code, fundRows] of byFund.entries()) {
      const maxReport = latestReport.get(code);
      normalized.set(code, fundMetrics.normalizeHoldingRows(fundRows.filter(r => String(r.report_date) === maxReport)));
      // 前十大重仓摘要（normalizeHoldingRows 已降序截取 topN；权重经 topHoldingsSummary 统一两位小数）
      topHoldingsMap.set(code, topHoldingsSummary(normalized.get(code)));
    }
    // 重合明细与判定共用同一次遍历（computeOverlapMap 第三参数输出容器；第二参缺省用项目默认阈值）
    const computed = fundMetrics.computeOverlapMap(normalized, undefined, detailMap);
    for (const [code, value] of computed.entries()) overlapMap.set(code, value);
  } catch (err) {
    // 持仓查询失败：保持全 null（数据不足），不影响主流程
  }
  return { overlapMap, detailMap, topHoldingsMap };
}

/** 权重百分比统一两位小数（仅展示格式化，不改底层数值；消除 0.0585×100=5.8500000000000005% 浮点噪声） */
function pct2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

/** 前十大重仓摘要串（「名称 权重%」降序）：与 formatOverlapDetail 同一格式化口径。空数据返回 null */
function topHoldingsSummary(normalizedRows) {
  const top = Array.isArray(normalizedRows) ? normalizedRows : [];
  return top.length ? top.map(r => `${r.stockName || r.stockCode} ${pct2(r.weightPct)}%`).join('、') : null;
}

/** 重合明细 → 紧凑串（AI 输入/表格单元格用；避免出现表格分隔符 |）。无数据返回 null。 */
function formatOverlapDetail(detail) {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  return detail
    .map(d => `${d.stockName || d.stockCode}:本${pct2(d.minePct)}%/彼${d.otherCode} ${pct2(d.otherPct)}%`)
    .join('；');
}

/**
 * 构建统一分析组合（默认当前活动账户；可指定 account 名称，仅限用户自己的账户）
 */
async function listAnalysisAccounts(userId) {
  const accounts = await loadUserAccounts(userId);
  return accounts.map(a => ({
    id: a.name,
    name: a.name,
    source: a.source,
    totalValue: (a.funds || []).reduce((s, f) => s + (Number(f.amount) || 0), 0)
  }));
}

/**
 * 构建统一分析组合
 *
 * - 外部分析（严格模式）：accountId 优先于 account；未指定且多账户时返回账户列表，不猜测、不使用 active
 * - DeepSeek 内部分析：useActive=true，使用当前登录用户自己的活动账户（保持现有行为）
 */
async function _buildAnalysisPortfolio(userId, options = {}) {
  const accounts = await loadUserAccounts(userId);
  // 账户选择逻辑与 getOrBuildAnalysisData 缓存键共用同一 selectAnalysisTarget，避免两处实现漂移
  let target = await selectAnalysisTarget(userId, options, accounts);
  if (!target && !options.useActive) {
    // 严格模式：单账户直接返回；多账户需明确指定，不自动猜测
    if (accounts.length === 1) {
      target = accounts[0];
    } else {
      return {
        success: true,
        needsAccount: accounts.length > 1,
        message: accounts.length > 1
          ? '存在多个账户，请通过 account 或 accountId 明确指定'
          : '当前用户暂无账户',
        account: null,
        portfolioSummary: fundMetrics.parsePortfolioSummary([], []),
        strategies: [],
        strategy: { core: [], forbidden: [], rules: [] },
        holdings: [],
        accounts: await listAnalysisAccounts(userId)
      };
    }
  }
  if (!target) {
    return {
      success: true,
      account: null,
      portfolioSummary: fundMetrics.parsePortfolioSummary([], []),
      strategies: [],
      strategy: { core: [], forbidden: [], rules: [] },
      holdings: [],
      accounts: await listAnalysisAccounts(userId)
    };
  }

  const accountFunds = Array.isArray(target.funds) ? target.funds : [];
  const strategy = parseStrategy(target.strategy);
  const totalValue = accountFunds.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  // 真实持仓重合判定（每账户一次，循环内复用；同时产出重合明细与前十大摘要）
  const { overlapMap, detailMap, topHoldingsMap } = await computeAccountOverlap(accountFunds);
  const holdings = [];

  for (const fund of accountFunds) {
    if (!fund || !fund.code) continue;
    const base = enrichFund(fund, accountFunds, strategy, userId);
    // P0-2：同一次分析内，同一基金只解析一次「今日估值 / history / metadata」。
    const code = String(fund.code);
    const savedToday = Number.isFinite(Number(fund.today)) ? Number(fund.today) : undefined;
    const today = await requestMemo(
      `today:${code}`,
      () => resolveFundToday(code, Number(fund.amount) || 0, userId, savedToday)
    );
    base.todayEstimate = today;
    base.today_change = (Number(fund.amount) || 0) * today;
    base.positionType = classifyPositionType({ ...fund, today }, accountFunds, strategy);
    try {
      // P0-2：history 按分析需要限量读取，禁止无条件加载完整历史。
      // 数据增强：getPerformanceHistory 在库内历史不足以覆盖 1 年窗口时按需增量回填
      // （sync_markers 节流 + ON CONFLICT DO NOTHING，绝不覆盖已确认净值；超时降级用现有数据）。
      const history = await requestMemo(
        `hist:${code}`,
        () => fundMetrics.getPerformanceHistory(code)
      );
      base.history = history;
      base.ret7d = periodReturn(history, 7);
      base.ret30d = periodReturn(history, 30);
      base.ret60d = periodReturn(history, 60);
      // 数据增强：performance / benchmark / allocation（缺数据如实 null，绝不伪造）
      const perf = fundMetrics.computePerformance(history);
      base.performance = perf;
      base.benchmark = await requestMemo(
        `bench:${code}`,
        () => fundMetrics.getBenchmarkMetrics(code, perf.return1m, perf.return3m, perf.dataAsOf, perf.return6m, perf.return1y)
      );
      base.allocation = fundMetrics.buildAllocation(code, overlapMap.get(code) === undefined ? null : overlapMap.get(code));
      // 前十大重仓摘要 + 重合明细（真实 fund_holdings；无数据如实 null）
      base.topHoldings = topHoldingsMap.get(code) === undefined ? null : topHoldingsMap.get(code);
      base.overlapDetail = formatOverlapDetail(detailMap.get(code) === undefined ? null : detailMap.get(code));
      // P3.19：历史摘要（替代把完整 history 数组塞给模型，节省 token、聚焦结论）
      try {
        const lastRec = history.length ? history[history.length - 1] : null;
        const navDate = lastRec ? lastRec.date : null;
        const f = v => (v === null || v === undefined || !Number.isFinite(v)) ? '未提供' : `${(v * 100).toFixed(2)}%`;
        base.historySummary = `近7日 ${f(base.ret7d)} ／ 近30日 ${f(base.ret30d)} ／ 近60日 ${f(base.ret60d)}；最近净值日 ${navDate || '未提供'}`;
      } catch (e2) {
        base.historySummary = '未提供';
      }
    } catch (e) {
      base.history = [];
      base.ret7d = null;
      base.ret30d = null;
      base.ret60d = null;
      base.historySummary = '未提供';
      // 数据增强：历史读取失败时，performance/benchmark 全 null、allocation 仍按配置给出
      base.performance = fundMetrics.computePerformance([]);
      base.benchmark = { name: null, return1m: null, return3m: null, return6m: null, return1y: null, relativeReturn1m: null, relativeReturn6m: null, relativeReturn1y: null, dataAsOf: null, kind: null, source: null };
      base.allocation = fundMetrics.buildAllocation(code, overlapMap.get(code) === undefined ? null : overlapMap.get(code));
      base.topHoldings = topHoldingsMap.get(code) === undefined ? null : topHoldingsMap.get(code);
      base.overlapDetail = formatOverlapDetail(detailMap.get(code) === undefined ? null : detailMap.get(code));
    }
    const fundMeta = await requestMemo(`fund:${code}`, () => getFund(code)) || {};
    if (!base.name || base.name === String(fund.code)) base.name = fundMeta.fund_name || base.name;
    if (!base.type || base.type === '基金') base.type = fundMeta.fund_type || base.type;
    holdings.push(base);
  }

  return {
    account: {
      name: target.name,
      type: target.accountTypeLabel || target.type || null,
      totalValue,
      targetRecovery: Number(target.targetRecovery) || 0,
      maxFunds: Number(target.maxFunds) || accountFunds.length
    },
    // 数据增强：组合策略摘要（从账户策略文本解析，未解析到的字段如实 null）
    portfolioSummary: fundMetrics.parsePortfolioSummary(
      target.strategy,
      accountFunds.map(f => ({ code: f.code, name: f.name }))
    ),
    strategies: Array.isArray(target.strategy) ? target.strategy.slice() : [],
    strategy,
    // 数据质量警告（与导出 JSON 同一 buildDataWarnings 口径）：随 AI 输入进入 prompt，
    // 确保影响建议可靠性的数据缺失对模型可见，不为省 Token 静默丢弃
    dataWarnings: buildDataWarnings({
      holdings,
      strategies: Array.isArray(target.strategy) ? target.strategy : []
    }),
    // 紧凑 AI 数据表（prompt 渲染用；导出 JSON 不含此字段，保持原契约）
    analysisTable: buildAnalysisTable(holdings),
    holdings,
    closedPositions: Array.isArray(target.closedPositions) ? target.closedPositions.slice(-10) : [],
    combinationSummary: buildCombinationSummary(holdings),
    accounts: accounts.map(a => ({ name: a.name, source: a.source, totalValue: (a.funds || []).reduce((s, f) => s + (Number(f.amount) || 0), 0) }))
  };
}

// P0-2：软超时护栏——到点即 reject，避免单次 Analysis 无限挂起（底层 fetch 仍有各自 timeout）。
async function buildAnalysisPortfolio(userId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || ANALYSIS_TIMEOUT_MS);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Analysis timeout after ${timeoutMs}ms`)), timeoutMs);
    // 严禁 unref —— 若分析请求是进程唯一工作，unref 会让定时器永不触发，分析无限挂起。
  });
  try {
    return await Promise.race([_buildAnalysisPortfolio(userId, options), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  buildAnalysisPortfolio,
  loadUserAccounts,
  listAnalysisAccounts,
  parseStrategy,
  directionFor,
  buildAnalysisTable,
  buildDataWarnings,
  formatPctCell,
  formatOverlapDetail,
  topHoldingsSummary,
  buildCompactExport,
  // 统一标准 JSON + 5 分钟跨请求共享缓存（内部 AI / 外部 AI 共用入口）
  STANDARD_ANALYSIS_JSON_SCHEMA_VERSION,
  buildAnalysisCompactJson,
  getOrBuildAnalysisData,
  invalidateAnalysisDataCache
};
