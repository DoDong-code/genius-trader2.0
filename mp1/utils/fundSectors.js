// utils/fundSectors.js
// 基金板块/大类自动识别（P1：删除新增基金「分类」选择，系统自动识别）
// 板块表与 analysis.js 页内常量保持一致（单一数据源，避免双份漂移）

// 已知代码 → 板块名（与 analysis.js sectorNameOf 的 FUND_SECTORS_BY_CODE 对齐）
export const FUND_SECTORS_BY_CODE = {
  '014002': '全球智能科技', '022184': '全球科技', '002771': '灵活配置',
  '002207': '黄金矿业', '019633': '半导体设备', '007339': '沪深300',
  '004253': '黄金', '013309': '恒生科技', '010827': '产业趋势',
  '025422': '数字经济', '014847': '债券', '008173': '债券',
  '020741': '债券', '015736': '纯债', '380006': '纯债',
  '004103': '债券', '009690': '灵活配置', '000001': '混合', '008702': '基金'
};

// 板块 → 资产大类（与 analysis.js assetClassOf 的 ASSET_CLASS_BY_SECTOR 对齐）
const ASSET_CLASS_BY_SECTOR = {
  '半导体设备': '权益类', '产业趋势': '权益类', '数字经济': '权益类',
  '灵活配置': '权益类', '混合': '权益类', '沪深300': '权益类',
  '黄金': '黄金类', '黄金矿业': '黄金类',
  '债券': '债券类', '纯债': '债券类',
  '全球科技': '海外类', '全球智能科技': '海外类', '恒生科技': '海外类'
};

// 名称关键词 → 资产大类（新增基金无代码映射时的兜底识别）
const CLASS_BY_NAME = [
  { re: /黄金|贵金属|金矿|金ETF/, cls: '黄金类' },
  { re: /债|存单|固收|货币/, cls: '债券类' },
  { re: /全球|海外|恒生|标普|纳斯达克|纳指|QDII|美股|互联|道琼斯|日经/, cls: '海外类' }
];

// 板块名（优先代码映射；其次历史 sector/category 字段；再兜底名称关键词识别）
export function sectorNameOf(f) {
  if (!f) return '其他';
  const byCode = FUND_SECTORS_BY_CODE[String(f.code || '')];
  if (byCode) return byCode;
  if (f.sector) return String(f.sector);
  if (f.category) return String(f.category);
  const name = String(f.name || '');
  for (const item of CLASS_BY_NAME) {
    if (item.re.test(name)) return item.cls;
  }
  return '其他';
}

// 资产大类（P1 新增基金自动识别用；历史分类兼容：同为大类标签）
// 优先级：代码板块映射 → 名称关键词 → 历史 category（四大类之一）→ '其他'
export function assetClassOf(f) {
  if (!f) return '其他';
  const byCode = FUND_SECTORS_BY_CODE[String(f.code || '')];
  if (byCode && ASSET_CLASS_BY_SECTOR[byCode]) return ASSET_CLASS_BY_SECTOR[byCode];
  const name = String(f.name || '');
  for (const item of CLASS_BY_NAME) {
    if (item.re.test(name)) return item.cls;
  }
  const raw = String(f.category || '');
  if (['权益类', '黄金类', '债券类', '海外类'].includes(raw)) return raw;
  return '其他';
}
