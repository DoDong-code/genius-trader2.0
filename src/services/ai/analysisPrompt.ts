import { AIConfig, PortfolioData, AnalysisResponse } from './openai';

/**
 * 统一 AI 分析 Prompt 构造器（Web + 小程序共用同一套判断逻辑）
 *
 * 设计目标（对齐需求）：
 * - AI 真正理解账户历史（成本 / 交易 / 调仓 / 净值走势 / 仓位形成）
 * - 区分「是否值得持有 / 仓位是否合理 / 今天是否适合卖」三问
 * - 禁止机械化涨跌规则、禁止自动债券/稳健建议
 * - 要求极简输出 + 标准动作词 + 结构化 operations
 * - 取消健康度/风险评分的生成（保留字段为 null，不参与判断、不展示）
 */

export interface AnalysisHolding {
  code?: string;
  name?: string;
  amount?: number;
  cost?: number;
  profit?: number;
  profitRate?: number;
  todayEstimate?: number;
  type?: string;
  direction?: string;
  positionType?: string;
  historySummary?: string;
  transactions?: Array<{ type?: string; date?: string; amount?: number; shares?: number }>;
}

export interface AnalysisAccount {
  name?: string;
  type?: string;
  totalValue?: number;
  targetRecovery?: number;
  maxFunds?: number;
}

export interface PortfolioInput {
  account?: AnalysisAccount;
  strategies?: string[];
  strategy?: { core?: string[]; forbidden?: string[]; rules?: string[] };
  holdings?: AnalysisHolding[];
  closedPositions?: Array<{ name?: string; code?: string; closedBefore?: string; amount?: number; reason?: string | string[] }>;
  combinationSummary?: string;
  totalAssets?: number;
}

// 标准动作词表（约束 AI 输出，保证前端可直接展示）
export const ACTION_VERBS = [
  '继续持有', '暂不操作', '暂不补仓', '分批补仓', '适量减仓', '反弹减仓', '反弹退出', '退出', '观察'
];

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '未提供';
  return `${(Number(v) * 100).toFixed(2)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '未提供';
  return `¥${Math.round(Number(v)).toLocaleString('zh-CN')}`;
}

function money(v: number | null | undefined): number {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * 由交易记录 + 清仓记录推导「仓位形成说明」（已减多少、近期是否加仓）
 * 纯后端只读推导，不编造。
 */
function buildPositionNarrative(
  holdings: AnalysisHolding[],
  closedPositions: PortfolioInput['closedPositions']
): string {
  const lines: string[] = [];
  holdings.forEach(h => {
    const txs = Array.isArray(h.transactions) ? h.transactions : [];
    if (txs.length === 0) return;
    const buys = txs.filter(t => /买|加|申购|定投|入/i.test(t.type || ''));
    const sells = txs.filter(t => /卖|减|赎|出|清/i.test(t.type || ''));
    const buyAmt = buys.reduce((s, t) => s + money(t.amount), 0);
    const sellAmt = sells.reduce((s, t) => s + money(t.amount), 0);
    const tail = `${h.name || h.code || ''}（${h.code || ''}）：近期买入约 ${fmtMoney(buyAmt)}、卖出约 ${fmtMoney(sellAmt)}`;
    lines.push(tail);
  });
  if (Array.isArray(closedPositions) && closedPositions.length > 0) {
    closedPositions.slice(-6).forEach(c => {
      const reason = Array.isArray(c?.reason) ? c!.reason!.join('、') : (c?.reason || '调仓清算');
      lines.push(`已清仓/调出 ${c?.name || ''}（${c?.code || ''}）约 ${fmtMoney(c?.amount)}，理由：${reason}`);
    });
  }
  if (lines.length === 0) return '未提供（无近期交易与清仓记录）';
  return lines.join('；\n');
}

export function buildAnalysisPrompt(data: PortfolioInput): string {
  const account = data.account || {};
  const strategies = Array.isArray(data.strategies) && data.strategies.length > 0
    ? data.strategies.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '未设置自定义策略。请勿自行编造任何「目标配比」「目标仓位」或「高于/低于目标」等表述；仅基于当前持仓实际构成给出观察类建议。';

  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const holdingsTable = holdings.length
    ? holdings.map(h =>
        `${h.code || ''} | ${h.name || ''} | 金额 ${fmtMoney(h.amount)} | 成本 ${fmtMoney(h.cost)} | 盈亏 ${fmtMoney(h.profit)} | 盈亏率 ${fmtPct(h.profitRate)} | 今日估算 ${fmtPct(h.todayEstimate)} | 角色 ${h.direction || h.type || '未提供'}`
      ).join('\n')
    : '（无持仓）';

  const historyBlock = holdings.length
    ? holdings.map(h => `${h.code || ''} ${h.name || ''}：${h.historySummary || '未提供'}`).join('\n')
    : '（无）';

  const narrative = buildPositionNarrative(holdings, data.closedPositions);
  const combination = data.combinationSummary || '未提供';

  return `你是一个真正理解这个基金账户“过去发生了什么”的资深投资顾问。你的唯一目标：结合账户历史做判断，并直接给出今天每只基金该怎么操作。少讲废话，把最重要的操作直接给到每只基金。

