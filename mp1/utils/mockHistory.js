// utils/mockHistory.js
// 本地兜底：当服务端 /api/fund/:code 不可用时，基于基金代码确定性地
// 生成一段历史单位净值日线序列，使「历史净值 / 历史业绩 / 趋势图」始终有数据。
// 同一 code 永远生成同一曲线（伪随机种子由 code 推导），避免每次刷新跳变。

// 32位字符串哈希（FNV-1a 变体），用于把 code 变成随机种子
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 线性同余生成器（确定性 PRNG）
function makeRng(seed) {
  let state = (seed || 1) >>> 0;
  return function () {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 生成某基金的历史净值序列
 * @param {string} code 基金代码（6位）
 * @param {string} endDate 截止日期 YYYY-MM-DD（默认取本地日期）
 * @param {number} days 天数（默认 1096 ≈ 3年）
 * @returns {Array<{date:string, nav:number, acc:number}>}
 */
export function generateMockHistory(code, endDate, days) {
  const totalDays = days || 1096;
  const end = endDate ? new Date(`${endDate}T00:00:00`) : new Date();
  // 按自然日回推，再剔除周末，贴近真实交易日历
  const start = new Date(end.getTime() - (totalDays - 1) * 86400000);

  const seed = hashSeed(String(code || '000000'));
  const rng = makeRng(seed);

  // 起点净值：0.8 ~ 3.2 之间确定性分布
  let nav = 0.8 + rng() * 2.4;
  // 累计净值起点略高（含分红再投资）
  let acc = nav * (1.02 + rng() * 0.08);

  // 年漂移：轻微向上（0.5% ~ 6% 年化）
  const annualDrift = 0.005 + rng() * 0.055;
  const dailyDrift = annualDrift / 252;
  // 波动率：0.6% ~ 1.4% 日波动
  const vol = 0.006 + rng() * 0.008;

  const list = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;

    if (i > 0) {
      const shock = (rng() - 0.5) * 2 * vol; // [-vol, vol]
      nav = nav * (1 + dailyDrift + shock);
      if (nav < 0.3) nav = 0.3;
      acc = nav * (1.02 + rng() * 0.08);
    }

    list.push({
      date: formatDate(d),
      nav: Number(nav.toFixed(4)),
      acc: Number(acc.toFixed(4))
    });
  }

  return list;
}
