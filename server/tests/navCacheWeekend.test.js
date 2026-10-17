/**
 * ensureTodayNav 周末补齐回归测试（2026-10-17 周末净值修复 · 任务场景 1-3 服务端部分）。
 *
 * 场景：周六（最近交易日=周五），库里只有周四净值 → ensureTodayNav 应补齐周五净值并写库；
 *       第二次调用命中缓存零 provider 请求；双源失败 → provider-unavailable。
 *
 * 隔离方式：require.cache 预注入 stub（dbAsync / estimateStatus / marketService /
 * providerEstimate / httpClient），navCacheService 加载即命中 stub —— 全程不触真实数据库、不发网络请求。
 * 注意：estimateStatus 与 marketService 为 stub（日期确定化）；其真实周末日期映射由
 * expectedNavDateWeekend.test.js 单独用真实模块验证。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const svcDir = path.join(rootDir, 'services');

const THURSDAY = '2026-10-15';
const FRIDAY = '2026-10-16';   // 最近交易日（周六视角）
const SATURDAY = '2026-10-17';

// ---------- stub 世界 ----------
const DB = { funds: {}, nav: new Map() }; // nav key: `${code}|${date}`
const inserts = [];
const providerCalls = { yahoo: 0, eastmoney: 0 };

const fakeDbAsync = {
  async get(sql, params = []) {
    if (/FROM fund\s+WHERE/i.test(sql)) return DB.funds[params[0]] || null;
    if (/FROM fund_nav/i.test(sql)) {
      const row = DB.nav.get(`${params[0]}|${params[1]}`);
      return row ? { ...row } : null;
    }
    return null;
  },
  async run(sql, params = []) {
    if (/INSERT INTO fund_nav/i.test(sql)) {
      const [code, date, nav, accNav, source] = params;
      inserts.push({ code, date, nav, source });
      DB.nav.set(`${code}|${date}`, { date, nav, acc_nav: accNav, source, fetched_at: 'stub' });
      return { changes: 1 };
    }
    return null;
  }
};

const fakeEstimateStatus = {
  // 与真实 expectedNavDateFor 周末口径一致：普通基金→最近交易日(周五)；QDII→再往前一交易日(周四)
  expectedNavDateFor: (fund) => (fund && String(fund.fund_type || '').includes('QDII') ? THURSDAY : FRIDAY)
};

const fakeMarketService = {
  // 固定为周六：expected(周五) !== today(周六) → before-close 守卫天然放行（确定性，不依赖真实时钟）
  shanghaiDateString: () => SATURDAY,
  // F1/F2 返回历史（不含 expected 日，见各用例）；F3 无数据
  fetchHistory: async (code) => {
    providerCalls.eastmoney += 1;
    if (code === 'F3') return { history: [] };
    // F1：只有周四（yahoo 将赢得周五）；F2：只有周四（QDII expected=周四，eastmoney 赢）
    return { history: [{ date: THURSDAY, nav: 1.47, accNav: 1.47 }] };
  }
};

// Yahoo 返回周五 close=1.5（F1/F2），F3 返回 404
const fakeHttpClient = {
  fetchWithTimeout: async (url) => {
    providerCalls.yahoo += 1;
    if (/\/F3\.OF\?/.test(url)) return { ok: false };
    // 2026-10-16T06:00Z = 上海时间周五 14:00
    const ts = Date.UTC(2026, 9, 16, 6, 0, 0) / 1000;
    return {
      ok: true,
      json: async () => ({
        chart: { result: [{ timestamp: [ts], indicators: { quote: [{ close: [1.5] }] } }] }
      })
    };
  }
};

const fakeProviderEstimate = { fetchProviderEstimate: async () => null };

function inject(absPath, exportsObj) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: exportsObj };
}
inject(require.resolve(path.join(rootDir, 'database', 'dbAsync.js')), fakeDbAsync);
inject(require.resolve(path.join(svcDir, 'estimateStatus.js')), fakeEstimateStatus);
inject(require.resolve(path.join(svcDir, 'marketService.js')), fakeMarketService);
inject(require.resolve(path.join(svcDir, 'providerEstimate.js')), fakeProviderEstimate);
inject(require.resolve(path.join(rootDir, 'utils', 'httpClient.js')), fakeHttpClient);

const { ensureTodayNav } = require(path.join(svcDir, 'navCacheService'));

test('场景1 周末补齐：库仅周四净值，周六调用补齐周五并写库', async () => {
  DB.funds.F1 = { fund_type: '股票型', fund_name: '测试股票基金' };
  DB.nav.set(`F1|${THURSDAY}`, { date: THURSDAY, nav: 1.47, acc_nav: 1.47, source: 'eastmoney' });

  const res = await ensureTodayNav('F1');
  assert.strictEqual(res.date, FRIDAY, 'expected 应为最近交易日（周五）');
  assert.strictEqual(res.cached, true, '成功获取应标记 cached=true');
  assert.strictEqual(res.nav, 1.5);
  assert.strictEqual(res.source, 'yahoo');

  // 已写库：周五行存在
  const saved = DB.nav.get(`F1|${FRIDAY}`);
  assert.ok(saved, '周五净值应已写入 fund_nav');
  assert.strictEqual(Number(saved.nav), 1.5);
  assert.ok(inserts.some(i => i.code === 'F1' && i.date === FRIDAY), '应执行 INSERT');
  // 周四行未被破坏
  assert.strictEqual(Number(DB.nav.get(`F1|${THURSDAY}`).nav), 1.47);
});

test('场景1b 缓存命中：第二次调用直接读缓存，零 provider 请求', async () => {
  const before = { ...providerCalls };
  const res = await ensureTodayNav('F1');
  assert.strictEqual(res.fromCache, true);
  assert.strictEqual(res.date, FRIDAY);
  assert.strictEqual(providerCalls.yahoo, before.yahoo, '不应再请求 yahoo');
  assert.strictEqual(providerCalls.eastmoney, before.eastmoney, '不应再请求 eastmoney');
});

test('场景2 QDII 周末 expected=前一交易日（周四）：eastmoney 补齐周四净值', async () => {
  DB.funds.F2 = { fund_type: 'QDII', fund_name: '测试QDII基金' };
  const res = await ensureTodayNav('F2');
  assert.strictEqual(res.date, THURSDAY, 'QDII 周末 expected 应为周四（T+1 跨日）');
  assert.strictEqual(res.cached, true);
  assert.strictEqual(res.nav, 1.47);
  assert.strictEqual(res.source, 'eastmoney');
  assert.ok(DB.nav.get(`F2|${THURSDAY}`), '周四净值应已写库');
});

test('场景3 双源无数据：返回 provider-unavailable，不写库、不误报 cached', async () => {
  DB.funds.F3 = { fund_type: '股票型', fund_name: '无数据基金' };
  const res = await ensureTodayNav('F3');
  assert.strictEqual(res.cached, false);
  assert.strictEqual(res.nav, null);
  assert.strictEqual(res.reason, 'provider-unavailable');
  assert.strictEqual(DB.nav.get(`F3|${FRIDAY}`), undefined, '不得把空结果写库');
});
