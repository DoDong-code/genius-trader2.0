module.exports = {
  holdingsWeight: 0.7,
  sectorWeight: 0.3,
  cashAdjustment: 0,
  quoteTtlMinutes: 5,
  estimateTtlMinutes: 5,
  sectorBenchmarks: {
    semiconductor: { name: '半导体指数参考', stockCode: '512480' },
    technology: { name: '科技指数参考', stockCode: '515000' },
    gold: { name: '黄金 ETF 参考', stockCode: '518880' },
    broad: { name: '沪深 300 参考', stockCode: '510300' },
    hongkongTechnology: { name: '恒生科技参考', stockCode: '513180' }
  },
  fundSectorMap: {
    '019633': 'semiconductor',
    '025500': 'technology',
    '022184': 'technology',
    '008702': 'gold',
    '000961': 'broad',
    '013309': 'hongkongTechnology',
    '007339': 'broad',
    '004253': 'gold',
    '025422': 'technology',
    '015442': 'technology'
  },
  nameRules: [
    { pattern: /半导体|芯片|集成电路/i, sector: 'semiconductor' },
    { pattern: /恒生科技|港股科技/i, sector: 'hongkongTechnology' },
    { pattern: /黄金|金银珠宝/i, sector: 'gold' },
    { pattern: /沪深300|宽基/i, sector: 'broad' },
    { pattern: /科技|数字经济|互联网|人工智能|智能/i, sector: 'technology' }
  ]
};
