// utils/format.js
// 金额/百分比统一格式化（P1/P2 统一整改：最多 2 位小数、不强制补 0）

// 百分比：输入小数（0.055 = 5.50%），输出字符串，正好 2 位小数
// sign=true 时正值加 '+'（涨跌展示）；sign=false 不加符号（权重/占比展示）
// 注意：用 rate01 == null + Number.isFinite(r) 判断，避免 Number(null)=0 / Number('')=0 误判
export function pct(rate01, sign = true) {
  if (rate01 == null) return '—';
  const r = Number(rate01);
  if (!Number.isFinite(r)) return '—';
  const p = r * 100;
  const text = p.toFixed(2);
  return sign ? `${p > 0 ? '+' : ''}${text}%` : `${text}%`;
}

// 金额：正好 2 位小数
export function money(val) {
  if (val == null) return '—';
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
