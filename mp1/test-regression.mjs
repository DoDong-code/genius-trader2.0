// test-regression.mjs — P0+P1 核心逻辑回归单元测试
// 运行：node test-regression.mjs
import { computeDataBadge, isQdiiFund, getPreviousTradingDay, isTradingDay, shanghaiDate, officialNavChange, providerDisplayName } from './utils/tradingDay.js';

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✅ PASS', name); }
  else { failed++; console.log('  ❌ FAIL', name); }
}

// ===== 模拟 app.js 核心方法（复制自 app.js 真实逻辑）=====
function makeApp(accounts, active) {
  const app = {
    globalData: { accounts: JSON.parse(JSON.stringify(accounts)), activeAccountName: active },
    isSyncAccount(acc) { return Boolean(acc && (acc.accountType === 'sync' || (!acc.accountType && acc.__source))); },
    convertAccountToLocal(acc) {
      if (!acc || !this.isSyncAccount(acc)) return;
      acc.originalSource = acc.syncSource || acc.__source || 'sync';
      acc.accountType = 'local';
      acc.syncSource = null;
      acc.convertedFromSync = true;
      acc.convertedTime = (acc.convertedTime || '') === '' ? new Date().toISOString() : acc.convertedTime;
      delete acc.__source;
    },
    renameAccount(oldName, newName) {
      if (!oldName || !newName || oldName === newName) return false;
      const accounts = this.globalData.accounts;
      if (!accounts[oldName]) return false;
      if (accounts[newName]) return false;
      const acc = accounts[oldName];
      this.convertAccountToLocal(acc);
      accounts[newName] = acc;
      acc.name = newName;
      delete accounts[oldName];
      Object.values(accounts).forEach(a => {
        if (Array.isArray(a.children)) { const i = a.children.indexOf(oldName); if (i !== -1) a.children[i] = newName; }
        if (a.parent === oldName) a.parent = newName;
      });
      if (this.globalData.activeAccountName === oldName) this.globalData.activeAccountName = newName;
      return true;
    },
    mergeFundsInto(target, funds) {
      (funds || []).forEach(cf => {
        const existing = (target.funds || []).find(pf => pf.code === cf.code);
        if (existing) {
          existing.amount = (Number(existing.amount) || 0) + (Number(cf.amount) || 0);
          existing.holdingProfit = (Number(existing.holdingProfit ?? existing.profit) || 0) + (Number(cf.holdingProfit ?? cf.profit) || 0);
          existing.shares = (Number(existing.shares) || 0) + (Number(cf.shares) || 0);
          const costBasis = (Number(existing.amount) || 0) - (Number(existing.holdingProfit) || 0);
          existing.holdingRate = costBasis > 0 ? existing.holdingProfit / costBasis : 0;
          existing.hold = existing.holdingRate;
          (cf.transactions || []).forEach(t => {
            const dup = (existing.transactions || []).some(x => x.type === t.type && x.date === t.date && Math.abs((x.amount || 0) - (t.amount || 0)) < 0.01);
            if (!dup) { existing.transactions = existing.transactions || []; existing.transactions.unshift(t); }
          });
        } else {
          target.funds = target.funds || [];
          target.funds.push(cf);
        }
      });
    }
  };
  return app;
}

// ===== 一、convertAccountToLocal =====
console.log('\n【一】convertAccountToLocal');
{
  const app = makeApp({ '同步A': { name: '同步A', accountType: 'sync', syncSource: 'yangjibao', funds: [] } }, '同步A');
  const acc = app.globalData.accounts['同步A'];
  app.convertAccountToLocal(acc);
  assert(acc.accountType === 'local', 'accountType 转 local');
  assert(acc.syncSource === null, 'syncSource 置 null');
  assert(acc.convertedFromSync === true, 'convertedFromSync 标记');
  assert(acc.originalSource === 'yangjibao', 'originalSource 记录来源');
  assert(app.isSyncAccount(acc) === false, '转 local 后不再判定为 sync');
}

