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

// genius-trader2.0/src/services/ai/analysisPrompt.ts
var analysisPrompt_exports = {};
__export(analysisPrompt_exports, {
  ACTION_VERBS: () => ACTION_VERBS,
  analyzeWithPrompt: () => analyzeWithPrompt,
  buildAnalysisPrompt: () => buildAnalysisPrompt,
  normalizeAnalysis: () => normalizeAnalysis
});
function fmtPct(v) {
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return "\u672A\u63D0\u4F9B";
  return `${(Number(v) * 100).toFixed(2)}%`;
}
function fmtMoney(v) {
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return "\u672A\u63D0\u4F9B";
  return `\xA5${Math.round(Number(v)).toLocaleString("zh-CN")}`;
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
    const tail = `${h.name || h.code || ""}\uFF08${h.code || ""}\uFF09\uFF1A\u8FD1\u671F\u4E70\u5165\u7EA6 ${fmtMoney(buyAmt)}\u3001\u5356\u51FA\u7EA6 ${fmtMoney(sellAmt)}`;
    lines.push(tail);
  });
  if (Array.isArray(closedPositions) && closedPositions.length > 0) {
    closedPositions.slice(-6).forEach((c) => {
      const reason = Array.isArray(c?.reason) ? c.reason.join("\u3001") : c?.reason || "\u8C03\u4ED3\u6E05\u7B97";
      lines.push(`\u5DF2\u6E05\u4ED3/\u8C03\u51FA ${c?.name || ""}\uFF08${c?.code || ""}\uFF09\u7EA6 ${fmtMoney(c?.amount)}\uFF0C\u7406\u7531\uFF1A${reason}`);
    });
  }
  if (lines.length === 0) return "\u672A\u63D0\u4F9B\uFF08\u65E0\u8FD1\u671F\u4EA4\u6613\u4E0E\u6E05\u4ED3\u8BB0\u5F55\uFF09";
  return lines.join("\uFF1B\n");
}
function buildAnalysisPrompt(data) {
  const account = data.account || {};
  const strategies = Array.isArray(data.strategies) && data.strategies.length > 0 ? data.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n") : "\u672A\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u7B56\u7565\u3002\u8BF7\u52FF\u81EA\u884C\u7F16\u9020\u4EFB\u4F55\u300C\u76EE\u6807\u914D\u6BD4\u300D\u300C\u76EE\u6807\u4ED3\u4F4D\u300D\u6216\u300C\u9AD8\u4E8E/\u4F4E\u4E8E\u76EE\u6807\u300D\u7B49\u8868\u8FF0\uFF1B\u4EC5\u57FA\u4E8E\u5F53\u524D\u6301\u4ED3\u5B9E\u9645\u6784\u6210\u7ED9\u51FA\u89C2\u5BDF\u7C7B\u5EFA\u8BAE\u3002";
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const holdingsTable = holdings.length ? holdings.map(
    (h) => `${h.code || ""} | ${h.name || ""} | \u91D1\u989D ${fmtMoney(h.amount)} | \u6210\u672C ${fmtMoney(h.cost)} | \u76C8\u4E8F ${fmtMoney(h.profit)} | \u76C8\u4E8F\u7387 ${fmtPct(h.profitRate)} | \u4ECA\u65E5\u4F30\u7B97 ${fmtPct(h.todayEstimate)} | \u89D2\u8272 ${h.direction || h.type || "\u672A\u63D0\u4F9B"}`
  ).join("\n") : "\uFF08\u65E0\u6301\u4ED3\uFF09";
  const historyBlock = holdings.length ? holdings.map((h) => `${h.code || ""} ${h.name || ""}\uFF1A${h.historySummary || "\u672A\u63D0\u4F9B"}`).join("\n") : "\uFF08\u65E0\uFF09";
  const narrative = buildPositionNarrative(holdings, data.closedPositions);
  const combination = data.combinationSummary || "\u672A\u63D0\u4F9B";
  return `\u4F60\u662F\u4E00\u4E2A\u771F\u6B63\u7406\u89E3\u8FD9\u4E2A\u57FA\u91D1\u8D26\u6237\u201C\u8FC7\u53BB\u53D1\u751F\u4E86\u4EC0\u4E48\u201D\u7684\u8D44\u6DF1\u6295\u8D44\u987E\u95EE\u3002\u4F60\u7684\u552F\u4E00\u76EE\u6807\uFF1A\u7ED3\u5408\u8D26\u6237\u5386\u53F2\u505A\u5224\u65AD\uFF0C\u5E76\u76F4\u63A5\u7ED9\u51FA\u4ECA\u5929\u6BCF\u53EA\u57FA\u91D1\u8BE5\u600E\u4E48\u64CD\u4F5C\u3002\u5C11\u8BB2\u5E9F\u8BDD\uFF0C\u628A\u6700\u91CD\u8981\u7684\u64CD\u4F5C\u76F4\u63A5\u7ED9\u5230\u6BCF\u53EA\u57FA\u91D1\u3002

\u3010\u5F53\u524D\u8D26\u6237\u3011
\u8D26\u6237\u540D\uFF1A${account.name || "\u9ED8\u8BA4\u8D26\u6237"}
\u8D26\u6237\u603B\u8D44\u4EA7\uFF1A${fmtMoney(account.totalValue)}
\u56DE\u672C\u76EE\u6807\uFF1A${money(account.targetRecovery) > 0 ? fmtMoney(account.targetRecovery) : "\u672A\u8BBE\u7F6E"}
\u7528\u6237\u6295\u8D44\u7B56\u7565\uFF08\u6240\u6709\u5EFA\u8BAE\u5FC5\u987B\u9075\u5B88\uFF0C\u4E0D\u5F97\u8FDD\u80CC\uFF09\uFF1A
${strategies}

\u3010\u5F53\u524D\u6301\u4ED3\uFF08\u91D1\u989D / \u6210\u672C / \u76C8\u4E8F / \u4ECA\u65E5\uFF09\u3011
${holdingsTable}

\u3010\u5386\u53F2\u4E0E\u8C03\u4ED3\u6458\u8981\uFF08\u771F\u5B9E\u6570\u636E\uFF0C\u4E25\u7981\u7F16\u9020\uFF1B\u65E0\u6570\u636E\u5199\u201C\u672A\u63D0\u4F9B\u201D\uFF09\u3011
\u8FD1\u671F\u4EA4\u6613\u4E0E\u6E05\u4ED3\u63A8\u5BFC\uFF08\u5DF2\u51CF\u591A\u5C11\u3001\u8FD1\u671F\u662F\u5426\u52A0\u4ED3\uFF09\uFF1A
${narrative}

\u5386\u53F2\u51C0\u503C\u8868\u73B0\uFF08\u6BCF\u53EA\uFF09\uFF1A
${historyBlock}

\u3010\u7EC4\u5408\u5173\u7CFB\uFF08\u4E0D\u8981\u5B64\u7ACB\u5206\u6790\u4E00\u53EA\u57FA\u91D1\uFF09\u3011
${combination}

\u3010\u5206\u6790\u7EAA\u5F8B\uFF08\u5F3A\u5236\uFF09\u3011
1. \u5BF9\u6BCF\u53EA\u57FA\u91D1\u5FC5\u987B\u533A\u5206\u4E09\u4E2A\u95EE\u9898\uFF0C\u4E0D\u5F97\u6DF7\u4E3A\u4E00\u8C08\uFF1A
   - \u8BE5\u57FA\u91D1\u662F\u5426\u503C\u5F97\u7EE7\u7EED\u6301\u6709\uFF1F
   - \u5F53\u524D\u4ED3\u4F4D\u662F\u5426\u5408\u7406\uFF1F
   - \u4ECA\u5929\u662F\u5426\u9002\u5408\u5356\uFF1F
   \u6CE8\u610F\uFF1A\u957F\u671F\u5E94\u9000\u51FA \u2260 \u4ECA\u5929\u5927\u8DCC\u5FC5\u987B\u5272\u8089\uFF1B\u957F\u671F\u503C\u5F97\u6301\u6709 \u2260 \u5F53\u524D\u4ED3\u4F4D\u8FC7\u9AD8\u65F6\u4E0D\u80FD\u51CF\u4ED3\u3002
2. \u4E25\u7981\u673A\u68B0\u5316\u89C4\u5219\uFF1A\u4ECA\u5929\u6DA8\u2192\u5356\u3001\u4ECA\u5929\u8DCC\u2192\u51CF\u3001\u76C8\u5229\u2192\u6B62\u76C8\u3001\u4E8F\u635F\u2192\u6B62\u635F\u3001\u8DCC\u591A\u2192\u8865\u3001\u6DA8\u591A\u2192\u5356\uFF0C\u4E00\u5F8B\u7981\u6B62\u3002\u5FC5\u987B\u7EFC\u5408\u3010\u5386\u53F2\u8D8B\u52BF\u3001\u5F53\u524D\u4ED3\u4F4D\u3001\u6301\u4ED3\u6210\u672C\u3001\u5386\u53F2\u8C03\u4ED3\u3001\u57FA\u91D1\u89D2\u8272\u3001\u57FA\u91D1\u95F4\u91CD\u590D\u5EA6\u3001\u7528\u6237\u7B56\u7565\u3001\u56DE\u672C\u76EE\u6807\u3001\u5F53\u524D\u5E02\u573A\u73AF\u5883\u3011\u518D\u7ED9\u64CD\u4F5C\u3002
3. \u82E5\u5EFA\u8BAE\u51CF\u4ED3\uFF0C\u5FC5\u987B\u660E\u786E\u8BF4\u660E\u201C\u4E3A\u4EC0\u4E48\u51CF\u8FD9\u53EA\u3001\u800C\u4E0D\u662F\u53E6\u4E00\u53EA\u201D\u3002
4. \u5C0A\u91CD\u8D26\u6237\u81EA\u8EAB\u7B56\u7565\uFF0C\u4E0D\u5F97\u4EC5\u56E0\u67D0\u7C7B\u5360\u6BD4\u9AD8\u5C31\u673A\u68B0\u5EFA\u8BAE\u589E\u914D\u503A\u5238/\u7A33\u5065\u8D44\u4EA7\uFF1B\u987B\u7ED3\u5408\u6574\u4E2A\u7EC4\u5408\u4E0E\u7528\u6237\u5B9E\u9645\u7B56\u7565\u5224\u65AD\u3002
5. \u8BC4\u4F30\u7406\u7531\u4E2D\u7684\u6570\u5B57\u5FC5\u987B\u76F4\u63A5\u5F15\u7528\u4E0A\u65B9\u6570\u636E\uFF0C\u4E25\u7981\u7F16\u9020\u672A\u63D0\u4F9B\u7684\u6570\u5B57\u3002

\u3010\u8F93\u51FA\u8981\u6C42\uFF08\u6781\u7B80\uFF0C\u52A1\u5FC5\u77ED\uFF0C\u51CF\u5C11\u751F\u6210\u8017\u65F6\uFF09\u3011
- summary\uFF1A\u4ECA\u65E5\u603B\u4F53\u5224\u65AD\uFF0C\u6700\u591A 3 \u53E5\u8BDD\uFF0C\u53EA\u8BF4\u6700\u91CD\u8981\u7684\u4E8B\uFF0C\u4E0D\u8981\u5C55\u5F00\u3002
- operations\uFF1A\u5FC5\u987B\u8986\u76D6\u4E0A\u65B9\u6240\u6709\u6301\u4ED3\u57FA\u91D1\uFF0C\u6BCF\u53EA\u4E00\u6761\u3002action \u5FC5\u987B\u4ECE\u56FA\u5B9A\u8BCD\u8868\u9009\u53D6\uFF1A${ACTION_VERBS.join(" / ")}\u3002
- reason\uFF1A\u9650 1 \u53E5\u3001\u2264 15 \u4E2A\u6C49\u5B57\u7684\u6781\u77ED\u8BF4\u660E\uFF08\u4F8B\u5982\u201C\u4ED3\u4F4D\u8FC7\u91CD\uFF0C\u9022\u9AD8\u51CF\u201D\u201C\u957F\u671F\u903B\u8F91\u5F31\uFF0C\u62E9\u673A\u9000\u201D\uFF09\uFF0C\u4E25\u7981\u5199\u6210\u591A\u53E5\u957F\u6587\u3002
- \u7528\u57FA\u91D1\u771F\u5B9E code \u56DE\u586B fundCode\u3002

\u8BF7\u4E25\u683C\u6309\u7167\u4EE5\u4E0B JSON \u8FD4\u56DE\uFF08\u7EAF JSON\uFF0C\u4E0D\u8981 markdown\u3001\u4E0D\u8981 \`\`\`json\`\`\` \u5757\u3001\u4E0D\u8981\u591A\u4F59\u6587\u5B57\uFF09\uFF1A
{
  "summary": "\u4ECA\u65E5\u603B\u4F53\u64CD\u4F5C\u5224\u65AD\uFF083\u53E5\u4EE5\u5185\uFF09",
  "operations": [
    { "fundCode": "\u57FA\u91D1\u4EE3\u7801", "action": "\u52A8\u4F5C(\u56FA\u5B9A\u8BCD\u8868)", "reason": "\u226415\u5B57\u6781\u77ED\u8BF4\u660E" }
  ]
}
\uFF08\u517C\u5BB9\u5B57\u6BB5 healthScore / riskScore / rebalanceSuggestion \u4E00\u5F8B\u8FD4\u56DE null\uFF0C\u4E0D\u8981\u751F\u6210\uFF0C\u4E5F\u4E0D\u53C2\u4E0E\u4EFB\u4F55\u64CD\u4F5C\u5EFA\u8BAE\u3002\uFF09

\u7528\u6237\u95EE\u9898\uFF1A${data.userQuery || "\uFF08\u65E0\uFF0C\u8BF7\u7ED9\u51FA\u4ECA\u65E5\u6574\u4F53\u64CD\u4F5C\u5EFA\u8BAE\uFF09"}`;
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
      action: o.action || "\u89C2\u5BDF",
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
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${(text || "").substring(0, 120)}...`,
      rebalanceSuggestion: "",
      suggestions: []
    };
    return fallback;
  }
}
var ACTION_VERBS;
var init_analysisPrompt = __esm({
  "genius-trader2.0/src/services/ai/analysisPrompt.ts"() {
    ACTION_VERBS = [
      "\u7EE7\u7EED\u6301\u6709",
      "\u6682\u4E0D\u64CD\u4F5C",
      "\u6682\u4E0D\u8865\u4ED3",
      "\u5206\u6279\u8865\u4ED3",
      "\u9002\u91CF\u51CF\u4ED3",
      "\u53CD\u5F39\u51CF\u4ED3",
      "\u53CD\u5F39\u9000\u51FA",
      "\u9000\u51FA",
      "\u89C2\u5BDF"
    ];
  }
});

// genius-trader2.0/src/services/ai/index.ts
var index_exports = {};
__export(index_exports, {
  analyzePortfolio: () => analyzePortfolio6,
  chat: () => chat6
});
module.exports = __toCommonJS(index_exports);

// genius-trader2.0/src/services/ai/openai.ts
async function chat(message, config) {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E OpenAI API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
  }
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
    })
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `HTTP error! status: ${response.status}`);
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
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// genius-trader2.0/src/services/ai/deepseek.ts
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

// genius-trader2.0/src/services/ai/kimi.ts
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

// genius-trader2.0/src/services/ai/gemini.ts
async function chat4(message, config) {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY || "";
  const model = config.model || "gemini-2.5-pro";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E Gemini API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
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
    throw new Error("Gemini API \u672A\u8FD4\u56DE\u6709\u6548\u7684 text \u5B57\u6BB5\uFF0C\u8BF7\u68C0\u67E5\u8F93\u5165\u6216\u6A21\u578B");
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
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// genius-trader2.0/src/services/ai/claude.ts
async function chat5(message, config) {
  const apiKey = config.apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const model = config.model || "claude-3-5-sonnet-latest";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E Claude API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
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
    throw new Error("Claude API \u672A\u8FD4\u56DE\u6709\u6548\u7684 text \u5B57\u6BB5");
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
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// genius-trader2.0/src/services/ai/index.ts
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
    case "\u81EA\u5B9A\u4E49 openai compatible":
    case "custom":
      return chat(message, config);
    default:
      throw new Error(`\u672A\u77E5\u7684 AI \u670D\u52A1\u5546: ${config.provider}`);
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
    case "\u81EA\u5B9A\u4E49 openai compatible":
    case "custom":
      return analyzePortfolio(portfolioData, config);
    default:
      throw new Error(`\u672A\u77E5\u7684 AI \u670D\u52A1\u5546: ${config.provider}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzePortfolio,
  chat
});
