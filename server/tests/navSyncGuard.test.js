/**
 * 周末净值补检守卫（mp1/utils/navSyncGuard.js）回归测试。
 * 对应 2026-10-17 修复的任务场景 1-6（判定层）：
 *   1. 周末成功补齐（全部成功 → 会话级去重生效）
 *   2. 首次失败后重试（不标记成功，下次可再触发）
 *   3. 部分失败后重试（不误标完全成功）
 *   4. 并发保护（syncing 期间不重复发起）
 *   5. 日期前进（旧涨跌幅不得冒充新日期涨跌幅；显式新值/同日沿用不回归）
 *   6. 交易日不回归（交易日一律不触发补检）
 * syncTodayNav 的单只失败被静默 catch，故以 updated/total 差值判定——与真实实现契约一致。
 */
const test = require('node:test');
const assert = require('node:assert');
const guard = require('../../mp1/utils/navSyncGuard.js');

test('场景1 周末成功补齐：全部成功才标记，且标记后不再重复触发', () => {
  // 周五为最近交易日，库/本地只有周四 → 周六打开触发补检
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: false, isTrading: false }),
    true,
    '非交易日、未成功、无进行中请求 → 应发起补检'
  );
  // syncTodayNav 返回 {total:5, updated:5} → 成功
  const r = guard.judgeNonTradingSyncResult({ total: 5, updated: 5 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.failed, 0);
  // 成功标记后同会话不再触发
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: true, syncing: false, isTrading: false }),
    false
  );
});

test('场景2 首次失败后重试：全失败不标记成功，下次 onShow 可再次触发', () => {
  // 网络失败：5 只全部失败（today-nav catch → missing → deep fallback 也失败）
  const r = guard.judgeNonTradingSyncResult({ total: 5, updated: 0 });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.failed, 5);
  // 不标记 → 下次 onShow 仍满足发起条件
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: false, isTrading: false }),
    true
  );
});

test('场景3 部分失败后重试：不得误标完全成功，剩余基金后续补齐', () => {
  const partial = guard.judgeNonTradingSyncResult({ total: 5, updated: 3 });
  assert.strictEqual(partial.success, false);
  assert.strictEqual(partial.failed, 2);
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: false, isTrading: false }),
    true
  );
  // 重试后补齐剩余 2 只 → 成功
  const done = guard.judgeNonTradingSyncResult({ total: 5, updated: 5 });
  assert.strictEqual(done.success, true);
});

test('场景3b 无持仓：total=0 视为无事可做（成功、会话去重），避免无意义重试', () => {
  const r = guard.judgeNonTradingSyncResult({ total: 0, updated: 0 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.failed, 0);
});

test('场景3c 网络异常（Promise reject）路径：判定结果不影响，由调用方 catch 不标记', () => {
  // judge 不应被 null/undefined 崩溃（调用方 catch 前的防御）
  assert.strictEqual(guard.judgeNonTradingSyncResult(null).success, false);
  assert.strictEqual(guard.judgeNonTradingSyncResult(undefined).success, false);
  assert.strictEqual(guard.judgeNonTradingSyncResult({}).success, false);
});

test('场景4 并发保护：补检进行中不重复发起', () => {
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: true, isTrading: false }),
    false,
    '进行中 → 不发第二个补检'
  );
  // 进行中标志释放后（失败场景）允许重试
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: false, isTrading: false }),
    true
  );
});

test('场景5 日期前进：旧涨跌幅不得冒充新日期涨跌幅', () => {
  // 周四 -1.2% → 周五净值落库但 today-nav 不含 changePercent（officialChange=null）→ 必须置 null
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: '2026-10-15', prevChangePercent: -1.2, navDate: '2026-10-16', officialChange: null
    }),
    null
  );
  // deep fallback 带来真实新涨跌幅 → 直接采用（含真实 0，不得误判为未知）
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: '2026-10-15', prevChangePercent: -1.2, navDate: '2026-10-16', officialChange: 0.55
    }),
    0.55
  );
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: '2026-10-15', prevChangePercent: -1.2, navDate: '2026-10-16', officialChange: 0
    }),
    0
  );
});

test('场景5b 日期未变：沿用旧值（同日重复刷新不抹掉已知涨跌幅）', () => {
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: '2026-10-16', prevChangePercent: -1.2, navDate: '2026-10-16', officialChange: null
    }),
    -1.2
  );
  // 首次写入（无旧日期）且无新值 → null（无日期可比，不存在「冒充」问题）
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: null, prevChangePercent: null, navDate: '2026-10-16', officialChange: null
    }),
    null
  );
  // 日期回退（脏数据）同样不得沿用旧值
  assert.strictEqual(
    guard.resolveAppliedChangePercent({
      prevDate: '2026-10-16', prevChangePercent: -1.2, navDate: '2026-10-15', officialChange: null
    }),
    null
  );
});

test('场景6 交易日不回归：交易日一律不触发非交易日补检（冻结规则不变）', () => {
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: false, syncing: false, isTrading: true }),
    false
  );
  assert.strictEqual(
    guard.shouldStartNonTradingSync({ synced: true, syncing: false, isTrading: true }),
    false
  );
});
