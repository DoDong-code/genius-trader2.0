import { AIConfig, PortfolioData, AnalysisResponse } from './openai';
import { buildAnalysisPrompt, normalizeAnalysis, buildCompactDataBlocks, toCompactRows } from './analysisPrompt';
import * as openai from './openai';
import * as deepseek from './deepseek';
import * as kimi from './kimi';
import * as gemini from './gemini';
import * as claude from './claude';

export { AIConfig, PortfolioData, AnalysisResponse };
// AI 输入适配层导出（紧凑 columns+rows 转换与 prompt 构造，供服务端/测试复用）
export { buildAnalysisPrompt, normalizeAnalysis, buildCompactDataBlocks, toCompactRows };

export async function chat(message: string, config: AIConfig): Promise<string> {
  const provider = (config.provider || 'OpenAI').toLowerCase();

  switch (provider) {
    case 'openai':
      return openai.chat(message, config);
    case 'deepseek':
      return deepseek.chat(message, config);
    case 'moonshot kimi':
    case 'kimi':
      return kimi.chat(message, config);
    case 'google gemini':
    case 'gemini':
      return gemini.chat(message, config);
    case 'claude':
      return claude.chat(message, config);
    case '自定义 openai compatible':
    case 'custom':
      // Custom OpenAI Compatible uses standard openai client
      return openai.chat(message, config);
    default:
      throw new Error(`未知的 AI 服务商: ${config.provider}`);
  }
}

export async function analyzePortfolio(portfolioData: PortfolioData, config: AIConfig): Promise<AnalysisResponse> {
  const provider = (config.provider || 'OpenAI').toLowerCase();

  switch (provider) {
    case 'openai':
      return openai.analyzePortfolio(portfolioData, config);
    case 'deepseek':
      return deepseek.analyzePortfolio(portfolioData, config);
    case 'moonshot kimi':
    case 'kimi':
      return kimi.analyzePortfolio(portfolioData, config);
    case 'google gemini':
    case 'gemini':
      return gemini.analyzePortfolio(portfolioData, config);
    case 'claude':
      return claude.analyzePortfolio(portfolioData, config);
    case '自定义 openai compatible':
    case 'custom':
      return openai.analyzePortfolio(portfolioData, config);
    default:
      throw new Error(`未知的 AI 服务商: ${config.provider}`);
  }
}
