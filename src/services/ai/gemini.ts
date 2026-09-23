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
    console.error('Failed to parse Gemini AI response as JSON:', text, err);
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
