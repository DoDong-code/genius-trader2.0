/**
 * stress/report.js — 读取 STRESS_RESULT.json，输出最终压力测试报告。
 * 用法：node stress/report.js [path/to/STRESS_RESULT.json]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, 'STRESS_RESULT.json');
const R = JSON.parse(fs.readFileSync(file, 'utf8'));

const EDGES = [0, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000, 30000, 60000];
function mergeHists(hists) {
  const out = new Array(EDGES.length - 1).fill(0);
  let total = 0;
  for (const h of hists) {
    if (!Array.isArray(h)) continue;
    for (let i = 0; i < out.length; i++) out[i] += (h[i] || 0);
    total += h.reduce((a, b) => a + b, 0);
  }
  return { out, total };
}
function pct(hist, total, p) {
  if (total === 0) return 0;
  const target = (p / 100) * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return EDGES[i + 1];
  }
  return EDGES[EDGES.length - 1];
}

const all = [...(R.tiers || []), ...(R.faults || []), R.soak].filter(Boolean);
const hists = all.map((t) => t.hist).filter(Boolean);
const { out: merged, total: totalReq } = mergeHists(hists);

const sum = (sel, key) => all.reduce((a, t) => a + (sel(t) ? (t[key] || 0) : 0), 0);
const totalSuccess = sum(() => true, 'success');
const totalFail = sum(() => true, 'fail');
const maxMs = all.reduce((a, t) => Math.max(a, t.maxMs || 0), 0);

// 状态聚合
const statusAgg = {};
for (const t of all) {
  for (const [k, v] of Object.entries(t.status || {})) statusAgg[k] = (statusAgg[k] || 0) + v;
}
const timeoutCount = (statusAgg['503'] || 0) + (statusAgg['504'] || 0) + (statusAgg['aborted'] || 0) + (statusAgg['408'] || 0) + (statusAgg['error'] || 0);
const isolationTotal = all.reduce((a, t) => a + (t.isolationViolations || 0), 0);
const casConflicts = all.reduce((a, t) => a + ((t.lastCas && t.lastCas.conflicts) || 0), 0) + ((R.finalCas && R.finalCas.conflicts) || 0);

const users = (R.tiers && R.tiers[0]) ? 110 : 0; // 固定准备 110 用户
const S = R.summary || {};

function fmtMB(b) { return b ? ((b / 1048576) | 0) + ' MB' : '0 MB'; }
function fmtMs(b) { return b ? (b | 0) + ' ms' : '0 ms'; }

const lines = [];
lines.push('==================================================');
lines.push('  Genius Trader 生产压力测试最终报告');
lines.push('  生成时间: ' + new Date().toISOString());
lines.push('==================================================');
lines.push('');
lines.push('【一、总体指标】');
lines.push('  测试人数(虚拟用户池): ' + users);
lines.push('  请求总数:            ' + totalReq.toLocaleString());
lines.push('  成功数(2xx):         ' + totalSuccess.toLocaleString());
lines.push('  失败数(非2xx/错误):  ' + totalFail.toLocaleString());
lines.push('  P50:                 ' + fmtMs(pct(merged, totalReq, 50)));
lines.push('  P95:                 ' + fmtMs(pct(merged, totalReq, 95)));
lines.push('  P99:                 ' + fmtMs(pct(merged, totalReq, 99)));
lines.push('  最大响应时间:        ' + fmtMs(maxMs));
lines.push('  测试开始 heapUsed:   ' + fmtMB(S.heapUsedStart));
lines.push('  测试结束 heapUsed:   ' + fmtMB(S.heapUsedEnd));
lines.push('  最大 heapUsed:       ' + fmtMB(S.heapUsedPeak));
lines.push('  RSS 峰值:            ' + fmtMB(S.rssPeak));
lines.push('  event loop delay 峰值: ' + fmtMs(S.elPeakMs));
lines.push('  PG waiting 峰值:     ' + (S.pgWaitingPeak || 0));
lines.push('  Provider queue 峰值: ' + (S.providerQueuePeak || 0));
lines.push('  OOM 次数:            ' + (S.oomCount || 0) + (S.serverCrashed ? '  (服务端进程退出!)' : ''));
lines.push('  SIGABRT 次数:        ' + ((S.sigabrt && 1) || 0));
lines.push('  账号串数据次数:      ' + isolationTotal);
lines.push('  CAS 冲突次数:        ' + casConflicts + '  (被拒绝的 stale revision)');
lines.push('  超时次数(503/504/408/aborted/error): ' + timeoutCount);
lines.push('  Provider 未触发(缓存/凭证门,非故障): ' + all.reduce((a, t) => a + ((t.providerUntriggered) || 0), 0));
lines.push('  Provider 穿透请求总量(全模式累计): ' + all.reduce((a, t) => a + ((t.providerTotalDelta) || 0), 0));
lines.push('');
lines.push('【二、状态分布】');
for (const [k, v] of Object.entries(statusAgg).sort((a, b) => b[1] - a[1])) {
  lines.push('  ' + k + ': ' + v.toLocaleString());
}
lines.push('');
lines.push('【三、各并发梯度 / 故障场景】');
for (const t of (R.tiers || [])) {
  lines.push(`  [${t.label}] 并发=${t.concurrency} 时长=${t.durationSec}s 通过=${t.pass ? 'PASS' : 'FAIL'} 请求=${t.total} 失败=${t.fail} P99=${fmtMs(t.p99)} 隔离违规=${t.isolationViolations} CAS=${t.lastCas && t.lastCas.casPass ? 'OK' : 'FAIL'} 登出=${fmtMs(t.logoutMaxMs)}(<9s:${t.logoutWithin9s})`);
}
for (const t of (R.faults || [])) {
  lines.push(`  [${t.label}] pg=${t.pgMode} prov=${t.providerMode} 通过=${t.pass ? 'PASS' : 'FAIL'} 请求=${t.total} 状态=${JSON.stringify(t.status)} pgWaiting=${t.peaks.pgWaitingPeak} provRatio=${t.providerGrowthRatio}`);
}
lines.push('');
lines.push('【四、30 分钟长压 + 5 分钟观察】');
if (R.soak) {
  lines.push(`  长压: 并发=${R.soak.concurrency} 请求=${R.soak.total} 失败=${R.soak.fail} P99=${fmtMs(R.soak.p99)} 隔离=${R.soak.isolationViolations} CAS=${R.soak.lastCas && R.soak.lastCas.casPass ? 'OK' : 'FAIL'} 登出=${fmtMs(R.soak.logoutMaxMs)}(<9s:${R.soak.logoutWithin9s})`);
}
if (R.observation) {
  lines.push(`  观察: heapUsedStart=${fmtMB(R.observation.heapUsedStart)} heapUsedEnd=${fmtMB(R.observation.heapUsedEnd)} 稳定=${R.observation.stable} heapPeak=${fmtMB(R.observation.heapUsedPeak)} rssPeak=${fmtMB(R.observation.rssPeak)} elPeak=${fmtMs(R.observation.elPeakMs)}`);
}
if (R.finalCas) {
  lines.push(`  终检 CAS: accepted=${R.finalCas.accepted} conflicts=${R.finalCas.conflicts} integrity=${R.finalCas.dataIntegrityOk} staleRejected=${R.finalCas.staleRejected} pass=${R.finalCas.casPass}`);
}
lines.push('');
lines.push('【五、明确结论 PASS/FAIL】');
const t10 = (R.tiers || []).find((t) => t.label === 'normal-10');
const t25 = (R.tiers || []).find((t) => t.label === 'normal-25');
const t50 = (R.tiers || []).find((t) => t.label === 'normal-50');
const t100 = (R.tiers || []).find((t) => t.label === 'normal-100');
const soakPass = R.soak && R.soak.pass && R.observation && R.observation.stable && !S.serverCrashed && isolationTotal === 0;
lines.push('  10 并发:   ' + (t10 ? (t10.pass ? 'PASS' : 'FAIL') : 'N/A'));
lines.push('  25 并发:   ' + (t25 ? (t25.pass ? 'PASS' : 'FAIL') : 'N/A'));
lines.push('  50 并发:   ' + (t50 ? (t50.pass ? 'PASS' : 'FAIL') : 'N/A'));
lines.push('  100 并发:  ' + (t100 ? (t100.pass ? 'PASS' : 'FAIL') : 'N/A'));
lines.push('  30分钟长压: ' + (soakPass ? 'PASS' : 'FAIL'));
const penPass = R.providerPenetration && R.providerPenetration.crashImmune && R.providerPenetration.allProvidersExercised;
lines.push('  Provider 穿透(不崩溃+全穿透): ' + (penPass ? 'PASS' : 'FAIL'));
lines.push('');
lines.push('【五之一、Provider 强制穿透验证（独立分组）】');
if (R.providerPenetration) {
  const pen = R.providerPenetration;
  lines.push('  服务端在故障下未崩溃(红线): ' + (pen.crashImmune ? 'YES' : 'NO(失败)'));
  lines.push('  被穿透 Provider: ' + (pen.exercisedProviders || []).join(', '));
  lines.push('  全 Provider 均被穿透(无删除/跳过): ' + (pen.allProvidersExercised ? 'YES' : 'NO(失败)'));
  for (const pm of (pen.perMode || [])) {
    lines.push(`  模式=${pm.mode} 服务端状态=${JSON.stringify(pm.serverStatus)} providerActivePeak(累计)=${pm.providerActivePeak}`);
    for (const [name, d] of Object.entries(pm.providerDelta || {})) {
      if (d.requests === 0) continue;
      lines.push(`     ${name}: req=${d.requests} ok=${d.success} err=${d.error} timeout=${d.timeout} abort=${d.abort} fallback=${d.fallback}`);
    }
  }
  lines.push('  fallback 总次数(各 Provider 失败触发服务端降级): ' +
    Object.values(pen.perMode || []).reduce((a, pm) => a + Object.values(pm.providerDelta || {}).reduce((b, d) => b + (d.fallback || 0), 0), 0));
} else {
  lines.push('  (未运行)');
}
lines.push('');
lines.push('【六、OOM / 内存稳定性判定】');
// 真正的“无单调增长 / 无泄漏”信号是【5 分钟无负载观察窗】内 heapUsed 是否稳定（observation.stable），
// 而非与冷启动基线(heapUsedStart, 进程刚起、尚未预热)比较 —— 后者必然显示“增长”而误报风险。
const heapReturn = (S.heapUsedPeak < 1200 * 1048576) && (R.observation && R.observation.stable);
lines.push('  heapUsed 峰值 < 1.2GB 且观察窗稳定(无泄漏): ' + (heapReturn ? 'YES' : 'NO') + ` (peak=${fmtMB(S.heapUsedPeak)} obsStable=${R.observation && R.observation.stable})`);
lines.push('  持续单调增长(观察窗内): ' + (!heapReturn ? 'YES(风险)' : 'NO'));
lines.push('  接近 Node heap limit: ' + (S.heapUsedPeak > 1200 * 1048576 ? 'YES(风险)' : 'NO') + ` (peak=${fmtMB(S.heapUsedPeak)})`);
lines.push('  SIGABRT/status134: ' + ((S.sigabrt) ? 'YES(失败)' : 'NO'));

console.log(lines.join('\n'));