【当前账户】
账户名：${account.name || '默认账户'}
账户总资产：${fmtMoney(account.totalValue)}
回本目标：${money(account.targetRecovery) > 0 ? fmtMoney(account.targetRecovery) : '未设置'}
用户投资策略（所有建议必须遵守，不得违背）：
${strategies}

【当前持仓（金额 / 成本 / 盈亏 / 今日）】
${holdingsTable}

【历史与调仓摘要（真实数据，严禁编造；无数据写“未提供”）】
近期交易与清仓推导（已减多少、近期是否加仓）：
${narrative}

历史净值表现（每只）：
${historyBlock}

【组合关系（不要孤立分析一只基金）】
${combination}

【分析纪律（强制）】
1. 对每只基金必须区分三个问题，不得混为一谈：
   - 该基金是否值得继续持有？
   - 当前仓位是否合理？
   - 今天是否适合卖？
   注意：长期应退出 ≠ 今天大跌必须割肉；长期值得持有 ≠ 当前仓位过高时不能减仓。
2. 严禁机械化规则：今天涨→卖、今天跌→减、盈利→止盈、亏损→止损、跌多→补、涨多→卖，一律禁止。必须综合【历史趋势、当前仓位、持仓成本、历史调仓、基金角色、基金间重复度、用户策略、回本目标、当前市场环境】再给操作。
3. 若建议减仓，必须明确说明“为什么减这只、而不是另一只”。
4. 尊重账户自身策略，不得仅因某类占比高就机械建议增配债券/稳健资产；须结合整个组合与用户实际策略判断。
5. 评估理由中的数字必须直接引用上方数据，严禁编造未提供的数字。

【输出要求（极简）】
- summary：今日总体判断，最多 3-4 句话，只说最重要的事。
- operations：必须覆盖上方所有持仓基金，每只一条。action 必须从固定词表选取：${ACTION_VERBS.join(' / ')}；reason 最多 1-2 句话。
- 用基金真实 code 回填 fundCode。

请严格按照以下 JSON 返回（纯 JSON，不要 markdown、不要 \`\`\`json\`\`\` 块、不要多余文字）：
{
  "summary": "今日总体操作判断（3-4句）",
  "operations": [
    { "fundCode": "基金代码", "action": "动作(固定词表)", "reason": "1-2句理由" }
  ]
}
（兼容字段 healthScore / riskScore / rebalanceSuggestion 一律返回 null，不要生成，也不参与任何操作建议。）

用户问题：${data.userQuery || '（无，请给出今日整体操作建议）'}`;
}

/**
 * 把 AI 原始返回归一化为 AnalysisResponse（供 Web / 小程序现有客户端消费）：
 * - 将 operations[].fundCode 映射为 suggestions[].code
 * - 用真实持仓补齐 fund 名称
 * - healthScore / riskScore 固定为 null（不参与判断、不展示）
 */
export function normalizeAnalysis(raw: any, data: PortfolioInput): AnalysisResponse {
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const byCode: Record<string, AnalysisHolding> = {};
  holdings.forEach(h => { if (h && h.code) byCode[String(h.code)] = h; });

  const ops = Array.isArray(raw && raw.operations) ? raw.operations : [];
  const suggestions = ops
    .filter((o: any) => o && (o.fundCode || o.code))
    .map((o: any) => {
      const code = String(o.fundCode || o.code || '');
      const h = byCode[code] || {};
      return {
        fund: o.fund || h.name || code,
        code,
        action: o.action || '观察',
        reason: o.reason || '',
        targetPct: null
      };
    });

  return {
    healthScore: null as any,
    healthText: '',
    healthColor: '',
    deviationText: '',
    riskScore: null as any,
    summary: (raw && raw.summary) || '',
    rebalanceSuggestion: '',
    suggestions
  };
}

// 兼容：让 index.ts 的 analyzePortfolio 也能直接调用（如需要）
export async function analyzeWithPrompt(portfolioData: PortfolioData, config: AIConfig, chatImpl: (m: string, c: AIConfig) => Promise<string>): Promise<AnalysisResponse> {
  const data = portfolioData as unknown as PortfolioInput;
  const prompt = buildAnalysisPrompt(data);
  const text = await chatImpl(prompt, config);
  let clean = (text || '').trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
  }
  clean = clean.trim();
  try {
    return normalizeAnalysis(JSON.parse(clean), data);
  } catch (err) {
    console.error('[analysisPrompt] Failed to parse AI response as JSON:', text, err);
    const fallback: AnalysisResponse = {
      healthScore: null as any,
      healthText: '',
      healthColor: '',
      deviationText: '',
      riskScore: null as any,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${(text || '').substring(0, 120)}...`,
      rebalanceSuggestion: '',
      suggestions: []
    };
    return fallback;
  }
}