// ===== 二、renameAccount（本地 + 同步 + 子账户引用）=====
console.log('\n【二】renameAccount');
{
  // 测试 1：本地账户改名
  const app = makeApp({ '主账户': { name: '主账户', funds: [], children: ['主账户-半导体'] }, '主账户-半导体': { name: '主账户-半导体', parent: '主账户', funds: [] } }, '主账户');
  const ok = app.renameAccount('主账户', '新主账户');
  assert(ok === true, '本地改名成功');
  assert(!app.globalData.accounts['主账户'], '旧 key 删除');
  assert(!!app.globalData.accounts['新主账户'], '新 key 存在');
  assert(app.globalData.activeAccountName === '新主账户', 'active 更新');
  assert(app.globalData.accounts['主账户-半导体'].parent === '新主账户', '子账户 parent 引用更新');
  assert(app.globalData.accounts['新主账户'].children.includes('主账户-半导体'), 'children 引用保持');

  // 测试 2：同步账户改名转 local
  const app2 = makeApp({ '养基宝账户': { name: '养基宝账户', accountType: 'sync', syncSource: 'yangjibao', funds: [] } }, '养基宝账户');
  app2.renameAccount('养基宝账户', '本地账户');
  const acc2 = app2.globalData.accounts['本地账户'];
  assert(acc2.accountType === 'local', '同步账户改名后 accountType=local');
  assert(acc2.syncSource === null, '同步账户改名后 syncSource=null');
  assert(acc2.convertedFromSync === true, '同步账户改名后 convertedFromSync=true');

  // 测试 3：改名冲突（新名已存在）
  const app3 = makeApp({ 'A': { name: 'A', funds: [] }, 'B': { name: 'B', funds: [] } }, 'A');
  assert(app3.renameAccount('A', 'B') === false, '改名冲突返回 false');
}

// ===== 三、mergeFundsInto（同 code 合并 + 去重）=====
console.log('\n【三】mergeFundsInto');
{
  const app = makeApp({ '目标': { name: '目标', funds: [
    { code: '019633', amount: 10000, holdingProfit: 500, holdingRate: 0.0526, shares: 3400, transactions: [{ type: 'buy', amount: 10000, fee: 0, date: '2026-07-13' }] }
  ] } }, '目标');
  const target = app.globalData.accounts['目标'];
  app.mergeFundsInto(target, [
    { code: '019633', amount: 5000, holdingProfit: 300, shares: 1700, transactions: [
      { type: 'buy', amount: 5000, fee: 0, date: '2026-08-01' },
      { type: 'buy', amount: 10000, fee: 0, date: '2026-07-13' } // 重复，应去重
    ] },
    { code: '008702', amount: 15000, holdingProfit: 1000, shares: 5000, transactions: [{ type: 'buy', amount: 15000, fee: 0, date: '2026-08-02' }] }
  ]);
  const f019633 = target.funds.find(f => f.code === '019633');
  const f008702 = target.funds.find(f => f.code === '008702');
  assert(f019633.amount === 15000, '同 code amount 相加 10000+5000=15000');
  assert(f019633.holdingProfit === 800, '同 code holdingProfit 相加 500+300=800');
  assert(f019633.shares === 5100, '同 code shares 相加 3400+1700=5100');
  assert(Math.abs(f019633.holdingRate - 800/(15000-800)) < 0.0001, 'holdingRate 重算 = profit/(amount-profit)');
  assert(f019633.hold === f019633.holdingRate, 'hold 同步 holdingRate');
  assert(f019633.transactions.length === 2, '重复流水去重（2 条去重后剩 2）');
  assert(f019633.transactions[0].date === '2026-08-01', '新流水 unshift 到最前');
  assert(f008702 && f008702.amount === 15000, '不同 code 直接 push');
  assert(target.funds.length === 2, '合并后基金数正确（不重复）');
}

