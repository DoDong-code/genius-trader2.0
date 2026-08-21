// pages/analysis/analysis.js
import { http } from '../../utils/request.js';
import { pct } from '../../utils/format.js';
import { isTradingDay } from '../../utils/tradingDay.js';
const app = getApp();

Page({
  data: {
    activeAccountName: '',
    allocations: [],
    strategy: [],
    closedPositions: [],

    // Custom Topbar heights
    statusBarHeight: 20,
    navBarHeight: 44,

    // AI configurations for display
    aiModelName: '',
    aiAnalysisTime: '',

    // Q&A properties
    userQuery: '',
    lastUserQuery: '',
    isLoading: false,
    loadingText: '',
    aiAnswer: '',
    aiSummary: '',

    // Decision report metrics
    report: null,
    hasAi: false
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });
  },

  onShow() {
    // 实验功能关闭时「分析」tab 隐藏，若用户仍停留在此页则跳回总览
    if (!wx.getStorageSync('experimentalMode')) {
      wx.switchTab({ url: '/pages/index/index' });
      return;
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().highlight('/pages/analysis/analysis');
    }
    this.refreshData();
  },

  onPullDownRefresh() {
    this.refreshData();
    setTimeout(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '诊断更新成功', icon: 'success' });
    }, 800);
  },

  refreshData() {
    const activeAccountName = app.globalData.activeAccountName;
    const account = app.getActiveAccount();
    
    // Calculate the complete decision report combining local calculations and cached AI suggestions
    const report = this.buildDecisionReport(account);

    // Retrieve AI configurations and details
    const isLocalEngine = wx.getStorageSync('ai_engine') === 'local';
    let aiAnalysisTime = '';
    let aiModelName = '';
    if (isLocalEngine) {
      aiModelName = '本地规则引擎';
      aiAnalysisTime = '实时计算';
    } else {
      aiAnalysisTime = wx.getStorageSync('LAST_AI_ANALYSIS_TIME_' + activeAccountName) || '';
      aiModelName = wx.getStorageSync('LAST_AI_ANALYSIS_MODEL_' + activeAccountName) || '';
    }
    const lastUserQuery = wx.getStorageSync('LAST_USER_QUERY_' + activeAccountName) || '';
    const aiAnswer = wx.getStorageSync('LAST_AI_ANSWER_' + activeAccountName) || '';

    this.setData({
      activeAccountName,
      allocations: report.allocations,
      strategy: report.strategyList,
      closedPositions: report.closedPositions,
      report,
      hasAi: report.hasAi,
      aiSummary: report.summary || '',
      aiAnalysisTime,
      aiModelName,
      lastUserQuery,
      aiAnswer
    });
  },

  // ─────────────────────────────────────────────
  // local analysis engine helpers (parity with app-refactor.js)
  // ─────────────────────────────────────────────

  sectorNameOf(f) {
    const FUND_SECTORS_BY_CODE = {
      '014002': '全球智能科技', '022184': '全球科技', '002771': '灵活配置',
      '002207': '黄金矿业', '019633': '半导体设备', '007339': '沪深300',
      '004253': '黄金', '013309': '恒生科技', '010827': '产业趋势',
      '025422': '数字经济', '014847': '债券', '008173': '债券',
      '020741': '债券', '015736': '纯债', '380006': '纯债',
      '004103': '债券', '009690': '灵活配置', '000001': '混合', '008702': '基金'
    };
    return (f && (FUND_SECTORS_BY_CODE[f.code] || f.sector || f.category)) || '其他';
  },

  assetClassOf(f) {
    const sector = this.sectorNameOf(f);
    const ASSET_CLASS_BY_SECTOR = {
      '半导体设备': '权益类', '产业趋势': '权益类', '数字经济': '权益类',
      '灵活配置': '权益类', '混合': '权益类', '沪深300': '权益类',
      '黄金': '黄金类', '黄金矿业': '黄金类',
      '债券': '债券类', '纯债': '债券类',
      '全球科技': '海外类', '全球智能科技': '海外类', '恒生科技': '海外类'
    };
    if (ASSET_CLASS_BY_SECTOR[sector]) return ASSET_CLASS_BY_SECTOR[sector];
    const raw = (f && f.category) || '';
    if (['权益类', '黄金类', '债券类', '海外类'].includes(raw)) return raw;
    const name = (f && f.name) || '';
    if (/黄金|贵金属|金矿/.test(name)) return '黄金类';
    if (/债|货币/.test(name)) return '债券类';
    if (/全球|海外|恒生|纳指|标普|QDII|美股/.test(name)) return '海外类';
    return '其他';
  },

  effectiveFundsOf(account) {
    if (!account) return [];
    const own = Array.isArray(account.funds) ? account.funds : [];
    if (!Array.isArray(account.children) || account.children.length === 0) return own;
    const all = own.slice();
    account.children.forEach(childName => {
      const child = app.globalData.accounts[childName];
      if (child && Array.isArray(child.funds)) {
        child.funds.forEach(f => all.push({ ...f, subAccount: child.name }));
      }
    });
    return all;
  },

  buildCategoryTargets(strategyList) {
    const t = { '权益类': 35, '黄金类': 20, '债券类': 25, '海外类': 20, '其他': 10 };
    (strategyList || []).forEach(st => {
      ['权益类', '黄金类', '债券类', '海外类', '其他'].forEach(k => {
        const m = st.match(new RegExp(k + '[^0-9%]*(\\d+)\\s*%'));
        if (m) t[k] = parseFloat(m[1]);
      });
    });
    return t;
  },

  buildAdviceText(diffPct, rules) {
    if (diffPct > 4) {
      let adviceText = '分批止盈 / 适当减仓';
      if (rules.recovery) adviceText = `止盈回本 (目标:¥${rules.recovery})`;
      else if (rules.targetReturn) adviceText = `目标止盈 (门槛:${rules.targetReturn})`;
      return { adviceText, adviceColor: '#ff9500', adviceBg: 'rgba(255, 149, 0, 0.08)' };
    }
    if (diffPct < -4) {
      if (rules.suspendedBuy) return { adviceText: '暂停申购 / 观望', adviceColor: '#86868b', adviceBg: 'rgba(134, 134, 139, 0.08)' };
      let adviceText = '分批低吸 / 逢低定投';
      if (rules.fixedInvest) adviceText = `低吸定投 (¥${rules.fixedInvest}/期)`;
      else if (rules.limit) adviceText = `限额定投 (单次:¥${rules.limit})`;
      return { adviceText, adviceColor: '#ff453a', adviceBg: 'rgba(255, 69, 58, 0.08)' };
    }
    let adviceText = '持有待涨 / 观望';
    if (rules.fixedInvest && !rules.suspendedBuy) adviceText = `策略观望 (定投:¥${rules.fixedInvest})`;
    return { adviceText, adviceColor: '#0a84ff', adviceBg: 'rgba(10, 132, 255, 0.08)' };
  },

  loadCachedAiResult(account) {
    const accountName = account.name || '默认账户';
    // 仅按账户隔离读取，禁止回退全局键 —— 避免未分析账户串显其他账户的 AI 结论（对齐 MIG-002）
    const str = wx.getStorageSync('LAST_AI_ANALYSIS_' + accountName);
    if (!str) return null;
    try {
      return typeof str === 'string' ? JSON.parse(str) : str;
    } catch (e) {
      return null;
    }
  },

  // P3.18：本地评估理由 —— 基于实际数据动态生成（与网页端 buildLocalAdviceReason 同构）
  buildLocalAdviceReason(f, ctx) {
    const diffPct = ctx && ctx.diffPct;
    const currentPct = ctx && ctx.currentPct;
    const todayRate = ctx && ctx.todayRate;
    const adviceText = ctx && ctx.adviceText;
    const cat = ctx && ctx.cat;
    const parts = [];
    if (Number.isFinite(todayRate)) {
      const dir = todayRate >= 0 ? '上涨' : '下跌';
      parts.push(`今日${dir} ${Math.abs(todayRate).toFixed(2)}%`);
    } else if (Number.isFinite(Number(f.holdingProfit))) {
      const hp = Number(f.holdingProfit);
      parts.push(`当前持有${hp >= 0 ? '盈利' : '亏损'} ¥${Math.abs(Math.round(hp)).toLocaleString('zh-CN')}`);
    } else if (Number.isFinite(Number(f.amount))) {
      parts.push(`当前持仓 ¥${Math.round(Number(f.amount)).toLocaleString('zh-CN')}`);
    }
    if (cat && cat !== '其他') {
      parts.push(`所属${cat}板块${todayRate < 0 ? '走弱' : '表现尚可'}`);
    }
    if (Number.isFinite(currentPct)) {
      parts.push(`持仓占比 ${currentPct.toFixed(1)}%`);
    }
    if (Number.isFinite(diffPct)) {
      if (diffPct > 1) parts.push(`高于目标配比 ${diffPct.toFixed(1)}%`);
      else if (diffPct < -1) parts.push(`低于目标配比 ${Math.abs(diffPct).toFixed(1)}%`);
      else parts.push('与目标配比基本一致');
    }
    let conclusion = '维持持有观察';
    if (/加仓|买入|低吸|定投|加$/.test(adviceText || '')) conclusion = '处于配置窗口，可逢低分批介入';
    else if (/减仓|止盈|卖出|赎回|减$/.test(adviceText || '')) conclusion = '按纪律适度减仓、控制集中度';
    parts.push(`建议${conclusion}`);
    return parts.join('，');
  },

  parseStrategyDetails(f, list) {
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
      if (st.includes(f.code)) {
        isMatch = true;
      } else {
        const brands = ["富国", "易方达", "华夏", "汇添富", "兴全", "景顺", "天弘", "交银", "广发", "中欧", "万家", "招商", "博时", "南方", "嘉实", "华安", "工银", "建信", "农银"];
        for (const b of brands) {
          if (f.name.includes(b) && st.includes(b)) {
            isMatch = true;
            break;
          }
        }
      }

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
        const limitMatch = st.match(/限额\s*(\d+)/);
        if (limitMatch) rules.limit = parseInt(limitMatch[1], 10);

        const recoveryMatch = st.match(/回本\s*(\d+)/);
        if (recoveryMatch) rules.recovery = parseInt(recoveryMatch[1], 10);

        const fixedMatch = st.match(/定投\s*(\d+)/);
        if (fixedMatch) rules.fixedInvest = parseInt(fixedMatch[1], 10);

        const targetProfitMatch = st.match(/止盈\s*(\d+%?)/);
        if (targetProfitMatch) rules.targetReturn = targetProfitMatch[1];

        if (st.includes("暂停申购") || st.includes("暂停买入") || st.includes("只允许卖出") || st.includes("只允许卖") || st.includes("禁止买入") || st.includes("禁止申购") || st.includes("暂停买")) {
          rules.suspendedBuy = true;
        }
      }
    });

    return { matched, rules };
  },

  buildDecisionReport(a) {
    const funds = this.effectiveFundsOf(a);
    const strategyList = a.strategy || [];
    const closedPositions = (a.closedPositions || []).map(cp => ({
      ...cp,
      reasonStr: Array.isArray(cp.reason) ? cp.reason.join('、') : (cp.reason || '调仓清算'),
      amountStr: (cp.amount !== undefined && cp.amount !== null && cp.amount !== '')
        ? `¥${Math.round(Number(cp.amount)).toLocaleString('zh-CN')}` : ''
    }));
    const totalAssets = funds.reduce((x, f) => x + (Number(f.amount) || 0), 0);

    const categoryTotals = {};
    funds.forEach(f => {
      const cat = this.assetClassOf(f);
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (Number(f.amount) || 0);
    });

    const colorMap = {
      '权益类': '#ff453a',
      '黄金类': '#ffd60a',
      '债券类': '#30d158',
      '海外类': '#0a84ff',
      '其他': '#bf5af2'
    };

    const allocations = Object.keys(categoryTotals).map(cat => {
      const amt = categoryTotals[cat];
      // 二次验收修复：局部变量不能用 pct（遮蔽 import 的 pct 格式化函数 → 页面崩溃空白）
      const pctVal = totalAssets > 0 ? (amt / totalAssets) * 100 : 0;
      return {
        category: cat,
        amount: amt,
        amountStr: `¥${Math.round(amt).toLocaleString('zh-CN')}`,
        pct: pctVal,
        pctStr: pct(pctVal / 100, false),
        color: colorMap[cat] || colorMap['其他']
      };
    }).sort((x, y) => y.amount - x.amount);

    const categoryTargets = this.buildCategoryTargets(strategyList);
    const activeCategories = new Set(funds.map(f => this.assetClassOf(f)));
    let activeTargetsSum = 0;
    activeCategories.forEach(cat => { activeTargetsSum += categoryTargets[cat] !== undefined ? categoryTargets[cat] : 10; });

    let healthScore = 60;
    let healthText = '亟待调整';
    let healthColor = '#ff453a';
    let deviationText = '当前账户无持仓数据';
    if (activeCategories.size >= 4) {
      healthScore = 95; healthText = '配置极佳'; healthColor = '#30d158';
    } else if (activeCategories.size === 3) {
      healthScore = 85; healthText = '配置良好'; healthColor = '#30d158';
    } else if (activeCategories.size === 2) {
      healthScore = 75; healthText = '配比一般'; healthColor = '#ff9500';
    } else if (activeCategories.size === 1) {
      healthScore = 60; healthText = '风险集中'; healthColor = '#ff453a';
    }

    let maxCatPct = 0;
    allocations.forEach(al => { if (al.pct > maxCatPct) maxCatPct = al.pct; });
    deviationText = '组合配比均衡度良好';
    if (maxCatPct > 65) deviationText = '单一资产类别配比过大，建议适当分散降低系统性风险';
    else if (maxCatPct > 45) deviationText = '大类配比略有偏离，建议微调持仓结构';
    else if (funds.length === 0) deviationText = '当前账户无持仓数据';

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

    // P3.18 修复：本地引擎模式不读取任何 AI 缓存（避免历史 AI 胡编理由继续显示）
    const aiResult = wx.getStorageSync('ai_engine') === 'local' ? null : this.loadCachedAiResult(a);
    // AI 幻觉检查（对齐 Web app-refactor.js:241-256）：实际有持仓但 AI 返回「持仓为空」或 healthScore<=0 时 fallback 本地规则
    const hasActualHoldings = funds.length > 0;
    const aiDeviationText = (aiResult && aiResult.deviationText) || '';
    const aiHealthScore = (aiResult && aiResult.healthScore !== undefined) ? Number(aiResult.healthScore) : null;
    const isAiDelusional = hasActualHoldings && (
      /为空|无持仓|空白|无任何持仓|暂无.*数据|无法判断/.test(aiDeviationText) ||
      (aiHealthScore !== null && aiHealthScore <= 0)
    );
    if (aiResult && !isAiDelusional) {
      healthScore = aiResult.healthScore !== undefined ? Number(aiResult.healthScore) : healthScore;
      healthText = aiResult.healthText || healthText;
      healthColor = aiResult.healthColor || healthColor;
      deviationText = aiResult.deviationText || deviationText;
    } else if (isAiDelusional) {
      console.warn('[AI诊断] AI 返回异常结果（声称无持仓或 healthScore<=0），已 fallback 到本地规则引擎');
    }
    // riskScore 同样做幻觉检查
    const aiRisk = (aiResult && !isAiDelusional && Number.isFinite(Number(aiResult.riskScore))) ? Number(aiResult.riskScore) : null;
    const riskScore = aiRisk !== null ? Math.max(0, Math.min(100, Math.round(aiRisk))) : localRisk;
    const riskLevel = riskScore >= 70 ? '高' : riskScore >= 40 ? '中' : '低';

    const topAlloc = allocations[0];
    const bondPct = (allocations.find(al => al.category === '债券类') || {}).pct || 0;
    const goldPct = (allocations.find(al => al.category === '黄金类') || {}).pct || 0;
    let rebalanceSuggestion = '组合较为稳健，维持现有配置与纪律定投即可。';
    const aiRebalance = (aiResult && !isAiDelusional && typeof aiResult.rebalanceSuggestion === 'string') ? aiResult.rebalanceSuggestion.trim() : '';
    if (aiRebalance) {
      rebalanceSuggestion = aiRebalance;
    } else if (maxCatPct > 65) {
      if (topAlloc && topAlloc.category === '债券类') {
        rebalanceSuggestion = `债券类占比过高（${maxCatPct.toFixed(0)}%），组合偏防守；可适度增加权益/海外资产的配置比例，并保持行业分散。`;
      } else if (topAlloc && topAlloc.category === '权益类') {
        const bondPart = bondPct > 0
          ? `当前债券类约占 ${bondPct.toFixed(0)}%，可在现有基础上适度提高稳健资产占比，进一步降低组合波动`
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

    const rows = funds.map(f => {
      const cat = this.sectorNameOf(f);
      const classCat = this.assetClassOf(f);
      const countInCat = funds.filter(x => this.assetClassOf(x) === classCat).length;
      const targetCategoryPct = categoryTargets[classCat] !== undefined ? categoryTargets[classCat] : (categoryTargets['其他'] || 10);
      const normalizedCategoryTarget = activeTargetsSum > 0 ? (targetCategoryPct / activeTargetsSum) * 100 : targetCategoryPct;
      const targetPct = countInCat > 0 ? (normalizedCategoryTarget / countInCat) : 0;
      const currentPct = totalAssets > 0 ? ((Number(f.amount) || 0) / totalAssets) * 100 : 0;
      const diffPct = currentPct - targetPct;
      const { rules: parsedRules } = this.parseStrategyDetails(f, strategyList);

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
        if (/(加|低吸|买|定投)/.test(adviceText)) { adviceColor = '#ff453a'; adviceBg = 'rgba(255, 69, 58, 0.08)'; }
        else if (/(减|止盈|卖|赎)/.test(adviceText)) { adviceColor = '#ff9500'; adviceBg = 'rgba(255, 149, 0, 0.08)'; }
        else { adviceColor = '#0a84ff'; adviceBg = 'rgba(10, 132, 255, 0.08)'; }
      } else {
        const fb = this.buildAdviceText(diffPct, parsedRules);
        adviceText = fb.adviceText;
        adviceColor = fb.adviceColor;
        adviceBg = fb.adviceBg;
        // P3.18：本地评估理由基于实际数据动态生成（不再统一固定文案）
        adviceReason = this.buildLocalAdviceReason(f, {
          diffPct,
          currentPct,
          todayRate: Number(f.today || 0) * 100,
          adviceText,
          cat
        });
      }

      const todayRate = Number(f.today || 0) * 100;
      const todayAmount = Number(f.amount || 0) * Number(f.today || 0);
      let actionType = 'hold';
      if (/(加|低吸|买|定投)/.test(adviceText)) actionType = 'buy';
      else if (/(减|止盈|卖|赎)/.test(adviceText)) actionType = 'sell';

      return {
        code: f.code,
        name: f.name,
        cat,
        amount: Number(f.amount) || 0,
        amountStr: `¥${Math.round(f.amount).toLocaleString('zh-CN')}`,
        currentPct,
        currentPctStr: pct(currentPct / 100, false),
        todayRate: todayRate.toFixed(2),
        isTodayPositive: todayRate >= 0,
        todayAmountStr: (todayRate >= 0 ? '+' : '') + todayAmount.toFixed(2),
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
  },

  // ─────────────────────────────────────────────
  // Interactive handlers (trading commands parsing & AI chat/diagnostics)
  // ─────────────────────────────────────────────

  matchesFundQuery(f, query) {
    if (!f || !f.name || !query) return false;
    if (query.includes(f.name)) return true;
    const cleanName = String(f.name).replace(/(混合|A|C|债券|股票|基金|指数|ETF|联接|QDII|LOF)/gi, '').trim();
    if (cleanName.length >= 2 && query.includes(cleanName)) return true;
    const keywords = (String(query).replace(/(加仓|增持|买入|减仓|减持|卖出|清仓|全部|一半|半仓|定投|元|万|块|日|号|今天|昨天|明天|调整|操作|调仓|改为|至|由|从|到|后|前|和|的|在|把|将|第|个|只|次|基金|账户|组合)/g, '').match(/[\u4e00-\u9fa5]{2,}/g) || []);
    return keywords.some(kw => String(f.name).includes(kw) || cleanName.includes(kw));
  },

  applyTradeInstruction(userQuery) {
    const a = app.getActiveAccount();
    if (!a || !userQuery || !a.funds || !a.funds.length) return { acted: false, actionMsg: '' };
    let acted = false;
    let actionMsg = '';
    a.funds.forEach(f => {
      const matchedByName = this.matchesFundQuery(f, userQuery);
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
    if (acted) app.saveState();
    return { acted, actionMsg };
  },

  onInputUserQuery(e) {
    this.setData({ userQuery: e.detail.value });
  },

  onApplyTrade() {
    const val = this.data.userQuery.trim();
    if (!val) {
      wx.showToast({ title: '请输入调仓指令', icon: 'none' });
      return;
    }
    const res = this.applyTradeInstruction(val);
    if (res.acted) {
      wx.showModal({
        title: '指令执行成功',
        content: `已成功为您执行以下调仓操作：${res.actionMsg}`,
        showCancel: false,
        success: () => {
          this.setData({ userQuery: '' });
          this.refreshData();
        }
      });
    } else {
      wx.showModal({
        title: '指令执行未匹配',
        content: '未能匹配到符合条件的基金。请确认指令中包含了本组合中的基金名称（或简称）及具体的加/减仓动作，例如：“大成产业趋势加仓2000元”',
        showCancel: false
      });
    }
  },

  onAskAi() {
    const val = this.data.userQuery.trim();
    if (!val) {
      wx.showToast({ title: '请输入提问内容', icon: 'none' });
      return;
    }
    this.askAiQuestion(val);
  },

  async onRunAiAnalysis() {
    // P3.18：本地引擎模式 —— 不调用任何外部 AI API，直接用持仓本地数据完成分析
    if (wx.getStorageSync('ai_engine') === 'local') {
      wx.showToast({ title: '本地引擎模式：已基于持仓本地数据完成分析', icon: 'none' });
      this.refreshData();
      return;
    }
    this.setData({
      isLoading: true,
      loadingText: '正在刷新账户持仓估值数据...'
    });

    try {
      // P3.18：数据决策树 —— 持仓数据 ≤5min 直接使用；>5min 且交易日才刷新估值；
      // 非交易日 / 当天净值已存在 → 不刷新（refreshData 直接使用最近净值）
      let saved = null;
      try { saved = wx.getStorageSync('genius-trader-portfolio-v2'); } catch (e) { /* ignore */ }
      const lastSync = (saved && saved.updatedAt) ? Number(saved.updatedAt) : 0;
      if (Date.now() - lastSync > 5 * 60 * 1000) {
        if (isTradingDay(new Date())) {
          await this.refreshAccountDataBeforeAi();
        }
        // 非交易时段：不刷新估值，直接使用最近一个交易日净值
      }
    } catch (e) {
      console.warn('Failed to refresh valuations:', e);
    }

    const lastUserQuery = this.data.lastUserQuery || '';
    await this.runAiDiagnostics(lastUserQuery);
  },

  onClearAiQuestion() {
    const activeAccountName = app.globalData.activeAccountName;
    wx.removeStorageSync('LAST_USER_QUERY_' + activeAccountName);
    wx.removeStorageSync('LAST_AI_ANSWER_' + activeAccountName);
    
    this.setData({
      lastUserQuery: '',
      aiAnswer: '',
      userQuery: ''
    });

    this.refreshData();
  },

  async refreshAccountDataBeforeAi() {
    const account = app.getActiveAccount();
    const funds = this.effectiveFundsOf(account);
    const promises = funds.map(async (f) => {
      if (!f || !f.code) return;
      try {
        const snapshotUrl = `/api/fund/${f.code}?refresh=1&force=1`;
        const estimateUrl = `/api/fund/${f.code}/estimate?amount=${Number(f.amount) || 0}&force=1`;

        const [snapshotRes, estimateRes] = await Promise.all([
          http.get(snapshotUrl, null, { silent: true }).catch(() => null),
          http.get(estimateUrl, null, { silent: true }).catch(() => null)
        ]);

        const est = (estimateRes && estimateRes.estimate) || estimateRes || {};
        const change = Number(est.estimate_change);
        if (Number.isFinite(change)) {
          f.today = change;
          const profit = Number(est.estimate_profit);
          f.todayEstimate = Number.isFinite(profit) ? profit : ((Number(f.amount) || 0) * change);
        }
        const navDate = snapshotRes && snapshotRes.latest_nav && snapshotRes.latest_nav.date;
        if (navDate) f.navUpdatedAt = navDate;
      } catch (e) {
        console.warn('Refresh failed for fund', f.code, e);
      }
    });

    await Promise.all(promises);
    app.saveState();
  },

  async runAiDiagnostics(userQuery) {
    const a = app.getActiveAccount();
    if (!a) return;
    // P3.18：本地引擎兜底（双保险）—— 不调用外部 AI，直接用本地报告
    if (wx.getStorageSync('ai_engine') === 'local') {
      this.refreshData();
      return;
    }

    const portfolioData = {
      account: a.name || '默认账户',
      strategies: a.strategy || [],
      holdings: (a.funds || []).map(f => ({
        name: f.name || '',
        code: f.code || '',
        amount: Number(f.amount) || 0,
        profit: Number(f.holdingProfit ?? f.profit ?? 0).toFixed(2),
        today_change: Number(f.todayEstimate ?? ((f.today || 0) * f.amount) ?? 0).toFixed(2)
      }))
    };

    if (userQuery) {
      portfolioData.userQuery = userQuery;
    }

    const aiProvider = wx.getStorageSync('ai_provider') || 'OpenAI';
    const aiBaseURL = wx.getStorageSync('ai_base_url_config') || '';
    const aiModelName = wx.getStorageSync('ai_model_name') || 'gpt-5-mini';
    const aiAPIKey = wx.getStorageSync('ai_api_key') || '';

    const requestBody = {
      portfolio: portfolioData,
      config: {
        provider: aiProvider,
        baseURL: aiBaseURL,
        model: aiModelName,
        apiKey: aiAPIKey
      }
    };

    this.setData({
      isLoading: true,
      loadingText: userQuery ? '正在调取天才问答及调仓建议...' : '正在调取今日最新估值与诊断...'
    });

    try {
      const data = await http.post('/api/ai/analyze', requestBody, { silent: true });
      if (data && data.success && data.analysis) {
        const analysis = data.analysis;
        const activeAccountName = a.name || '默认账户';
        const timeString = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // 仅写账户隔离键，不再写全局键 LAST_AI_ANALYSIS —— 避免跨账户串显（对齐 MIG-002）
        wx.setStorageSync('LAST_AI_ANALYSIS_' + activeAccountName, analysis);
        wx.setStorageSync('LAST_AI_ANALYSIS_TIME_' + activeAccountName, timeString);
        wx.setStorageSync('LAST_AI_ANALYSIS_MODEL_' + activeAccountName, aiModelName);

        wx.showToast({ title: '天才诊断更新成功', icon: 'success' });
      } else {
        const errMsg = (data && data.error) || '分析返回异常';
        wx.showModal({
          title: '天才诊断失败',
          content: `${errMsg}\n\n系统将继续使用内置规则计算引擎提供基础版配比建议。`,
          showCancel: false
        });
      }
    } catch (err) {
      wx.showModal({
        title: 'AI 诊断异常',
        content: `${err.message || '网络错误'}\n\n系统将继续使用内置规则计算引擎提供基础版配比建议。`,
        showCancel: false
      });
    } finally {
      this.setData({ isLoading: false });
      this.refreshData();
    }
  },

  async askAiQuestion(question) {
    const a = app.getActiveAccount();
    if (!a) return;
    // P3.18：本地引擎模式 —— 提问也走本地（不调用外部 AI）
    if (wx.getStorageSync('ai_engine') === 'local') {
      wx.showToast({ title: '本地引擎模式：不调用外部 AI，已回答基于本地数据', icon: 'none' });
      this.setData({ aiAnswer: '本地引擎模式：当前未配置外部 AI 接口。请基于上方「今日操作建议」与持仓数据自行判断。' });
      this.refreshData();
      return;
    }

    this.setData({
      isLoading: true,
      loadingText: '天才正在思考，请稍候...'
    });

    const holdings = this.effectiveFundsOf(a).map(f => ({
      name: f.name,
      code: f.code,
      amount: Number(f.amount) || 0,
      profit: Number(f.holdingProfit ?? f.profit) || 0,
      today_change: Number((f.today || 0) * (Number(f.amount) || 0)) || 0
    }));

    const portfolio = { account: a.name || '默认账户', strategies: a.strategy || [], holdings };
    const isReview = /复盘/.test(question);

    let prompt = '';
    if (isReview) {
        let closedNote = '复盘分析';
      try {
        const marketRes = await http.get('/api/market/status', null, { silent: true }).catch(() => null);
        closedNote = marketRes && marketRes.trading_day && (marketRes.time || '') >= '15:00'
          ? '今日已收盘'
          : '今日尚未收盘（当前为盘中数据，以下为盘中复盘）';
      } catch (e) { /* ignore */ }
      prompt = `${closedNote}。请对以下基金组合进行复盘分析，包括：今日行情与持仓表现回顾、主要涨跌原因、明日关注要点、投资纪律执行情况与后续操作建议。\n组合数据：\n${JSON.stringify(portfolio, null, 2)}\n`;
    } else {
      prompt = `请基于以下基金组合数据回答用户问题，回答尽量具体、给出操作建议。\n组合数据：\n${JSON.stringify(portfolio, null, 2)}\n用户问题：${question}`;
    }

    const aiProvider = wx.getStorageSync('ai_provider') || 'OpenAI';
    const aiBaseURL = wx.getStorageSync('ai_base_url_config') || '';
    const aiModelName = wx.getStorageSync('ai_model_name') || 'gpt-5-mini';
    const aiAPIKey = wx.getStorageSync('ai_api_key') || '';

    try {
      const data = await http.post('/api/ai/chat', {
        message: prompt,
        config: { provider: aiProvider, baseURL: aiBaseURL, model: aiModelName, apiKey: aiAPIKey }
      }, { silent: true });
      if (data && data.success) {
        const reply = data.reply || 'AI 未返回有效回答';
        const activeAccountName = a.name || '默认账户';

        wx.setStorageSync('LAST_USER_QUERY_' + activeAccountName, question);
        wx.setStorageSync('LAST_AI_ANSWER_' + activeAccountName, reply);
        wx.setStorageSync('LAST_AI_ANALYSIS_MODEL_' + activeAccountName, aiModelName);

        this.setData({
          lastUserQuery: question,
          aiAnswer: reply,
          userQuery: ''
        });
      } else {
        const errMsg = (data && data.error) || '回答返回异常';
        wx.showModal({
          title: '回答生成失败',
          content: errMsg,
          showCancel: false
        });
      }
    } catch (err) {
      wx.showModal({
        title: '回答生成异常',
        content: err.message || '网络连接失败',
        showCancel: false
      });
    } finally {
      this.setData({ isLoading: false });
      this.refreshData();
    }
  }
});
