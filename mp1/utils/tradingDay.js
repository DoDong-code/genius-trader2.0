// utils/tradingDay.js
// 数据标识状态机核心工具（对齐网页端 live-estimates.js）

// 上海日期：返回 yyyy-mm-dd（北京时间）
export function shanghaiDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// 是否已过 A 股收盘（15:00 北京时间）
export function isShanghaiAfterClose(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const t = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Number(t.hour) * 60 + Number(t.minute) >= 15 * 60;
}

// 是否交易日（周末 + 2026 年节假日硬编码表）
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'
]);

export function isTradingDay(d = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short'
  }).format(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !HOLIDAYS_2026.has(shanghaiDate(d));
}

// 港股 / 恒生科技类基金：按「当日」规则处理（与美股 QDII 的 T+1 披露规则严格区分）
export function isHkFund(fund) {
  if (!fund) return false;
  const name = String(fund.name || fund.fund_name || '');
  return /恒生|港股|港美|香港/.test(name);
}

// 2026 年香港公众假期（香港政府宪报）：周末 + 以下日期为非交易日
const HK_HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-04-03', '2026-04-04', '2026-04-06',
  '2026-05-01', '2026-05-25',
  '2026-06-19', '2026-07-01', '2026-09-26',
  '2026-10-01', '2026-10-19',
  '2026-12-25', '2026-12-26'
]);

export function isHkTradingDay(d = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short'
  }).format(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !HK_HOLIDAYS_2026.has(shanghaiDate(d));
}

export function getLatestHkTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  while (true) {
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    if (isHkTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
      return `${yyyy}-${mm}-${dd}`;
    }
    dt.setDate(dt.getDate() - 1);
  }
}

// QDII/美股基金识别：T+1/T+2 净值披露规则
// 排除港股（恒生/港股/港美/香港 → 这些当日结算）
const QDII_CODES = { '022184': true, '014002': true };
export function isQdiiFund(fund) {
  if (!fund) return false;
  const name = String(fund.name || '');
  if (/恒生|港股|港美|香港/.test(name)) return false;
  if (QDII_CODES[String(fund.code || '')]) return true;
  return /QDII|全球|海外|纳斯达克|纳指|标普|日经|德国|法国|印度|越南|美国|道琼斯|欧洲/i.test(name);
}

// 基金「今日正式净值」业务日期：
//   A股            → 中国市场交易日（当日）
//   港股/恒生科技   → 香港市场交易日（当日）
//   QDII/美股/全球  → 实际 NAV 披露日期（前一交易日），绝不强制等于中国本地日期
export function expectedNavDateFor(fund, dateStr = shanghaiDate()) {
  if (isHkFund(fund)) {
    return isHkTradingDay(new Date(`${dateStr}T00:00:00`)) ? dateStr : getLatestHkTradingDay(dateStr);
  }
  if (isQdiiFund(fund)) {
    const base = isTradingDay(new Date(`${dateStr}T00:00:00`)) ? dateStr : getLatestTradingDay(dateStr);
    return getPreviousTradingDay(base);
  }
  return isTradingDay(new Date(`${dateStr}T00:00:00`)) ? dateStr : getLatestTradingDay(dateStr);
}

// 前一交易日（QDII 基金今天结算前一日净值用）
export function getPreviousTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  while (true) {
    dt.setDate(dt.getDate() - 1);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    if (isTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
      return `${yyyy}-${mm}-${dd}`;
    }
  }
}

