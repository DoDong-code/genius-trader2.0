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
const config = require('../config/estimateConfig');

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
  if (Number.isFinite(Number(savedToday))) return Number(savedToday);
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
  return {
    code: String(fund.code),
    name: String(fund.name || fund.code),
    amount,
    profit,
    profitRate,
    todayEstimate: today,
    today_change: amount * today,
    positionType: classifyPositionType(fund, accountFunds, strategy),
    type: String(fund.category || fund.fund_type || '基金'),
    direction: directionFor(fund.code, fund.name)
  };
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
async function buildAnalysisPortfolio(userId, options = {}) {
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
    const today = await resolveFundToday(fund.code, Number(fund.amount) || 0, userId, Number.isFinite(Number(fund.today)) ? Number(fund.today) : undefined);
    base.todayEstimate = today;
    base.today_change = (Number(fund.amount) || 0) * today;
    base.positionType = classifyPositionType({ ...fund, today }, accountFunds, strategy);
    try {
      const history = await getHistory(String(fund.code));
      base.history = history;
      base.ret7d = periodReturn(history, 7);
      base.ret30d = periodReturn(history, 30);
      base.ret60d = periodReturn(history, 60);
    } catch (e) {
      base.history = [];
      base.ret7d = null;
      base.ret30d = null;
      base.ret60d = null;
    }
    const fundMeta = await getFund(String(fund.code)) || {};
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
    accounts: accounts.map(a => ({ name: a.name, source: a.source, totalValue: (a.funds || []).reduce((s, f) => s + (Number(f.amount) || 0), 0) }))
  };
}

module.exports = {
  buildAnalysisPortfolio,
  loadUserAccounts,
  listAnalysisAccounts,
  parseStrategy,
  directionFor
};
