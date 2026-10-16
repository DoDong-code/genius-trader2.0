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

export interface AnalysisPerformance {
  return1m?: number | null;
  return3m?: number | null;
  return6m?: number | null;
  return1y?: number | null;
  maxDrawdown1y?: number | null;
  drawdownFromHigh1y?: number | null;
  volatility20d?: number | null;
  trend?: 'up' | 'sideways' | 'down' | 'unknown' | null;
  dataAsOf?: string | null;
  historyDays?: number | null;
}

export interface AnalysisBenchmark {
  name?: string | null;
  return1m?: number | null;
  return3m?: number | null;
  relativeReturn1m?: number | null;
  dataAsOf?: string | null;
  kind?: string | null;
  source?: string | null;
}

export interface AnalysisAllocation {
  role?: string | null;
  sector?: string | null;
  maxAmount?: number | null;
  overlapWarning?: boolean | null;
}

export interface AnalysisPortfolioSummary {
  equityCap?: number | null;
  coreIndex?: string | null;
  coreIndexCap?: number | null;
  recoveryTarget?: number | null;
  recoveryHorizonMonths?: number | null;
  cashAvailable?: number | null;
  realizedProfitLoss?: number | null;
  recoveryDefinitionStatus?: string | null;
}

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
  performance?: AnalysisPerformance | null;
  benchmark?: AnalysisBenchmark | null;
  allocation?: AnalysisAllocation | null;
  transactions?: Array<{ type?: string; date?: string; amount?: number; shares?: number }>;
}

export interface AnalysisAccount {
  name?: string;
  type?: string;
  totalValue?: number;
  targetRecovery?: number;
  maxFunds?: number;
}

export interface AnalysisHoldingsTable {
  date?: string;
  columns: string[];
  funds: Array<Array<string | number | null>>;
}

export interface PortfolioInput {
  account?: AnalysisAccount;
  strategies?: string[];
  strategy?: { core?: string[]; forbidden?: string[]; rules?: string[] };
  portfolioSummary?: AnalysisPortfolioSummary | null;
  holdings?: AnalysisHolding[];
  /** 紧凑数据表（服务端一次性格式化，columns 与 funds 行严格按序对应）；缺失时回退逐基金文本块 */
  analysisTable?: AnalysisHoldingsTable | null;
  closedPositions?: Array<{ name?: string; code?: string; closedBefore?: string; amount?: number; reason?: string | string[] }>;
  combinationSummary?: string;
  totalAssets?: number;
}

// 标准动作词表（约束 AI 输出，保证前端可直接展示）
export const ACTION_VERBS = [
  '继续持有', '暂不操作', '暂不补仓', '分批补仓', '做T', '适量减仓', '反弹减仓', '反弹退出', '退出', '观察'
];

