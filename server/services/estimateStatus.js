/**
 * P3.18-ESTIMATE-STATE：基金估值/净值统一数据状态判定（后端唯一权威）
 *
 * data_status 四态：
 *   CONFIRMED_NAV   - fund_nav 已确认当日净值（expected 日）→ 前端蓝「MMDD」（唯一蓝色来源）
 *   PROVIDER_TODAY  - 第三方（小倍/养基宝）返回当日数据（trade_date === expected）→ 前端灰「小倍/养基宝」
 *   PROVIDER_STALE  - 第三方返回旧数据（trade_date 存在但非当日）→ 前端灰「小倍/养基宝」
 *   NO_DATA         - 无确认净值且无第三方当日/旧数据（本地估算/无数据）→ 前端灰「估值」
 */
const { shanghaiDateString, getLatestTradingDay, isTradingDay } = require('./marketService');

function isQdiiFund(fund) {
  if (!fund) return false;
  const type = fund.fund_type || '';
  const name = fund.fund_name || '';
  return (
    type.includes('QDII') ||
    type.includes('海外') ||
    type.includes('美股') ||
    name.includes('QDII') ||
    name.includes('美股') ||
    name.includes('纳斯达克') ||
    name.includes('标普') ||
    name.includes('标普500') ||
    name.includes('S&P')
  );
}

function previousTradingDay(dateStr) {
  const parts = String(dateStr).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return getLatestTradingDay(`${yyyy}-${mm}-${dd}`);
}

function expectedNavDateFor(fund, now = new Date()) {
  const today = shanghaiDateString(now.getTime ? now.getTime() : Date.now());
  const isTr = isTradingDay(today);
  if (isTr) {
    return isQdiiFund(fund) ? previousTradingDay(today) : today;
  } else {
    const lastTradingDay = getLatestTradingDay(today);
    return isQdiiFund(fund) ? previousTradingDay(lastTradingDay) : lastTradingDay;
  }
}

const PROVIDER_SOURCES = new Set(['xiaobeiyangji', 'yangjibao', 'xbyj', 'yjb']);

/**
 * @param {{confirmedNavDate?:string, expectedNavDate:string, providerSource?:string|null, providerTradeDate?:string|null}} params
 * @returns {'CONFIRMED_NAV'|'PROVIDER_TODAY'|'PROVIDER_STALE'|'NO_DATA'}
 */
function resolveDataStatus({ confirmedNavDate, expectedNavDate, providerSource, providerTradeDate }) {
  if (confirmedNavDate && (confirmedNavDate === expectedNavDate || (providerTradeDate && providerTradeDate === confirmedNavDate))) return 'CONFIRMED_NAV';
  if (providerSource && providerTradeDate) {
    return providerTradeDate === expectedNavDate ? 'PROVIDER_TODAY' : 'PROVIDER_STALE';
  }
  return 'NO_DATA';
}

module.exports = { resolveDataStatus, expectedNavDateFor, isQdiiFund, PROVIDER_SOURCES };
