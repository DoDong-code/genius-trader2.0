import { AIConfig, PortfolioData, AnalysisResponse, chat as openAIChat, analyzePortfolio as openAIAnalyze } from './openai';

export async function chat(message: string, config: AIConfig): Promise<string> {
  const mergedConfig: AIConfig = {
    ...config,
    baseURL: config.baseURL || 'https://api.deepseek.com/v1',
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: config.model || 'deepseek-chat'
  };
  return openAIChat(message, mergedConfig);
}

export async function analyzePortfolio(portfolioData: PortfolioData, config: AIConfig): Promise<AnalysisResponse> {
  const mergedConfig: AIConfig = {
    ...config,
    baseURL: config.baseURL || 'https://api.deepseek.com/v1',
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: config.model || 'deepseek-chat'
  };
  return openAIAnalyze(portfolioData, mergedConfig);
}