function fmtPct(v: number | string | null | undefined): string {
  // 统一百分比格式：两位小数、正值 +、负值 -、零 0.00%、空 —；
  // 已格式化字符串（±x.xx%）原样返回，禁止二次乘 100。
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[+-]?\d+(?:\.\d+)?\s*%$/.test(s)) {
      const t = s.replace(/\s*%$/, '%');
      return !t.startsWith('-') && !t.startsWith('+') && parseFloat(t) > 0 ? `+${t}` : t;
    }
    if (s === '' ) return '—';
    const n = Number(s);
    if (!Number.isFinite(n)) return '—';
    return fmtPct(n);
  }
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const pct = Number(v) * 100;
  if (pct === 0 || Object.is(pct, -0)) return '0.00%';
  const text = pct.toFixed(2);
  if (parseFloat(text) === 0) return '0.00%';
  return pct > 0 ? `+${text}%` : `-${text.slice(1)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '未提供';
  return `¥${Math.round(Number(v)).toLocaleString('zh-CN')}`;
}

function money(v: number | null | undefined): number {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function fmtNum(v: number | null | undefined): string {
  const n = Number(v);
  return (v === null || v === undefined || !Number.isFinite(n)) ? '未提供' : String(n);
}

/** 趋势与角色等枚举值的安全中文映射（未知原样输出「未提供/unknown」） */
function fmtEnum(v: string | null | undefined, map: Record<string, string>): string {
  if (!v) return '未提供';
  return map[v] || v;
}

const TREND_LABEL: Record<string, string> = {
  up: '上升趋势', sideways: '横盘震荡', down: '下降趋势', unknown: '数据不足(unknown)'
};

const ROLE_LABEL: Record<string, string> = {
  core: '核心宽基', growth: '成长配置', sector: '行业主题',
  defensive: '防御配置', diversifier: '分散配置', unknown: '未确认'
};

function fmtDataAsOf(perf?: AnalysisPerformance | null): string {
  const d = perf && perf.dataAsOf ? String(perf.dataAsOf) : '';
  const days = perf && perf.historyDays !== null && perf.historyDays !== undefined ? Number(perf.historyDays) : null;
  if (!d) return '无有效历史净值';
  return days !== null && Number.isFinite(days) ? `${d}（有效 ${days} 个交易日）` : d;
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

  // —— 数据增强板块：performance（量化表现，后端按日历窗口计算，全部为小数比率） ——
  const performanceBlock = holdings.length
    ? holdings.map(h => {
        const p = h.performance;
        if (!p) return `${h.code || ''} ${h.name || ''}：未提供`;
        return [
          `${h.code || ''} ${h.name || ''}：`,
          `近1月 ${fmtPct(p.return1m)} / 近3月 ${fmtPct(p.return3m)} / 近6月 ${fmtPct(p.return6m)} / 近1年 ${fmtPct(p.return1y)}`,
          `近1年最大回撤 ${fmtPct(p.maxDrawdown1y)} / 当前距1年高点 ${fmtPct(p.drawdownFromHigh1y)} / 20日年化波动率 ${fmtPct(p.volatility20d)}`,
          `趋势 ${fmtEnum(p.trend, TREND_LABEL)}；数据截至 ${fmtDataAsOf(p)}`
        ].join('；');
      }).join('\n')
    : '（无）';

  // —— 数据增强板块：benchmark（业绩基准对比；未配置基准如实标注，严禁默认沪深300） ——
  const benchmarkBlock = holdings.length
    ? holdings.map(h => {
        const b = h.benchmark;
        if (!b || !b.name) return `${h.code || ''} ${h.name || ''}：无可用业绩基准（未提供，不要自行假设基准）`;
        return `${h.code || ''} ${h.name || ''}：基准「${b.name}」（${b.kind === 'official' ? '官方业绩基准' : '辅助分析基准'}）基准近1月 ${fmtPct(b.return1m)} / 近3月 ${fmtPct(b.return3m)}；相对基准近1月超额 ${fmtPct(b.relativeReturn1m)}；基准数据截至 ${b.dataAsOf || '未提供'}`;
      }).join('\n')
    : '（无）';

  // —— 数据增强板块：allocation（基金角色与仓位上限，人工配置优先） ——
  const allocationBlock = holdings.length
    ? holdings.map(h => {
        const a = h.allocation;
        if (!a) return `${h.code || ''} ${h.name || ''}：未提供`;
        const cap = (a.maxAmount === null || a.maxAmount === undefined) ? '无单独上限' : fmtMoney(a.maxAmount);
        const overlap = (a.overlapWarning === null || a.overlapWarning === undefined)
          ? '重合数据不足(未判定)'
          : (a.overlapWarning ? '与组合内其他基金存在真实重仓重合' : '无显著重仓重合');
        return `${h.code || ''} ${h.name || ''}：角色 ${fmtEnum(a.role, ROLE_LABEL)} / 方向 ${a.sector || '未提供'} / 目标上限 ${cap} / ${overlap}`;
      }).join('\n')
    : '（无）';

  const ps = data.portfolioSummary;
  const portfolioSummaryBlock = ps ? [
    `权益总持仓目标上限：${ps.equityCap === null || ps.equityCap === undefined ? '未提供' : fmtMoney(ps.equityCap)}`,
    `核心宽基：${ps.coreIndex || '未指定'}，目标上限 ${ps.coreIndexCap === null || ps.coreIndexCap === undefined ? '未提供' : fmtMoney(ps.coreIndexCap)}`,
    `回本目标：${ps.recoveryTarget === null || ps.recoveryTarget === undefined ? '未提供' : fmtMoney(ps.recoveryTarget)}（定义待确认，见下），期限 ${ps.recoveryHorizonMonths === null || ps.recoveryHorizonMonths === undefined ? '未提供' : `${ps.recoveryHorizonMonths} 个月`}`,
    `可用现金：${ps.cashAvailable === null || ps.cashAvailable === undefined ? '未提供' : fmtMoney(ps.cashAvailable)}；已实现盈亏：${ps.realizedProfitLoss === null || ps.realizedProfitLoss === undefined ? '未提供' : fmtMoney(ps.realizedProfitLoss)}`
  ].join('\n') : '未提供';

  // —— 紧凑数据表（服务端已一次性格式化百分比；缺失时回退旧版逐基金文本块） ——
  const dataTable = (data.analysisTable
    && Array.isArray(data.analysisTable.columns) && data.analysisTable.columns.length > 0
    && Array.isArray(data.analysisTable.funds)) ? data.analysisTable : null;

  const dataTableBlock = dataTable
    ? [
        `date: ${dataTable.date || ''}`,
        `columns: ${dataTable.columns.join(',')}`,
        ...dataTable.funds.map(row => row
          .map(cell => (cell === null || cell === undefined) ? '' : String(cell))
          .join(' | '))
      ].join('\n')
    : null;

  const enhancedBlocks = dataTableBlock
    ? `【持仓数据表（columns 与每行数据严格按序对应；百分比已是格式化字符串："+"正、"-"负、"0.00%"零；"—"=缺失，严禁编造。navDate=正式净值截至日期，不是当日估值。ret1m/ret3m/ret6m/ret1y=近1/3/6/12月收益率，mdd=近1年最大回撤，ddHigh=当前距1年高点跌幅，trend=趋势分类(up/sideways/down/unknown)，bench=业绩基准名称，rel1m=相对基准近1月超额收益）】
