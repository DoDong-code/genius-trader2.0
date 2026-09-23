import { AIConfig, PortfolioData, AnalysisResponse, chat as openAIChat, analyzePortfolio as openAIAnalyze } from './openai';

export async function chat(message: string, config: AIConfig): Promise<string> {
  const apiKey = config.apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const model = config.model || 'claude-3-5-sonnet-latest';

  if (!apiKey) {
    throw new Error('未配置 Claude API Key，请检查环境变量或临时输入');
  }

  const isCustomBase = config.baseURL && !config.baseURL.includes('api.anthropic.com');

  if (isCustomBase) {
    const mergedConfig: AIConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return openAIChat(message, mergedConfig);
  }

  const baseUrl = config.baseURL || 'https://api.anthropic.com';
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1/messages`;

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'user', content: message }
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
    throw new Error('Claude API 未返回有效的 text 字段');
  }

  return textContent;
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
    console.error('Failed to parse Claude AI response as JSON:', text, err);
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
