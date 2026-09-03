import { AIConfig, PortfolioData, AnalysisResponse, chat as openAIChat, analyzePortfolio as openAIAnalyze } from './openai';

export async function chat(message: string, config: AIConfig): Promise<string> {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
  const model = config.model || 'gemini-2.5-pro';
  
  if (!apiKey) {
    throw new Error('未配置 Gemini API Key，请检查环境变量或临时输入');
  }

  const isCustomBase = config.baseURL && !config.baseURL.includes('generativelanguage.googleapis.com');
  
  // If user provided a custom OpenAI-compatible base URL for Gemini, use OpenAI client format
  if (isCustomBase) {
    const mergedConfig: AIConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return openAIChat(message, mergedConfig);
  }

  // Otherwise, use Gemini's standard REST API
  // default base URL: https://generativelanguage.googleapis.com
  const baseUrl = config.baseURL || 'https://generativelanguage.googleapis.com';
  // Standard endpoint: POST /v1beta/models/{model}:generateContent?key={apiKey}
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
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
    throw new Error('Gemini API 未返回有效的 text 字段，请检查输入或模型');
  }

  return textContent;
}

export async function analyzePortfolio(portfolioData: PortfolioData, config: AIConfig): Promise<AnalysisResponse> {
  const prompt = `你是一个专业的基金投资顾问。请分析以下持仓基金数据，评估整体风险，并给出具体的投资建议、目标仓位及操作行动。
重要要求：评估理由中的任何数字（涨跌幅、金额、收益率等）必须直接引用上方持仓数据中提供的数值，严禁自行编造或推断未提供的数字；如果数据中没有相关数值，请写“未提供”。
账户定位参考：上方持仓数据中 account.name 可能包含「-权益」「-债」「-混合」等后缀，代表用户设定的账户定位（预期类型）。请以账户定位为基准评估组合是否匹配：若实际持仓大类与定位明显偏离（如权益账户高仓位债券、债券账户高仓位权益），必须在 deviationText 和 rebalanceSuggestion 中明确指出「定位偏离」，并相应调整风险评分与调仓建议；不得仅凭实际持仓构成给账户贴上与定位不符的标签。
持仓基金数据：
${JSON.stringify(portfolioData, null, 2)}

你当前的投资纪律核心策略（必须作为所有建议的重要参考与约束，所有操作建议均不得违背这些纪律）：
${portfolioData.strategies && portfolioData.strategies.length > 0
  ? portfolioData.strategies.map((s, i) => `${i + 1}. ${s}`).join('\n')
  : '未设置自定义策略。请勿自行编造任何「目标配比」「目标仓位」或「高于/低于目标」等表述；仅基于当前持仓实际构成给出观察类建议（如行业集中度、回撤、相关性、单一品种占比等），不要给出再平衡/调仓目标。'}

请严格按照以下 JSON 格式进行回复（不要包含任何 markdown 标记、\`\`\`json 块、多余文字或注释，确保其为可以直接解析的纯 JSON 对象）：
{
  "healthScore": 组合健康度分值 (0-100的数字),
  "healthText": "组合健康度状态评价 (如配置极佳、配置良好、配比一般、亟待调整等短语)",
  "healthColor": "状态颜色代码 (如 #34a853 代表极佳/良好, #ff9500 代表一般, #ff3b30 代表较差)",
  "deviationText": "大类资产偏离状态说明 (根据你对该组合各大类偏离情况的专业评价)",
  "riskScore": 评估风险分值 (0-100的数字),
  "summary": "今日操作建议的总结 (结合投资纪律核心策略，用一句话概括今天最应执行的操作与纪律提醒)",
  "suggestions": [
    {
      "fund": "基金名称",
      "code": "基金代码",
      "action": "建议的操作：如持有、加仓、减仓、赎回等",
      "reason": "具体的操作理由 and 分析",
      "targetPct": 建议的目标仓位百分比数值 (0-100的数字)。仅当上方用户自定义策略能明确推导该基金的目标配比时填写具体数值；未设置自定义策略、或策略无法推导目标配比时，一律填 null，严禁编造数字。
    }
  ]
}`;

  const text = await chat(prompt, config);
  
  // Clean potential markdown wrappers
  let cleanText = text.trim();
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
  }
  cleanText = cleanText.trim();

  try {
    return JSON.parse(cleanText) as AnalysisResponse;
  } catch (err) {
    console.error('Failed to parse Gemini AI response as JSON:', text, err);
    // Return fallback structure
    return {
      healthScore: 60,
      healthText: "需要调整",
      healthColor: "#ff3b30",
      deviationText: "无法获取 AI 诊断结果，显示本地估算",
      riskScore: 50,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}
