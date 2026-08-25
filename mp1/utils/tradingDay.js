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

// QDII/美股基金识别：T+2 净值延迟
// 排除港股（恒生/港股/港美 → 这些当日结算）
const QDII_CODES = { '022184': true, '014002': true };
export function isQdiiFund(fund) {
  if (!fund) return false;
  const name = String(fund.name || '');
  if (/恒生|港股|港美/.test(name)) return false;
  if (QDII_CODES[String(fund.code || '')]) return true;
  return /QDII|全球|海外|纳斯达克|纳指|标普|日经|德国|法国|印度|越南|美国|道琼斯|欧洲/i.test(name);
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

// P4.5 统一三态净值显示（与网页端 live-estimates.js 的 getNavDisplayState 完全一致）：
//   CONFIRMED_NAV   → 蓝「MMDD」（后端确认净值，唯一蓝色来源）
//   TODAY_ESTIMATE  → 灰「估值」
//   NO_DATA         → 灰「暂无数据」
// 蓝色仅来自后端确认净值（dataStatus===CONFIRMED_NAV 或 latest_nav.confirmed）；
// 禁止用 provider 名 / estimate 日期 / 开盘与否 / 非交易日 / localStorage 推导蓝色。
// @param {{navConfirmed?:boolean, navDate?:string|null, estimateReady?:boolean}} params
// @returns {{type:string, tone:'blue'|'gray', text:string}}
export function getNavDisplayState({ navConfirmed = false, navDate = null, estimateReady = false } = {}) {
  if (navConfirmed && navDate) {
    return { type: 'CONFIRMED_NAV', tone: 'blue', text: formatMMDD(navDate).replace('-', '') };
  }
  if (estimateReady) {
    return { type: 'TODAY_ESTIMATE', tone: 'gray', text: '估值' };
  }
  return { type: 'NO_DATA', tone: 'gray', text: '暂无数据' };
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