// MMDD 格式化（蓝徽章显示用）
export function formatMMDD(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const m = dateStr.match(/(\d{2})[-/](\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : '';
}

// 冻结三态净值显示（与网页端 live-estimates.js 的 getNavDisplayState 完全一致）：
//   交易日 + 基金「今日」正式 NAV 已确认     → 蓝「MMDD」（CONFIRMED_NAV）
//   非交易日 + 最近正式 NAV 已确认           → 蓝「最近 MMDD」（CONFIRMED_NAV）
//   交易日 + 今日 NAV 未发布 + 有估值        → 灰「估值」（TODAY_ESTIMATE）
//   其他                                    → null（UI 留空，禁止显示「暂无数据」）
// 市场规则：A股/港股（恒生科技）= 当日；QDII/美股/全球 = 实际 NAV 披露日期（T+1）。
// 禁止「昨日净值蓝标」：交易日今日 NAV 未发布时，latest NAV=昨日也绝不显示蓝色。
// @param {{navConfirmed?:boolean, navDate?:string|null, estimateReady?:boolean,
//          isTradingDayFlag?:boolean|null, today?:string|null, fund?:object|null}} params
// @returns {{type:string, tone:'blue'|'gray', text:string}}
export function getNavDisplayState({
  navConfirmed = false,
  navDate = null,
  estimateReady = false,
  isTradingDayFlag = null,
  today = null,
  fund = null
} = {}) {
  const todayStr = today || shanghaiDate();
  const trading = isTradingDayFlag === null
    ? (isHkFund(fund) ? isHkTradingDay(new Date(`${todayStr}T00:00:00`)) : isTradingDay(new Date()))
    : Boolean(isTradingDayFlag);
  const expected = expectedNavDateFor(fund, todayStr);
  if (navConfirmed && navDate) {
    if (!trading || String(navDate) === expected) {
      return { type: 'CONFIRMED_NAV', tone: 'blue', text: formatMMDD(navDate).replace('-', '') };
    }
  }
  if (estimateReady) {
    return { type: 'TODAY_ESTIMATE', tone: 'gray', text: '估值' };
  }
  return null; // 没有数据：保持空白，不显示任何标签，禁止显示「暂无数据」
}

const PROVIDER_SOURCE_SET = new Set(['xiaobeiyangji', 'yangjibao', 'xbyj', 'yjb']);

/**
 * P3.18-ESTIMATE-STATE 临时降级：后端未部署时，前端用 estimate 响应自推 data_status
 *（部署后后端接管，行为等价）。纯前端只读 estimate 字段，不改后端。
 * @param {object} fund - 持仓基金
 * @param {object|null} estimate - estimate API 响应（含 trade_date / source / data_source_actual）
 * @param {Date} [now]
 * @returns {'PROVIDER_TODAY'|'PROVIDER_STALE'|'NO_DATA'|null}
 */
export function inferDataStatusFromEstimate(fund, estimate, now = new Date()) {
  if (!estimate) return 'NO_DATA';
  const actualSource = estimate.data_source_actual || estimate.source || estimate.estimate_source;
  if (actualSource && actualSource === 'local') return 'NO_DATA'; // 本地估算不算 provider 当日
  if (!actualSource || !PROVIDER_SOURCE_SET.has(String(actualSource))) return null; // 非 provider（交由后端 data_status 兜底）
  const tradeDate = estimate.trade_date || estimate.nav_date || null;
  if (!tradeDate) return 'PROVIDER_STALE';
  const today = shanghaiDate(now);
  const expected = isQdiiFund(fund) ? getPreviousTradingDay(today) : today;
  return tradeDate === expected ? 'PROVIDER_TODAY' : 'PROVIDER_STALE';
}

/**
 * 从 history 计算官方涨跌幅（navDate 当天 vs 前一交易日）
 */
export function officialNavChange(history, navDate) {
  if (!Array.isArray(history) || !navDate) return null;
  const records = history
    .filter(item => item && item.date && Number.isFinite(Number(item.nav)))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const idx = records.findIndex(item => item.date === navDate);
  if (idx > 0) {
    const curr = Number(records[idx].nav);
    const prev = Number(records[idx - 1].nav);
    if (Number.isFinite(curr) && Number.isFinite(prev) && prev > 0) {
      return curr / prev - 1;
    }
  }
  return null;
}
