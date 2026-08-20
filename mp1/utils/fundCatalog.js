// utils/fundCatalog.js
// 前端内置常用基金目录（code → 名称），用于「名称 → 代码」模糊联想。
// 后端 /api/funds 只返回数据库已导入的基金（通常很少），无法覆盖全量市场；
// 这里内置一份常见基金目录，名称输入时做本地模糊匹配，匹配到即回填代码并调 /api/fund/:code 自动导入详情。

const FUND_CATALOG = [
  // 宽基指数
  { code: '161725', name: '招商中证白酒指数(LOF)A' },
  { code: '012414', name: '招商中证白酒指数C' },
  { code: '110022', name: '易方达消费行业股票' },
  { code: '110011', name: '易方达中小盘混合' },
  { code: '005827', name: '易方达蓝筹精选混合' },
  { code: '003095', name: '中欧医疗健康混合A' },
  { code: '003096', name: '中欧医疗健康混合C' },
  { code: '163406', name: '兴全合润混合' },
  { code: '163402', name: '兴全趋势投资混合(LOF)' },
  { code: '000001', name: '华夏成长混合' },
  { code: '000001', name: '华夏成长混合' },
  { code: '001594', name: '华夏中证500ETF联接A' },
  { code: '510300', name: '沪深300ETF' },
  { code: '510500', name: '中证500ETF' },
  { code: '510050', name: '上证50ETF' },
  { code: '159915', name: '创业板ETF' },
  { code: '012348', name: '华夏上证50ETF联接C' },
  { code: '007339', name: '沪深300' },
  // 半导体 / 科技
  { code: '019633', name: '国泰半导体设备ETF联接C' },
  { code: '014002', name: '天弘全球智能科技' },
  { code: '022184', name: '天弘全球科技' },
  { code: '008888', name: '华夏国证半导体芯片ETF联接A' },
  { code: '008889', name: '华夏国证半导体芯片ETF联接C' },
  { code: '013309', name: '易方达恒生科技ETF联接(QDII)C' },
  { code: '012348', name: '华夏恒生科技ETF联接' },
  // 黄金 / 有色金属
  { code: '008702', name: '华夏黄金ETF联接C' },
  { code: '002207', name: '前海开源金银珠宝混合C' },
  { code: '004253', name: '黄金' },
  { code: '008173', name: '华安黄金易ETF联接C' },
  // 债券
  { code: '014847', name: '华夏30天滚动短债债券C' },
  { code: '008173', name: '华夏短债债券C' },
  { code: '020741', name: '广发双债添利债券C' },
  { code: '015736', name: '纯债' },
  { code: '380006', name: '广发聚宝混合C' },
  { code: '004103', name: '广发集利债券A' },
  { code: '009690', name: '灵活配置' },
  // QDII / 海外
  { code: '000988', name: '嘉实全球互联网股票(QDII)' },
  { code: '005668', name: '工银全球美元债' },
  { code: '007349', name: '汇添富全球消费混合(QDII)' },
  // 银行 / 金融
  { code: '001595', name: '天弘中证银行ETF联接C' },
  // 其他常见
  { code: '002771', name: '安信新回报混合C' },
  { code: '025422', name: '数字经济' },
  { code: '010827', name: '易方达产业趋势混合' },
  { code: '012414', name: '招商中证白酒C' },
  { code: '009570', name: '鹏华匠心精选混合C' }
];

// 去重（同 code 只保留一条）
const deduped = [];
const seen = new Set();
for (const f of FUND_CATALOG) {
  if (seen.has(f.code)) continue;
  seen.add(f.code);
  deduped.push(f);
}

export default deduped;
