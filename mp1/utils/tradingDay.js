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

// 数据源 → 中文 label（兼容短名 yjb/xbyj 与长名 yangjibao/xiaobeiyangji）
export function providerDisplayName(source) {
  if (source === 'xiaobeiyangji' || source === 'xbyj') return '小倍';
  if (source === 'yangjibao' || source === 'yjb') return '养基宝';
  return null;
}

/**
 * 计算数据徽章（四态状态机，对齐网页端 live-estimates.js）
 * @param {object} fund       - 持仓基金（必含 code、name）
 * @param {string|null} navDate - 后端返回的 latest_nav.date（yyyy-mm-dd）
 * @param {string|null} estimateSource - estimate 接口返回的 source（xiaobeiyangji/yangjibao/yjb/xbyj）
 * @param {Date} [now]        - 用于测试的时间
 * @param {number|null} officialChange - 官方涨跌幅（由 history 计算，对齐 Web 状态①需 finite）
 * @param {boolean} [hasEstimateData] - 是否存在有效估值/数据源数据（有 navDate 或 有限 today/todayEstimate）
 * @returns {{text:string, tone:'blue'|'gray', kind:'updated'|'source'|'estimate', source?:string}}
 *
 * 判定（P0 估值状态修复）：
 *   ① 官方净值已更新到预期日期（QDII ? 前一交易日 : 今日）且有官方涨跌幅 → 蓝「已更新 MMDD」
 *   ② 非交易日（isTradingDay=false）但有 navDate → 蓝「已更新 MMDD」（最近交易日）
 *   ③ 有估值/数据源数据（hasEstimateData）→ 蓝「数据源标识」：provider 名（小倍/养基宝）或「估算」
 *   ④ 其他（无净值、无估值数据）→ 灰「估值」（唯一灰色场景）
 */
export function computeDataBadge(fund, navDate, estimateSource, now = new Date(), officialChange = null, hasEstimateData = false) {
  const today = shanghaiDate(now);
  const trading = isTradingDay(now);
  const expected = isQdiiFund(fund) ? getPreviousTradingDay(today) : today;
  // 状态①：对齐 Web live-estimates.js:422 —— navDate===expected 且官方涨跌幅为有限数
  // 注意：用 Number.isFinite(officialChange) 而非 Number.isFinite(Number(officialChange))，
  // 因为 Number(null)=0 会误判无涨跌幅数据为「涨跌幅 0」；Number.isFinite(null) 正确返回 false。
  const updated = Boolean(navDate && navDate === expected && Number.isFinite(officialChange));

  if (updated) {
    return { text: `已更新${formatMMDD(navDate).replace('-', '')}`, tone: 'blue', kind: 'updated' };
  }
  if (!trading && navDate) {
    return { text: `已更新${formatMMDD(navDate).replace('-', '')}`, tone: 'blue', kind: 'updated' };
  }
  // ③ 有估值/数据源数据 → 蓝色数据源标识（provider 名 或 本地估算）
  if (hasEstimateData) {
    const label = providerDisplayName(estimateSource) || '估算';
    return { text: label, tone: 'blue', kind: 'source', source: estimateSource || null };
  }
  // ④ 唯一灰色场景：无净值、无估值数据
  return { text: '估值', tone: 'gray', kind: 'estimate', source: null };
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