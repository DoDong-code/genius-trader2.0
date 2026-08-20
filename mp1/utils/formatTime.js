// utils/formatTime.js
// 全项目统一时间格式化：按中国北京时间（Asia/Shanghai / UTC+8）显示。
//
// 输入支持：
//   - epoch 毫秒数（如 Date.now()、时间戳数字）
//   - ISO 字符串（含 Z 或时区偏移，如后端返回的 "2026-08-17T02:50:18.000Z"）
//   - Date 对象
// 输出：'YYYY-MM-DD HH:mm:ss'（北京时间）；无效输入返回 '—'
//
// 规则：后端所有时间以 UTC 存储/返回（带 Z 或偏移的 ISO 字符串），
//       前端统一先解析为 epoch，再按北京时间格式化。禁止直接字符串切片当本地时间用。

export function formatShanghaiTime(input, withSeconds = true) {
  let ts;
  if (typeof input === 'number') {
    ts = input;
  } else if (input instanceof Date) {
    ts = input.getTime();
  } else if (typeof input === 'string' && input.trim()) {
    ts = new Date(input).getTime();
  } else {
    return '—';
  }
  if (!Number.isFinite(ts)) return '—';

  const d = new Date(ts);
  // 设备无关：把 epoch 渲染成北京时间（无论设备在哪个时区）
  const sh = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const base = `${sh.getFullYear()}-${pad(sh.getMonth() + 1)}-${pad(sh.getDate())} ${pad(sh.getHours())}:${pad(sh.getMinutes())}`;
  return withSeconds ? `${base}:${pad(sh.getSeconds())}` : base;
}
