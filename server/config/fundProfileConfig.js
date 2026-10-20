/**
 * 基金档案配置（人工配置优先，代码不自动改写）
 *
 * 规则（对齐需求 §七）：
 *  - role 只能由人工配置给出；未配置的基金 role 一律 'unknown'，禁止只凭基金名称推断。
 *  - maxAmount 为经过明确配置的单只基金目标金额上限；没有单独上限时为 null。
 *  - benchmark 为「有明确来源的辅助分析基准」（ETF 跟踪指数代理），
 *    kind 固定 'auxiliary'；官方业绩比较基准暂未从数据源可靠获取，禁止伪造。
 *    没有配置基准的基金一律返回 null，绝不默认与沪深300比较。
 *  - sector 填写明确的投资方向（中文标签）。
 *
 * 本配置只描述「明确已知」的信息；新增基金未配置时全部字段降级为 null/unknown，
 * 不影响其他基金的计算。
 */
module.exports = {
  // 组合级固定约束（来源：账户策略文本；解析逻辑见 fundMetricsService.parsePortfolioSummary）
  portfolioDefaults: {
    equityCap: 100000,
    coreIndexFundCode: '007339',
    coreIndexCap: 20000,
    recoveryTarget: 15000,
    recoveryHorizonMonths: 12
  },

  // 人工配置的基金档案（优先级高于任何自动推断）
  fundProfiles: {
    '007339': {
      role: 'core',
      sector: 'A股宽基',
      maxAmount: 20000,
      benchmark: {
        name: '沪深300指数',
        kind: 'auxiliary',
        stockCode: '510300',
        source: '辅助分析基准：沪深300ETF(510300) 跟踪指数代理'
      }
    },
    '019633': {
      role: null,
      sector: '半导体设备',
      maxAmount: null,
      benchmark: {
        name: '中证半导体产业指数（代理）',
        kind: 'auxiliary',
        stockCode: '512480',
        source: '辅助分析基准：半导体ETF(512480)'
      }
    },
    '008702': {
      role: null,
      sector: '黄金及贵金属',
      maxAmount: null,
      benchmark: {
        name: '国内黄金现货（代理）',
        kind: 'auxiliary',
        stockCode: '518880',
        source: '辅助分析基准：黄金ETF(518880)'
      }
    },
    '004253': {
      role: null,
      sector: '黄金及贵金属',
      maxAmount: null,
      benchmark: {
        name: '国内黄金现货（代理）',
        kind: 'auxiliary',
        stockCode: '518880',
        source: '辅助分析基准：黄金ETF(518880)'
      }
    },
    '013309': {
      role: null,
      sector: '恒生科技',
      maxAmount: null,
      benchmark: {
        name: '恒生科技指数（代理）',
        kind: 'auxiliary',
        stockCode: '513180',
        source: '辅助分析基准：恒生科技ETF(513180)'
      }
    },
    '000961': {
      role: null,
      sector: 'A股宽基',
      maxAmount: null,
      benchmark: {
        name: '沪深300指数',
        kind: 'auxiliary',
        stockCode: '510300',
        source: '辅助分析基准：沪深300ETF(510300) 跟踪指数代理'
      }
    },
    // 018147 建信新兴市场混合(QDII)C：前十大重仓为台积电/英伟达/SK海力士/博通等海外科技股，
    // Web（app-refactor.js）与 mp1（fundSectors.js）板块映射均为「全球科技」。
    // 2026-10-20 修正：此前误配「A股宽基 + 沪深300 基准」与真实持仓和前端分类冲突。
    // 现有 ETF 代理（510300/513180/515000 等）均不能可靠代表新兴市场科技 → benchmark null，如实缺失。
    '018147': {
      role: null,
      sector: '全球科技',
      maxAmount: null,
      benchmark: null
    },
    '016665': {
      role: null,
      sector: '海外科技/全球高端制造',
      maxAmount: null,
      benchmark: null
    },
    '025500': {
      role: null,
      sector: '科技成长',
      maxAmount: null,
      benchmark: {
        name: '中证科技指数（代理）',
        kind: 'auxiliary',
        stockCode: '515000',
        source: '辅助分析基准：科技ETF(515000)'
      }
    },
    '022184': {
      role: null,
      sector: '科技成长',
      maxAmount: null,
      benchmark: {
        name: '中证科技指数（代理）',
        kind: 'auxiliary',
        stockCode: '515000',
        source: '辅助分析基准：科技ETF(515000)'
      }
    },
    '025422': {
      role: null,
      sector: '科技成长',
      maxAmount: null,
      benchmark: {
        name: '中证科技指数（代理）',
        kind: 'auxiliary',
        stockCode: '515000',
        source: '辅助分析基准：科技ETF(515000)'
      }
    },
    '015442': {
      role: null,
      sector: '科技成长',
      maxAmount: null,
      benchmark: {
        name: '中证科技指数（代理）',
        kind: 'auxiliary',
        stockCode: '515000',
        source: '辅助分析基准：科技ETF(515000)'
      }
    }
  },

  // 持仓重合判定阈值：同一股票在两只基金前十大持仓中的占比（归一化为百分数）均 >= 3%
  // 才视为真实重合；个别 1~2% 的重合不触发 overlapWarning。
  overlap: {
    minWeightPct: 3,
    topN: 10
  },

  // 波动率窗口：最多取近 20 个有效日收益率，至少 5 个才计算，否则 null
  volatility: {
    window: 20,
    minReturns: 5,
    annualizationFactor: 252
  },

  // 1 年窗口指标（return1y / maxDrawdown1y / drawdownFromHigh1y）的最低数据要求：
  // 时间跨度 >= 1 个日历年 且 窗口内有效记录 >= 180 个交易日，否则如实返回 null。
  oneYear: {
    minCalendarDays: 365,
    minRecords: 180
  }
};
