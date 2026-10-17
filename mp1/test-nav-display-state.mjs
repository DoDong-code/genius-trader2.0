// test-nav-display-state.mjs — getNavDisplayState 蓝标/估值条件回归（2026-10-17 修订）
// 修订内容：蓝色唯一条件 = navDate === expected（交易日/非交易日统一）；
// 非交易日旧确认净值不再标蓝（缺陷：周六库缺 10-13 起净值时显示蓝色 10-09）；
// 灰「估值」仅限交易日。运行：node --test mp1/test-nav-display-state.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNavDisplayState, expectedNavDateFor } from './utils/tradingDay.js';

// 真实持仓基金（截图 2026-10-17）：
// 「沪深港黄金」不匹配 isHkFund 的 /恒生|港股|港美|香港/ → A股口径
const aShareFund = { code: '020412', name: '永赢中证沪深港黄金产业股票ETF联接C' };
const qdiiFund = { code: '022184', name: '富国全球科技互联网股票(QDII)C' };

const SAT = '2026-10-17'; // 周六
const FRI = '2026-10-16'; // 周五（最近交易日）
const THU = '2026-10-15'; // QDII 最近披露日（T+1）

test('expected 基准：周六 A股→周五、QDII→周四', () => {
  assert.equal(expectedNavDateFor(aShareFund, SAT), FRI);
  assert.equal(expectedNavDateFor(qdiiFund, SAT), THU);
});

test('场景1 周六 + A股已确认周五净值 → 蓝 1016', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: FRI, estimateReady: false,
    isTradingDayFlag: false, today: SAT, fund: aShareFund
  });
  assert.equal(s.type, 'CONFIRMED_NAV');
  assert.equal(s.tone, 'blue');
  assert.equal(s.text, '1016');
});

test('场景2 周六 + A股净值停在 10-12（数据缺口）→ 不标蓝，UI 留空（2026-10-17 修订核心）', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: '2026-10-12', estimateReady: false,
    isTradingDayFlag: false, today: SAT, fund: aShareFund
  });
  assert.equal(s, null, '旧确认净值在非交易日不得标蓝');
});

test('场景3 周六 + QDII 已确认周四净值 → 蓝 1015（不强制中国本地日期）', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: THU, estimateReady: false,
    isTradingDayFlag: false, today: SAT, fund: qdiiFund
  });
  assert.equal(s.type, 'CONFIRMED_NAV');
  assert.equal(s.text, '1015');
});

test('场景4 周六 + QDII 净值停在 10-12 → 不标蓝', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: '2026-10-12', estimateReady: false,
    isTradingDayFlag: false, today: SAT, fund: qdiiFund
  });
  assert.equal(s, null);
});

test('场景5 周六 + 仅剩陈旧估值 → 不显示灰「估值」（估值仅限交易日）', () => {
  const s = getNavDisplayState({
    navConfirmed: false, navDate: null, estimateReady: true,
    isTradingDayFlag: false, today: SAT, fund: aShareFund
  });
  assert.equal(s, null);
});

test('场景6 交易日 + 今日 NAV 未发布 + 有估值 → 灰「估值」（回归保护，不变）', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: THU, estimateReady: true,
    isTradingDayFlag: true, today: FRI, fund: aShareFund
  });
  assert.equal(s.type, 'TODAY_ESTIMATE');
  assert.equal(s.tone, 'gray');
  assert.equal(s.text, '估值');
});

test('场景7 交易日 + 昨日净值 → 禁止蓝标（回归保护，不变）', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: THU, estimateReady: false,
    isTradingDayFlag: true, today: FRI, fund: aShareFund
  });
  assert.equal(s, null);
});

test('场景8 交易日 + 今日净值已确认 → 蓝 1016（回归保护，不变）', () => {
  const s = getNavDisplayState({
    navConfirmed: true, navDate: FRI, estimateReady: false,
    isTradingDayFlag: true, today: FRI, fund: aShareFund
  });
  assert.equal(s.type, 'CONFIRMED_NAV');
  assert.equal(s.text, '1016');
});
