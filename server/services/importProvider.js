/**
 * 三方持仓 → Genius Trader 数据结构（标准化映射）
 *
 * 说明：Genius Trader 的持仓权威状态保存在浏览器 localStorage，
 * 本服务只负责把第三方原始数据规范化为 Genius Trader 的账户/基金结构，
 * 由前端合并进本地持仓（不覆盖用户手动账户）。
 *
 * 归一化输出：
 * {
 *   provider: 'yangjibao' | 'xiaobeiyangji',
 *   accounts: [{
 *     name: '养基宝-xxx' | '小倍养基-xxx',
 *     funds: [{
 *       code, name, amount, holdingProfit, holdingRate, shares,
 *       category, transactions: [{ type:'buy', amount, date }]
 *     }]
 *   }]
 * }
 */

const PARENT_PREFIX = {
  yangjibao: '养基宝',
  xiaobeiyangji: '小倍养基'
};

const DEFAULT_SUB_ACCOUNT = '默认账户';

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildFund(holding, options = {}) {
  const shares = toNumber(holding.share);
  const amount = toNumber(holding.amount);
  const earnings = toNumber(holding.earnings);
  const cost = Math.max(0, amount - earnings);
  const holdingRate = cost > 0 ? earnings / cost : 0;
  const operationDate = String(holding.operation_date || new Date().toISOString().slice(0, 10));

  // 成本净值（每份成本）：养基宝直接提供单位成本（hold_cost），优先采用；
  // 小倍养基未提供真实成本净值，用 成本/份额 反推
  let costNav = 0;
  if (options.preferSourceNav && toNumber(holding.nav) > 0) {
    costNav = toNumber(holding.nav);
  } else if (shares > 0) {
    costNav = cost / shares;
  }

  return {
    code: String(holding.fund_code || ''),
    name: String(holding.fund_name || holding.fund_code || ''),
    amount,
    holdingProfit: earnings,
    holdingRate,
    shares,
    costNav,
    category: '基金',
    transactions: [
      {
        type: 'buy',
        amount,
        date: operationDate
      }
    ]
  };
}

/**
 * 归一化养基宝数据
 * provider.fetchAccounts() → [{account_id, name}]
 * provider.fetchHoldings(accountId) → [{fund_code, fund_name, share, nav, amount, earnings, operation_date}]
 */
async function normalizeYangjibao(provider) {
  const rawAccounts = await provider.fetchAccounts();
  const accounts = [];
  for (const rawAccount of rawAccounts) {
    const holdings = await provider.fetchHoldings(rawAccount.account_id);
    accounts.push({
      name: `${PARENT_PREFIX.yangjibao}-${rawAccount.name}`,
      funds: holdings.map(holding => buildFund(holding, { preferSourceNav: true })).filter(f => f.code)
    });
  }
  return accounts;
}

/**
 * 归一化小倍养基数据（按 accountId 分组，无分组归入默认账户）
 * provider.fetchAccounts() → [{account_id, name}]
 * provider.fetchHoldings() → [{..., account_id}]
 */
async function normalizeXiaobeiyangji(provider) {
  const rawAccounts = await provider.fetchAccounts();
  const accountNameMap = new Map();
  for (const acc of rawAccounts) {
    const key = acc.account_id || '';
    if (key) accountNameMap.set(key, acc.name || DEFAULT_SUB_ACCOUNT);
  }

  const holdings = await provider.fetchHoldings();
  const groups = new Map();
  for (const holding of holdings) {
    const key = holding.account_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(holding);
  }

  const accounts = [];
  for (const [key, groupHoldings] of groups.entries()) {
    const subName = key ? (accountNameMap.get(key) || DEFAULT_SUB_ACCOUNT) : DEFAULT_SUB_ACCOUNT;
    accounts.push({
      name: `${PARENT_PREFIX.xiaobeiyangji}-${subName}`,
      funds: groupHoldings.map(buildFund).filter(f => f.code)
    });
  }
  return accounts;
}

/**
 * 统一入口
 * @param {object} provider 已登录的 Provider 实例
 * @returns {Promise<{provider: string, accounts: Array}>}
 */
async function normalizeProviderAccounts(provider) {
  if (!provider || !provider.sourceName) throw new Error('无效的数据源');
  let accounts;
  if (provider.sourceName === 'yangjibao') {
    accounts = await normalizeYangjibao(provider);
  } else if (provider.sourceName === 'xiaobeiyangji') {
    accounts = await normalizeXiaobeiyangji(provider);
  } else {
    // 通用兜底：有 fetchAccounts/fetchHoldings(accountId) 的平台按养基宝模式处理
    accounts = await normalizeYangjibao(provider);
  }
  return {
    provider: provider.sourceName,
    accounts
  };
}

module.exports = {
  normalizeProviderAccounts,
  buildFund,
  PARENT_PREFIX,
  DEFAULT_SUB_ACCOUNT
};
