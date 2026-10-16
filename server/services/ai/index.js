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
  normalizeAnalysis: () => normalizeAnalysis
});
function fmtPct(v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?\d+(?:\.\d+)?\s*%$/.test(s)) {
      const t = s.replace(/\s*%$/, "%");
      return !t.startsWith("-") && !t.startsWith("+") && parseFloat(t) > 0 ? `+${t}` : t;
    }
    if (s === "") return "\u2014";
    const n = Number(s);
    if (!Number.isFinite(n)) return "\u2014";
    return fmtPct(n);
  }
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return "\u2014";
  const pct = Number(v) * 100;
  if (pct === 0 || Object.is(pct, -0)) return "0.00%";
  const text = pct.toFixed(2);
  if (parseFloat(text) === 0) return "0.00%";
  return pct > 0 ? `+${text}%` : `-${text.slice(1)}%`;
}
function fmtMoney(v) {
  if (v === null || v === void 0 || !Number.isFinite(Number(v))) return "\u672A\u63D0\u4F9B";
  return `\xA5${Math.round(Number(v)).toLocaleString("zh-CN")}`;
}
function money(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}
function fmtEnum(v, map) {
  if (!v) return "\u672A\u63D0\u4F9B";
  return map[v] || v;
}
function fmtDataAsOf(perf) {
  const d = perf && perf.dataAsOf ? String(perf.dataAsOf) : "";
  const days = perf && perf.historyDays !== null && perf.historyDays !== void 0 ? Number(perf.historyDays) : null;
  if (!d) return "\u65E0\u6709\u6548\u5386\u53F2\u51C0\u503C";
  return days !== null && Number.isFinite(days) ? `${d}\uFF08\u6709\u6548 ${days} \u4E2A\u4EA4\u6613\u65E5\uFF09` : d;
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
  const performanceBlock = holdings.length ? holdings.map((h) => {
    const p = h.performance;
    if (!p) return `${h.code || ""} ${h.name || ""}\uFF1A\u672A\u63D0\u4F9B`;
    return [
      `${h.code || ""} ${h.name || ""}\uFF1A`,
      `\u8FD11\u6708 ${fmtPct(p.return1m)} / \u8FD13\u6708 ${fmtPct(p.return3m)} / \u8FD16\u6708 ${fmtPct(p.return6m)} / \u8FD11\u5E74 ${fmtPct(p.return1y)}`,
      `\u8FD11\u5E74\u6700\u5927\u56DE\u64A4 ${fmtPct(p.maxDrawdown1y)} / \u5F53\u524D\u8DDD1\u5E74\u9AD8\u70B9 ${fmtPct(p.drawdownFromHigh1y)} / 20\u65E5\u5E74\u5316\u6CE2\u52A8\u7387 ${fmtPct(p.volatility20d)}`,
      `\u8D8B\u52BF ${fmtEnum(p.trend, TREND_LABEL)}\uFF1B\u6570\u636E\u622A\u81F3 ${fmtDataAsOf(p)}`
    ].join("\uFF1B");
  }).join("\n") : "\uFF08\u65E0\uFF09";
  const benchmarkBlock = holdings.length ? holdings.map((h) => {
    const b = h.benchmark;
    if (!b || !b.name) return `${h.code || ""} ${h.name || ""}\uFF1A\u65E0\u53EF\u7528\u4E1A\u7EE9\u57FA\u51C6\uFF08\u672A\u63D0\u4F9B\uFF0C\u4E0D\u8981\u81EA\u884C\u5047\u8BBE\u57FA\u51C6\uFF09`;
    return `${h.code || ""} ${h.name || ""}\uFF1A\u57FA\u51C6\u300C${b.name}\u300D\uFF08${b.kind === "official" ? "\u5B98\u65B9\u4E1A\u7EE9\u57FA\u51C6" : "\u8F85\u52A9\u5206\u6790\u57FA\u51C6"}\uFF09\u57FA\u51C6\u8FD11\u6708 ${fmtPct(b.return1m)} / \u8FD13\u6708 ${fmtPct(b.return3m)}\uFF1B\u76F8\u5BF9\u57FA\u51C6\u8FD11\u6708\u8D85\u989D ${fmtPct(b.relativeReturn1m)}\uFF1B\u57FA\u51C6\u6570\u636E\u622A\u81F3 ${b.dataAsOf || "\u672A\u63D0\u4F9B"}`;
  }).join("\n") : "\uFF08\u65E0\uFF09";
  const allocationBlock = holdings.length ? holdings.map((h) => {
    const a = h.allocation;
    if (!a) return `${h.code || ""} ${h.name || ""}\uFF1A\u672A\u63D0\u4F9B`;
    const cap = a.maxAmount === null || a.maxAmount === void 0 ? "\u65E0\u5355\u72EC\u4E0A\u9650" : fmtMoney(a.maxAmount);
    const overlap = a.overlapWarning === null || a.overlapWarning === void 0 ? "\u91CD\u5408\u6570\u636E\u4E0D\u8DB3(\u672A\u5224\u5B9A)" : a.overlapWarning ? "\u4E0E\u7EC4\u5408\u5185\u5176\u4ED6\u57FA\u91D1\u5B58\u5728\u771F\u5B9E\u91CD\u4ED3\u91CD\u5408" : "\u65E0\u663E\u8457\u91CD\u4ED3\u91CD\u5408";
    return `${h.code || ""} ${h.name || ""}\uFF1A\u89D2\u8272 ${fmtEnum(a.role, ROLE_LABEL)} / \u65B9\u5411 ${a.sector || "\u672A\u63D0\u4F9B"} / \u76EE\u6807\u4E0A\u9650 ${cap} / ${overlap}`;
  }).join("\n") : "\uFF08\u65E0\uFF09";
  const ps = data.portfolioSummary;
  const portfolioSummaryBlock = ps ? [
    `\u6743\u76CA\u603B\u6301\u4ED3\u76EE\u6807\u4E0A\u9650\uFF1A${ps.equityCap === null || ps.equityCap === void 0 ? "\u672A\u63D0\u4F9B" : fmtMoney(ps.equityCap)}`,
    `\u6838\u5FC3\u5BBD\u57FA\uFF1A${ps.coreIndex || "\u672A\u6307\u5B9A"}\uFF0C\u76EE\u6807\u4E0A\u9650 ${ps.coreIndexCap === null || ps.coreIndexCap === void 0 ? "\u672A\u63D0\u4F9B" : fmtMoney(ps.coreIndexCap)}`,
    `\u56DE\u672C\u76EE\u6807\uFF1A${ps.recoveryTarget === null || ps.recoveryTarget === void 0 ? "\u672A\u63D0\u4F9B" : fmtMoney(ps.recoveryTarget)}\uFF08\u5B9A\u4E49\u5F85\u786E\u8BA4\uFF0C\u89C1\u4E0B\uFF09\uFF0C\u671F\u9650 ${ps.recoveryHorizonMonths === null || ps.recoveryHorizonMonths === void 0 ? "\u672A\u63D0\u4F9B" : `${ps.recoveryHorizonMonths} \u4E2A\u6708`}`,
    `\u53EF\u7528\u73B0\u91D1\uFF1A${ps.cashAvailable === null || ps.cashAvailable === void 0 ? "\u672A\u63D0\u4F9B" : fmtMoney(ps.cashAvailable)}\uFF1B\u5DF2\u5B9E\u73B0\u76C8\u4E8F\uFF1A${ps.realizedProfitLoss === null || ps.realizedProfitLoss === void 0 ? "\u672A\u63D0\u4F9B" : fmtMoney(ps.realizedProfitLoss)}`
  ].join("\n") : "\u672A\u63D0\u4F9B";
  const dataTable = data.analysisTable && Array.isArray(data.analysisTable.columns) && data.analysisTable.columns.length > 0 && Array.isArray(data.analysisTable.funds) ? data.analysisTable : null;
  const dataTableBlock = dataTable ? [
    `date: ${dataTable.date || ""}`,
    `columns: ${dataTable.columns.join(",")}`,
    ...dataTable.funds.map((row) => row.map((cell) => cell === null || cell === void 0 ? "" : String(cell)).join(" | "))
  ].join("\n") : null;
  const enhancedBlocks = dataTableBlock ? `\u3010\u6301\u4ED3\u6570\u636E\u8868\uFF08columns \u4E0E\u6BCF\u884C\u6570\u636E\u4E25\u683C\u6309\u5E8F\u5BF9\u5E94\uFF1B\u767E\u5206\u6BD4\u5DF2\u662F\u683C\u5F0F\u5316\u5B57\u7B26\u4E32\uFF1A"+"\u6B63\u3001"-"\u8D1F\u3001"0.00%"\u96F6\uFF1B"\u2014"=\u7F3A\u5931\uFF0C\u4E25\u7981\u7F16\u9020\u3002navDate=\u6B63\u5F0F\u51C0\u503C\u622A\u81F3\u65E5\u671F\uFF0C\u4E0D\u662F\u5F53\u65E5\u4F30\u503C\u3002ret1m/ret3m/ret6m/ret1y=\u8FD11/3/6/12\u6708\u6536\u76CA\u7387\uFF0Cmdd=\u8FD11\u5E74\u6700\u5927\u56DE\u64A4\uFF0CddHigh=\u5F53\u524D\u8DDD1\u5E74\u9AD8\u70B9\u8DCC\u5E45\uFF0Ctrend=\u8D8B\u52BF\u5206\u7C7B(up/sideways/down/unknown)\uFF0Cbench=\u4E1A\u7EE9\u57FA\u51C6\u540D\u79F0\uFF0Crel1m=\u76F8\u5BF9\u57FA\u51C6\u8FD11\u6708\u8D85\u989D\u6536\u76CA\uFF09\u3011
${dataTableBlock}` : `\u3010\u91CF\u5316\u8868\u73B0\uFF08performance\uFF0C\u771F\u5B9E\u51C0\u503C\u6309\u65E5\u5386\u7A97\u53E3\u8BA1\u7B97\uFF1B\u300C\u672A\u63D0\u4F9B\u300D= \u6570\u636E\u4E0D\u8DB3\uFF0C\u4E25\u7981\u7F16\u9020\uFF09\u3011
${performanceBlock}

\u3010\u4E1A\u7EE9\u57FA\u51C6\u5BF9\u6BD4\uFF08benchmark\uFF1B\u672A\u914D\u7F6E\u57FA\u51C6\u7684\u57FA\u91D1\u4E25\u7981\u9ED8\u8BA4\u4E0E\u6CAA\u6DF1300\u6BD4\u8F83\uFF09\u3011
${benchmarkBlock}

\u3010\u5386\u53F2\u51C0\u503C\u8868\u73B0\uFF08\u6BCF\u53EA\uFF09\u3011
${historyBlock}`;
  const narrative = buildPositionNarrative(holdings, data.closedPositions);
  const combination = data.combinationSummary || "\u672A\u63D0\u4F9B";
  return `\u4F60\u662F\u4E00\u4E2A\u771F\u6B63\u7406\u89E3\u8FD9\u4E2A\u57FA\u91D1\u8D26\u6237\u201C\u8FC7\u53BB\u53D1\u751F\u4E86\u4EC0\u4E48\u201D\u7684\u8D44\u6DF1\u6295\u8D44\u987E\u95EE\u3002\u4F60\u7684\u552F\u4E00\u76EE\u6807\uFF1A\u7ED3\u5408\u8D26\u6237\u5386\u53F2\u505A\u5224\u65AD\uFF0C\u5E76\u76F4\u63A5\u7ED9\u51FA\u4ECA\u5929\u6BCF\u53EA\u57FA\u91D1\u8BE5\u600E\u4E48\u64CD\u4F5C\u3002\u5C11\u8BB2\u5E9F\u8BDD\uFF0C\u628A\u6700\u91CD\u8981\u7684\u64CD\u4F5C\u76F4\u63A5\u7ED9\u5230\u6BCF\u53EA\u57FA\u91D1\u3002

\u3010\u5F53\u524D\u8D26\u6237\u3011
\u8D26\u6237\u540D\uFF1A${account.name || "\u9ED8\u8BA4\u8D26\u6237"}
\u8D26\u6237\u603B\u8D44\u4EA7\uFF1A${fmtMoney(account.totalValue)}
\u56DE\u672C\u76EE\u6807\uFF1A${money(account.targetRecovery) > 0 ? fmtMoney(account.targetRecovery) : "\u672A\u8BBE\u7F6E"}
\u7528\u6237\u6295\u8D44\u7B56\u7565\uFF08\u6240\u6709\u5EFA\u8BAE\u5FC5\u987B\u9075\u5B88\uFF0C\u4E0D\u5F97\u8FDD\u80CC\uFF09\uFF1A
${strategies}

\u3010\u7EC4\u5408\u7B56\u7565\u4E0A\u9650\uFF08\u4EBA\u5DE5\u914D\u7F6E\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8\uFF09\u3011
${portfolioSummaryBlock}
\u6CE8\u610F\uFF1A\u82E5\u56DE\u672C\u76EE\u6807\u6807\u6CE8\u300C\u5B9A\u4E49\u5F85\u786E\u8BA4\u300D\uFF0C\u4E0D\u8981\u81EA\u884C\u89E3\u91CA\u4E3A\u5DF2\u786E\u8BA4\u7684\u76EE\u6807\uFF0C\u4EC5\u5728\u9700\u8981\u65F6\u63D0\u793A\u7528\u6237\u786E\u8BA4\u3002

\u3010\u5F53\u524D\u6301\u4ED3\uFF08\u91D1\u989D / \u6210\u672C / \u76C8\u4E8F / \u4ECA\u65E5\uFF09\u3011
${holdingsTable}

${enhancedBlocks}

\u3010\u57FA\u91D1\u89D2\u8272\u4E0E\u4ED3\u4F4D\u4E0A\u9650\uFF08allocation\uFF0C\u4EBA\u5DE5\u914D\u7F6E\u4F18\u5148\uFF1Boverlap \u7531\u771F\u5B9E\u6301\u4ED3\u8BA1\u7B97\uFF09\u3011
${allocationBlock}

\u3010\u5386\u53F2\u4E0E\u8C03\u4ED3\u6458\u8981\uFF08\u771F\u5B9E\u6570\u636E\uFF0C\u4E25\u7981\u7F16\u9020\uFF1B\u65E0\u6570\u636E\u5199\u201C\u672A\u63D0\u4F9B\u201D\uFF09\u3011
\u8FD1\u671F\u4EA4\u6613\u4E0E\u6E05\u4ED3\u63A8\u5BFC\uFF08\u5DF2\u51CF\u591A\u5C11\u3001\u8FD1\u671F\u662F\u5426\u52A0\u4ED3\uFF09\uFF1A
${narrative}

\u3010\u7EC4\u5408\u5173\u7CFB\uFF08\u4E0D\u8981\u5B64\u7ACB\u5206\u6790\u4E00\u53EA\u57FA\u91D1\uFF09\u3011
${combination}

\u3010\u5206\u6790\u7EAA\u5F8B\uFF08\u5F3A\u5236\uFF09\u3011
1. \u5BF9\u6BCF\u53EA\u57FA\u91D1\u5FC5\u987B\u533A\u5206\u4E09\u4E2A\u95EE\u9898\uFF0C\u4E0D\u5F97\u6DF7\u4E3A\u4E00\u8C08\uFF1A
   - \u8BE5\u57FA\u91D1\u662F\u5426\u503C\u5F97\u7EE7\u7EED\u6301\u6709\uFF1F
   - \u5F53\u524D\u4ED3\u4F4D\u662F\u5426\u5408\u7406\uFF1F
   - \u4ECA\u5929\u662F\u5426\u9002\u5408\u5356\uFF1F
   \u6CE8\u610F\uFF1A\u957F\u671F\u5E94\u9000\u51FA \u2260 \u4ECA\u5929\u5927\u8DCC\u5FC5\u987B\u5272\u8089\uFF1B\u957F\u671F\u503C\u5F97\u6301\u6709 \u2260 \u5F53\u524D\u4ED3\u4F4D\u8FC7\u9AD8\u65F6\u4E0D\u80FD\u51CF\u4ED3\u3002
2. \u4E25\u7981\u673A\u68B0\u5316\u89C4\u5219\uFF1A\u4ECA\u5929\u6DA8\u2192\u5356\u3001\u4ECA\u5929\u8DCC\u2192\u51CF\u3001\u76C8\u5229\u2192\u6B62\u76C8\u3001\u4E8F\u635F\u2192\u6B62\u635F\u3001\u8DCC\u591A\u2192\u8865\u3001\u6DA8\u591A\u2192\u5356\uFF0C\u4E00\u5F8B\u7981\u6B62\u3002\u5FC5\u987B\u7EFC\u5408\u3010\u6301\u4ED3\u6570\u636E\u8868\uFF08\u8D8B\u52BF/\u56DE\u64A4/\u5468\u671F\u6536\u76CA/\u57FA\u51C6\u8D85\u989D\uFF09\u3001\u57FA\u91D1\u89D2\u8272\u4E0E\u4E0A\u9650\u3001\u5F53\u524D\u4ED3\u4F4D\u3001\u6301\u4ED3\u6210\u672C\u3001\u5386\u53F2\u8C03\u4ED3\u3001\u57FA\u91D1\u95F4\u91CD\u5408\u5EA6\u3001\u7528\u6237\u7B56\u7565\u3001\u56DE\u672C\u76EE\u6807\u3001\u5F53\u524D\u5E02\u573A\u73AF\u5883\u3011\u518D\u7ED9\u64CD\u4F5C\u3002
3. \u7981\u6B62\u4EC5\u51ED\u4EE5\u4E0B\u5355\u4E00\u4FE1\u606F\u7ED9\u51FA\u4E70\u5356\u5EFA\u8BAE\uFF1A\u5F53\u65E5\u6DA8\u8DCC\u5E45\u3001\u5355\u53EA\u57FA\u91D1\u6D6E\u4E8F\u6BD4\u4F8B\u3001\u4E2A\u522B\u80A1\u7968\u91CD\u5408\u3001\u8FDE\u7EED\u4E0B\u8DCC\u5929\u6570\u3001\u7F3A\u5C11\u65E5\u671F\u7684\u5386\u53F2\u51C0\u503C\u3001\u4E0D\u5B8C\u6574\u6216\u672A\u7ECF\u9A8C\u8BC1\u7684\u65B0\u95FB\u3002
4. \u5FC5\u987B\u533A\u5206\u4EE5\u4E0B\u60C5\u5F62\uFF0C\u7ED9\u51FA\u4E0D\u540C\u7ED3\u8BBA\uFF1A
   \u2460 \u57FA\u91D1\u77ED\u671F\u56DE\u8C03\uFF0C\u4F46\u4E2D\u671F\u8D8B\u52BF\u5C1A\u672A\u7834\u574F\uFF08\u5982\u8FD13\u6708\u6536\u76CA\u4E3A\u6B63\u3001\u672A\u8DCC\u7834\u8D8B\u52BF\uFF09\u2192 \u4E0D\u56E0\u77ED\u671F\u6CE2\u52A8\u51CF\u4ED3\uFF1B
   \u2461 \u4E2D\u671F\u8D8B\u52BF\u8D70\u5F31\uFF08\u8FD13\u6708/\u8FD11\u5E74\u6536\u76CA\u663E\u8457\u4E3A\u8D1F\u3001\u56DE\u64A4\u6301\u7EED\u6269\u5927\uFF09\u2192 \u63A7\u5236\u65B0\u589E\u4ED3\u4F4D\uFF1B
   \u2462 \u5927\u5E45\u56DE\u64A4\u540E\u51FA\u73B0\u4F01\u7A33\u4FE1\u53F7\u4F46\u672A\u786E\u8BA4\u53CD\u8F6C \u2192 \u89C2\u5BDF\uFF0C\u4E0D\u6025\u6284\u5E95\uFF1B
   \u2463 \u57FA\u91D1\u8868\u73B0\u663E\u8457\u5F31\u4E8E\u5176\u4E1A\u7EE9\u57FA\u51C6 \u2192 \u8BF4\u660E\u76F8\u5BF9\u5F31\u52BF\u53CA\u53EF\u80FD\u539F\u56E0\uFF1B
   \u2464 \u57FA\u91D1\u4E0E\u5176\u4ED6\u6301\u4ED3\u5B58\u5728\u771F\u5B9E\u98CE\u9669\u96C6\u4E2D\uFF08overlapWarning\uFF09\u2192 \u4F5C\u4E3A\u7EC4\u5408\u98CE\u9669\u63D0\u793A\uFF0C\u8BF4\u660E\u96C6\u4E2D\u5EA6\uFF0C\u4E0D\u76F4\u63A5\u7B49\u4E8E\u5356\u51FA\uFF1B
   \u2465 \u6570\u636E\u4E0D\u8DB3\uFF08historyDays \u5C11\u3001\u57FA\u51C6\u672A\u63D0\u4F9B\u3001\u56DE\u64A4\u672A\u63D0\u4F9B\uFF09\u2192 \u660E\u786E\u5217\u51FA\u7F3A\u5931\u9879\u53CA\u5176\u5F71\u54CD\uFF0C\u53EF\u7ED9\u300C\u89C2\u5BDF\u300D\u7ED3\u8BBA\uFF0C\u4E0D\u5F97\u5F3A\u884C\u4E0B\u5224\u65AD\u3002
5. \u57FA\u91D1\u4E4B\u95F4\u7684\u6301\u4ED3\u91CD\u5408\u5EA6\u53EA\u80FD\u4F5C\u4E3A\u7EC4\u5408\u98CE\u9669\u7684\u4E00\u9879\u53C2\u8003\uFF0C\u7EDD\u4E0D\u80FD\u4EC5\u51ED\u300C\u6CAA\u6DF1300\u4E0E\u67D0\u57FA\u91D1\u5B58\u5728\u4E2A\u522B\u91CD\u4ED3\u80A1\u7968\u91CD\u5408\u300D\u5C31\u5EFA\u8BAE\u51CF\u4ED3\u6CAA\u6DF1300\u7B49\u6838\u5FC3\u5BBD\u57FA\u3002
6. \u6838\u5FC3\u5BBD\u57FA\u5B9A\u4F4D\u4E0E\u76EE\u6807\u4E0A\u9650\u662F\u6709\u6548\u7B56\u7565\u8F93\u5165\uFF1A\u82E5 allocation \u4E2D\u67D0\u57FA\u91D1 role=\u6838\u5FC3\u5BBD\u57FA\u4E14\u8BBE\u6709 maxAmount\uFF0C\u4EFB\u4F55\u9488\u5BF9\u5B83\u7684\u51CF\u4ED3\u5EFA\u8BAE\u5FC5\u987B\u8BBA\u8BC1\u300C\u4E3A\u4EC0\u4E48\u9700\u8981\u8C03\u6574\u6838\u5FC3\u914D\u7F6E\u672C\u8EAB\u300D\uFF08\u5982\u8D85\u8FC7\u4E0A\u9650\u3001\u7EC4\u5408\u66B4\u9732\u5931\u8861\uFF09\uFF0C\u4E0D\u5F97\u4EE5\u6301\u4ED3\u91CD\u5408\u4E3A\u7406\u7531\u3002
7. \u53EF\u4EE5\u63D0\u51FA\u6301\u6709\u3001\u89C2\u5BDF\u3001\u8865\u4ED3\u3001\u51CF\u4ED3\u6216\u505AT\u5EFA\u8BAE\uFF0C\u4F46\u5FC5\u987B\u7ED9\u51FA\u5177\u4F53\u6570\u636E\u4F9D\u636E\u3001\u64CD\u4F5C\u6761\u4EF6\uFF08\u5982\u300C\u82E5\u53CD\u5F39\u81F3X\u300D\u6216\u300C\u82E5\u8DCC\u7834\u524D\u4F4E\u300D\uFF09\u53CA\u4E3B\u8981\u98CE\u9669\u3002\u4E0D\u5F97\u56E0\u4E3A\u300C\u6BCF\u65E5\u5206\u6790\u300D\u7684\u8981\u6C42\u5C31\u5F3A\u5236\u751F\u6210\u4E70\u5356\u64CD\u4F5C\uFF1B\u6CA1\u6709\u503C\u5F97\u64CD\u4F5C\u7684\u5C31\u660E\u786E\u8BF4\u300C\u6682\u4E0D\u64CD\u4F5C\u300D\u3002
8. \u82E5\u5EFA\u8BAE\u51CF\u4ED3\uFF0C\u5FC5\u987B\u660E\u786E\u8BF4\u660E\u201C\u4E3A\u4EC0\u4E48\u51CF\u8FD9\u53EA\u3001\u800C\u4E0D\u662F\u53E6\u4E00\u53EA\u201D\u3002
9. \u5C0A\u91CD\u8D26\u6237\u81EA\u8EAB\u7B56\u7565\uFF0C\u4E0D\u5F97\u4EC5\u56E0\u67D0\u7C7B\u5360\u6BD4\u9AD8\u5C31\u673A\u68B0\u5EFA\u8BAE\u589E\u914D\u503A\u5238/\u7A33\u5065\u8D44\u4EA7\uFF1B\u987B\u7ED3\u5408\u6574\u4E2A\u7EC4\u5408\u4E0E\u7528\u6237\u5B9E\u9645\u7B56\u7565\u5224\u65AD\u3002
10. \u8BC4\u4F30\u7406\u7531\u4E2D\u7684\u6570\u5B57\u5FC5\u987B\u76F4\u63A5\u5F15\u7528\u4E0A\u65B9\u6570\u636E\uFF0C\u4E25\u7981\u7F16\u9020\u672A\u63D0\u4F9B\u7684\u6570\u5B57\uFF1B\u67D0\u9879\u6570\u636E\u300C\u672A\u63D0\u4F9B\u300D\u65F6\u4E0D\u5F97\u5047\u88C5\u5B83\u5B58\u5728\u3002

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
var ACTION_VERBS, TREND_LABEL, ROLE_LABEL;
var init_analysisPrompt = __esm({
  "src/services/ai/analysisPrompt.ts"() {
    ACTION_VERBS = [
      "\u7EE7\u7EED\u6301\u6709",
      "\u6682\u4E0D\u64CD\u4F5C",
      "\u6682\u4E0D\u8865\u4ED3",
      "\u5206\u6279\u8865\u4ED3",
      "\u505AT",
      "\u9002\u91CF\u51CF\u4ED3",
      "\u53CD\u5F39\u51CF\u4ED3",
      "\u53CD\u5F39\u9000\u51FA",
      "\u9000\u51FA",
      "\u89C2\u5BDF"
    ];
    TREND_LABEL = {
      up: "\u4E0A\u5347\u8D8B\u52BF",
      sideways: "\u6A2A\u76D8\u9707\u8361",
      down: "\u4E0B\u964D\u8D8B\u52BF",
      unknown: "\u6570\u636E\u4E0D\u8DB3(unknown)"
    };
    ROLE_LABEL = {
      core: "\u6838\u5FC3\u5BBD\u57FA",
      growth: "\u6210\u957F\u914D\u7F6E",
      sector: "\u884C\u4E1A\u4E3B\u9898",
      defensive: "\u9632\u5FA1\u914D\u7F6E",
      diversifier: "\u5206\u6563\u914D\u7F6E",
      unknown: "\u672A\u786E\u8BA4"
    };
  }
});

// src/services/ai/index.ts
var index_exports = {};
__export(index_exports, {
  analyzePortfolio: () => analyzePortfolio6,
  chat: () => chat6
});
module.exports = __toCommonJS(index_exports);

// src/services/ai/openai.ts
async function chat(message, config) {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E OpenAI API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
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
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

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

// src/services/ai/claude.ts
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
