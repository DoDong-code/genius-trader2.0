// 投资策略去重合并工具（UMD：浏览器 script 标签 / 微信小程序 require / Node require 通用）
// 仅做最小去重，不引入任何策略系统或新表。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.dedupeStrategies = factory().dedupeStrategies;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // 去重合并投资策略：完全相同的策略（按 trim 后文本判定）只保留第一份。
  function dedupeStrategies(arr) {
    var seen = new Set();
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (s) {
      var k = String(s == null ? '' : s).trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    });
    return out;
  }
  return { dedupeStrategies: dedupeStrategies };
});
