// test-regression.mjs — P0+P1 核心逻辑回归单元测试
// 运行：node test-regression.mjs
import { getNavDisplayState, isQdiiFund, officialNavChange } from './utils/tradingDay.js';

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

// ===== 四、getNavDisplayState 三态（冻结规则 2026-08-25，与 Web 一致）=====
console.log('\n【四】getNavDisplayState 三态（冻结）');
{
  // 测试 1：交易日 15:00，今日正式 NAV 未发布，今日 Estimate 存在 → 灰「估值」，绝对不能蓝昨日日期
  const s1 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s1.type === 'TODAY_ESTIMATE' && s1.tone === 'gray' && s1.text === '估值', `测试1 交易日+昨日NAV+估值 → 灰估值(${s1.text})，禁止蓝昨日`);

  // 测试 2：交易日 20:30，某基金正式 NAV 已发布 08/25 → 蓝 0825
  const s2 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-25', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s2.type === 'CONFIRMED_NAV' && s2.tone === 'blue' && s2.text === '0825', `测试2 交易日今日NAV已发布 → 蓝0825(${s2.text})`);

  // 测试 3：同一时间其他基金仍未发布 08/25 → 蓝 0825 与 灰估值 可同时存在
  const s3 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s2.type === 'CONFIRMED_NAV' && s3.type === 'TODAY_ESTIMATE', '测试3 同日蓝/灰可共存');

  // 测试 4：周六/周日 → 蓝「最近正式 NAV 日期」
  const s4 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-25', estimateReady: false, isTradingDayFlag: false, today: '2026-08-26' });
  assert(s4.type === 'CONFIRMED_NAV' && s4.tone === 'blue' && s4.text === '0825', `测试4 非交易日 → 蓝最近净值(${s4.text})`);

  // 测试 5：8/18 登录后 6 天未登录，8/25 打开：旧 NAV(08/18) 不得当蓝色今日；后台补到 08/25 后 → 蓝 0825
  const s5a = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-18', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s5a.type === 'TODAY_ESTIMATE' && s5a.tone === 'gray', '测试5 未登录后旧NAV(08/18) → 灰估值，不蓝');
  const s5b = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-25', estimateReady: false, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s5b.type === 'CONFIRMED_NAV' && s5b.text === '0825', '测试5 后台追平到 08/25 → 蓝 0825');

  // 测试 6：8/25 交易日，当前 NAV=08/24，切换小倍→养基宝 → NAV 仍 08/24，UI 仍灰估值，绝不能蓝 08/24
  const s6 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s6.type === 'TODAY_ESTIMATE' && s6.tone === 'gray', '测试6 切源后 NAV=08/24 → 仍灰估值，不蓝昨日');

  // 测试 7：已有 08/25 NAV，切源后仍蓝 08/25，不能重新变灰
  assert(s2.type === 'CONFIRMED_NAV' && s2.text === '0825', '测试7 已有今日NAV切源后仍蓝 0825');

  // 补充：无 nav、无 estimate → null（留空，禁止「暂无数据」）
  const s7 = getNavDisplayState({ navConfirmed: false, navDate: null, estimateReady: false, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s7 === null, '无 nav/estimate → null（UI 留空）');

  // 补充：estimate 日期/ provider 不能制造蓝；confirmed=false 即使有 navDate 也不能蓝
  const s8 = getNavDisplayState({ navConfirmed: false, navDate: '2026-08-25', estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s8.type !== 'CONFIRMED_NAV' && s8.tone === 'gray', 'provider 日期不能制造蓝');
  const s9 = getNavDisplayState({ navConfirmed: false, navDate: '2026-08-24', estimateReady: false, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s9 === null, 'confirmed=false 不蓝（blank）');

  // 补充：confirmed=true 但 navDate 缺失 → 不判蓝（防脏数据）
  const s10 = getNavDisplayState({ navConfirmed: true, navDate: null, estimateReady: true, isTradingDayFlag: true, today: '2026-08-25' });
  assert(s10 !== null && s10.type !== 'CONFIRMED_NAV' && s10.tone === 'gray', 'confirmed=true 缺 navDate → 不蓝');

  // 补充：默认参数（不传 isTradingDayFlag/today）按当前真实日期判定，兼容旧调用
  const s11 = getNavDisplayState({ navConfirmed: false, navDate: null, estimateReady: true });
  assert(s11.type === 'TODAY_ESTIMATE' && s11.tone === 'gray', '默认参数：有估值 → 灰估值');

  // QDII 白名单（isQdiiFund 独立于徽章三态，仍保留回归）
  assert(isQdiiFund({ code: '022184', name: 'x' }) === true, 'QDII 白名单 022184');
  assert(isQdiiFund({ code: '014002', name: 'x' }) === true, 'QDII 白名单 014002');
  assert(isQdiiFund({ code: '013309', name: '易方达恒生科技ETF联接(QDII)C' }) === false, '港股恒生排除');
  assert(isQdiiFund({ code: '008702', name: '华夏黄金ETF联接C' }) === false, '黄金非 QDII');

  // officialNavChange 历史涨跌幅仍有效
  const hc = officialNavChange([{ date: '2026-08-13', nav: 1.00 }, { date: '2026-08-14', nav: 1.02 }], '2026-08-14');
  assert(Math.abs(hc - 0.02) < 0.0001, 'officialNavChange 涨跌幅 0.02');
}

// ===== 四-B、港股/恒生科技 与 QDII/美股 市场日期规则（补充修正 2026-08-25）=====
console.log('\n【四-B】港股/恒生科技 与 QDII/美股 市场日期规则');
{
  const hkFund = { code: '013309', name: '易方达恒生科技ETF联接(QDII)C' };
  const qdiiFund = { code: '022184', name: '富国全球科技互联网股票(QDII)C' };

  // 测试 2：港股/恒生交易日 + NAV 未发布（08/24）→ 灰估值，绝不蓝昨日
  const hk1 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, today: '2026-08-25', fund: hkFund });
  assert(hk1.type === 'TODAY_ESTIMATE' && hk1.tone === 'gray', `测试2 恒生交易日NAV未发布 → 灰估值(${hk1.type})`);

  // 测试 3：港股/恒生交易日 + NAV 已发布 08/25 → 蓝 0825
  const hk2 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-25', estimateReady: false, today: '2026-08-25', fund: hkFund });
  assert(hk2.type === 'CONFIRMED_NAV' && hk2.tone === 'blue' && hk2.text === '0825', `测试3 恒生交易日NAV已发布 → 蓝0825(${hk2.text})`);

  // 测试 4：香港市场节假日（2026-07-01 香港特别行政区成立纪念日，中国是交易日）→ 蓝最近正式 NAV
  const hk3 = getNavDisplayState({ navConfirmed: true, navDate: '2026-06-30', estimateReady: false, today: '2026-07-01', fund: hkFund });
  assert(hk3.type === 'CONFIRMED_NAV' && hk3.tone === 'blue' && hk3.text === '0630', `测试4 香港节假日 → 蓝最近净值(${hk3.text})`);

  // 测试 5：QDII 尚未到正式 NAV 发布（08/21，expected=08/24）→ 有 Estimate 时灰估值
  const q1 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-21', estimateReady: true, today: '2026-08-25', fund: qdiiFund });
  assert(q1.type === 'TODAY_ESTIMATE' && q1.tone === 'gray', `测试5 QDII未发布 → 灰估值(${q1.type})`);

  // 测试 6：QDII 正式 NAV 按真实规则发布（08/24）→ 蓝 0824（不强制中国本地日期）
  const q2 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: false, today: '2026-08-25', fund: qdiiFund });
  assert(q2.type === 'CONFIRMED_NAV' && q2.tone === 'blue' && q2.text === '0824', `测试6 QDII真实NAV日期 → 蓝0824(${q2.text})`);

  // 测试 7：切换数据源不改变 NAV 日期（同一基金同一 NAV 日期，切源前后徽章判定完全一致）
  const q3 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, today: '2026-08-25', fund: qdiiFund });
  assert(q3.type === 'CONFIRMED_NAV' && q3.text === '0824', '测试7 切源后 NAV 日期不变，仍蓝真实日期 0824');

  // 测试 8：刷新不改变三态逻辑（A股当日规则仍成立）
  const cn1 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-24', estimateReady: true, today: '2026-08-25' });
  assert(cn1.type === 'TODAY_ESTIMATE' && cn1.tone === 'gray', '测试8 A股刷新后三态逻辑不变（灰估值）');
  const cn2 = getNavDisplayState({ navConfirmed: true, navDate: '2026-08-25', estimateReady: false, today: '2026-08-25' });
  assert(cn2.type === 'CONFIRMED_NAV' && cn2.text === '0825', '测试8 A股今日NAV → 蓝0825');
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