// ===== 四、computeDataBadge 三态 =====
console.log('\n【四】computeDataBadge 三态');
{
  const fundA = { code: '019633', name: '国泰半导体设备ETF联接C' };
  const qdii = { code: '022184', name: '全球科技基金' };
  // 2026-08-14 是周五（交易日），2026-08-16 是周日（非交易日）
  const fri = new Date('2026-08-14T10:00:00+08:00');
  const sun = new Date('2026-08-16T10:00:00+08:00');

  // 状态①：交易日，navDate === expected(today) 且有 officialChange → 蓝已更新
  const b1 = computeDataBadge(fundA, '2026-08-14', null, fri, 0.012);
  assert(b1.tone === 'blue' && b1.text === '已更新0814', `状态①交易日已更新 → 蓝(${b1.text})`);

  // 状态① 无 officialChange → 灰估值
  const b1b = computeDataBadge(fundA, '2026-08-14', null, fri, null);
  assert(b1b.tone === 'gray', '状态① 无 officialChange → 灰估值');

  // 状态②：非交易日，有 navDate → 蓝已更新最近交易日
  const b2 = computeDataBadge(fundA, '2026-08-14', null, sun, 0.012);
  assert(b2.tone === 'blue' && b2.text === '已更新0814', `状态②非交易日 → 蓝(${b2.text})`);

  // 状态③：交易日盘中，navDate 是上一交易日（≠expected）→ 灰估值
  const b3 = computeDataBadge(fundA, '2026-08-13', null, fri, 0.012);
  assert(b3.tone === 'gray' && b3.text === '估值', `状态③盘中 → 灰(${b3.text})`);

  // 状态③ 第三方 → 灰小倍/养基宝
  const b3b = computeDataBadge(fundA, '2026-08-13', 'xiaobeiyangji', fri, 0.012);
  assert(b3b.tone === 'gray' && b3b.text === '小倍', `状态③第三方 → 灰(${b3b.text})`);

  // QDII：expected = 前一交易日
  const b4 = computeDataBadge(qdii, '2026-08-13', null, fri, 0.012);
  assert(b4.tone === 'blue' && b4.text === '已更新0813', `QDII expected=前一交易日 → 蓝(${b4.text})`);

  // QDII 白名单
  assert(isQdiiFund({ code: '022184', name: 'x' }) === true, 'QDII 白名单 022184');
  assert(isQdiiFund({ code: '014002', name: 'x' }) === true, 'QDII 白名单 014002');
  assert(isQdiiFund({ code: '013309', name: '易方达恒生科技ETF联接(QDII)C' }) === false, '港股恒生排除');
  assert(isQdiiFund({ code: '008702', name: '华夏黄金ETF联接C' }) === false, '黄金非 QDII');
}

// ===== 五、todayEstimate 优先级 =====
console.log('\n【五】todayEstimate 优先级');
{
  const f = { amount: 10000, today: 0.02, todayEstimate: 180 }; // todayEstimate=180，amount×today=200
  const todayProfitVal = Number.isFinite(Number(f.todayEstimate)) ? Number(f.todayEstimate) : (Number(f.amount) || 0) * (Number(f.today) || 0);
  assert(todayProfitVal === 180, 'todayEstimate 优先（180，而非 amount×today=200）');
  const f2 = { amount: 10000, today: 0.02 }; // 无 todayEstimate
  const v2 = Number.isFinite(Number(f2.todayEstimate)) ? Number(f2.todayEstimate) : (Number(f2.amount) || 0) * (Number(f2.today) || 0);
  assert(v2 === 200, '无 todayEstimate 时 fallback amount×today=200');
}

// ===== 六、流水排序（unshift 最新在前）=====
console.log('\n【六】流水排序');
{
  const tx = [];
  tx.unshift({ type: 'buy', amount: 100, date: '2026-08-10' });
  tx.unshift({ type: 'buy', amount: 200, date: '2026-08-11' });
  assert(tx[0].date === '2026-08-11' && tx[1].date === '2026-08-10', '最新流水在最前（第二笔在前，第一笔在后）');
}

// ===== 七、officialNavChange =====
console.log('\n【七】officialNavChange');
{
  const history = [{ date: '2026-08-13', nav: 1.00 }, { date: '2026-08-14', nav: 1.02 }];
  const c = officialNavChange(history, '2026-08-14');
  assert(Math.abs(c - 0.02) < 0.0001, '涨跌幅 1.02/1.00-1=0.02');
}

console.log(`\n========== 结果：通过 ${passed}，失败 ${failed} ==========`);
process.exit(failed > 0 ? 1 : 0);
