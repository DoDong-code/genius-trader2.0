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
const config = require('../config/estimateConfig');

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
  synced.forEach(acc => accounts.push({ ...acc, source: 'sync' }));
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
  const profitRate = amount > 0 ? profit / amount : 0;
  const today = Number(fund.today) || 0;
  // P3.19：成本基数（优先 fund.cost / costBasis；缺失时用 金额-盈亏 反推，避免为 0）
  let cost = 0;
  if (Number.isFinite(Number(fund.cost)) && Number(fund.cost) > 0) cost = Number(fund.cost);
  else if (Number.isFinite(Number(fund.costBasis)) && Number(fund.costBasis) > 0) cost = Number(fund.costBasis);
  else if (amount > 0) cost = amount - profit;
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
  let target = null;
  if (options.accountId) {
    target = accounts.find(a => String(a.name) === String(options.accountId));
  } else if (options.account) {
    target = accounts.find(a => a.name === options.account);
  } else if (options.useActive) {
    const state = await getUserState(userId);
    const activeName = state && state.active;
    target = accounts.find(a => a.name === activeName) || accounts[0] || null;
  }
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
      strategies: [],
      strategy: { core: [], forbidden: [], rules: [] },
      holdings: [],
      accounts: await listAnalysisAccounts(userId)
    };
  }

  const accountFunds = Array.isArray(target.funds) ? target.funds : [];
  const strategy = parseStrategy(target.strategy);
  const totalValue = accountFunds.reduce((s, f) => s + (Number(f.amount) || 0), 0);
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
      const history = await requestMemo(
        `hist:${code}`,
        () => getHistory(code, { limit: ANALYSIS_HISTORY_LIMIT })
      );
      base.history = history;
      base.ret7d = periodReturn(history, 7);
      base.ret30d = periodReturn(history, 30);
      base.ret60d = periodReturn(history, 60);
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
    strategies: Array.isArray(target.strategy) ? target.strategy.slice() : [],
    strategy,
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
  directionFor
};
