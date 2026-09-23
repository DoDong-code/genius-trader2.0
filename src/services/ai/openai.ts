export interface AIConfig {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  model: string;
}

export interface PortfolioData {
  account: string;
  strategies?: string[];
  holdings: Array<{
    name: string;
    code: string;
    amount: number | string;
    profit: number | string;
    today_change: number | string;
  }>;
}

export interface AnalysisResponse {
  healthScore: number | null;
  healthText: string;
  healthColor: string;
  deviationText: string;
  riskScore: number | null;
  summary: string;
  rebalanceSuggestion?: string;
  suggestions: Array<{
    fund: string;
    code: string;
    action: string;
    reason: string;
    targetPct?: number | null;
  }>;
}

export async function chat(message: string, config: AIConfig): Promise<string> {
  const baseURL = config.baseURL || 'https://api.openai.com/v1';
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
  
  if (!apiKey) {
    throw new Error('未配置 OpenAI API Key，请检查环境变量或临时输入');
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model || 'gpt-5-mini',
      messages: [
        { role: 'user', content: message }
      ],
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

export async function analyzePortfolio(portfolioData: PortfolioData, config: AIConfig): Promise<AnalysisResponse> {
  const { buildAnalysisPrompt, normalizeAnalysis } = require('./analysisPrompt');
  const data = portfolioData as unknown as import('./analysisPrompt').PortfolioInput;
  const prompt = buildAnalysisPrompt(data);

  const text = await chat(prompt, config);

  // Clean potential markdown wrappers
  let cleanText = text.trim();
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
  }
  cleanText = cleanText.trim();

  try {
    return normalizeAnalysis(JSON.parse(cleanText), data);
  } catch (err) {
    console.error('Failed to parse AI response as JSON:', text, err);
    // Return fallback structure
    return {
      healthScore: null,
      healthText: '',
      healthColor: '',
      deviationText: '',
      riskScore: null,
      summary: `无法解析 AI 返回的 JSON 数据。AI 原始回复: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}
