/**
 * 统一百分比格式化工具（数据精简与百分比统一改造，2026-10-16）
 *
 * 规则（唯一转换点：服务端）：
 * - 原始比例一律以小数存储与传输（-0.0105 = -1.05%），内部计算不经过本模块。
 * - 展示与 AI 表格输出必须经 formatPct 转换一次：两位小数、正值带 +、负值带 -、
 *   零值 0.00%、空值 —。
 * - 禁止重复转换：已是「±x.xx%」形式的字符串原样返回，防止 -0.0105 被二次乘 100
 *   变成 -105.00%。
 * - 白名单 isPercentField：明确哪些字段是比例小数；金额/成本/市值/盈亏额/净值/
 *   份额/日期不在白名单，禁止百分比转换。
 */

const NULL_TEXT = '—';

/** 百分比字段白名单（字段名为小写驼峰；含历史别名） */
const PCT_FIELD_WHITELIST = new Set([
  // 当日涨跌
  'todaychange', 'todayestimate', 'today', 'todaypct', 'estimatechange',
  // 持仓收益率
  'profitrate', 'holdingrate', 'hold', 'profitpct',
  // performance 周期指标
  'return1m', 'return3m', 'return6m', 'return1y',
  'ret7d', 'ret30d', 'ret60d',
  'maxdrawdown1y', 'drawdownfromhigh1y', 'volatility20d',
  'mdd', 'ddhigh', 'ret1m', 'ret3m', 'ret6m', 'ret1y', 'vol20d',
  // benchmark
  'relativereturn1m', 'rel1m',
  'benchmark.return1m', 'benchmark.return3m', 'benchmark.relativereturn1m'
]);

/** 已格式化百分比字符串（±x.xx% / x.xx% / ±x.xx ％） */
const FORMATTED_PCT_RE = /^[+-]?\d+(?:\.\d+)?\s*%$/;

function looksFormatted(v) {
  return typeof v === 'string' && FORMATTED_PCT_RE.test(v.trim());
}

/**
 * 比例小数 → 百分比展示字符串。
 * @param {number|string|null|undefined} v 原始比例小数（或已格式化字符串，原样返回）
 * @param {object} [opts] { nullText='—', signed=true }
 * @returns {string}
 */
function formatPct(v, opts = {}) {
  const nullText = opts.nullText === undefined ? NULL_TEXT : String(opts.nullText);
  const signed = opts.signed !== false;
  // 防重复格式化：已是「x.xx%」字符串直接返回
  if (looksFormatted(v)) {
    const s = String(v).trim().replace(/\s*%$/, '%');
    // 补 + 号（负号已在字符串里）
    if (signed && !s.startsWith('-') && !s.startsWith('+') && parseFloat(s) > 0) return `+${s}`;
    return s;
  }
  if (v === null || v === undefined || v === '') return nullText;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return nullText;
  // -0 视为零
  const pct = n * 100;
  if (Object.is(pct, -0) || pct === 0) return '0.00%';
  const text = pct.toFixed(2);
  // 舍入后为零的极小值（如 0.00001）按零值处理，不得输出 +0.00% / -0.00%
  if (parseFloat(text) === 0) return '0.00%';
  if (!signed) return `${text}%`;
  return pct > 0 ? `+${text}%` : `-${text.slice(1)}%`;
}

/**
 * 字段名是否属于比例小数白名单（大小写不敏感）。
 */
function isPercentField(name) {
  return PCT_FIELD_WHITELIST.has(String(name || '').toLowerCase());
}

/**
 * 持仓口径校验（§五 异常数据校验）：
 * - 约定口径：profitRate = profit / amount（amount 为持仓市值，非 cost）。
 * - 上游自带 profitRate（holdingRate/hold）与口径不一致（>0.5 个百分点）时记录警告，
 *   展示仍按约定口径，不静默改数据。
 * - 空值不产生警告、也绝不自动转 0%。
 * @returns {string[]} 警告列表（空数组 = 无警告）
 */
function validateHolding(h) {
  const warnings = [];
  if (!h || typeof h !== 'object') return warnings;
  // 空值（null/undefined/''）按缺失处理：不告警、绝不转 0
  const missing = v => v === null || v === undefined || v === '';
  if (missing(h.amount) || missing(h.profit)) return warnings;
  const amount = Number(h.amount);
  const profit = Number(h.profit);
  if (!Number.isFinite(amount) || !Number.isFinite(profit)) return warnings;
  const expected = amount > 0 ? profit / amount : null;
  if (expected === null) return warnings;
  if (missing(h.profitRate)) return warnings;
  const claimed = Number(h.profitRate);
  if (Number.isFinite(claimed) && claimed !== 0 && Math.abs(claimed - expected) > 0.005) {
    warnings.push(
      `${h.code || ''} ${h.name || ''}: profitRate(${formatPct(claimed)}) 与约定口径 profit/amount(${formatPct(expected)}) 不一致，已按约定口径展示`
    );
  }
  return warnings;
}

module.exports = {
  NULL_TEXT,
  PCT_FIELD_WHITELIST,
  formatPct,
  looksFormatted,
  isPercentField,
  validateHolding
};
