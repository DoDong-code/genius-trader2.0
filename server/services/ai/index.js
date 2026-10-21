var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/ai/analysisPrompt.ts
var analysisPrompt_exports = {};
__export(analysisPrompt_exports, {
  ACTION_VERBS: () => ACTION_VERBS,
  analyzeWithPrompt: () => analyzeWithPrompt,
  buildAnalysisPrompt: () => buildAnalysisPrompt,
  buildCompactDataBlocks: () => buildCompactDataBlocks,
  normalizeAnalysis: () => normalizeAnalysis,
  toCompactRows: () => toCompactRows
});
function toCompactRows(items, specs) {
  const columns = specs.map((s) => s.key);
  const source = Array.isArray(items) ? items : [];
  const rows = source.map((item) => specs.map((spec) => {
    const v = spec.value(item);
    return v === void 0 ? null : v;
  }));
  return { columns, rows };
}
function pctNum(v) {
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return null;
  return Number((Number(v) * 100).toFixed(2));
}
function buildCompactDataBlocks(holdings) {
  const list = Array.isArray(holdings) ? holdings : [];
  const holdingsTable = toCompactRows(list, [
    { key: "code", value: (h) => h.code || null },
    { key: "name", value: (h) => h.name || null },
    { key: "amount", value: (h) => Number.isFinite(Number(h.amount)) ? Number(h.amount) : null },
    { key: "cost", value: (h) => Number.isFinite(Number(h.cost)) ? Number(h.cost) : null },
    { key: "profit", value: (h) => Number.isFinite(Number(h.profit)) ? Number(h.profit) : null },
    { key: "profitRatePct", value: (h) => pctNum(h.profitRate) },
    { key: "todayEstimatePct", value: (h) => pctNum(h.todayEstimate) },
    { key: "direction", value: (h) => h.direction || h.type || null }
  ]);
  const performanceTable = toCompactRows(list, [
    { key: "code", value: (h) => h.code || null },
    { key: "return1mPct", value: (h) => pctNum(h.performance?.return1m) },
    { key: "return3mPct", value: (h) => pctNum(h.performance?.return3m) },
    { key: "return6mPct", value: (h) => pctNum(h.performance?.return6m) },
    { key: "return1yPct", value: (h) => pctNum(h.performance?.return1y) },
    { key: "maxDrawdown1yPct", value: (h) => pctNum(h.performance?.maxDrawdown1y) },
    { key: "drawdownFromHigh1yPct", value: (h) => pctNum(h.performance?.drawdownFromHigh1y) },
    { key: "volatility20dPct", value: (h) => pctNum(h.performance?.volatility20d) },
    { key: "trend", value: (h) => h.performance && h.performance.trend || null },
    { key: "dataAsOf", value: (h) => h.performance && h.performance.dataAsOf || null },
    { key: "historyDays", value: (h) => h.performance && h.performance.historyDays !== null && h.performance.historyDays !== void 0 ? h.performance.historyDays : null }
  ]);
  const withBench = list.filter((h) => h.benchmark && h.benchmark.name);
  const benchmarkTable = withBench.length ? toCompactRows(withBench, [
    { key: "code", value: (h) => h.code || null },
    { key: "benchName", value: (h) => h.benchmark && h.benchmark.name || null },
    { key: "benchKind", value: (h) => h.benchmark && h.benchmark.kind || null },
    { key: "bench1mPct", value: (h) => pctNum(h.benchmark?.return1m) },
    { key: "bench3mPct", value: (h) => pctNum(h.benchmark?.return3m) },
    { key: "bench6mPct", value: (h) => pctNum(h.benchmark?.return6m) },
    { key: "bench1yPct", value: (h) => pctNum(h.benchmark?.return1y) },
    { key: "rel1mPct", value: (h) => pctNum(h.benchmark?.relativeReturn1m) },
    { key: "rel6mPct", value: (h) => pctNum(h.benchmark?.relativeReturn6m) },
    { key: "rel1yPct", value: (h) => pctNum(h.benchmark?.relativeReturn1y) },
    { key: "benchDataAsOf", value: (h) => h.benchmark && h.benchmark.dataAsOf || null }
  ]) : null;
  const allocationTable = toCompactRows(list, [
    { key: "code", value: (h) => h.code || null },
    { key: "role", value: (h) => h.allocation && h.allocation.role ? ROLE_LABEL[h.allocation.role] || h.allocation.role : null },
    { key: "sector", value: (h) => h.allocation && h.allocation.sector || null },
    { key: "maxAmount", value: (h) => h.allocation && h.allocation.maxAmount !== null && h.allocation.maxAmount !== void 0 ? h.allocation.maxAmount : null },
    { key: "overlapWarning", value: (h) => h.allocation && h.allocation.overlapWarning !== void 0 ? h.allocation.overlapWarning : null }
  ]);
  const holdingsDetailTable = toCompactRows(list, [
    { key: "code", value: (h) => h.code || null },
    { key: "topHoldings", value: (h) => h.topHoldings === void 0 ? null : h.topHoldings },
    { key: "overlapDetail", value: (h) => h.overlapDetail === void 0 ? null : h.overlapDetail }
  ]);
  return {
    holdings: holdingsTable,
    performance: performanceTable,
    benchmark: benchmarkTable,
    allocation: allocationTable,
    holdingsDetail: holdingsDetailTable
  };
}
function compactBlockText(title, table, extraNote) {
  return `【${title}】
${extraNote ? extraNote + "\n" : ""}${JSON.stringify(table)}`;
}
function fmtMoney(v) {
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return "未提供";
  return `¥${Math.round(Number(v)).toLocaleString("zh-CN")}`;
}
function money(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}
function buildPositionNarrative(holdings, closedPositions) {
  const lines = [];
  holdings.forEach((h) => {
    const txs = Array.isArray(h.transactions) ? h.transactions : [];
    if (txs.length === 0) return;
    const buys = txs.filter((t) => /买|加|申购|定投|入/i.test(t.type || ""));
    const sells = txs.filter((t) => /卖|减|赎|出|清/i.test(t.type || ""));
    const buyAmt = buys.reduce((s, t) => s + money(t.amount), 0);
    const sellAmt = sells.reduce((s, t) => s + money(t.amount), 0);
    const tail = `${h.name || h.code || ""}（${h.code || ""}）：近期买入约 ${fmtMoney(buyAmt)}、卖出约 ${fmtMoney(sellAmt)}`;
    lines.push(tail);
  });
  if (Array.isArray(closedPositions) && closedPositions.length > 0) {
    closedPositions.slice(-6).forEach((c) => {
      const reason = Array.isArray(c?.reason) ? c.reason.join("、") : c?.reason || "调仓清算";
      lines.push(`已清仓/调出 ${c?.name || ""}（${c?.code || ""}）约 ${fmtMoney(c?.amount)}，理由：${reason}`);
    });
  }
  if (lines.length === 0) return "未提供（无近期交易与清仓记录）";
  return lines.join("；\n");
}
function buildAnalysisPrompt(data) {
  const account = data.account || {};
  const strategies = Array.isArray(data.strategies) && data.strategies.length > 0 ? data.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n") : "未设置自定义策略。请勿自行编造任何「目标配比」「目标仓位」或「高于/低于目标」等表述；仅基于当前持仓实际构成给出观察类建议。";
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const compact = buildCompactDataBlocks(holdings);
  const COMPACT_NOTE = "读取规则：columns[i] 对应每行第 i 个值，必须先按表头还原字段含义再分析；带Pct后缀的列=百分数数值（-7.36表示-7.36%）；金额单位=人民币元；null=数据缺失，严禁当作0或编造；禁止将不同列的数值混用。";
  const holdingsJsonBlock = compactBlockText(
    "当前持仓明细（columns+rows）",
    compact.holdings,
    `${COMPACT_NOTE} profitRatePct=盈亏率（成本口径=盈亏/成本）；todayEstimatePct=今日估算涨跌；direction=持仓方向/分类。`
  );
  const performanceJsonBlock = compactBlockText(
    "量化表现（performance，真实净值按日历窗口计算）",
    compact.performance,
    `${COMPACT_NOTE} trend: up=上升趋势/sideways=横盘震荡/down=下降趋势/unknown=数据不足；dataAsOf=计算所用净值日期；historyDays=有效交易日数。`
  );
  const benchmarkJsonBlock = compact.benchmark ? compactBlockText(
    "业绩基准对比（benchmark，仅列出已配置基准的基金；未列出的基金未配置基准，严禁默认与沪深300比较）",
    compact.benchmark,
    `${COMPACT_NOTE} bench*=基准同期收益；rel*=相对基准超额（基金-基准）。`
  ) : "";
  const allocationJsonBlock = compactBlockText(
    "基金角色与仓位上限（allocation）",
    compact.allocation,
    `${COMPACT_NOTE} maxAmount=null=无单独上限；overlapWarning: true=与其他持仓存在真实重仓重合/false=无显著重仓重合/null=重合数据不足未判定。`
  );
  const holdingsDetailJsonBlock = compactBlockText(
    "前十大重仓与重合明细（真实报告期数据）",
    compact.holdingsDetail,
    `${COMPACT_NOTE} topHoldings/overlapDetail=紧凑文本串；null=未获取到或未判定，严禁编造。`
  );
  const dataWarningsBlock = Array.isArray(data.dataWarnings) && data.dataWarnings.length > 0 ? `【数据质量警告（以下数据存在可靠性问题，分析时必须考虑，不得忽略）】
${data.dataWarnings.map((w) => `- ${w}`).join("\n")}
` : "";
  const historyBlock = holdings.length ? holdings.map((h) => `${h.code || ""} ${h.name || ""}：${h.historySummary || "未提供"}`).join("\n") : "（无）";
  const ps = data.portfolioSummary;
  const portfolioSummaryBlock = ps ? [
    `权益总持仓目标上限：${ps.equityCap === null || ps.equityCap === void 0 ? "未提供" : fmtMoney(ps.equityCap)}`,
    `核心宽基：${ps.coreIndex || "未指定"}，目标上限 ${ps.coreIndexCap === null || ps.coreIndexCap === void 0 ? "未提供" : fmtMoney(ps.coreIndexCap)}`,
    `回本目标：${ps.recoveryTarget === null || ps.recoveryTarget === void 0 ? "未提供" : fmtMoney(ps.recoveryTarget)}（定义待确认，见下），期限 ${ps.recoveryHorizonMonths === null || ps.recoveryHorizonMonths === void 0 ? "未提供" : `${ps.recoveryHorizonMonths} 个月`}`,
    `可用现金：${ps.cashAvailable === null || ps.cashAvailable === void 0 ? "未提供" : fmtMoney(ps.cashAvailable)}；已实现盈亏：${ps.realizedProfitLoss === null || ps.realizedProfitLoss === void 0 ? "未提供" : fmtMoney(ps.realizedProfitLoss)}`
  ].join("\n") : "未提供";
  const narrative = buildPositionNarrative(holdings, data.closedPositions);
  const combination = data.combinationSummary || "未提供";
  const analysisTable = data.analysisTable && Array.isArray(data.analysisTable.funds) && data.analysisTable.funds.length > 0 ? data.analysisTable : null;
  const tableBlock = analysisTable ? [
    '列说明：amount/cost/profit=金额(元)；profitPct=盈亏率(成本口径=盈亏/成本)；todayPct=今日估算涨跌；1m/3m/6m/1y=近1/3/6/12月收益率；mdd=近1年最大回撤；ddHigh=距近1年高点回撤；trend=趋势(up/sideways/down/unknown)；rel1m/rel6m/rel1y=近1/6/12月相对基准超额；navDate=计算所用净值日期；topHoldings=前十大重仓摘要(最新报告期，"无数据"=未获取到，不要编造)；overlapDetail=与其他持仓基金的重仓重合明细(股票:本x%/彼基金代码 y%，最多3条，"无数据"=未判定或未获取)。百分比已格式化为字符串，「—」= 数据缺失，严禁编造或重复换算。',
    analysisTable.columns.join(" | "),
    ...analysisTable.funds.map((row) => row.join(" | "))
  ].join("\n") : null;
  return `你是一个真正理解这个基金账户“过去发生了什么”的资深投资顾问。你的唯一目标：结合账户历史做判断，并直接给出今天每只基金该怎么操作。少讲废话，把最重要的操作直接给到每只基金。

【当前账户】
账户名：${account.name || "默认账户"}
账户总资产：${fmtMoney(account.totalValue)}
回本目标：${money(account.targetRecovery) > 0 ? fmtMoney(account.targetRecovery) : "未设置"}
用户投资策略（所有建议必须遵守，不得违背）：
${strategies}

【组合策略上限（人工配置，优先级最高）】
${portfolioSummaryBlock}
注意：若回本目标标注「定义待确认」，不要自行解释为已确认的目标，仅在需要时提示用户确认。

${tableBlock ? `【持仓数据表（唯一持仓数据源，列顺序严格对应表头；「—」= 缺失）】
${tableBlock}` : `${holdingsJsonBlock}

${performanceJsonBlock}

${benchmarkJsonBlock}`}

${allocationJsonBlock}
${dataWarningsBlock}【历史与调仓摘要（真实数据，严禁编造；无数据写“未提供”）】
近期交易与清仓推导（已减多少、近期是否加仓）：
${narrative}
${tableBlock ? "" : `
历史净值表现（每只）：
${historyBlock}

${holdingsDetailJsonBlock}`}【组合关系（不要孤立分析一只基金）】
${combination}

【分析纪律（强制）】
1. 对每只基金必须区分三个问题，不得混为一谈：
   - 该基金是否值得继续持有？
   - 当前仓位是否合理？
   - 今天是否适合卖？
   注意：长期应退出 ≠ 今天大跌必须割肉；长期值得持有 ≠ 当前仓位过高时不能减仓。
2. 严禁机械化规则：今天涨→卖、今天跌→减、盈利→止盈、亏损→止损、跌多→补、涨多→卖，一律禁止。必须综合【量化表现（趋势/回撤/波动率）、基准相对表现、基金角色与上限、当前仓位、持仓成本、历史调仓、基金间重合度、用户策略、回本目标、当前市场环境】再给操作。
3. 禁止仅凭以下单一信息给出买卖建议：当日涨跌幅、单只基金浮亏比例、个别股票重合、连续下跌天数、缺少日期的历史净值、不完整或未经验证的新闻。
4. 必须区分以下情形，给出不同结论：
   ① 基金短期回调，但中期趋势尚未破坏（如近3月收益为正、未跌破趋势）→ 不因短期波动减仓；
   ② 中期趋势走弱（近3月/近1年收益显著为负、回撤持续扩大）→ 控制新增仓位；
   ③ 大幅回撤后出现企稳信号但未确认反转 → 观察，不急抄底；
   ④ 基金表现显著弱于其业绩基准 → 说明相对弱势及可能原因；
   ⑤ 基金与其他持仓存在真实风险集中（overlapWarning）→ 作为组合风险提示，说明集中度，不直接等于卖出；若提供 overlapDetail（重合明细），须引用具体重合股票与双方权重说明集中程度，无明细时不得编造具体股票；
   ⑥ 数据不足（historyDays 少、基准未提供、回撤未提供）→ 明确列出缺失项及其影响，可给「观察」结论，不得强行下判断。
5. 基金之间的持仓重合度只能作为组合风险的一项参考，绝不能仅凭「沪深300与某基金存在个别重仓股票重合」就建议减仓沪深300等核心宽基。
6. 核心宽基定位与目标上限是有效策略输入：若 allocation 中某基金 role=核心宽基且设有 maxAmount，任何针对它的减仓建议必须论证「为什么需要调整核心配置本身」（如超过上限、组合暴露失衡），不得以持仓重合为理由。
7. 可以提出持有、观察、补仓、减仓或做T建议，但必须给出具体数据依据、操作条件（如「若反弹至X」或「若跌破前低」）及主要风险。不得因为「每日分析」的要求就强制生成买卖操作；没有值得操作的就明确说「暂不操作」。
8. 若建议减仓，必须明确说明“为什么减这只、而不是另一只”。
9. 尊重账户自身策略，不得仅因某类占比高就机械建议增配债券/稳健资产；须结合整个组合与用户实际策略判断。
10. 评估理由中的数字必须直接引用上方数据，严禁编造未提供的数字；某项数据「未提供」时不得假装它存在。

【输出要求（极简，务必短，减少生成耗时）】
- summary：今日总体判断，最多 3 句话，只说最重要的事，不要展开。
- operations：必须覆盖上方所有持仓基金，每只一条。action 必须从固定词表选取：${ACTION_VERBS.join(" / ")}。
- reason：限 1 句、≤ 15 个汉字的极短说明（例如“仓位过重，逢高减”“长期逻辑弱，择机退”），严禁写成多句长文。
- 用基金真实 code 回填 fundCode。

请严格按照以下 JSON 返回（纯 JSON，不要 markdown、不要 \`\`\`json\`\`\` 块、不要多余文字）：
{
  "summary": "今日总体操作判断（3句以内）",
  "operations": [
    { "fundCode": "基金代码", "action": "动作(固定词表)", "reason": "≤15字极短说明" }
  ]
}
（兼容字段 healthScore / riskScore / rebalanceSuggestion 一律返回 null，不要生成，也不参与任何操作建议。）

用户问题：${data.userQuery || "（无，请给出今日整体操作建议）"}`;
}
function normalizeAnalysis(raw, data) {
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const byCode = {};
  holdings.forEach((h) => {
    if (h && h.code) byCode[String(h.code)] = h;
  });
  const ops = Array.isArray(raw && raw.operations) ? raw.operations : [];
  const suggestions = ops.filter((o) => o && (o.fundCode || o.code)).map((o) => {
    const code = String(o.fundCode || o.code || "");
    const h = byCode[code] || {};
    return {
      fund: o.fund || h.name || code,
      code,
      action: o.action || "观察",
      reason: o.reason || "",
      targetPct: null
    };
  });
  return {
    healthScore: null,
    healthText: "",
    healthColor: "",
    deviationText: "",
    riskScore: null,
    summary: raw && raw.summary || "",
    rebalanceSuggestion: "",
    suggestions
  };
}
async function analyzeWithPrompt(portfolioData, config, chatImpl) {
  const data = portfolioData;
  const prompt = buildAnalysisPrompt(data);
  const text = await chatImpl(prompt, config);
  let clean = (text || "").trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  clean = clean.trim();
  try {
    return normalizeAnalysis(JSON.parse(clean), data);
  } catch (err) {
    console.error("[analysisPrompt] Failed to parse AI response as JSON:", text, err);
    const fallback = {
      healthScore: null,
      healthText: "",
      healthColor: "",
      deviationText: "",
      riskScore: null,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${(text || "").substring(0, 120)}...`,
      rebalanceSuggestion: "",
      suggestions: []
    };
    return fallback;
  }
}
var ACTION_VERBS, ROLE_LABEL;
var init_analysisPrompt = __esm({
  "src/services/ai/analysisPrompt.ts"() {
    ACTION_VERBS = [
      "继续持有",
      "暂不操作",
      "暂不补仓",
      "分批补仓",
      "做T",
      "适量减仓",
      "反弹减仓",
      "反弹退出",
      "退出",
      "观察"
    ];
    ROLE_LABEL = {
      core: "核心宽基",
      growth: "成长配置",
      sector: "行业主题",
      defensive: "防御配置",
      diversifier: "分散配置",
      unknown: "未确认"
    };
  }
});

// src/services/ai/index.ts
var index_exports = {};
__export(index_exports, {
  analyzePortfolio: () => analyzePortfolio6,
  buildAnalysisPrompt: () => buildAnalysisPrompt,
  buildCompactDataBlocks: () => buildCompactDataBlocks,
  chat: () => chat6,
  normalizeAnalysis: () => normalizeAnalysis,
  toCompactRows: () => toCompactRows
});
module.exports = __toCommonJS(index_exports);

// src/services/ai/openai.ts
async function chat(message, config) {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("未配置 OpenAI API Key，请检查环境变量或临时输入");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 11e4);
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model || "gpt-5-mini",
      messages: [
        { role: "user", content: message }
      ],
      temperature: 0.7
    }),
    signal: controller.signal
  });
  clearTimeout(timer);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const code = errorData?.error?.code || errorData?.error?.type || "";
    const message2 = errorData?.error?.message || `HTTP error! status: ${status}`;
    throw new Error(`[${status}${code ? ` ${code}` : ""}] ${message2}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}
async function analyzePortfolio(portfolioData, config) {
  const { buildAnalysisPrompt: buildAnalysisPrompt2, normalizeAnalysis: normalizeAnalysis2 } = (init_analysisPrompt(), __toCommonJS(analysisPrompt_exports));
  const data = portfolioData;
  const prompt = buildAnalysisPrompt2(data);
  const text = await chat(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return normalizeAnalysis2(JSON.parse(cleanText), data);
  } catch (err) {
    console.error("Failed to parse AI response as JSON:", text, err);
    return {
      healthScore: null,
      healthText: "",
      healthColor: "",
      deviationText: "",
      riskScore: null,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/index.ts
init_analysisPrompt();

// src/services/ai/deepseek.ts
async function chat2(message, config) {
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.deepseek.com/v1",
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || "",
    model: config.model || "deepseek-chat"
  };
  return chat(message, mergedConfig);
}
async function analyzePortfolio2(portfolioData, config) {
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.deepseek.com/v1",
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || "",
    model: config.model || "deepseek-chat"
  };
  return analyzePortfolio(portfolioData, mergedConfig);
}

// src/services/ai/kimi.ts
async function chat3(message, config) {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "";
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.moonshot.cn/v1",
    apiKey,
    model: config.model || "moonshot-v1-8k"
  };
  return chat(message, mergedConfig);
}
async function analyzePortfolio3(portfolioData, config) {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "";
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.moonshot.cn/v1",
    apiKey,
    model: config.model || "moonshot-v1-8k"
  };
  return analyzePortfolio(portfolioData, mergedConfig);
}

// src/services/ai/gemini.ts
async function chat4(message, config) {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY || "";
  const model = config.model || "gemini-2.5-pro";
  if (!apiKey) {
    throw new Error("未配置 Gemini API Key，请检查环境变量或临时输入");
  }
  const isCustomBase = config.baseURL && !config.baseURL.includes("generativelanguage.googleapis.com");
  if (isCustomBase) {
    const mergedConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return chat(message, mergedConfig);
  }
  const baseUrl = config.baseURL || "https://generativelanguage.googleapis.com";
  const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: message }
          ]
        }
      ]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Response error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error("Gemini API 未返回有效的 text 字段，请检查输入或模型");
  }
  return textContent;
}
async function analyzePortfolio4(portfolioData, config) {
  const { buildAnalysisPrompt: buildAnalysisPrompt2, normalizeAnalysis: normalizeAnalysis2 } = (init_analysisPrompt(), __toCommonJS(analysisPrompt_exports));
  const data = portfolioData;
  const prompt = buildAnalysisPrompt2(data);
  const text = await chat4(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return normalizeAnalysis2(JSON.parse(cleanText), data);
  } catch (err) {
    console.error("Failed to parse Gemini AI response as JSON:", text, err);
    return {
      healthScore: null,
      healthText: "",
      healthColor: "",
      deviationText: "",
      riskScore: null,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/claude.ts
async function chat5(message, config) {
  const apiKey = config.apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const model = config.model || "claude-3-5-sonnet-latest";
  if (!apiKey) {
    throw new Error("未配置 Claude API Key，请检查环境变量或临时输入");
  }
  const isCustomBase = config.baseURL && !config.baseURL.includes("api.anthropic.com");
  if (isCustomBase) {
    const mergedConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return chat(message, mergedConfig);
  }
  const baseUrl = config.baseURL || "https://api.anthropic.com";
  const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1/messages`;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "user", content: message }
      ]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Response error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textContent = data?.content?.[0]?.text;
  if (!textContent) {
    throw new Error("Claude API 未返回有效的 text 字段");
  }
  return textContent;
}
async function analyzePortfolio5(portfolioData, config) {
  const { buildAnalysisPrompt: buildAnalysisPrompt2, normalizeAnalysis: normalizeAnalysis2 } = (init_analysisPrompt(), __toCommonJS(analysisPrompt_exports));
  const data = portfolioData;
  const prompt = buildAnalysisPrompt2(data);
  const text = await chat5(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return normalizeAnalysis2(JSON.parse(cleanText), data);
  } catch (err) {
    console.error("Failed to parse Claude AI response as JSON:", text, err);
    return {
      healthScore: null,
      healthText: "",
      healthColor: "",
      deviationText: "",
      riskScore: null,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/index.ts
async function chat6(message, config) {
  const provider = (config.provider || "OpenAI").toLowerCase();
  switch (provider) {
    case "openai":
      return chat(message, config);
    case "deepseek":
      return chat2(message, config);
    case "moonshot kimi":
    case "kimi":
      return chat3(message, config);
    case "google gemini":
    case "gemini":
      return chat4(message, config);
    case "claude":
      return chat5(message, config);
    case "自定义 openai compatible":
    case "custom":
      return chat(message, config);
    default:
      throw new Error(`未知的 AI 服务商: ${config.provider}`);
  }
}
async function analyzePortfolio6(portfolioData, config) {
  const provider = (config.provider || "OpenAI").toLowerCase();
  switch (provider) {
    case "openai":
      return analyzePortfolio(portfolioData, config);
    case "deepseek":
      return analyzePortfolio2(portfolioData, config);
    case "moonshot kimi":
    case "kimi":
      return analyzePortfolio3(portfolioData, config);
    case "google gemini":
    case "gemini":
      return analyzePortfolio4(portfolioData, config);
    case "claude":
      return analyzePortfolio5(portfolioData, config);
    case "自定义 openai compatible":
    case "custom":
      return analyzePortfolio(portfolioData, config);
    default:
      throw new Error(`未知的 AI 服务商: ${config.provider}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzePortfolio,
  buildAnalysisPrompt,
  buildCompactDataBlocks,
  chat,
  normalizeAnalysis,
  toCompactRows
});
