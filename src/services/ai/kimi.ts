import { AIConfig, PortfolioData, AnalysisResponse, chat as openAIChat, analyzePortfolio as openAIAnalyze } from './openai';

export async function chat(message: string, config: AIConfig): Promise<string> {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '';
  const mergedConfig: AIConfig = {
    ...config,
    baseURL: config.baseURL || 'https://api.moonshot.cn/v1',
    apiKey,
    model: config.model || 'moonshot-v1-8k'
  };
  return openAIChat(message, mergedConfig);
}

export async function analyzePortfolio(portfolioData: PortfolioData, config: AIConfig): Promise<AnalysisResponse> {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '';
  const mergedConfig: AIConfig = {
    ...config,
    baseURL: config.baseURL || 'https://api.moonshot.cn/v1',
    apiKey,
    model: config.model || 'moonshot-v1-8k'
  };
  return openAIAnalyze(portfolioData, mergedConfig);
}
