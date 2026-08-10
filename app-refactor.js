(function(){
  window.FUND_API_BASE = localStorage.getItem('FUND_API_BASE') || '';
  window.AI_API_KEY = localStorage.getItem('AI_API_KEY') || '';
  window.__accountTabSelected = 'all';
  const s=window.portfolioState;if(!s)return;
  const root=document.querySelector('#view-root'),title=document.querySelector('#page-title');
  let view='portfolio',editing=false,selected=new Set();
  const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>Math.round(n).toLocaleString('zh-CN'), acct=()=>s.accounts[s.getActive()];
  const money2=n=>{const v=Number(n)||0;return (v<0?'−':'')+Math.abs(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});};
  // 账户类型：sync（同步账户）/ local（本地账户）。兼容旧 __source 数据。
  function ensureAccountType(acc) {
    if (!acc || typeof acc !== 'object') return;
    if (acc.accountType === 'sync' || acc.accountType === 'local') return;
    if (acc.__source) {
      acc.accountType = 'sync';
      acc.syncSource = acc.syncSource || acc.__source;
    } else {
      acc.accountType = 'local';
    }
    if (acc.accountType === 'local') acc.syncSource = acc.syncSource || null;
  }
  function isSyncAccount(acc) {
    return Boolean(acc && (acc.accountType === 'sync' || (!acc.accountType && acc.__source)));
  }
  // 同步账户 → 本地账户（解除同步，保留数据与来源记录）
  function convertAccountToLocal(acc) {
    if (!acc || !isSyncAccount(acc)) return;
    acc.originalSource = acc.syncSource || acc.__source || 'sync';
    acc.accountType = 'local';
    acc.syncSource = null;
    acc.convertedFromSync = true;
    acc.convertedTime = new Date().toISOString();
    delete acc.__source;
  }
  window.ensureAccountType = ensureAccountType;
  window.isSyncAccount = isSyncAccount;
  window.convertAccountToLocal = convertAccountToLocal;

  function buildCategoryTargets(strategyList) {
    const t = { '权益类': 35, '黄金类': 20, '债券类': 25, '海外类': 20, '其他': 10 };
    (strategyList || []).forEach(st => {
      ['权益类', '黄金类', '债券类', '海外类', '其他'].forEach(k => {
        const m = st.match(new RegExp(k + '[^0-9%]*(\\d+)\\s*%'));
        if (m) t[k] = parseFloat(m[1]);
      });
    });
    return t;
  }

  // ─────────────────────────────────────────────
  // 账户层级：父账户 / 子账户
  // ─────────────────────────────────────────────
  const FUND_SECTORS_BY_CODE = {
    '014002': '全球智能科技', '022184': '全球科技', '002771': '灵活配置',
    '002207': '黄金矿业', '019633': '半导体设备', '007339': '沪深300',
    '004253': '黄金', '013309': '恒生科技', '010827': '产业趋势',
    '025422': '数字经济', '014847': '债券', '008173': '债券',
    '020741': '债券', '015736': '纯债', '380006': '纯债',
    '004103': '债券', '009690': '灵活配置', '000001': '混合', '008702': '基金'
  };

  function sectorNameOf(f) {
    return (f && (FUND_SECTORS_BY_CODE[f.code] || f.sector || f.category)) || '其他';
  }

  // 板块 → 大类资产（资产配比分析用，与持仓页板块口径一致）
  const ASSET_CLASS_BY_SECTOR = {
    '半导体设备': '权益类', '产业趋势': '权益类', '数字经济': '权益类',
    '灵活配置': '权益类', '混合': '权益类', '沪深300': '权益类',
    '黄金': '黄金类', '黄金矿业': '黄金类',
    '债券': '债券类', '纯债': '债券类',
    '全球科技': '海外类', '全球智能科技': '海外类', '恒生科技': '海外类'
  };
  function assetClassOf(f) {
    const sector = sectorNameOf(f);
    if (ASSET_CLASS_BY_SECTOR[sector]) return ASSET_CLASS_BY_SECTOR[sector];
    const raw = (f && f.category) || '';
    if (['权益类', '黄金类', '债券类', '海外类'].includes(raw)) return raw;
    const name = (f && f.name) || '';
    if (/黄金|贵金属|金矿/.test(name)) return '黄金类';
    if (/债|货币/.test(name)) return '债券类';
    if (/全球|海外|恒生|纳指|标普|QDII|美股/.test(name)) return '海外类';
    return '其他';
  }

  // 父账户有效持仓 = 自身持仓 + 全部子账户持仓（子账户带 subAccount 标记）
  function effectiveFundsOf(account) {
    if (!account) return [];
    const own = Array.isArray(account.funds) ? account.funds : [];
    if (!Array.isArray(account.children) || account.children.length === 0) return own;
    const all = own.slice();
    account.children.forEach(childName => {
      const child = s.accounts[childName];
      if (child && Array.isArray(child.funds)) {
        child.funds.forEach(f => all.push({ ...f, subAccount: child.name }));
      }
    });
    return all;
  }

  function rootAccountsOf() {
    return Object.values(s.accounts).filter(a => !a.parent);
  }

  // 把一组基金合并进目标账户（同代码合并金额/收益/份额，流水去重）
  function mergeFundsInto(target, funds) {
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
          if (!dup) {
            existing.transactions = existing.transactions || [];
            existing.transactions.unshift(t);
          }
        });
      } else {
        target.funds = target.funds || [];
        target.funds.push(cf);
      }
    });
  }

  function buildAdviceText(diffPct, rules) {
    if (diffPct > 4) {
      let adviceText = '分批止盈 / 适当减仓';
      if (rules.recovery) adviceText = `止盈回本 (目标:${money(rules.recovery)})`;
      else if (rules.targetReturn) adviceText = `目标止盈 (门槛:${rules.targetReturn})`;
      return { adviceText, adviceColor: '#ff9500', adviceBg: 'rgba(255, 149, 0, 0.08)' };
    }
    if (diffPct < -4) {
      if (rules.suspendedBuy) return { adviceText: '暂停申购 / 观望', adviceColor: '#86868b', adviceBg: 'rgba(134, 134, 139, 0.08)' };
      let adviceText = '分批低吸 / 逢低定投';
      if (rules.fixedInvest) adviceText = `低吸定投 (${money(rules.fixedInvest)}/期)`;
      else if (rules.limit) adviceText = `限额定投 (单次:${money(rules.limit)})`;
      return { adviceText, adviceColor: '#ff3b30', adviceBg: 'rgba(255, 59, 48, 0.08)' };
    }
    let adviceText = '持有待涨 / 观望';
    if (rules.fixedInvest && !rules.suspendedBuy) adviceText = `策略观望 (定投:${money(rules.fixedInvest)})`;
    return { adviceText, adviceColor: '#0071e3', adviceBg: 'rgba(0, 113, 227, 0.08)' };
  }

  function loadCachedAiResult(a) {
    const accountName = a.name || '默认账户';
    const str = localStorage.getItem('LAST_AI_ANALYSIS_' + accountName) || localStorage.getItem('LAST_AI_ANALYSIS');
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  /**
   * 统一决策报告：本地规则引擎 + AI 结果合并为一份标准结构，
   * 分析页与首页“今日操作建议”模块共用，避免两套口径。
   */
  function buildDecisionReport(a) {
    const funds = effectiveFundsOf(a);
    const strategyList = a.strategy || [];
    const closedPositions = a.closedPositions || [];
    const totalAssets = funds.reduce((x, f) => x + (Number(f.amount) || 0), 0);

    const categoryTotals = {};
    funds.forEach(f => {
      const cat = assetClassOf(f);
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (Number(f.amount) || 0);
    });

    const colorMap = {
      '权益类': '#ff3b30',
      '黄金类': '#ffd60a',
      '债券类': '#34a853',
      '海外类': '#0071e3',
      '其他': '#af52de'
    };
    const allocations = Object.keys(categoryTotals).map(cat => {
      const amt = categoryTotals[cat];
      const pct = totalAssets > 0 ? (amt / totalAssets) * 100 : 0;
      return {
        category: cat,
        amount: amt,
        amountStr: money(amt),
        pct,
        pctStr: pct.toFixed(2) + '%',
        color: colorMap[cat] || colorMap['其他']
      };
    }).sort((x, y) => y.amount - x.amount);

    const categoryTargets = buildCategoryTargets(strategyList);
    const activeCategories = new Set(funds.map(f => assetClassOf(f)));
    let activeTargetsSum = 0;
    activeCategories.forEach(cat => { activeTargetsSum += categoryTargets[cat] !== undefined ? categoryTargets[cat] : 10; });

    // 本地健康度 / 偏离度（沿用原分析页口径）
    let healthScore = 60;
    let healthText = '亟待调整';
    let healthColor = '#ff3b30';
    let deviationText = '当前账户无持仓数据';
    if (activeCategories.size >= 4) {
      healthScore = 95; healthText = '配置极佳'; healthColor = '#34a853';
    } else if (activeCategories.size === 3) {
      healthScore = 85; healthText = '配置良好'; healthColor = '#34a853';
    } else if (activeCategories.size === 2) {
      healthScore = 75; healthText = '配比一般'; healthColor = '#ff9500';
    } else if (activeCategories.size === 1) {
      healthScore = 60; healthText = '风险集中'; healthColor = '#ff3b30';
    }
    let maxCatPct = 0;
    allocations.forEach(al => { if (al.pct > maxCatPct) maxCatPct = al.pct; });
    deviationText = '组合配比均衡度良好';
    if (maxCatPct > 65) deviationText = '单一资产类别配比过大，建议适当分散降低系统性风险';
    else if (maxCatPct > 45) deviationText = '大类配比略有偏离，建议微调持仓结构';
    else if (funds.length === 0) deviationText = '当前账户无持仓数据';

    // 本地风险评分（0-100，越高越危险）：集中度 + 亏损 + 波动
    let localRisk = 50;
    if (activeCategories.size === 1) localRisk += 15;
    else if (activeCategories.size === 2) localRisk += 5;
    if (maxCatPct > 65) localRisk += 10;
    else if (maxCatPct > 45) localRisk += 5;
    const profitRates = funds.map(f => {
      const amount = Number(f.amount) || 0;
      const profit = Number(f.holdingProfit ?? f.profit) || 0;
      return amount > 0 ? profit / amount : 0;
    });
    const avgRate = profitRates.length ? profitRates.reduce((s, r) => s + r, 0) / profitRates.length : 0;
    if (avgRate < -0.1) localRisk += 10;
    else if (avgRate < 0) localRisk += 5;
    else if (avgRate > 0.15) localRisk -= 5;
    localRisk = Math.max(5, Math.min(95, localRisk));

    const aiResult = loadCachedAiResult(a);
    if (aiResult) {
      healthScore = aiResult.healthScore !== undefined ? Number(aiResult.healthScore) : healthScore;
      healthText = aiResult.healthText || healthText;
      healthColor = aiResult.healthColor || healthColor;
      deviationText = aiResult.deviationText || deviationText;
    }
    const aiRisk = aiResult && Number.isFinite(Number(aiResult.riskScore)) ? Number(aiResult.riskScore) : null;
    const riskScore = aiRisk !== null ? Math.max(0, Math.min(100, Math.round(aiRisk))) : localRisk;
    const riskLevel = riskScore >= 70 ? '高' : riskScore >= 40 ? '中' : '低';

    // 如何组合配比降低风险：AI 一句话建议优先，本地自适应规则兜底
    const topAlloc = allocations[0];
    const bondPct = (allocations.find(al => al.category === '债券类') || {}).pct || 0;
    const goldPct = (allocations.find(al => al.category === '黄金类') || {}).pct || 0;
    let rebalanceSuggestion = '组合较为稳健，维持现有配置与纪律定投即可。';
    const aiRebalance = aiResult && typeof aiResult.rebalanceSuggestion === 'string' ? aiResult.rebalanceSuggestion.trim() : '';
    if (aiRebalance) {
      rebalanceSuggestion = aiRebalance;
    } else if (maxCatPct > 65) {
      if (topAlloc && topAlloc.category === '债券类') {
        rebalanceSuggestion = `债券类占比过高（${maxCatPct.toFixed(0)}%），组合偏防守；可适度增加权益/海外资产的配置比例，并保持行业分散。`;
      } else if (topAlloc && topAlloc.category === '权益类') {
        const bondPart = bondPct > 0
          ? `当前债券类约占 ${bondPct.toFixed(0)}%，可在现有基础上适度提高稳健资产占比，进一步降低波动`
          : '建议增配债券/稳健类资产，降低组合波动';
        rebalanceSuggestion = `权益类占比过高（${maxCatPct.toFixed(0)}%），建议分散到 2-3 个行业，${bondPart}。`;
      } else {
        rebalanceSuggestion = `「${topAlloc ? topAlloc.category : '其他'}」占比过高（${maxCatPct.toFixed(0)}%），建议适当分散，降低单一资产集中度。`;
      }
    } else if (riskScore >= 70) {
      rebalanceSuggestion = (bondPct > 0 || goldPct > 0)
        ? '风险偏高，建议适度降低权益/行业主题基金仓位，在现有稳健资产基础上进一步控制单一行业集中度。'
        : '风险偏高，建议降低权益/行业主题基金仓位，增配债券与稳健资产，并控制单一行业集中度。';
    } else if (riskScore >= 40) {
      rebalanceSuggestion = '风险适中，可小幅提高稳健资产（债券/黄金）占比，保持行业分散。';
    }

    // 逐基金统一决策行（本地规则 + AI 建议合并）
    const rows = funds.map(f => {
      const cat = sectorNameOf(f);
      const classCat = assetClassOf(f);
      const countInCat = funds.filter(x => assetClassOf(x) === classCat).length;
      const targetCategoryPct = categoryTargets[classCat] !== undefined ? categoryTargets[classCat] : (categoryTargets['其他'] || 10);
      const normalizedCategoryTarget = activeTargetsSum > 0 ? (targetCategoryPct / activeTargetsSum) * 100 : targetCategoryPct;
      const targetPct = countInCat > 0 ? (normalizedCategoryTarget / countInCat) : 0;
      const currentPct = totalAssets > 0 ? ((Number(f.amount) || 0) / totalAssets) * 100 : 0;
      const diffPct = currentPct - targetPct;
      const { rules: parsedRules } = parseStrategyDetails(f, strategyList);

      let aiSugg = null;
      if (aiResult && aiResult.suggestions) {
        aiSugg = aiResult.suggestions.find(s =>
          (s.code && String(s.code) === String(f.code)) ||
          (s.fund && (s.fund.includes(f.name) || f.name.includes(s.fund)))
        ) || null;
      }

      let adviceText, adviceColor, adviceBg, adviceReason;
      if (aiSugg) {
        adviceText = aiSugg.action;
        adviceReason = aiSugg.reason;
        if (/(加|低吸|买|定投)/.test(adviceText)) { adviceColor = '#ff3b30'; adviceBg = 'rgba(255, 59, 48, 0.08)'; }
        else if (/(减|止盈|卖|赎)/.test(adviceText)) { adviceColor = '#ff9500'; adviceBg = 'rgba(255, 149, 0, 0.08)'; }
        else { adviceColor = '#0071e3'; adviceBg = 'rgba(0, 113, 227, 0.08)'; }
      } else {
        const fb = buildAdviceText(diffPct, parsedRules);
        adviceText = fb.adviceText;
        adviceColor = fb.adviceColor;
        adviceBg = fb.adviceBg;
        adviceReason = '基于本地规则引擎对资产配比偏离度以及投资策略进行的综合计算。';
      }

      const todayRate = Number(f.today || 0) * 100;
      let actionType = 'hold';
      if (/(加|低吸|买|定投)/.test(adviceText)) actionType = 'buy';
      else if (/(减|止盈|卖|赎)/.test(adviceText)) actionType = 'sell';

      return {
        code: f.code,
        name: f.name,
        cat,
        amount: Number(f.amount) || 0,
        currentPct,
        todayRate,
        isTodayPositive: todayRate >= 0,
        adviceText,
        adviceColor,
        adviceBg,
        adviceReason,
        actionType
      };
    });

    return {
      funds,
      strategyList,
      closedPositions,
      allocations,
      totalAssets,
      healthScore,
      healthText,
      healthColor,
      deviationText,
      riskScore,
      riskLevel,
      rebalanceSuggestion,
      hasAi: Boolean(aiResult),
      summary: aiResult && aiResult.summary ? aiResult.summary : null,
      rows,
      aiResult
    };
  }

  function parseStrategyDetails(f, list) {
    const matched = [];
    const rules = {
      limit: null,
      recovery: null,
      targetReturn: null,
      fixedInvest: null,
      suspendedBuy: false
    };

    list.forEach(st => {
      let isMatch = false;
      // 1. Direct match by 6-digit fund code
      if (st.includes(f.code)) {
        isMatch = true;
      } else {
        // 2. Match by well-known brands
        const brands = ["富国", "易方达", "华夏", "汇添富", "兴全", "景顺", "天弘", "交银", "广发", "中欧", "万家", "招商", "博时", "南方", "嘉实", "华安", "工银", "建信", "农银"];
        for (const b of brands) {
          if (f.name.includes(b) && st.includes(b)) {
            isMatch = true;
            break;
          }
        }
      }

      // 3. Match by partial substring of length >= 2 if no brand matched
      if (!isMatch) {
        const cleanName = f.name.replace(/(基金|混合|指数|股票|债券|A|C|LOF|ETF|联接)/g, '');
        if (cleanName.length >= 2) {
          for (let i = 0; i <= cleanName.length - 2; i++) {
            const slice = cleanName.substring(i, i + 2);
            if (st.includes(slice)) {
              isMatch = true;
              break;
            }
          }
        }
      }

      if (isMatch) {
        matched.push(st);
        // Parse limit (限额)
        const limitMatch = st.match(/限额\s*(\d+)/);
        if (limitMatch) rules.limit = parseInt(limitMatch[1], 10);

        // Parse recovery (回本)
        const recoveryMatch = st.match(/回本\s*(\d+)/);
        if (recoveryMatch) rules.recovery = parseInt(recoveryMatch[1], 10);

        // Parse fixed invest (定投)
        const fixedMatch = st.match(/定投\s*(\d+)/);
        if (fixedMatch) rules.fixedInvest = parseInt(fixedMatch[1], 10);

        // Parse target profit (止盈)
        const targetProfitMatch = st.match(/止盈\s*(\d+%?)/);
        if (targetProfitMatch) rules.targetReturn = targetProfitMatch[1];

        // Check for suspended buy or only-sell constraints (e.g. 暂停申购, 已经暂停申购, 只允许卖出, 暂停买入, 禁止买入)
        if (st.includes("暂停申购") || st.includes("暂停买入") || st.includes("只允许卖出") || st.includes("只允许卖") || st.includes("禁止买入") || st.includes("禁止申购") || st.includes("暂停买")) {
          rules.suspendedBuy = true;
        }
      }
    });

    return { matched, rules };
  }

  function buildTodayAdviceModule(a) {
    const report = buildDecisionReport(a);
    const summaryHtml = report.summary ? `
      <div class="today-advice-summary"><strong>今日操作建议的总结：</strong>${esc(report.summary)}</div>
    ` : `
      <div class="today-advice-empty">今日操作建议总结尚未生成，点击右上角 › 前往分析页运行 AI 诊断</div>
    `;

    const todayKey = new Date().toLocaleDateString('en-CA');
    const updatedTime = localStorage.getItem('TODAY_ADVICE_AUTO_UPDATED_TIME_' + todayKey) || '';

    return `
      <section class="today-advice-section">
        <div class="today-advice-head">
          <div>
            <h2>今日操作建议</h2>
          </div>
          <div style="display:flex;align-items:center;gap:14px;">
            <div class="today-advice-meta">
              <span>每个交易日 14:40 自动更新</span>
              ${updatedTime ? `<span> · 今日 ${updatedTime} 已更新</span>` : ''}
            </div>
            <span class="today-advice-arrow" id="go-analysis-btn" role="button" aria-label="查看完整分析与操作建议" title="查看完整分析与操作建议">›</span>
          </div>
        </div>
        ${summaryHtml}
      </section>
    `;
  }

  let todayAdviceTimer = null;
  function scheduleTodayAdviceUpdate() {
    if (todayAdviceTimer) clearInterval(todayAdviceTimer);
    const runCheck = async () => {
      try {
        const res = await fetch('/api/market/status');
        const data = await res.json();
        if (!data || !data.success) return;
        const dateStr = data.date;
        const timeStr = data.time || '';
        const flagKey = 'TODAY_ADVICE_AUTO_UPDATED_' + dateStr;
        if (data.trading_day && timeStr >= '14:40' && localStorage.getItem(flagKey) !== '1') {
          localStorage.setItem(flagKey, '1');
          localStorage.setItem('TODAY_ADVICE_AUTO_UPDATED_TIME_' + dateStr, timeStr.slice(0, 5));
          if (typeof window.refreshFundEstimates === 'function') window.refreshFundEstimates();
          setTimeout(() => { if (view === 'overview') overview(); }, 8000);
        }
      } catch (e) { /* 忽略瞬时网络错误 */ }
    };
    runCheck();
    todayAdviceTimer = setInterval(runCheck, 60000);
  }

  window.onAccountTabChange = function (sel) {
    window.__accountTabSelected = sel || 'all';
    if (view === 'overview') render('overview');
  };

  function overview(){
    const a = acct() || { name: '', funds: [], strategy: [], closedPositions: [] };
    const effFunds = effectiveFundsOf(a);
    const total = effFunds.reduce((x, f) => x + (Number(f.amount) || 0), 0);
    const day = effFunds.reduce((x, f) => x + (Number(f.amount) || 0) * (Number(f.today) || 0), 0);
    title.textContent = '天才交易员上线';
    const selectedTab = window.__accountTabSelected || 'all';
    const showAccountMgmt = selectedTab === 'all';
    const adviceModule = showAccountMgmt ? '' : buildTodayAdviceModule(a);
    const marketIndicesModule = `
      <div class="market-indices" id="market-indices">
        <div class="market-indices-head">
          <span class="eyebrow">行情</span>
        </div>
        <div class="market-indices-grid">加载中…</div>
      </div>
    `;
    root.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span class="kpi-label">当前账户总资产</span><strong class="kpi-value">${money(total)}</strong></div>
        <div class="kpi"><span class="kpi-label">昨日收益</span><strong class="kpi-value">${money(day)}</strong><span class="kpi-sub">${total ? (day / total * 100).toFixed(2) : '0.00'}%</span></div>
        <div class="kpi"><span class="kpi-label">今日收益</span><strong class="kpi-value">0.00</strong><span class="kpi-sub"><span class="estimate-state">估算</span><span>0.00%</span></span></div>
        <div class="kpi"><span class="kpi-label">持有收益</span><strong class="kpi-value">0</strong><span class="kpi-sub">0.00%</span></div>
        <div class="kpi"><span class="kpi-label">累计收益</span><strong class="kpi-value">−9,839</strong><span class="kpi-sub">−19.12%</span></div>
      </div>
      ${marketIndicesModule}
      ${adviceModule}
      ${showAccountMgmt ? `
      <section class="list-section account-section">
        <div class="section-head">
          <div><p class="eyebrow">账户管理</p><h2>选择账户</h2></div>
          <button class="primary" data-action="toggle-edit">${editing ? '完成' : '编辑'}</button>
          ${editing ? '<button class="secondary-button" data-action="add-account">新增账户</button>' : ''}
        </div>
        <div class="account-list">
          ${rootAccountsOf().map(a => {
            const synced = isSyncAccount(a);
            const effFunds = effectiveFundsOf(a);
            const effTotal = effFunds.reduce((x, f) => x + (Number(f.amount) || 0), 0);
            const effDay = effFunds.reduce((x, f) => x + (Number(f.amount) || 0) * (Number(f.today) || 0), 0);
            const children = (a.children || []).map(n => s.accounts[n]).filter(Boolean);
            return `
              <div class="account-card ${editing ? 'account-edit-row' : ''}" data-account="${esc(a.name)}">
                ${editing ? '<input type="checkbox" data-check="' + esc(a.name) + '" ' + (selected.has(a.name) ? 'checked' : '') + ' />' : ''}
                <div><b>${esc(a.name)}${synced ? ' <span class="synced-badge">同步</span>' : ''}${children.length ? ` <span class="parent-badge">${children.length} 子账户</span>` : ''}</b>
                  <small>${effFunds.length ? effFunds.length + ' 项持仓' : '暂无持仓'}</small>
                </div>
                <div><strong>${money(effTotal)}</strong><span>${money(effDay)}</span></div>
              </div>
              ${editing ? `
                <div class="account-sub-actions">
                  <button type="button" class="link-btn" data-action="add-sub-account" data-parent="${esc(a.name)}">＋ 新建子账户</button>
                  ${!synced && effFunds.length ? `<button type="button" class="link-btn" data-action="split-by-sector" data-parent="${esc(a.name)}">按板块拆分</button>` : ''}
                </div>` : ''}
              ${children.map(c => `
                <div class="sub-account-card" data-sub-account="${esc(c.name)}">
                  <div><b>${esc(c.name)}</b><small>${c.funds.length ? c.funds.length + ' 项持仓' : '暂无持仓'}</small></div>
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="text-align: right;"><strong>${money(c.funds.reduce((x, f) => x + (Number(f.amount) || 0), 0))}</strong><span>${money(c.funds.reduce((x, f) => x + (Number(f.amount) || 0) * (Number(f.today) || 0), 0))}</span></div>
                    ${editing ? `<button type="button" class="link-btn danger-link" data-action="delete-sub-account" data-child="${esc(c.name)}" data-parent="${esc(a.name)}">删除</button>` : ''}
                  </div>
                </div>
              `).join('')}
            `;
          }).join('')}
        </div>
        ${editing ? `<div class="account-delete-bar"><button class="danger-button" data-action="delete" ${!selected.size ? 'disabled' : ''}>删除所选</button><button class="secondary-button" data-action="move-accounts" ${!selected.size ? 'disabled' : ''}>移动</button></div>` : ''}
      </section>
      ` : ''}
    `;
    if (!showAccountMgmt) scheduleTodayAdviceUpdate();
    loadMarketIndices();
  }

  let marketIndicesCache = { data: null, at: 0 };
  let marketIndicesTimer = null;
  async function loadMarketIndices(force) {
    const box = document.getElementById('market-indices');
    if (!box) return;
    const grid = box.querySelector('.market-indices-grid');
    const render = (indices, ok) => {
      if (!grid) return;
      if (!ok || !indices || !indices.length) {
        grid.innerHTML = '<span style="color:#86868b;font-size:12px;">行情数据暂不可用</span>';
        return;
      }
      grid.innerHTML = indices.map(item => {
        const pct = Number(item.changePercent);
        const okItem = item.ok && Number.isFinite(pct) && Number.isFinite(Number(item.price));
        const up = pct > 0;
        const color = okItem ? (up ? '#ff3b30' : '#34a853') : '#86868b';
        const sign = okItem && up ? '+' : '';
        const price = okItem
          ? Number(item.price).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '—';
        const change = okItem ? `${sign}${pct.toFixed(2)}%` : '—';
        return `
          <div class="market-index-item">
            <span class="market-index-name">${esc(item.name)}</span>
            <strong class="market-index-price">${price}</strong>
            <span class="market-index-change" style="color:${color}">${change}</span>
          </div>`;
      }).join('');
    };
    const now = Date.now();
    if (!force && marketIndicesCache.data && now - marketIndicesCache.at < 30000) {
      render(marketIndicesCache.data, true);
    } else {
      try {
        const res = await fetch('/api/market/indices' + (force ? '?refresh=1' : ''));
        const data = await res.json();
        const indices = (data && data.indices) || [];
        marketIndicesCache = { data: indices, at: Date.now() };
        render(indices, true);
      } catch (err) {
        render(null, false);
      }
    }
    // 60 秒后自动刷新；页面已离开该模块则停止
    if (marketIndicesTimer) clearTimeout(marketIndicesTimer);
    marketIndicesTimer = setTimeout(() => {
      if (document.getElementById('market-indices')) loadMarketIndices();
    }, 60000);
  }

  window.refreshMarketIndices = function () { return loadMarketIndices(true); };

  function portfolio(){
    title.textContent = s.getActive();
    const a = acct() || { name: '', funds: [], strategy: [], closedPositions: [] };
    const funds = effectiveFundsOf(a);
    const totalAssets = funds.reduce((x, f) => x + (Number(f.amount) || 0), 0);
    const totalProfit = funds.reduce((x, f) => x + (Number(f.holdingProfit ?? f.profit) || 0), 0);
    const totalToday = funds.reduce((x, f) => x + (Number(f.amount) || 0) * (Number(f.today) || 0), 0);
    const profitRate = (totalAssets - totalProfit) > 0 ? totalProfit / (totalAssets - totalProfit) : 0;
    // 子账户 tab：父账户显示其子账户；子账户显示父账户下的兄弟子账户 + 返回父账户
    const parentAccount = a.parent ? s.accounts[a.parent] : null;
    const tabOwner = parentAccount || a;
    const childTabs = (tabOwner.children || []).map(n => s.accounts[n]).filter(Boolean);
    let subTabsHtml = '';
    if (childTabs.length) {
      const backChip = parentAccount
        ? `<button type="button" class="sub-tab parent-tab" data-parent-tab="${esc(parentAccount.name)}">← ${esc(parentAccount.name)}</button>`
        : '';
      subTabsHtml = `
        <div class="sub-account-tabs">
          <span class="sub-account-tabs-label">子账户</span>
          ${backChip}
          ${childTabs.map(c => `
            <button type="button" class="sub-tab ${c.name === a.name ? 'active' : ''}" data-sub-tab="${esc(c.name)}">${esc(c.name)}</button>
          `).join('')}
        </div>`;
    }
    root.innerHTML = `
      <section class="list-section">
        <div class="section-head">
          <div><p class="eyebrow holdings-count"><span class="desktop-label">持仓 / ${funds.length} 项</span><span class="mobile-label">${funds.length} 项</span></p><h2 class="holdings-title">持仓列表</h2></div>
          <div class="section-head-actions">
            <button class="secondary-button column-customizer-btn" data-action="customize-columns"><span class="desktop-label">自定义表头</span><span class="mobile-label">自定义</span></button>
            ${a.parent ? `<button class="secondary-button add-from-parent-btn" data-action="add-from-parent" title="从父账户添加基金">＋ 父账户基金</button>` : ''}
            <button class="primary add-fund-button" data-action="add-fund">增加基金</button>
          </div>
        </div>
        ${childTabs.length ? `
        <div class="account-totals-row">
          <span>总资产 <b>${money(totalAssets)}</b></span>
          <span>持有收益 <b class="${totalProfit >= 0 ? 'positive' : 'negative'}">${money(totalProfit)}</b></span>
          <span>今日收益 <b class="${totalToday >= 0 ? 'positive' : 'negative'}">${money(totalToday)}</b></span>
          <span>收益率 <b class="${totalProfit >= 0 ? 'positive' : 'negative'}">${(profitRate * 100).toFixed(2)}%</b></span>
        </div>
        ` : ''}
        ${subTabsHtml}
        <div class="holding-head">
          <span data-col-key="fund">基金</span>
          <span data-col-key="holdingProfit"><span class="desktop-label">持有收益</span><span class="mobile-label">持有</span></span>
          <span data-col-key="todayProfit"><span class="desktop-label">今日收益</span><span class="mobile-label">今日</span></span>
          <span data-col-key="amount"><span class="desktop-label">持有金额</span><span class="mobile-label">金额</span></span>
        </div>
        <div class="fund-list">
          ${funds.map(f => `
            <button class="fund-row" data-code="${f.code}" title="${esc(f.name)}">
              <div class="fund-info" data-col-key="fund"><b title="${esc(f.name)}">${esc(f.name)}</b><small class="fund-meta"><span class="fund-code-text">${f.code}</span><span class="fund-meta-sep"> · </span><span class="fund-sector-text">${esc(f.category)}</span>${f.subAccount ? `<span class="fund-meta-sep"> · </span><span class="fund-sub-tag">${esc(f.subAccount)}</span>` : ''}</small></div>
              <div class="fund-est" data-col-key="holdingProfit"><strong>${(f.amount * f.hold > 0 ? '+' : '')}${money2(f.amount * f.hold)}</strong><span>${(f.hold > 0 ? '+' : '')}${((f.hold * 100).toFixed(2))}%</span></div>
              <div class="fund-today" data-col-key="todayProfit"><strong>${money2(f.amount * f.today)}</strong><span>${((f.today * 100).toFixed(2))}%</span></div>
              <div class="fund-amount" data-col-key="amount"><strong>${money2(f.amount)}</strong><span>${((((Number.isFinite(f.holdingRate) ? f.holdingRate : f.hold) || 0) * 100).toFixed(2))}%</span></div>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }
  function analysis(){
    title.textContent = '';
    const a = acct() || { name: '', funds: [], strategy: [], closedPositions: [] };
    const report = buildDecisionReport(a);
    const {
      funds,
      strategyList,
      closedPositions,
      allocations,
      totalAssets,
      healthScore,
      healthText,
      healthColor,
      deviationText,
      riskScore,
      riskLevel,
      rebalanceSuggestion,
      summary,
      rows
    } = report;
    const aiResult = report.aiResult;

    const activeAccountName = a.name || '默认账户';
    let cachedTime = localStorage.getItem('LAST_AI_ANALYSIS_TIME_' + activeAccountName) || '';
    let cachedModel = localStorage.getItem('LAST_AI_ANALYSIS_MODEL_' + activeAccountName) || '';
    if (!cachedTime) cachedTime = window.lastAnalysisTime || '';
    if (!cachedModel) cachedModel = localStorage.getItem('AI_MODEL_NAME') || '';


    let allocHtml = '';
    if (allocations.length > 0) {
      allocHtml = allocations.map(item => `
        <div class="allocation-item" style="margin-bottom: 22px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px;">
            <span style="font-weight: 500; color: #1d1d1f;">${esc(item.category)}</span>
            <span style="color: #6e6e73; font-weight: 500;">${item.amountStr} (${item.pctStr})</span>
          </div>
          <div style="height: 6px; background: rgba(0,0,0,0.06); border-radius: 999px; overflow: hidden;">
            <div style="width: ${item.pct}%; height: 100%; background: ${item.color}; border-radius: 999px;"></div>
          </div>
        </div>
      `).join('');
    } else {
      allocHtml = `
        <div class="empty-state" style="padding: 40px 10px; color: #86868b; text-align: center;">
          <span style="font-size: 32px; display: block; margin-bottom: 12px;">📊</span>
          <span>当前账户无持仓，无法生成配置比例</span>
        </div>
      `;
    }

    let strategyHtml = '';
    if (strategyList.length > 0) {
      strategyHtml = `
        <div class="strategy-list" style="display: flex; flex-direction: column; gap: 14px;">
          ${strategyList.map((st, idx) => `
            <div class="strategy-bullet" style="display: flex; align-items: flex-start; gap: 12px; font-size: 14px; line-height: 1.5; color: #1d1d1f;">
              <span style="display: inline-block; width: 6px; height: 6px; background: #0071e3; border-radius: 50%; margin-top: 8px; flex-shrink: 0;"></span>
              <span>${esc(st)}</span>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      strategyHtml = `
        <div class="empty-state" style="padding: 40px 10px; color: #86868b; text-align: center;">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display: block; margin: 0 auto 12px auto;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          <span>未设立投资策略方针。可在设置中增加策略细则</span>
        </div>
      `;
    }



    root.innerHTML = `
      <section class="analysis-page" style="width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;">
        <!-- Injected Custom Styles for Animation and Responsiveness -->
        <style>
          @keyframes rotate {
            100% { transform: rotate(360deg); }
          }
          .analysis-page {
            width: 100% !important;
          }
          .analysis-layout-grid {
            display: grid;
            grid-template-columns: 1.5fr 1fr;
            gap: 28px;
            align-items: start;
            width: 100%;
          }
          @media (max-width: 1024px) {
            .analysis-layout-grid {
              grid-template-columns: 1fr;
              gap: 24px;
            }
          }
          @media (max-width: 720px) {
            .analysis-table-wrapper {
              display: none !important;
            }
            .analysis-cards {
              display: flex !important;
            }
          }

          /* Tooltip Details Reset & Styling */
          details.tooltip-details summary::-webkit-details-marker {
            display: none !important;
          }
          details.tooltip-details summary::marker {
            content: "" !important;
            display: none !important;
          }
          details.tooltip-details summary {
            list-style: none !important;
          }
          details.tooltip-details summary:hover {
            background: #0071e3 !important;
            color: #ffffff !important;
            transform: scale(1.08);
          }
          details.tooltip-details[open] summary {
            background: #0071e3 !important;
            color: #ffffff !important;
          }
        </style>

        <!-- AI建议 Panel (Full-width, and "今日预估组合收益" removed) -->
        <div class="panel" style="padding: 28px; border-radius: 18px; display: flex; flex-direction: column; gap: 24px; background: linear-gradient(135deg, #ffffff 0%, #f9f9fb 100%); border: 1px solid rgba(0,0,0,0.04); box-sizing: border-box; width: 100%; margin-bottom: 28px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; margin: 4px 0 6px 0;">
              <h2 style="font-size: 24px; font-weight: 700; color: #1d1d1f; margin: 0;">AI建议</h2>
            </div>
          </div>

          <!-- AI Q&A Window (Moved below subtitle) -->
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 13.5px; font-weight: 600; color: #1d1d1f; display: inline-flex; align-items: center; gap: 4px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>智能 AI 交互问答与调仓重构
              </span>
              <details class="tooltip-details" style="position: relative; display: inline-block;">
                <summary style="list-style: none; outline: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(0, 113, 227, 0.08); color: #0071e3; font-size: 11px; font-weight: 700; border: none; user-select: none; transition: all 0.2s;">
                  ?
                </summary>
                <div class="tooltip-bubble" style="position: absolute; left: 0; top: 24px; z-index: 1000; width: 320px; padding: 14px 18px; border-radius: 12px; background: #ffffff; color: #1d1d1f; box-shadow: 0 8px 32px rgba(0,0,0,0.12); border: 1px solid rgba(0,0,0,0.06); font-size: 13px; line-height: 1.6; font-weight: normal; text-align: left; white-space: normal;">
                  <div style="position: absolute; top: -6px; left: 12px; transform: rotate(45deg); width: 10px; height: 10px; background: #ffffff; border-left: 1px solid rgba(0,0,0,0.06); border-top: 1px solid rgba(0,0,0,0.06);"></div>
                  您可以针对当前投资组合进行提问。例如：“如果我想在下半年降低风险，应当怎么做？”、“增加1万黄金 and 减持一半新能源基金后，配比如何变化？”。AI 将根据提问实时重构诊断总结 and 具体基金建议。
                </div>
              </details>
            </div>
            <div style="display: flex; gap: 10px; align-items: center; width: 100%; flex-wrap: wrap;">
              ${window.innerWidth <= 760 ? `
              <textarea id="ai-question-input" rows="2" placeholder="向 AI 提问，或输入调仓指令，如：大成产业趋势混合C 减仓一半" style="flex: 1 1 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); font-size: 13px; line-height: 1.5; outline: none; transition: border-color 0.2s; resize: none; font-family: inherit; box-sizing: border-box; min-height: 46px;">${esc(window.lastAIUserQuestion || '')}</textarea>` : `
              <input type="text" id="ai-question-input" value="${esc(window.lastAIUserQuestion || '')}" placeholder="向 AI 提问，或直接输入调仓指令（如：大成产业趋势混合C 昨天减仓一半）..." style="flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); font-size: 13px; outline: none; transition: border-color 0.2s;" />`}
              <div class="ai-ask-actions" style="display: flex; gap: 10px; align-items: center;">
                <button id="ai-trade-btn" class="primary" style="padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; background: #34a853; color: #fff; border: 0; cursor: pointer; transition: all 0.2s; white-space: nowrap;">调仓</button>
                <button id="ai-ask-submit-btn" class="primary" style="padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; background: #0071e3; color: #fff; border: 0; cursor: pointer; transition: all 0.2s; white-space: nowrap;">提问</button>
                <button id="run-ai-analysis-btn" class="primary" style="padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; background: #0071e3; color: #fff; border: 0; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 12px rgba(0,113,227,0.15); white-space: nowrap;">
                  <span class="btn-text">诊断</span>
                </button>
              </div>
            </div>
            ${window.lastAIUserQuestion ? `
              <div style="background: rgba(0, 113, 227, 0.03); border: 1px dashed rgba(0, 113, 227, 0.25); padding: 10px 14px; border-radius: 8px; font-size: 12.5px; color: #0071e3; display: flex; justify-content: space-between; align-items: center;">
                <div style="line-height: 1.4;">
                  <strong>当前提问：</strong>"${esc(window.lastAIUserQuestion)}"
                </div>
                <button id="clear-ai-question-btn" style="background: none; border: none; color: #ff3b30; cursor: pointer; font-size: 12px; font-weight: 500; text-decoration: underline; padding: 0; margin-left: 12px; white-space: nowrap;">恢复默认诊断</button>
              </div>
            ` : ''}
          </div>

          <!-- AI 问答回答窗口 -->
          <div id="ai-answer-window" style="display: none; background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 14px 16px; font-size: 13px; color: #1d1d1f; line-height: 1.7; box-shadow: 0 2px 10px rgba(0,0,0,0.03); white-space: pre-wrap; word-break: break-word;"></div>

          ${summary ? `
          <div style="background: rgba(0, 113, 227, 0.03); border-left: 4px solid #0071e3; padding: 14px 18px; border-radius: 8px; font-size: 13.5px; color: #1d1d1f; line-height: 1.6; margin-top: 12px;">
            <strong>今日操作建议的总结：</strong>${esc(summary)}
          </div>
          ` : ''}

          <!-- Analysis Results KPI Stats -->
          ${totalAssets > 0 ? `
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
            <!-- 合并：组合配比健康度 + 风险评分 -->
            <div style="background: rgba(0,0,0,0.02); padding: 16px 20px; border-radius: 12px; display: flex; flex-direction: column;">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
                  <span style="font-size: 11px; color: #86868b; font-weight: 500;">组合配比健康度</span>
                  <strong style="font-size: clamp(30px, 6vw, 50px); line-height: 1.05; color: #1d1d1f; font-weight: 500; letter-spacing: -0.03em;">${healthScore}分</strong>
                  <span style="font-size: 13px; font-weight: 600; color: ${healthColor}; margin-top: 2px;">${healthText}</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; border-left: 1px solid rgba(0,0,0,0.06); padding-left: 16px;">
                  <span style="font-size: 11px; color: #86868b; font-weight: 500;">风险评分</span>
                  <strong style="font-size: clamp(30px, 6vw, 50px); line-height: 1.05; color: #1d1d1f; font-weight: 500; letter-spacing: -0.03em;">${riskScore}分</strong>
                  <span style="font-size: 13px; font-weight: 600; color: ${riskScore >= 70 ? '#ff3b30' : riskScore >= 40 ? '#ff9500' : '#34a853'}; margin-top: 2px;">${riskLevel}风险</span>
                </div>
              </div>
              <div style="margin-top: auto; padding-top: 16px; border-top: 1px dashed rgba(0,0,0,0.06); font-size: 11px; color: #86868b; display: flex; align-items: center; gap: 12px;">
                <span>模型: <b style="color: #34a853; font-weight: 500;">${esc(cachedModel || '—')}</b></span>
                <span>时间: <b style="color: #34a853; font-weight: 500;">${esc(cachedTime || '—')}</b></span>
              </div>
            </div>
            <!-- 持仓分析 + 如何组合配比降低风险 -->
            <div style="background: rgba(0,0,0,0.02); padding: 16px 20px; border-radius: 12px; display: flex; flex-direction: column; gap: 6px;">
              <span style="font-size: 11px; color: #86868b; font-weight: 500;">持仓分析</span>
              <strong style="font-size: 13.5px; color: #1d1d1f; font-weight: 700; min-height: 32px; display: flex; align-items: center; line-height: 1.5;">${deviationText}</strong>
              <div style="border-top: 1px dashed rgba(0,0,0,0.06); padding-top: 8px; margin-top: 4px;">
                <span style="font-size: 11px; color: #86868b; font-weight: 500; display: block; margin-bottom: 4px;">如何组合配比降低风险</span>
                <span style="font-size: 12px; color: #6e6e73; line-height: 1.55; display: block;">${rebalanceSuggestion}</span>
              </div>
            </div>
          </div>
          ` : ''}

        </div>

        <!-- Today's Operations and Recommendations Panel (Full Width Sibling) -->
        <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%; margin-bottom: 28px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 24px; margin-top: 6px;">
            <h2 style="font-size: 21px; font-weight: 650; margin: 0;">今日具体基金操作建议</h2>
          </div>

          ${funds.length === 0 ? `
            <div style="padding: 40px 10px; text-align: center; color: #86868b;">
              <span style="font-size: 32px; display: block; margin-bottom: 12px;">📈</span>
              <span>当前暂无任何持仓基金。请在“持仓列表”中添加您的第一支基金，即可获得今日诊断及操作建议！</span>
            </div>
          ` : `
            <!-- Desktop Table View -->
            <div class="analysis-table-wrapper" style="width: 100%; overflow-x: auto;">
              <table class="analysis-table" style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
                <thead>
                  <tr style="border-bottom: 1.5px solid rgba(0,0,0,0.08); color: #86868b; font-weight: 500; font-size: 12px; letter-spacing: 0.03em;">
                    <th style="padding: 12px 16px; font-weight: 600; text-align: left; width: 20%;">基金名称 & 代码</th>
                    <th style="padding: 12px 16px; font-weight: 600; text-align: left; width: 15%;">目前仓位 (占比)</th>
                    <th style="padding: 12px 16px; font-weight: 600; text-align: left; width: 12%;">今日估算涨幅</th>
                    <th style="padding: 12px 16px; font-weight: 600; text-align: left; width: 20%;">操作建议</th>
                    <th style="padding: 12px 16px; font-weight: 600; text-align: left; width: 33%;">评估理由</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(row => {
                    const { name: fundName, code: fundCode, cat, amount: fundAmount, currentPct, todayRate, isTodayPositive, adviceText, adviceColor, adviceBg, adviceReason } = row;
                    return `
                      <tr style="border-bottom: 1px solid rgba(0,0,0,0.05); transition: background 0.15s;">
                        <td style="padding: 16px; vertical-align: middle;">
                          <div style="font-weight: 600; color: #1d1d1f;">${esc(fundName)}</div>
                          <div style="font-size: 11px; color: #86868b; font-family: monospace; margin-top: 2px;">${fundCode} · ${esc(cat)}</div>
                        </td>
                        <td style="padding: 16px; vertical-align: middle;">
                          <div style="font-weight: 600; color: #1d1d1f;">${money(fundAmount)}</div>
                          <div style="font-size: 12px; color: #6e6e73; margin-top: 2px;">${currentPct.toFixed(2)}%</div>
                        </td>
                        <td style="padding: 16px; vertical-align: middle;">
                          <span class="est-badge ${isTodayPositive ? 'positive' : 'negative'}" style="display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; color: ${isTodayPositive ? '#ff3b30' : '#34a853'}; background: ${isTodayPositive ? 'rgba(255, 59, 48, 0.06)' : 'rgba(52, 168, 83, 0.06)'};">
                            ${isTodayPositive ? '+' : ''}${todayRate.toFixed(2)}%
                          </span>
                        </td>
                        <td style="padding: 16px; vertical-align: middle;">
                          <span style="display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 12.5px; font-weight: 600; color: ${adviceColor}; background: ${adviceBg}; white-space: nowrap;">
                            ${esc(adviceText)}
                          </span>
                        </td>
                        <td style="padding: 16px; vertical-align: middle; color: #6e6e73; font-size: 13px; line-height: 1.4;">
                          ${esc(adviceReason)}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>

            <!-- Mobile Cards View (Hidden on desktop, visible on mobile) -->
            <div class="analysis-cards" style="display: none; flex-direction: column; gap: 16px;">
              ${rows.map(row => {
                const { name: fundName, code: fundCode, cat, amount: fundAmount, currentPct, todayRate, isTodayPositive, adviceText, adviceColor, adviceBg, adviceReason } = row;
                return `
                  <div style="background: #f5f5f7; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; border: 1px solid rgba(0,0,0,0.03);">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                      <div>
                        <b style="font-size: 14.5px; color: #1d1d1f; display: block; line-height: 1.3;">${esc(fundName)}</b>
                        <span style="font-size: 11px; color: #86868b; font-family: monospace;">${fundCode} · ${esc(cat)}</span>
                      </div>
                      <span style="display: inline-block; padding: 5px 10px; border-radius: 14px; font-size: 11.5px; font-weight: 600; color: ${adviceColor}; background: ${adviceBg}; white-space: nowrap;">
                        ${esc(adviceText)}
                      </span>
                    </div>

                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 12px; text-align: left;">
                      <div>
                        <span style="font-size: 10px; color: #86868b; display: block; margin-bottom: 2px;">目前持仓</span>
                        <strong style="font-size: 12.5px; color: #1d1d1f; display: block;">${money(fundAmount)}</strong>
                        <span style="font-size: 11px; color: #6e6e73;">${currentPct.toFixed(1)}%</span>
                      </div>
                      <div>
                        <span style="font-size: 10px; color: #86868b; display: block; margin-bottom: 2px;">今日估值</span>
                        <span style="font-size: 12.5px; font-weight: 600; color: ${isTodayPositive ? '#ff3b30' : '#34a853'}; display: block;">
                          ${isTodayPositive ? '+' : ''}${todayRate.toFixed(2)}%
                        </span>
                      </div>
                    </div>

                    <div style="background: rgba(0,0,0,0.015); padding: 8px 10px; border-radius: 6px; font-size: 11.5px; color: #6e6e73; line-height: 1.4; border-left: 3px solid ${adviceColor};">
                      <strong>评估理由：</strong>${esc(adviceReason)}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>

        <!-- Bottom Grid: Asset Allocation and Investment Strategy (Moved to Bottom) -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 28px; margin-top: 28px; width: 100%;">
          <!-- Allocation Analysis -->
          <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
            <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">资产配比分析</h2>
            <p style="font-size: 13px; color: #86868b; margin-bottom: 24px; margin-top: 0;">当前账户下的细分大类资产构成比例</p>
            ${allocHtml}
          </div>

          <!-- Operating Strategy -->
          <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
            <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">投资操作策略</h2>
            <p style="font-size: 13px; color: #86868b; margin-bottom: 24px; margin-top: 0;">指导当前账户投资纪律的核心方针</p>
            ${strategyHtml}
          </div>
        </div>

        ${closedPositions.length ? `
        <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%; margin-top: 28px;">
          <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">已清仓记录</h2>
          <div class="closed-list">
            ${closedPositions.map(c => `
              <div class="closed-row">
                <span>${esc(c.name)} <small>(${esc(c.code)})</small></span>
                <b>${money(Number(c.amount) || 0)}</b>
                <em>${esc(c.closedBefore || '')} · ${esc(c.reason || '清仓')}</em>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
      </section>
    `;
  }

  // ─────────────────────────────────────────────
  // 第三方基金同步（养基宝 / 小倍养基）
  // ─────────────────────────────────────────────
  let providerStatusCache = { yangjibao: null, xiaobeiyangji: null };
  let providerQrTimer = null;

  function providerApi(path, options) {
    const headers = Object.assign({}, (options && options.headers) || {}, window.auth && window.auth.authHeaders ? window.auth.authHeaders() : {});
    return fetch(path, Object.assign({}, options, { headers })).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  // ─────────────────────────────────────────────
  // Apple 风格提示 / 弹窗
  // ─────────────────────────────────────────────
  function showToast(message, type = 'success') {
    const old = document.querySelector('.apple-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'apple-toast';
    toast.setAttribute('role', 'status');
    const icon = type === 'error' ? '!' : type === 'warning' ? '⚠' : '✓';
    toast.innerHTML = `<span class="apple-toast-icon">${icon}</span><span>${esc(message)}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 260);
    }, 2800);
  }

  function showAppleDialog({ title, message = '', okText = '确定', cancelText = '取消', danger = false }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay apple-dialog-overlay';
      overlay.innerHTML = `
        <div class="confirm-dialog apple-dialog" role="alertdialog" aria-modal="true">
          <h2>${esc(title)}</h2>
          ${message ? `<p class="apple-dialog-message">${esc(message)}</p>` : ''}
          <div class="confirm-actions apple-dialog-actions">
            ${cancelText ? `<button type="button" class="apple-dialog-cancel" data-role="cancel">${esc(cancelText)}</button>` : ''}
            <button type="button" class="${danger ? 'apple-dialog-danger' : 'primary'}" data-role="ok">${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const close = result => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-role="cancel"]')) close(false);
        else if (e.target.closest('[data-role="ok"]')) close(true);
      });
    });
  }
  window.showAppleDialog = showAppleDialog;

  function showAppleInputDialog({ title, message = '', placeholder = '', okText = '确定', cancelText = '取消' }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay apple-dialog-overlay';
      overlay.innerHTML = `
        <div class="confirm-dialog apple-dialog" role="dialog" aria-modal="true">
          <h2>${esc(title)}</h2>
          ${message ? `<p class="apple-dialog-message">${esc(message)}</p>` : ''}
          <input class="apple-dialog-input" placeholder="${esc(placeholder)}" value="" autocomplete="off" />
          <div class="confirm-actions apple-dialog-actions">
            <button type="button" class="apple-dialog-cancel" data-role="cancel">${esc(cancelText)}</button>
            <button type="button" class="primary" data-role="ok">${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const input = overlay.querySelector('.apple-dialog-input');
      input.focus();
      const close = result => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      };
      const submit = () => {
        const value = input.value.trim();
        if (!value) return;
        close(value);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-role="cancel"]')) close(null);
        else if (e.target.closest('[data-role="ok"]')) submit();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') close(null);
      });
    });
  }

  function showMoveAccountsDialog(sources, targetOptions) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay apple-dialog-overlay';
      overlay.innerHTML = `
        <div class="confirm-dialog apple-dialog" role="dialog" aria-modal="true">
          <h2>移动账户</h2>
          <p class="apple-dialog-message">将「${esc(sources.join('、'))}」的持仓移动到目标账户。</p>
          <label style="display: block; margin-top: 16px; font-size: 12px; color: #6e6e73;">目标账户</label>
          <select class="apple-dialog-input" style="width: 100%; margin-top: 6px;">
            ${targetOptions.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
          </select>
          <label style="display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 13px; color: #1d1d1f; cursor: pointer;">
            <input type="checkbox" id="move-keep-account" /> 移动后保留该账户（复制持仓到目标账户，原账户及持仓保留）
          </label>
          <div class="confirm-actions apple-dialog-actions">
            <button type="button" class="apple-dialog-cancel" data-role="cancel">取消</button>
            <button type="button" class="primary" data-role="ok">移动</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const close = result => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-role="cancel"]')) close(null);
        else if (e.target.closest('[data-role="ok"]')) {
          close({
            target: overlay.querySelector('select').value,
            keep: overlay.querySelector('#move-keep-account').checked
          });
        }
      });
      overlay.querySelector('select').focus();
    });
  }

  function showAddFromParentDialog(parentFunds, parentName) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay apple-dialog-overlay';
      overlay.innerHTML = `
        <div class="confirm-dialog apple-dialog" role="dialog" aria-modal="true">
          <h2>从父账户添加基金</h2>
          <p class="apple-dialog-message">选择「${esc(parentName)}」中的基金添加到当前子账户。</p>
          <div class="parent-fund-picker">
            ${parentFunds.length ? parentFunds.map(f => `
              <label class="parent-fund-item">
                <input type="checkbox" value="${esc(f.code)}" />
                <span><b>${esc(f.name)}</b><small>${f.code} · ${money(Number(f.amount) || 0)}</small></span>
              </label>`).join('') : '<div style="color:#86868b;font-size:13px;">父账户暂无持仓</div>'}
          </div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#1d1d1f;cursor:pointer;">
            <input type="checkbox" id="add-keep-parent" /> 父账户保留该基金（复制，不移出）
          </label>
          <div class="confirm-actions apple-dialog-actions">
            <button type="button" class="apple-dialog-cancel" data-role="cancel">取消</button>
            <button type="button" class="primary" data-role="ok">添加</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const close = result => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-role="cancel"]')) close(null);
        else if (e.target.closest('[data-role="ok"]')) {
          const codes = Array.from(overlay.querySelectorAll('.parent-fund-item input:checked')).map(i => i.value);
          if (!codes.length) return;
          close({ codes, copy: overlay.querySelector('#add-keep-parent').checked });
        }
      });
    });
  }

  async function refreshProviderStatus() {
    const [yjb, xbyj] = await Promise.all([
      providerApi('/api/provider/yangjibao/status').catch(() => null),
      providerApi('/api/provider/xiaobeiyangji/status').catch(() => null)
    ]);
    providerStatusCache.yangjibao = yjb;
    providerStatusCache.xiaobeiyangji = xbyj;
  }

  // 同步账户权威数据：从服务端加载并合并进本地状态（标记 accountType=sync，不持久化到 localStorage）
  async function refreshSyncedAccounts() {
    try {
      const data = await providerApi('/api/portfolio/accounts');
      const serverAccounts = data.accounts || [];
      const serverNames = new Set(serverAccounts.map(a => a.name));
      Object.keys(s.accounts).forEach(name => {
        const account = s.accounts[name];
        if (account && isSyncAccount(account) && !serverNames.has(name)) delete s.accounts[name];
      });
      serverAccounts.forEach(acc => {
        acc.accountType = 'sync';
        acc.syncSource = acc.source_name || 'sync';
        delete acc.__source;
        s.accounts[acc.name] = acc;
      });
      // 若当前活动账户已不存在（例如默认账户被删除），回退到第一个可用账户
      if (!s.accounts[s.getActive()]) {
        const first = Object.keys(s.accounts)[0];
        s.setActive(first || '');
      }
      return serverAccounts;
    } catch (e) {
      return [];
    }
  }

  function applyProviderStatus() {
    const yjb = providerStatusCache.yangjibao;
    const yjbConnected = Boolean(yjb && yjb.logged_in);
    const yjbStatus = document.querySelector('#yjb-status-text');
    if (yjbStatus) yjbStatus.textContent = yjbConnected ? '已连接' : '未登录';
    const yjbLoginArea = document.querySelector('#yjb-login-area');
    const yjbConnectedArea = document.querySelector('#yjb-connected-area');
    if (yjbLoginArea) yjbLoginArea.style.display = yjbConnected ? 'none' : 'block';
    if (yjbConnectedArea) {
      yjbConnectedArea.style.display = yjbConnected ? 'block' : 'none';
      const last = yjbConnectedArea.querySelector('#yjb-last-sync');
      if (last) last.textContent = yjb && yjb.last_sync_at ? String(yjb.last_sync_at).replace('T', ' ').slice(0, 19) : '—';
    }

    const xbyj = providerStatusCache.xiaobeiyangji;
    const xbyjConnected = Boolean(xbyj && xbyj.logged_in);
    const xbyjStatus = document.querySelector('#xbyj-status-text');
    if (xbyjStatus) xbyjStatus.textContent = xbyjConnected ? '已连接' : '未登录';
    const xbyjLoginArea = document.querySelector('#xbyj-login-area');
    const xbyjConnectedArea = document.querySelector('#xbyj-connected-area');
    if (xbyjLoginArea) xbyjLoginArea.style.display = xbyjConnected ? 'none' : 'block';
    if (xbyjConnectedArea) {
      xbyjConnectedArea.style.display = xbyjConnected ? 'block' : 'none';
      const last = xbyjConnectedArea.querySelector('#xbyj-last-sync');
      if (last) last.textContent = xbyj && xbyj.last_sync_at ? String(xbyj.last_sync_at).replace('T', ' ').slice(0, 19) : '—';
    }
  }

  function runProviderImport(sourceName, overwrite) {
    const names = { yangjibao: '养基宝', xiaobeiyangji: '小倍养基' };
    return providerApi(`/api/provider/${sourceName}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwrite: Boolean(overwrite) })
    }).then(async data => {
      const accountCount = (data.accounts || []).length;
      const fundCount = (data.accounts || []).reduce((sum, a) => sum + (a.funds || []).length, 0);
      await refreshProviderStatus().catch(() => {});
      await refreshSyncedAccounts();
      if (view === 'portfolio' || view === 'overview') render(view);
      showToast(`同步完成：成功导入 ${fundCount} 个基金、${accountCount} 个账户`);
      const runAi = await showAppleDialog({
        title: '同步完成',
        message: `成功导入 ${fundCount} 个基金、${accountCount} 个账户。是否立即进行 AI 分析，生成今日投资报告？`,
        okText: '立即分析',
        cancelText: '稍后再说'
      });
      if (runAi) {
        runAiDiagnostics('');
      }
      return { accountCount, fundCount };
    }).catch(err => {
      if (err.data && err.data.token_expired) {
        showToast('登录已过期，请重新登录后再次同步', 'warning');
      } else {
        showToast(`同步失败：${err.message || '网络错误'}`, 'error');
      }
      refreshProviderStatus().then(() => { if (view === 'setting') applyProviderStatus(); }).catch(() => {});
      throw err;
    });
  }

  // AI 问答回答窗口：根据上方提问生成答案（输入“复盘”触发复盘分析）
  function askAiQuestion(question) {
    const a = acct();
    const answerBox = document.querySelector('#ai-answer-window');
    if (!answerBox) return;
    answerBox.style.display = 'block';
    answerBox.textContent = 'AI 正在思考，请稍候…';

    const holdings = effectiveFundsOf(a).map(f => ({
      name: f.name,
      code: f.code,
      amount: Number(f.amount) || 0,
      profit: Number(f.holdingProfit ?? f.profit) || 0,
      today_change: Number((f.today || 0) * (Number(f.amount) || 0)) || 0
    }));
    const portfolio = { account: a.name || '默认账户', strategies: a.strategy || [], holdings };
    const isReview = /复盘/.test(question);

    (async () => {
      try {
        let prompt;
        if (isReview) {
          let closedNote = '复盘分析';
          try {
            const market = await providerApi('/api/market/status');
            closedNote = market && market.trading_day && (market.time || '') >= '15:00'
              ? '今日已收盘'
              : '今日尚未收盘（当前为盘中数据，以下为盘中复盘）';
          } catch (e) { /* 默认提示 */ }
          prompt = `${closedNote}。请对以下基金组合进行复盘分析，包括：今日行情与持仓表现回顾、主要涨跌原因、明日关注要点、投资纪律执行情况与后续操作建议。\n组合数据：\n${JSON.stringify(portfolio, null, 2)}\n`;
        } else {
          prompt = `请基于以下基金组合数据回答用户问题，回答尽量具体、给出操作建议。\n组合数据：\n${JSON.stringify(portfolio, null, 2)}\n用户问题：${question}`;
        }
        const aiProvider = localStorage.getItem('AI_PROVIDER') || 'OpenAI';
        const aiBaseURL = localStorage.getItem('AI_BASE_URL') || '';
        const aiModelName = localStorage.getItem('AI_MODEL_NAME') || 'gpt-5-mini';
        const aiAPIKey = window.AI_API_KEY || '';
        const data = await providerApi('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: prompt,
            config: { provider: aiProvider, baseURL: aiBaseURL, model: aiModelName, apiKey: aiAPIKey }
          })
        });
        // 诊断流程可能已重新渲染页面，写入时重新获取窗口元素
        const freshBox = document.querySelector('#ai-answer-window');
        if (freshBox) {
          freshBox.style.display = 'block';
          freshBox.textContent = data.reply || 'AI 未返回有效回答';
        }
      } catch (err) {
        const freshBox = document.querySelector('#ai-answer-window');
        if (freshBox) {
          freshBox.style.display = 'block';
          freshBox.textContent = `回答生成失败：${err.message || '网络错误'}`;
        }
      }
    })();
  }

  function showProviderQRModal(sourceName) {
    const names = { yangjibao: '养基宝', xiaobeiyangji: '小倍养基' };
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay provider-qr-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" style="text-align: center; max-width: 360px;">
        <h2>${names[sourceName] || sourceName}扫码登录</h2>
        <div id="provider-qr-image" style="margin: 18px auto; width: 240px; height: 240px; display: grid; place-items: center; color: #86868b; font-size: 13px;">正在获取二维码…</div>
        <p id="provider-qr-status" style="color: #86868b; font-size: 12px; margin: 0 0 14px 0;">请使用微信扫描二维码完成登录</p>
        <div class="confirm-actions"><button type="button" data-close>取消</button></div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const close = () => {
      if (providerQrTimer) { clearInterval(providerQrTimer); providerQrTimer = null; }
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-close]')) close();
    });

    providerApi(`/api/provider/${sourceName}/qrcode`, { method: 'POST' }).then(qr => {
      const box = overlay.querySelector('#provider-qr-image');
      const img = document.createElement('img');
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qr.qr_url)}`;
      img.width = 240;
      img.height = 240;
      img.alt = '登录二维码';
      img.style.borderRadius = '8px';
      box.innerHTML = '';
      box.appendChild(img);

      const started = Date.now();
      providerQrTimer = setInterval(async () => {
        if (Date.now() - started > 90000) {
          clearInterval(providerQrTimer); providerQrTimer = null;
          const status = overlay.querySelector('#provider-qr-status');
          if (status) status.textContent = '二维码已过期，请重新获取';
          return;
        }
        try {
          const st = await providerApi(`/api/provider/${sourceName}/status?qr_id=${encodeURIComponent(qr.qr_id)}`);
          if (st.state === 'confirmed') {
            clearInterval(providerQrTimer); providerQrTimer = null;
            const status = overlay.querySelector('#provider-qr-status');
            if (status) status.textContent = '登录成功';
            setTimeout(() => {
              close();
              refreshProviderStatus().then(() => { if (view === 'setting') applyProviderStatus(); }).catch(() => {});
              showToast(`${names[sourceName] || sourceName}登录成功`);
            }, 500);
          } else if (st.state === 'expired') {
            clearInterval(providerQrTimer); providerQrTimer = null;
            const status = overlay.querySelector('#provider-qr-status');
            if (status) status.textContent = '二维码已过期，请重新获取';
          }
        } catch (e) { /* 网络波动继续轮询 */ }
      }, 2000);
    }).catch(() => {
      const box = overlay.querySelector('#provider-qr-image');
      if (box) box.textContent = '获取二维码失败，请重试';
    });
  }

  function setting(){
    title.textContent = '';
    const a = acct();
    const strategyList = a.strategy || [];

    const savedProvider = localStorage.getItem('AI_PROVIDER') || 'OpenAI';
    const savedBaseURL = localStorage.getItem('AI_BASE_URL') || '';
    const savedModelName = localStorage.getItem('AI_MODEL_NAME') || 'gpt-5-mini';
    const savedAPIKey = window.AI_API_KEY || '';

    window.settingsCollapsedState = window.settingsCollapsedState || { datasource: true, aimodel: true, providers: true, strategy: true, dangerzone: true };

    let strategyItemsHtml = '';
    if (strategyList.length > 0) {
      strategyItemsHtml = strategyList.map((st, idx) => `
        <div class="strategy-edit-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.06);">
          <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: #1d1d1f; padding-right: 12px; line-height: 1.4;">${esc(st)}</span>
          <button class="delete-strategy-btn" data-strategy-idx="${idx}" style="background: none; border: 0; color: #ff3b30; font-size: 13px; cursor: pointer; padding: 4px 8px; font-weight: 500;">删除</button>
        </div>
      `).join('');
    } else {
      strategyItemsHtml = `
        <div style="color: #86868b; font-size: 13px; padding: 24px 0; text-align: center;">
          暂无策略方针，可在下方添加以规范投资纪律
        </div>
      `;
    }

    root.innerHTML = `
      <section class="settings-page" style="width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;">
        <!-- Injected Custom Styles for Responsiveness and Accordion Animations -->
        <style>
          .settings-toggle-header:hover {
            background: #f5f5f7 !important;
          }
          .settings-toggle-header:active {
            background: #e8e8ed !important;
          }
        </style>

        <div style="display: flex; flex-direction: column; gap: 20px; width: 100%;">
          
          <!-- Section 1: Data Source API Configuration -->
          <div class="panel" style="padding: 0; border-radius: 18px; box-sizing: border-box; background: #fff; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.01); overflow: hidden; transition: all 0.25s ease-in-out; width: 100%;">
            <div class="settings-toggle-header" data-panel="datasource" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; cursor: pointer; background: #fafafa; border-bottom: 1px solid rgba(0,0,0,0.04); user-select: none;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #86868b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg></span>
                <div style="text-align: left;">
                  <h2 style="font-size: 16px; font-weight: 650; margin: 0; color: #1d1d1f;">数据源接口配置</h2>
                  <p style="font-size: 12px; color: #86868b; margin: 2px 0 0 0;">配置全局资产数据的抓取接口基地址，修改后立即应用到估值及详情查询</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="toggle-arrow" style="font-size: 14px; color: #86868b; transition: transform 0.2s; transform: ${window.settingsCollapsedState.datasource ? 'rotate(-90deg)' : 'rotate(0deg)'}; font-weight: bold; display: inline-block;">▼</span>
              </div>
            </div>

            <div class="panel-body-datasource" style="display: ${window.settingsCollapsedState.datasource ? 'none' : 'block'}; padding: 24px;">
              <div style="margin-bottom: 16px;">
                <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px;">接口基地址 (API Base URL)</label>
                <div style="display: flex; gap: 10px;">
                  <input type="text" id="api-base-url-input" placeholder="留空默认使用当前服务器地址，例如: http://localhost:3000" 
                         value="${esc(window.FUND_API_BASE || '')}"
                         style="flex: 1; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box;" />
                  <button class="primary" id="save-api-btn" style="padding: 8px 16px; border-radius: 8px; font-size: 13px; height: 38px; line-height: 1; white-space: nowrap; background: #34a853; font-weight: 600;">保存</button>
                </div>
              </div>

              <!-- List of currently in-use endpoints (目前已用接口) -->
              <div style="margin-bottom: 18px; padding-top: 14px; border-top: 1px solid rgba(0,0,0,0.06);">
                <span style="font-size: 12.5px; font-weight: 600; color: #1d1d1f; display: block; margin-bottom: 8px;">系统已接入的数据源接口：</span>
                <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-family: monospace;">
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/funds</span>
                    <span style="color: #86868b;">全量持仓基金同步</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/{code}</span>
                    <span style="color: #86868b;">净值及单支基金详情</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/import/{code}</span>
                    <span style="color: #86868b;">导入新增上市基金</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/{code}/estimate</span>
                    <span style="color: #86868b;">基金实时净值测算</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/stock/{code}</span>
                    <span style="color: #86868b;">股票行情即时获取</span>
                  </div>
                </div>
              </div>

              <!-- Interface Testing Area (增加时可以调用/测试) -->
              <div style="padding: 14px; border-radius: 12px; background: rgba(0, 113, 227, 0.03); border: 1px dashed rgba(0, 113, 227, 0.2); margin-top: 14px;">
                <span style="font-size: 13px; font-weight: 600; color: #0071e3; display: flex; align-items: center; gap: 4px; margin-bottom: 6px;">接口连通性测试</span>
                <p style="font-size: 12px; color: #6e6e73; margin: 0 0 10px 0; line-height: 1.4;">输入一个基金代码，即可测试当前或待保存的数据源接口是否能连通并成功调用。</p>
                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                  <input type="text" id="test-fund-code-input" placeholder="000001" maxlength="6" value="000001"
                         style="width: 100px; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 12px; background: #fff; text-align: center; font-family: monospace; outline: none; box-sizing: border-box;" />
                  <button class="primary" id="test-api-btn" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 12px; height: 32px; line-height: 1; white-space: nowrap; background: #0071e3; font-weight: 600;">一键测试</button>
                </div>
                <div id="test-api-result" style="display: none; padding: 12px; border-radius: 8px; background: #fff; border: 1px solid rgba(0,0,0,0.06); font-size: 12px; line-height: 1.5; color: #1d1d1f; overflow-x: auto;">
                </div>
              </div>
            </div>
          </div>

          <!-- Section 2: AI Model API Configuration -->
          <div class="panel" style="padding: 0; border-radius: 18px; box-sizing: border-box; background: #fff; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.01); overflow: hidden; transition: all 0.25s ease-in-out; width: 100%;">
            <div class="settings-toggle-header" data-panel="aimodel" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; cursor: pointer; background: #fafafa; border-bottom: 1px solid rgba(0,0,0,0.04); user-select: none;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #86868b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="15" x2="23" y2="15"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="15" x2="4" y2="15"></line></svg></span>
                <div style="text-align: left;">
                  <h2 style="font-size: 16px; font-weight: 650; margin: 0; color: #1d1d1f;">AI模型接口配置</h2>
                  <p style="font-size: 12px; color: #86868b; margin: 2px 0 0 0;">配置全局 AI 分析服务接口，修改后立即应用到持仓分析、智能建议、风险评估</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="toggle-arrow" style="font-size: 14px; color: #86868b; transition: transform 0.2s; transform: ${window.settingsCollapsedState.aimodel ? 'rotate(-90deg)' : 'rotate(0deg)'}; font-weight: bold; display: inline-block;">▼</span>
              </div>
            </div>

            <div class="panel-body-aimodel" style="display: ${window.settingsCollapsedState.aimodel ? 'none' : 'block'}; padding: 24px;">
              <div style="display: flex; flex-direction: column; gap: 16px;">
                <!-- First Part: AI Provider selection -->
                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px; font-weight: 500;">AI接口商 (AI Provider)</label>
                  <select id="ai-provider-select" style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box; color: #1d1d1f; cursor: pointer; height: 38px;">
                    <option value="OpenAI" ${savedProvider === 'OpenAI' ? 'selected' : ''}>OpenAI</option>
                    <option value="DeepSeek" ${savedProvider === 'DeepSeek' ? 'selected' : ''}>DeepSeek</option>
                    <option value="Google Gemini" ${savedProvider === 'Google Gemini' ? 'selected' : ''}>Google Gemini</option>
                    <option value="Moonshot Kimi" ${savedProvider === 'Moonshot Kimi' ? 'selected' : ''}>Moonshot Kimi</option>
                    <option value="Claude" ${savedProvider === 'Claude' ? 'selected' : ''}>Claude</option>
                    <option value="自定义 OpenAI Compatible" ${savedProvider === '自定义 OpenAI Compatible' ? 'selected' : ''}>自定义 OpenAI Compatible</option>
                  </select>
                </div>

                <!-- Second Part: Interface Configuration fields -->
                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px; font-weight: 500;">API Base URL</label>
                  <input type="text" id="ai-base-url-input" placeholder="留空默认使用官方基地址" 
                         value="${esc(savedBaseURL)}"
                         style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box; color: #1d1d1f; height: 38px;" />
                </div>

                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px; font-weight: 500;">API Key</label>
                  <input type="password" id="ai-api-key-input" placeholder="sk-xxxxxxxx（若不填则默认使用服务器环境变量配置）" 
                         value="${esc(savedAPIKey)}"
                         style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box; color: #1d1d1f; height: 38px;" />
                </div>

                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px; font-weight: 500;">Model名称 (Model Name)</label>
                  <input type="text" id="ai-model-name-input" placeholder="例如: gpt-5-mini" 
                         value="${esc(savedModelName)}"
                         style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box; color: #1d1d1f; height: 38px;" />
                </div>

                <div style="display: flex; justify-content: flex-end;">
                  <button class="primary" id="save-ai-config-btn" style="padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; background: #34a853; border: 0; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; height: 38px;">保存</button>
                </div>
              </div>

              <!-- Third Part: Supported endpoints list -->
              <div style="padding-top: 14px; border-top: 1px solid rgba(0,0,0,0.06); margin-top: 16px;">
                <span style="font-size: 12.5px; font-weight: 600; color: #1d1d1f; display: block; margin-bottom: 8px;">系统已接入的 AI 接口：</span>
                <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-family: monospace;">
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #34a853; font-weight: 600;">[POST] /api/ai/analyze</span>
                    <span style="color: #86868b;">基金持仓智能分析</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #34a853; font-weight: 600;">[POST] /api/ai/chat</span>
                    <span style="color: #86868b;">通用 AI 对话</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #34a853; font-weight: 600;">[GET] /api/ai/models</span>
                    <span style="color: #86868b;">获取可用模型列表</span>
                  </div>
                </div>
              </div>

              <!-- Fourth Part: Interface Connection Test Area -->
              <div style="padding: 14px; border-radius: 12px; background: rgba(52, 168, 83, 0.03); border: 1px dashed rgba(52, 168, 83, 0.2); display: flex; flex-direction: column; gap: 10px; margin-top: 16px;">
                <span style="font-size: 13px; font-weight: 600; color: #34a853; display: flex; align-items: center; gap: 4px;">AI 接口连通性测试</span>
                <p style="font-size: 12px; color: #6e6e73; margin: 0; line-height: 1.4;">点击下方一键测试，将发送测试请求并计算调用响应时长、验证接口连通度。</p>
                
                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">测试问题</label>
                  <input type="text" id="test-ai-question" value="请分析当前基金市场风险"
                         style="width: 100%; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 12px; background: #fff; outline: none; box-sizing: border-box; color: #1d1d1f; height: 32px;" />
                </div>

                <div style="display: flex; gap: 8px;">
                  <button class="primary" id="test-ai-btn" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 12px; height: 32px; line-height: 1; white-space: nowrap; background: #34a853; border: 0; color: #fff; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center;">一键测试</button>
                </div>
                <div id="test-ai-result" style="display: none; padding: 12px; border-radius: 8px; background: #fff; border: 1px solid rgba(0,0,0,0.06); font-size: 12px; line-height: 1.5; color: #1d1d1f; overflow-x: auto; width: 100%; box-sizing: border-box;">
                </div>
              </div>
            </div>
          </div>

          <!-- Section 2.5: Third-party Fund Sync -->
          <div class="panel" style="padding: 0; border-radius: 18px; box-sizing: border-box; background: #fff; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.01); overflow: hidden; transition: all 0.25s ease-in-out; width: 100%;">
            <div class="settings-toggle-header" data-panel="providers" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; cursor: pointer; background: #fafafa; border-bottom: 1px solid rgba(0,0,0,0.04); user-select: none;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #86868b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="12" y1="9" x2="12" y2="15"></line><line x1="8" y1="13" x2="16" y2="13"></line></svg></span>
                <div style="text-align: left;">
                  <h2 style="font-size: 16px; font-weight: 650; margin: 0; color: #1d1d1f;">第三方基金同步</h2>
                  <p style="font-size: 12px; color: #86868b; margin: 2px 0 0 0;">养基宝 / 小倍养基一键导入持仓，自动同步估值</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="toggle-arrow" style="font-size: 14px; color: #86868b; transition: transform 0.2s; transform: ${window.settingsCollapsedState.providers ? 'rotate(-90deg)' : 'rotate(0deg)'}; font-weight: bold; display: inline-block;">▼</span>
              </div>
            </div>

            <div class="panel-body-providers" style="display: ${window.settingsCollapsedState.providers ? 'none' : 'block'}; padding: 24px;">
              <!-- 养基宝 -->
              <div style="background: #fafafa; border: 1px solid rgba(0,0,0,0.04); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                  <b style="font-size: 14px; color: #1d1d1f;">养基宝</b>
                  <span id="yjb-status-text" style="font-size: 12px; color: #86868b;">检查中…</span>
                </div>
                <div id="yjb-login-area" style="display: none;">
                  <button class="primary" id="yjb-qrcode-btn" style="width: 100%; padding: 9px 12px; border-radius: 8px; font-size: 13px;">扫码登录</button>
                </div>
                <div id="yjb-connected-area" style="display: none;">
                  <div style="font-size: 12px; color: #6e6e73; margin-bottom: 10px;">最后同步：<b id="yjb-last-sync" style="color: #1d1d1f;">—</b></div>
                  <div style="display: flex; gap: 8px;">
                    <button class="primary" id="yjb-import-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px;">同步持仓</button>
                    <button class="secondary-button" id="yjb-overwrite-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px;">覆盖重导</button>
                    <button id="yjb-logout-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px; background: rgba(255,59,48,0.08); color: #ff3b30; border: 1px solid rgba(255,59,48,0.2); cursor: pointer; font-weight: 600;">退出登录</button>
                  </div>
                </div>
              </div>

              <!-- 小倍养基 -->
              <div style="background: #fafafa; border: 1px solid rgba(0,0,0,0.04); border-radius: 12px; padding: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                  <b style="font-size: 14px; color: #1d1d1f;">小倍养基</b>
                  <span id="xbyj-status-text" style="font-size: 12px; color: #86868b;">检查中…</span>
                </div>
                <div id="xbyj-login-area" style="display: none;">
                  <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input type="tel" id="xbyj-phone" placeholder="手机号" style="flex: 1; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 13px; background: #fff; outline: none;" />
                    <button class="secondary-button" id="xbyj-sms-btn" style="padding: 8px 12px; border-radius: 6px; font-size: 13px; white-space: nowrap;">验证码</button>
                  </div>
                  <div style="display: flex; gap: 8px;">
                    <input type="text" id="xbyj-code" placeholder="短信验证码" style="flex: 1; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 13px; background: #fff; outline: none;" />
                    <button class="primary" id="xbyj-login-btn" style="padding: 8px 12px; border-radius: 6px; font-size: 13px;">登录</button>
                  </div>
                  <div style="font-size: 11px; color: #86868b; margin-top: 8px; line-height: 1.5;">收不到验证码？请确认手机号已在「小倍养基」App 注册，并避免频繁点击发送。</div>
                </div>
                <div id="xbyj-connected-area" style="display: none;">
                  <div style="font-size: 12px; color: #6e6e73; margin-bottom: 10px;">最后同步：<b id="xbyj-last-sync" style="color: #1d1d1f;">—</b></div>
                  <div style="display: flex; gap: 8px;">
                    <button class="primary" id="xbyj-import-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px;">同步全部</button>
                    <button class="secondary-button" id="xbyj-overwrite-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px;">覆盖重导</button>
                    <button id="xbyj-logout-btn" style="flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px; background: rgba(255,59,48,0.08); color: #ff3b30; border: 1px solid rgba(255,59,48,0.2); cursor: pointer; font-weight: 600;">退出登录</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Section 3: Investment Strategy -->
          <div class="panel" style="padding: 0; border-radius: 18px; box-sizing: border-box; background: #fff; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.01); overflow: hidden; transition: all 0.25s ease-in-out; width: 100%;">
            <div class="settings-toggle-header" data-panel="strategy" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; cursor: pointer; background: #fafafa; border-bottom: 1px solid rgba(0,0,0,0.04); user-select: none;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #86868b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg></span>
                <div style="text-align: left;">
                  <h2 style="font-size: 16px; font-weight: 650; margin: 0; color: #1d1d1f;">投资策略方针</h2>
                  <p style="font-size: 12px; color: #86868b; margin: 2px 0 0 0;">规范投资纪律的自定义核心策略条目</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="toggle-arrow" style="font-size: 14px; color: #86868b; transition: transform 0.2s; transform: ${window.settingsCollapsedState.strategy ? 'rotate(-90deg)' : 'rotate(0deg)'}; font-weight: bold; display: inline-block;">▼</span>
              </div>
            </div>

            <div class="panel-body-strategy" style="display: ${window.settingsCollapsedState.strategy ? 'none' : 'block'}; padding: 24px;">
              <div style="max-height: 220px; overflow-y: auto; margin-bottom: 18px; padding-right: 6px;">
                ${strategyItemsHtml}
              </div>

              <!-- Add Strategy Input form -->
              <div style="display: flex; gap: 12px; margin-top: 14px;">
                <input type="text" id="new-strategy-input" placeholder="例如：定投沪深300，每次投入500元..." 
                       style="flex: 1; padding: 10px 14px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; color: #1d1d1f; outline: none; box-sizing: border-box;" />
                <button class="primary" id="add-strategy-btn" style="padding: 8px 16px; border-radius: 8px; font-size: 13px; height: 38px; line-height: 1; white-space: nowrap;">添加</button>
              </div>
            </div>
          </div>

          <!-- Section 4: Danger Zone -->
          <div class="panel" style="padding: 0; border-radius: 18px; box-sizing: border-box; background: #fff; border: 1px solid rgba(255, 59, 48, 0.15); box-shadow: 0 4px 12px rgba(255, 59, 48, 0.01); overflow: hidden; transition: all 0.25s ease-in-out; width: 100%;">
            <div class="settings-toggle-header" data-panel="dangerzone" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; cursor: pointer; background: rgba(255, 59, 48, 0.02); border-bottom: 1px solid rgba(255, 59, 48, 0.08); user-select: none;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #ff3b30;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></span>
                <div style="text-align: left;">
                  <h2 style="font-size: 16px; font-weight: 650; margin: 0; color: #ff3b30;">危险区域</h2>
                  <p style="font-size: 12px; color: #86868b; margin: 2px 0 0 0;">清空浏览器本地 LocalStorage 存储并进行数据重置</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="toggle-arrow" style="font-size: 14px; color: #ff3b30; transition: transform 0.2s; transform: ${window.settingsCollapsedState.dangerzone ? 'rotate(-90deg)' : 'rotate(0deg)'}; font-weight: bold; display: inline-block;">▼</span>
              </div>
            </div>

            <div class="panel-body-dangerzone" style="display: ${window.settingsCollapsedState.dangerzone ? 'none' : 'block'}; padding: 24px;">
              <button id="reset-storage-btn" style="width: 100%; padding: 12px; border-radius: 8px; font-size: 13px; background: rgba(255,59,48,0.08); color: #ff3b30; border: 1px solid rgba(255,59,48,0.2); cursor: pointer; font-weight: 600; text-align: center; display: block;">清空并恢复出厂默认值</button>
            </div>
          </div>

        </div>
      </section>
    `;
    applyProviderStatus();
    refreshProviderStatus().then(() => { if (view === 'setting') applyProviderStatus(); }).catch(() => {});
  }

  function render(v){
    view=v||view;
    document.querySelectorAll('.nav-tab').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    if(view==='overview') {
      overview();
    } else if(view==='portfolio') {
      portfolio();
    } else if(view==='analysis') {
      analysis();
    } else if(view==='setting') {
      setting();
    } else {
      overview();
    }
  }

  // 匹配调仓指令中的基金（支持简称/部分名称，如“易方达加仓2000”）
  function matchesFundQuery(f, query) {
    if (!f || !f.name || !query) return false;
    if (query.includes(f.name)) return true;
    const cleanName = String(f.name).replace(/(混合|A|C|债券|股票|基金|指数|ETF|联接|QDII|LOF)/gi, '').trim();
    if (cleanName.length >= 2 && query.includes(cleanName)) return true;
    const keywords = (String(query).replace(/(加仓|增持|买入|减仓|减持|卖出|清仓|全部|一半|半仓|定投|元|万|块|日|号|今天|昨天|明天|调整|操作|调仓|改为|至|由|从|到|后|前|和|的|在|把|将|第|个|只|次|基金|账户|组合)/g, '').match(/[\u4e00-\u9fa5]{2,}/g) || []);
    return keywords.some(kw => String(f.name).includes(kw) || cleanName.includes(kw));
  }

  // 解析并执行调仓指令（加仓/减仓/清仓）。仅由“调仓”按钮触发，不调用 AI。
  function applyTradeInstruction(userQuery) {
    const a = acct();
    if (!a || !userQuery || !a.funds || !a.funds.length) return { acted: false, actionMsg: '' };
    let acted = false;
    let actionMsg = '';
    a.funds.forEach(f => {
      const matchedByName = matchesFundQuery(f, userQuery);
      const matchedByCode = f.code && userQuery.includes(String(f.code));
      if (!matchedByName && !matchedByCode) return;
      if (/(减仓一半|卖出一半|减半|减持一半|减仓50%|减持50%|卖出50%)/.test(userQuery)) {
        const oldAmt = f.amount;
        f.amount = Number((f.amount * 0.5).toFixed(2));
        acted = true;
        actionMsg += `\n- 【减仓一半】已将【${f.name}】持仓金额由 ${oldAmt.toLocaleString()} 调整为 ${f.amount.toLocaleString()}。`;
      } else if (/(清仓|全部卖出|卖出全部|减仓100%|全部减掉)/.test(userQuery)) {
        const oldAmt = f.amount;
        f.amount = 0;
        acted = true;
        actionMsg += `\n- 【清仓退出】已将【${f.name}】（原金额 ${oldAmt.toLocaleString()}）清空（设为 0）。`;
      } else if (/(减仓|减持|卖出|减仓占比|减仓比例)(\d+)%/.test(userQuery)) {
        const match = userQuery.match(/(减仓|减持|卖出|减仓占比|减仓比例)(\d+)%/);
        const pct = parseFloat(match[2]);
        if (pct > 0 && pct <= 100) {
          const oldAmt = f.amount;
          const ratio = (100 - pct) / 100;
          f.amount = Number((f.amount * ratio).toFixed(2));
          acted = true;
          actionMsg += `\n- 【减仓 ${pct}%】已将【${f.name}】持仓金额由 ${oldAmt.toLocaleString()} 减少至 ${f.amount.toLocaleString()}。`;
        }
      } else if (/(加仓|增持|买入)(\d+)%/.test(userQuery)) {
        const match = userQuery.match(/(加仓|增持|买入)(\d+)%/);
        const pct = parseFloat(match[2]);
        if (pct > 0) {
          const oldAmt = f.amount;
          const ratio = (100 + pct) / 100;
          f.amount = Number((f.amount * ratio).toFixed(2));
          acted = true;
          actionMsg += `\n- 【加仓 ${pct}%】已将【${f.name}】持仓金额由 ${oldAmt.toLocaleString()} 增加至 ${f.amount.toLocaleString()}。`;
        }
      } else if (/(减仓|减持|卖出)(\d+)(元|万)?/.test(userQuery)) {
        const match = userQuery.match(/(减仓|减持|卖出)(\d+)(元|万)?/);
        let val = parseFloat(match[2]);
        if (match[3] === '万') val *= 10000;
        if (val > 0) {
          const oldAmt = f.amount;
          f.amount = Math.max(0, Number((f.amount - val).toFixed(2)));
          acted = true;
          actionMsg += `\n- 【减仓 ${val.toLocaleString()}】已将【${f.name}】持仓金额由 ${oldAmt.toLocaleString()} 减少至 ${f.amount.toLocaleString()}。`;
        }
      } else if (/(加仓|增持|买入)(\d+)(元|万)?/.test(userQuery)) {
        const match = userQuery.match(/(加仓|增持|买入)(\d+)(元|万)?/);
        let val = parseFloat(match[2]);
        if (match[3] === '万') val *= 10000;
        if (val > 0) {
          const oldAmt = f.amount;
          f.amount = Number((f.amount + val).toFixed(2));
          acted = true;
          actionMsg += `\n- 【加仓 ${val.toLocaleString()}】已将【${f.name}】持仓金额由 ${oldAmt.toLocaleString()} 增加至 ${f.amount.toLocaleString()}。`;
        }
      }
    });
    if (acted) window.savePortfolioState?.();
    return { acted, actionMsg };
  }

  function runAiDiagnostics(userQuery) {
    const a = acct();
    if (!a) return;

    // 2. Build the portfolio payload to send to the real AI engine
    const portfolioData = {
      account: a.name || '默认账户',
      strategies: a.strategy || [],
      holdings: (a.funds || []).map(f => ({
        name: f.name || '',
        code: f.code || '',
        amount: Number(f.amount) || 0,
        profit: Number(f.cost ? (f.amount - f.cost) : 0).toFixed(2),
        today_change: Number((f.today || 0) * f.amount || 0).toFixed(2)
      }))
    };

    if (userQuery) {
      portfolioData.userQuery = userQuery;
    }

    const aiProvider = localStorage.getItem('AI_PROVIDER') || 'OpenAI';
    const aiBaseURL = localStorage.getItem('AI_BASE_URL') || '';
    const aiModelName = localStorage.getItem('AI_MODEL_NAME') || 'gpt-5-mini';
    const aiAPIKey = window.AI_API_KEY || '';

    const requestBody = {
      portfolio: portfolioData,
      config: {
        provider: aiProvider,
        baseURL: aiBaseURL,
        model: aiModelName,
        apiKey: aiAPIKey
      }
    };

    // Update button text if it exists
    const runAnalysisBtn = document.querySelector('#run-ai-analysis-btn');
    let btnText = null;
    if (runAnalysisBtn) {
      btnText = runAnalysisBtn.querySelector('.btn-text');
      runAnalysisBtn.disabled = true;
      runAnalysisBtn.style.opacity = '0.7';
      if (btnText) btnText.textContent = userQuery ? '正在调取 AI 问答及调仓建议...' : '正在调取今日最新估值与诊断...';
    }

    fetch('/api/ai/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    })
    .then(async response => {
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData?.error || `HTTP ${response.status}`);
      }
      const resData = await response.json();
      if (resData.success && resData.analysis) {
        window.lastAIAnalysisResult = resData.analysis;
        const activeAccountName = a.name || '默认账户';
        const timeString = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        localStorage.setItem('LAST_AI_ANALYSIS', JSON.stringify(resData.analysis));
        localStorage.setItem('LAST_AI_ANALYSIS_' + activeAccountName, JSON.stringify(resData.analysis));
        localStorage.setItem('LAST_AI_ANALYSIS_TIME_' + activeAccountName, timeString);
        localStorage.setItem('LAST_AI_ANALYSIS_MODEL_' + activeAccountName, aiModelName);
      } else {
        throw new Error('AI 返回数据格式不正确');
      }
    })
    .catch(err => {
      console.error('AI Analysis failed:', err);
      let errMsg = err.message;
      if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource_exhausted') || errMsg.toLowerCase().includes('rate_limit') || errMsg.toLowerCase().includes('limit')) {
        errMsg = `Gemini/AI API 额度已用尽（Resource Exhausted）或触发限频。\n\n建议解决方法：\n1. 稍等半分钟后再次重试该操作；\n2. 前往【设置】页面切换为其他 AI 服务商（如 Kimi、DeepSeek、OpenAI）或配置您自己高配额的 API Key；\n3. 如果是在 Google AI Studio 调试，可以考虑为您的 API Key 开启随现随付（Pay-as-you-go）方案。`;
      }
      alert(`AI 诊断分析失败:\n${errMsg}\n\n系统将继续使用内置规则计算引擎提供基础版偏离度调仓操作建议。`);
    })
    .finally(() => {
      window.lastAnalysisTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      render('analysis');
    });
  }

  // Handle Enter key on AI Q&A Input
  root.addEventListener('keydown', e => {
    if (e.target.id === 'ai-question-input' && e.key === 'Enter') {
      if (e.shiftKey) return;
      e.preventDefault();
      const btn = document.querySelector('#ai-ask-submit-btn');
      if (btn) btn.click();
    }
  });

  root.addEventListener('click',e=>{
    // Close other tooltips when clicking outside or clicking another one
    const clickedDetails = e.target.closest('.tooltip-details');
    document.querySelectorAll('details.tooltip-details').forEach(d => {
      if (d !== clickedDetails) {
        d.removeAttribute('open');
      }
    });

    // 移动端：气泡展开后居中显示，避免超出屏幕
    if (clickedDetails && window.innerWidth <= 760) {
      const positionBubble = () => {
        if (!clickedDetails.hasAttribute('open')) return;
        const bubble = clickedDetails.querySelector('.tooltip-bubble');
        const summary = clickedDetails.querySelector('summary');
        if (!bubble || !summary) return;
        const rect = summary.getBoundingClientRect();
        const vw = window.innerWidth;
        const bubbleWidth = Math.min(320, vw - 32);
        bubble.style.position = 'fixed';
        bubble.style.left = '50%';
        bubble.style.top = (rect.bottom + 8) + 'px';
        bubble.style.transform = 'translateX(-50%)';
        bubble.style.width = bubbleWidth + 'px';
        bubble.style.maxWidth = (vw - 32) + 'px';
        bubble.style.zIndex = '2000';
        const arrow = bubble.firstElementChild;
        if (arrow) {
          const arrowLeft = Math.max(10, Math.min(bubbleWidth - 22, rect.left + rect.width / 2 - vw / 2 - 5));
          arrow.style.left = arrowLeft + 'px';
        }
      };
      clickedDetails.addEventListener('toggle', positionBubble, { once: true });
    }

    const runAnalysisBtn = e.target.closest('#run-ai-analysis-btn');
    if (runAnalysisBtn) {
      runAiDiagnostics(window.lastAIUserQuestion);
      return;
    }

    const aiTradeBtn = e.target.closest('#ai-trade-btn');
    if (aiTradeBtn) {
      const input = document.querySelector('#ai-question-input');
      const val = input ? input.value.trim() : '';
      if (!val) {
        showToast('请输入调仓指令，例如：易方达加仓2000', 'warning');
        return;
      }
      const result = applyTradeInstruction(val);
      if (result.acted) {
        showAppleDialog({
          title: '调仓已执行',
          message: result.actionMsg.trim(),
          okText: '知道了',
          cancelText: ''
        });
        render('analysis');
      } else {
        showToast('未识别到调仓指令，请包含基金名称和操作（加仓/减仓/清仓）及金额', 'warning');
      }
      return;
    }

    const aiAskSubmitBtn = e.target.closest('#ai-ask-submit-btn');
    if (aiAskSubmitBtn) {
      const input = document.querySelector('#ai-question-input');
      const val = input ? input.value.trim() : '';
      if (!val) {
        alert('请输入需要咨询的问题！');
        return;
      }
      window.lastAIUserQuestion = val;
      askAiQuestion(val);
      return;
    }

    const clearAiQuestionBtn = e.target.closest('#clear-ai-question-btn');
    if (clearAiQuestionBtn) {
      window.lastAIUserQuestion = '';
      runAiDiagnostics('');
      const answerBox = document.querySelector('#ai-answer-window');
      if (answerBox) {
        answerBox.style.display = 'none';
        answerBox.textContent = '';
      }
      return;
    }

    const goAnalysisBtn = e.target.closest('#go-analysis-btn');
    if (goAnalysisBtn) {
      render('analysis');
      return;
    }

    const adjustHoldingBtn = e.target.closest('.adjust-holding-btn');
    if (adjustHoldingBtn) {
      const code = adjustHoldingBtn.dataset.code;
      const a = acct();
      const fund = a.funds.find(x => x.code === code);
      if (fund) {
        const val = prompt('请输入 [' + fund.name + '] 的持仓金额 (元)：', fund.amount);
        if (val !== null) {
          const amt = parseFloat(val);
          if (!isNaN(amt) && amt >= 0) {
            fund.amount = amt;
            window.savePortfolioState?.();
            alert('持仓金额已成功修改为 ' + amt.toLocaleString());
            render('analysis');
          } else {
            alert('请输入有效的正数金额！');
          }
        }
      }
      return;
    }

    const action=e.target.closest('[data-action]')?.dataset.action;
    if(action==='toggle-edit'){
      editing=!editing;
      selected.clear();
      render('overview');
      return;
    }
    if(action==='add-account'){
      const n=prompt('输入账户名称');
      if(n&&!s.accounts[n]){
        s.accounts[n]={name:n,accountType:'local',syncSource:null,funds:[],strategy:[],closedPositions:[]};
        render('overview');
      }
      return;
    }
    if(action==='delete'){
      if(confirm('确定删除选中的账户吗？')){
        selected.forEach(n=>{
          const wasSynced = isSyncAccount(s.accounts[n]);
          Object.values(s.accounts).forEach(a => {
            if (Array.isArray(a.children)) {
              const i = a.children.indexOf(n);
              if (i !== -1) a.children.splice(i, 1);
            }
          });
          const target = s.accounts[n];
          if (target && Array.isArray(target.children)) {
            target.children.forEach(cn => { if (s.accounts[cn]) s.accounts[cn].parent = undefined; });
          }
          delete s.accounts[n];
          if (wasSynced) {
            providerApi('/api/portfolio/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account_id: n })
            }).catch(() => {});
          }
        });
        selected.clear();
        editing=false;
        render('overview');
      }
      return;
    }

    // --- Settings page interactive controls ---
    const toggleHeader = e.target.closest('.settings-toggle-header');
    if (toggleHeader) {
      const panelKey = toggleHeader.dataset.panel;
      if (panelKey) {
        window.settingsCollapsedState = window.settingsCollapsedState || { datasource: true, aimodel: true, providers: true, strategy: true, dangerzone: true };
        window.settingsCollapsedState[panelKey] = !window.settingsCollapsedState[panelKey];
        setting();
      }
      return;
    }

    const addStrategyBtn = e.target.closest('#add-strategy-btn');
    if (addStrategyBtn) {
      const input = document.querySelector('#new-strategy-input');
      const val = input ? input.value.trim() : '';
      if (val) {
        const a = acct();
        if (!a.strategy) a.strategy = [];
        a.strategy.push(val);
        window.savePortfolioState?.();
        setting();
      }
      return;
    }

    const delStrategyBtn = e.target.closest('.delete-strategy-btn');
    if (delStrategyBtn) {
      const idx = parseInt(delStrategyBtn.dataset.strategyIdx, 10);
      const a = acct();
      if (a.strategy && a.strategy[idx] !== undefined) {
        a.strategy.splice(idx, 1);
        window.savePortfolioState?.();
        setting();
      }
      return;
    }



    const saveApiBtn = e.target.closest('#save-api-btn');
    if (saveApiBtn) {
      const input = document.querySelector('#api-base-url-input');
      const val = input ? input.value.trim().replace(/\/+$/, '') : '';
      localStorage.setItem('FUND_API_BASE', val);
      window.FUND_API_BASE = val;
      alert('数据源基地址保存并应用成功！');
      setting();
      return;
    }

    const testApiBtn = e.target.closest('#test-api-btn');
    if (testApiBtn) {
      const testCodeInput = document.querySelector('#test-fund-code-input');
      const testCode = testCodeInput ? testCodeInput.value.trim() : '000001';
      const baseUrlInput = document.querySelector('#api-base-url-input');
      const baseUrl = baseUrlInput ? baseUrlInput.value.trim().replace(/\/+$/, '') : '';
      
      const resultDiv = document.querySelector('#test-api-result');
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<span style="color: #6e6e73;">正在调用接口进行测试连接，请稍候...</span>';
      }
      
      let targetUrl = '';
      if (!baseUrl) {
        targetUrl = `/api/fund/${testCode}`;
      } else {
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          targetUrl = `${window.location.protocol}//${baseUrl}/api/fund/${testCode}`;
        } else {
          targetUrl = `${baseUrl}/api/fund/${testCode}`;
        }
      }
      
      const startTime = performance.now();
      
      fetch(targetUrl)
        .then(async response => {
          const duration = Math.round(performance.now() - startTime);
          if (response.ok) {
            const data = await response.json();
            if (resultDiv) {
              resultDiv.innerHTML = `
                <div style="color: #34a853; font-weight: 600; margin-bottom: 6px;">✓ 接口连接成功 (耗时: ${duration}ms)</div>
                <div style="font-size: 11px; color: #86868b; margin-bottom: 6px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
                <strong style="display:block; margin-bottom: 4px;">返回数据预览：</strong>
                <pre style="margin: 0; background: #f5f5f7; padding: 8px; border-radius: 6px; font-size: 11px; max-height: 120px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; word-break: break-all;">${esc(JSON.stringify(data, null, 2).substring(0, 300))}...</pre>
              `;
            }
          } else {
            if (resultDiv) {
              resultDiv.innerHTML = `
                <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ 接口响应失败 (HTTP 状态码: ${response.status})</div>
                <div style="font-size: 11px; color: #86868b; margin-bottom: 4px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
                <div style="font-size: 12px; color: #6e6e73;">请检查接口地址配置是否正确，或该基金代码是否合法。</div>
              `;
            }
          }
        })
        .catch(err => {
          if (resultDiv) {
            resultDiv.innerHTML = `
              <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ 接口连接异常/跨域错误</div>
              <div style="font-size: 11px; color: #86868b; margin-bottom: 6px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
              <div style="font-size: 12px; color: #6e6e73; line-height: 1.4;">
                错误详情: <span style="color:#ff3b30; font-family: monospace;">${esc(err.message)}</span><br>
                提示：如果您配置的是外部 API 地址，请确保该 API 服务支持并开启了 **CORS 跨域请求**，否则浏览器由于安全策略会拦截请求。
              </div>
            `;
          }
        });
      return;
    }

    const saveAiConfigBtn = e.target.closest('#save-ai-config-btn');
    if (saveAiConfigBtn) {
      const provider = document.querySelector('#ai-provider-select')?.value || 'OpenAI';
      const baseURL = document.querySelector('#ai-base-url-input')?.value.trim() || '';
      const apiKey = document.querySelector('#ai-api-key-input')?.value.trim() || '';
      const modelName = document.querySelector('#ai-model-name-input')?.value.trim() || 'gpt-5-mini';
      
      localStorage.setItem('AI_PROVIDER', provider);
      localStorage.setItem('AI_BASE_URL', baseURL);
      localStorage.setItem('AI_MODEL_NAME', modelName);
      
      if (apiKey) {
        window.AI_API_KEY = apiKey;
        // Client-side local storage of third-party key is used for persisting user-entered configuration.
        localStorage.setItem('AI_API_KEY', apiKey);
      } else {
        window.AI_API_KEY = '';
        localStorage.removeItem('AI_API_KEY');
      }
      
      alert('AI 接口配置保存并应用成功！');
      setting();
      return;
    }

    const testAiBtn = e.target.closest('#test-ai-btn');
    if (testAiBtn) {
      const provider = document.querySelector('#ai-provider-select')?.value || 'OpenAI';
      const baseURL = document.querySelector('#ai-base-url-input')?.value.trim() || '';
      const apiKey = document.querySelector('#ai-api-key-input')?.value.trim() || window.AI_API_KEY || '';
      const modelName = document.querySelector('#ai-model-name-input')?.value.trim() || 'gpt-5-mini';
      const question = document.querySelector('#test-ai-question')?.value.trim() || '请分析当前基金市场风险';
      
      const resultDiv = document.querySelector('#test-ai-result');
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<span style="color: #6e6e73;">正在发起 AI 服务连接测试，此过程可能需要几秒，请稍候...</span>';
      }
      
      const startTime = performance.now();
      
      fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-API-Key': apiKey
        },
        body: JSON.stringify({
          message: question,
          config: {
            provider,
            baseURL,
            model: modelName
          }
        })
      })
      .then(async response => {
        const duration = Math.round(performance.now() - startTime);
        const data = await response.json().catch(() => ({}));
        
        if (response.ok && data.success) {
          if (resultDiv) {
            resultDiv.innerHTML = `
              <div style="color: #34a853; font-weight: 600; margin-bottom: 6px;">✓ AI 接口调用成功 (耗时: ${duration}ms)</div>
              <div style="font-size: 11px; color: #86868b; margin-bottom: 6px;">使用模型: <span style="font-family: monospace;">${esc(modelName)}</span></div>
              <strong style="display:block; margin-bottom: 4px;">AI 原始回复：</strong>
              <div style="background: #f5f5f7; padding: 10px; border-radius: 6px; font-size: 12px; font-family: system-ui, -apple-system; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; color: #1d1d1f; border: 1px solid rgba(0,0,0,0.04);">${esc(data.reply)}</div>
            `;
          }
        } else {
          const errMsg = data.error || '未知网络或网关错误';
          if (resultDiv) {
            resultDiv.innerHTML = `
              <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ AI 接口响应失败 (HTTP 状态码: ${response.status})</div>
              <div style="font-size: 12px; color: #6e6e73; margin-bottom: 6px; line-height: 1.4;">
                错误详情: <span style="color:#ff3b30; font-family: monospace; font-weight: 600;">${esc(errMsg)}</span>
              </div>
              <div style="font-size: 11.5px; color: #86868b; line-height: 1.4;">
                排查建议：<br>
                1. 确保在本地后台或环境变量中正确配置了对应的 API Key（如 <span style="font-family: monospace;">OPENAI_API_KEY</span> 等）或者在上方输入框中填写了临时的 API Key；<br>
                2. 检查网络或代理是否能顺畅访问服务商基地址；<br>
                3. 如果使用自定义 Compatible 端点，请确保服务端的 CORS 跨域请求已开启。
              </div>
            `;
          }
        }
      })
      .catch(err => {
        if (resultDiv) {
          resultDiv.innerHTML = `
            <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ 接口调用异常</div>
            <div style="font-size: 12px; color: #6e6e73; line-height: 1.4;">
              错误详情: <span style="color:#ff3b30; font-family: monospace;">${esc(err.message)}</span><br>
              请检查您的网络连接或后端服务器是否正常运行。
            </div>
          `;
        }
      });
      return;
    }

    const copyJsonBtn = e.target.closest('#copy-json-btn');
    if (copyJsonBtn) {
      const backupObj = {
        accounts: s.accounts,
        active: s.getActive()
      };
      const str = JSON.stringify(backupObj, null, 2);
      const textarea = document.querySelector('#backup-json-area');
      if (textarea) {
        textarea.value = str;
        textarea.select();
        try {
          document.execCommand('copy');
          alert('备份 JSON 已成功生成并复制到剪贴板！');
        } catch (err) {
          alert('备份 JSON 已成功生成，请在文本框中手动复制。');
        }
      }
      return;
    }

    const importJsonBtn = e.target.closest('#import-json-btn');
    if (importJsonBtn) {
      const textarea = document.querySelector('#backup-json-area');
      const str = textarea ? textarea.value.trim() : '';
      if (!str || !str.startsWith('{')) {
        alert('请输入有效的备份 JSON 数据！');
        return;
      }

      if (confirm('导入将永久覆盖您当前的所有持仓与历史账户，不可撤销！是否确定导入？')) {
        try {
          const parsed = JSON.parse(str);
          if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
            Object.keys(s.accounts).forEach(k => delete s.accounts[k]);
            Object.keys(parsed.accounts).forEach(k => {
              s.accounts[k] = parsed.accounts[k];
            });
            const nextActive = s.accounts[parsed.active] ? parsed.active : Object.keys(s.accounts)[0] || '主账户';
            s.setActive(nextActive);
            window.savePortfolioState?.();
            alert('备份数据导入成功！');
            setting();
          } else {
            alert('JSON 数据格式有误，未包含 accounts 属性。');
          }
        } catch (err) {
          alert('JSON 解析失败，请检查数据。');
        }
      }
      return;
    }

    const resetStorageBtn = e.target.closest('#reset-storage-btn');
    if (resetStorageBtn) {
      if (confirm('警告：此操作将重置整个应用程序的本地存储！是否继续？')) {
        localStorage.removeItem('genius-trader-portfolio-v2');
        location.reload();
      }
      return;
    }

    // --- 第三方基金同步 ---
    const yjbQrcodeBtn = e.target.closest('#yjb-qrcode-btn');
    if (yjbQrcodeBtn) { showProviderQRModal('yangjibao'); return; }

    const yjbImportBtn = e.target.closest('#yjb-import-btn');
    if (yjbImportBtn) { runProviderImport('yangjibao', false); return; }

    const yjbOverwriteBtn = e.target.closest('#yjb-overwrite-btn');
    if (yjbOverwriteBtn) {
      showAppleDialog({
        title: '覆盖重导',
        message: '将清空养基宝账户已有持仓后重新导入，是否继续？',
        okText: '覆盖重导',
        danger: true
      }).then(ok => { if (ok) runProviderImport('yangjibao', true); });
      return;
    }

    const yjbLogoutBtn = e.target.closest('#yjb-logout-btn');
    if (yjbLogoutBtn) {
      providerApi('/api/provider/yangjibao/logout', { method: 'POST' })
        .then(() => refreshProviderStatus())
        .then(() => { if (view === 'setting') applyProviderStatus(); showToast('已退出养基宝'); })
        .catch(() => showToast('退出登录失败', 'error'));
      return;
    }

    const xbyjSmsBtn = e.target.closest('#xbyj-sms-btn');
    if (xbyjSmsBtn) {
      const phone = ((document.querySelector('#xbyj-phone') || {}).value || '').trim();
      if (!/^1\d{10}$/.test(phone)) { showToast('请输入正确的手机号', 'warning'); return; }
      providerApi('/api/provider/xiaobeiyangji/sendSMS', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      }).then(() => showToast('验证码已发送，请注意查收')).catch(err => showToast(`验证码发送失败：${err.message || '网络错误'}`, 'error'));
      return;
    }

    const xbyjLoginBtn = e.target.closest('#xbyj-login-btn');
    if (xbyjLoginBtn) {
      const phone = ((document.querySelector('#xbyj-phone') || {}).value || '').trim();
      const code = ((document.querySelector('#xbyj-code') || {}).value || '').trim();
      if (!/^1\d{10}$/.test(phone)) { showToast('请输入正确的手机号', 'warning'); return; }
      if (!code) { showToast('请输入验证码', 'warning'); return; }
      providerApi('/api/provider/xiaobeiyangji/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code })
      }).then(() => refreshProviderStatus())
        .then(() => { if (view === 'setting') applyProviderStatus(); showToast('小倍养基登录成功'); })
        .catch(err => showToast(`登录失败：${err.message || '网络错误'}`, 'error'));
      return;
    }

    const xbyjImportBtn = e.target.closest('#xbyj-import-btn');
    if (xbyjImportBtn) { runProviderImport('xiaobeiyangji', false); return; }

    const xbyjOverwriteBtn = e.target.closest('#xbyj-overwrite-btn');
    if (xbyjOverwriteBtn) {
      showAppleDialog({
        title: '覆盖重导',
        message: '将清空小倍养基账户已有持仓后重新导入，是否继续？',
        okText: '覆盖重导',
        danger: true
      }).then(ok => { if (ok) runProviderImport('xiaobeiyangji', true); });
      return;
    }

    const xbyjLogoutBtn = e.target.closest('#xbyj-logout-btn');
    if (xbyjLogoutBtn) {
      providerApi('/api/provider/xiaobeiyangji/logout', { method: 'POST' })
        .then(() => refreshProviderStatus())
        .then(() => { if (view === 'setting') applyProviderStatus(); showToast('已退出小倍养基'); })
        .catch(() => showToast('退出登录失败', 'error'));
      return;
    }

    // --- 账户层级：新建子账户 / 按板块拆分 ---
    const addSubAccountBtn = e.target.closest('[data-action="add-sub-account"]');
    if (addSubAccountBtn) {
      const parentName = addSubAccountBtn.dataset.parent;
      showAppleInputDialog({
        title: '新建子账户',
        message: `为「${parentName}」创建子账户`,
        placeholder: '例如：半导体、黄金、债券',
        okText: '创建'
      }).then(childName => {
        if (!childName) return;
        if (s.accounts[childName]) { showToast('该账户名称已存在', 'warning'); return; }
        s.accounts[childName] = { name: childName, accountType: 'local', syncSource: null, parent: parentName, funds: [], strategy: [], closedPositions: [] };
        const parent = s.accounts[parentName];
        if (parent) {
          parent.children = parent.children || [];
          parent.children.push(childName);
        }
        window.savePortfolioState?.();
        render('overview');
        showToast(`已创建子账户「${childName}」`);
      });
      return;
    }

    const splitBySectorBtn = e.target.closest('[data-action="split-by-sector"]');
    if (splitBySectorBtn) {
      const parentName = splitBySectorBtn.dataset.parent;
      const parent = s.accounts[parentName];
      if (parent) {
        showAppleDialog({
          title: '按板块拆分',
          message: `将把「${parentName}」的持仓按板块拆分为子账户，父账户只保留汇总。是否继续？`,
          okText: '开始拆分',
          danger: true
        }).then(ok => {
          if (!ok) return;
          const groups = {};
          (parent.funds || []).forEach(f => {
            const sector = sectorNameOf(f);
            (groups[sector] = groups[sector] || []).push(f);
          });
          parent.children = parent.children || [];
          Object.keys(groups).forEach(sector => {
            const childName = `${parentName}-${sector}`;
            if (!s.accounts[childName]) {
              s.accounts[childName] = { name: childName, accountType: 'local', syncSource: null, parent: parentName, funds: [], strategy: [], closedPositions: [] };
            }
            s.accounts[childName].funds = groups[sector];
            if (!parent.children.includes(childName)) parent.children.push(childName);
          });
          parent.funds = [];
          window.savePortfolioState?.();
          render('overview');
          showToast(`已按板块拆分为 ${Object.keys(groups).length} 个子账户`);
        });
      }
      return;
    }

    const deleteSubAccountBtn = e.target.closest('[data-action="delete-sub-account"]');
    if (deleteSubAccountBtn) {
      const childName = deleteSubAccountBtn.dataset.child;
      const parentName = deleteSubAccountBtn.dataset.parent;
      showAppleDialog({
        title: '删除子账户',
        message: `确定删除子账户「${childName}」？其持仓将合并回父账户「${parentName}」，父级总资产不变。`,
        okText: '删除',
        danger: true
      }).then(ok => {
        if (!ok) return;
        const parent = s.accounts[parentName];
        const child = s.accounts[childName];
        if (parent && child) {
          // 子账户持仓合并回父账户（同代码合并金额/收益，流水去重），父级总资产不减少
          mergeFundsInto(parent, child.funds);
          if (Array.isArray(parent.children)) {
            const index = parent.children.indexOf(childName);
            if (index !== -1) parent.children.splice(index, 1);
          }
        }
        delete s.accounts[childName];
        window.savePortfolioState?.();
        render('overview');
        showToast(`已删除子账户「${childName}」，持仓已合并回父账户`);
      });
      return;
    }

    const subAccountCard = e.target.closest('[data-sub-account]');
    if (subAccountCard && !editing) {
      s.setActive(subAccountCard.dataset.subAccount);
      render('portfolio');
      return;
    }

    const moveAccountsBtn = e.target.closest('[data-action="move-accounts"]');
    if (moveAccountsBtn) {
      const sources = [...selected];
      if (!sources.length) return;
      const targetOptions = Object.keys(s.accounts).filter(n => !sources.includes(n));
      if (!targetOptions.length) {
        showToast('没有可移动的目标账户', 'warning');
        return;
      }
      showMoveAccountsDialog(sources, targetOptions).then(async result => {
        if (!result || !result.target) return;
        const target = s.accounts[result.target];
        if (!target) return;
        // 涉及同步账户：先转为本地账户（解除同步），提示用户后不再调用任何同步接口
        const involved = sources.map(name => s.accounts[name]).concat([target]).filter(Boolean);
        const hasSync = involved.some(isSyncAccount);
        if (hasSync) {
          const ok = await showAppleDialog({
            title: '移动账户',
            message: '修改同步账户持仓后，该账户将解除同步，转换为本地管理账户。',
            okText: '继续',
            cancelText: '取消'
          });
          if (!ok) return;
          involved.forEach(acc => {
            if (!isSyncAccount(acc)) return;
            const oldName = acc.name;
            convertAccountToLocal(acc);
            providerApi('/api/portfolio/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: oldName, to: acc.name })
            }).catch(() => {});
          });
        }
        sources.forEach(name => {
          const src = s.accounts[name];
          if (!src || name === result.target) return;
          // 复制持仓（避免源/目标共享同一对象引用）
          const copiedFunds = (src.funds || []).map(f => ({ ...f, transactions: Array.isArray(f.transactions) ? f.transactions.slice() : [] }));
          mergeFundsInto(target, copiedFunds);
          if (!result.keep) {
            // 从其它账户的 children 引用中移除，子账户提升为根账户
            Object.values(s.accounts).forEach(a => {
              if (Array.isArray(a.children)) {
                const i = a.children.indexOf(name);
                if (i !== -1) a.children.splice(i, 1);
              }
            });
            if (Array.isArray(src.children)) {
              src.children.forEach(cn => { if (s.accounts[cn]) s.accounts[cn].parent = undefined; });
            }
            delete s.accounts[name];
          }
        });
        window.savePortfolioState?.();
        render('overview');
        showToast(`已移动 ${sources.length} 个账户到「${result.target}」`);
      });
      return;
    }

    const addFromParentBtn = e.target.closest('[data-action="add-from-parent"]');
    if (addFromParentBtn) {
      const child = acct();
      if (!child || !child.parent) return;
      const parent = s.accounts[child.parent];
      if (!parent || !(parent.funds || []).length) {
        showToast('父账户暂无持仓可添加', 'warning');
        return;
      }
      showAddFromParentDialog(parent.funds, parent.name).then(async result => {
        if (!result || !result.codes.length) return;
        let moved = 0;
        result.codes.forEach(code => {
          const index = (parent.funds || []).findIndex(f => f.code === code);
          if (index === -1) return;
          const fund = parent.funds[index];
          const fundToAdd = result.copy
            ? { ...fund, transactions: Array.isArray(fund.transactions) ? fund.transactions.slice() : [] }
            : fund;
          mergeFundsInto(child, [fundToAdd]);
          if (!result.copy) parent.funds.splice(index, 1);
          moved += 1;
        });
        window.savePortfolioState?.();
        // 从同步父账户移出基金 = 用户主动修改：父账户转为本地账户（解除同步），不再写回服务端
        if (!result.copy && isSyncAccount(parent)) {
          const oldName = parent.name;
          convertAccountToLocal(parent);
          providerApi('/api/portfolio/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: oldName, to: parent.name })
          }).catch(() => showToast('父账户同步关系解除失败，请重试', 'warning'));
        }
        render('portfolio');
        showToast(`已添加 ${moved} 个基金到子账户「${child.name}」`);
      });
      return;
    }

    const subTab = e.target.closest('[data-sub-tab]');
    if (subTab) {
      s.setActive(subTab.dataset.subTab);
      render('portfolio');
      return;
    }

    const parentTab = e.target.closest('[data-parent-tab]');
    if (parentTab) {
      s.setActive(parentTab.dataset.parentTab);
      render('portfolio');
      return;
    }

    const row=e.target.closest('[data-account]');
    if(row&&!editing){
      s.setActive(row.dataset.account);
      render('portfolio');
    }
  });
  root.addEventListener('change',e=>{
    const c=e.target.closest('[data-check]');
    if(c)c.checked?selected.add(c.dataset.check):selected.delete(c.dataset.check);
    const d=root.querySelector('[data-action="delete"]');
    if(d)d.disabled=!selected.size;
    const m=root.querySelector('[data-action="move-accounts"]');
    if(m)m.disabled=!selected.size;

    if (e.target.id === 'ai-provider-select') {
      const provider = e.target.value;
      const baseUrlInput = document.querySelector('#ai-base-url-input');
      const modelNameInput = document.querySelector('#ai-model-name-input');
      
      const defaults = {
        'OpenAI': { url: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
        'DeepSeek': { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        'Google Gemini': { url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro' },
        'Moonshot Kimi': { url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
        'Claude': { url: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest' },
        '自定义 OpenAI Compatible': { url: '', model: '' }
      };
      
      if (defaults[provider]) {
        if (baseUrlInput) baseUrlInput.value = defaults[provider].url;
        if (modelNameInput) modelNameInput.value = defaults[provider].model;
      }
    }
  });
  document.querySelectorAll('.nav-tab').forEach(b=>b.addEventListener('click',()=>{editing=false;selected.clear();render(b.dataset.view)}));
  render('portfolio');
  // 阶段1：启动时从服务端加载同步账户权威数据
  refreshSyncedAccounts().then(() => render(view)).catch(() => {});
  // 统一把新版渲染器挂到全局 state.render，供账户切换等模块调用，
  // 避免旧版 app.js 渲染器覆盖持仓页（导致今日操作建议模块丢失）。
  s.render = render;
  // 账户层级助手（供 account-tabs / portfolio-tabs / live-estimates 等脚本使用）
  s.effectiveFunds = effectiveFundsOf;
  s.rootAccounts = rootAccountsOf;
  // 供详情页等脚本调用的 Apple 风格提示
  window.showToast = showToast;
})();
