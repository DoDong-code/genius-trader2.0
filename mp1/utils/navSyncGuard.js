/**
 * 周末/非交易日净值补检守卫 + 净值日期前进时的涨跌幅裁决（纯函数，无副作用，供 node --test 单测）。
 * 抽取自 mp1/pages/portfolio/portfolio.js（2026-10-17 周末净值补齐修复）：
 * 判定逻辑集中于此以便回归测试；本模块不发请求、不读全局状态。
 */

// 是否应当发起非交易日净值补检：非交易日 + 本会话未成功过 + 无进行中请求（防并发）。
// 交易日（isTrading=true）一律 false —— 保持 onShow 既有冻结规则不变。
function shouldStartNonTradingSync({ synced, syncing, isTrading }) {
  return !synced && !syncing && !isTrading;
}

// 评判 syncTodayNav 结果（返回 {total, updated}，单只基金失败被其内部静默 catch，
// 因此用 updated/total 差值识别失败数量，不依赖 Promise 是否 reject）：
//   - total=0（无持仓，无事可做）或 updated>=total（全部基金都取到最近交易日净值）→ 本次补检成功；
//   - 结果缺失（null/undefined/无 total 字段）→ 一律不判成功（无法证明任何基金已补齐）；
//   - 部分/全部失败 → success=false，调用方不得置会话级去重标志，下次 onShow 自动重试
//     （today-nav 幂等且服务端缓存优先，已确认基金零请求，重试收敛、无高频风险）。
function judgeNonTradingSyncResult(res) {
  const hasTotal = Boolean(res) && typeof res === 'object' && res.total !== undefined;
  const total = Number(res && res.total) || 0;
  const updated = Number(res && res.updated) || 0;
  return {
    total,
    updated,
    failed: Math.max(total - updated, 0),
    success: hasTotal ? (total === 0 || updated >= total) : false
  };
}

// _applyNavDate 写入 latest_nav.changePercent 的裁决：
//   - 显式新涨跌幅（deep fallback 提供真实 pct，或官方返回 0）→ 直接采用
//     （注意 Number(null)===0 陷阱：null/undefined/'' 视为「未知」，绝不当作 0%）；
//   - 净值日期前进且暂无新涨跌幅（today-nav 响应不含 changePercent）→ 置 null（界面显示「—」），
//     禁止把旧日期涨跌幅冒充新日期涨跌幅；navDateMap.officialChange 同为 null，
//     _refreshNavDatesIfNeeded 的跳过条件（officialChange 为有限数）不成立 → ?fast=1 回源回填正确值；
//   - 日期未变且无新值 → 沿用旧值（保持既有行为，避免同日重复刷新时把已知涨跌幅抹掉）。
function resolveAppliedChangePercent({ prevDate, prevChangePercent, navDate, officialChange }) {
  if (officialChange !== null && officialChange !== undefined && officialChange !== '') {
    const oc = Number(officialChange);
    if (Number.isFinite(oc)) return oc;
  }
  const advanced = Boolean(navDate && prevDate && String(navDate) !== String(prevDate));
  if (advanced) return null;
  if (prevChangePercent !== null && prevChangePercent !== undefined && prevChangePercent !== '') {
    const pc = Number(prevChangePercent);
    if (Number.isFinite(pc)) return pc;
  }
  return null;
}

module.exports = { shouldStartNonTradingSync, judgeNonTradingSyncResult, resolveAppliedChangePercent };