${dataTableBlock}`
    : `【量化表现（performance，真实净值按日历窗口计算；「未提供」= 数据不足，严禁编造）】
${performanceBlock}

【业绩基准对比（benchmark；未配置基准的基金严禁默认与沪深300比较）】
${benchmarkBlock}

【历史净值表现（每只）】
${historyBlock}`;

  const narrative = buildPositionNarrative(holdings, data.closedPositions);
  const combination = data.combinationSummary || '未提供';

  return `你是一个真正理解这个基金账户“过去发生了什么”的资深投资顾问。你的唯一目标：结合账户历史做判断，并直接给出今天每只基金该怎么操作。少讲废话，把最重要的操作直接给到每只基金。

【当前账户】
账户名：${account.name || '默认账户'}
账户总资产：${fmtMoney(account.totalValue)}
回本目标：${money(account.targetRecovery) > 0 ? fmtMoney(account.targetRecovery) : '未设置'}
用户投资策略（所有建议必须遵守，不得违背）：
${strategies}

【组合策略上限（人工配置，优先级最高）】
${portfolioSummaryBlock}
注意：若回本目标标注「定义待确认」，不要自行解释为已确认的目标，仅在需要时提示用户确认。

【当前持仓（金额 / 成本 / 盈亏 / 今日）】
${holdingsTable}

${enhancedBlocks}

【基金角色与仓位上限（allocation，人工配置优先；overlap 由真实持仓计算）】
${allocationBlock}

【历史与调仓摘要（真实数据，严禁编造；无数据写“未提供”）】
近期交易与清仓推导（已减多少、近期是否加仓）：
${narrative}

【组合关系（不要孤立分析一只基金）】
${combination}

【分析纪律（强制）】
1. 对每只基金必须区分三个问题，不得混为一谈：
   - 该基金是否值得继续持有？
   - 当前仓位是否合理？
   - 今天是否适合卖？
   注意：长期应退出 ≠ 今天大跌必须割肉；长期值得持有 ≠ 当前仓位过高时不能减仓。
2. 严禁机械化规则：今天涨→卖、今天跌→减、盈利→止盈、亏损→止损、跌多→补、涨多→卖，一律禁止。必须综合【持仓数据表（趋势/回撤/周期收益/基准超额）、基金角色与上限、当前仓位、持仓成本、历史调仓、基金间重合度、用户策略、回本目标、当前市场环境】再给操作。
3. 禁止仅凭以下单一信息给出买卖建议：当日涨跌幅、单只基金浮亏比例、个别股票重合、连续下跌天数、缺少日期的历史净值、不完整或未经验证的新闻。
4. 必须区分以下情形，给出不同结论：
   ① 基金短期回调，但中期趋势尚未破坏（如近3月收益为正、未跌破趋势）→ 不因短期波动减仓；
   ② 中期趋势走弱（近3月/近1年收益显著为负、回撤持续扩大）→ 控制新增仓位；
   ③ 大幅回撤后出现企稳信号但未确认反转 → 观察，不急抄底；
   ④ 基金表现显著弱于其业绩基准 → 说明相对弱势及可能原因；
   ⑤ 基金与其他持仓存在真实风险集中（overlapWarning）→ 作为组合风险提示，说明集中度，不直接等于卖出；
   ⑥ 数据不足（historyDays 少、基准未提供、回撤未提供）→ 明确列出缺失项及其影响，可给「观察」结论，不得强行下判断。
5. 基金之间的持仓重合度只能作为组合风险的一项参考，绝不能仅凭「沪深300与某基金存在个别重仓股票重合」就建议减仓沪深300等核心宽基。
6. 核心宽基定位与目标上限是有效策略输入：若 allocation 中某基金 role=核心宽基且设有 maxAmount，任何针对它的减仓建议必须论证「为什么需要调整核心配置本身」（如超过上限、组合暴露失衡），不得以持仓重合为理由。
7. 可以提出持有、观察、补仓、减仓或做T建议，但必须给出具体数据依据、操作条件（如「若反弹至X」或「若跌破前低」）及主要风险。不得因为「每日分析」的要求就强制生成买卖操作；没有值得操作的就明确说「暂不操作」。
8. 若建议减仓，必须明确说明“为什么减这只、而不是另一只”。
9. 尊重账户自身策略，不得仅因某类占比高就机械建议增配债券/稳健资产；须结合整个组合与用户实际策略判断。
10. 评估理由中的数字必须直接引用上方数据，严禁编造未提供的数字；某项数据「未提供」时不得假装它存在。

【输出要求（极简，务必短，减少生成耗时）】
- summary：今日总体判断，最多 3 句话，只说最重要的事，不要展开。
- operations：必须覆盖上方所有持仓基金，每只一条。action 必须从固定词表选取：${ACTION_VERBS.join(' / ')}。
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
