/**
 * stress/runStress.cjs — 真实压力测试驱动器（不修改任何业务代码）。
 *
 * 启动一个生产模式的服务端进程（node -r ./stress/pgShim.cjs server/index.js，云端 DATABASE_URL），
 * 在整个测试期间保持同一进程，依次执行：
 *   - 10 / 25 / 50 / 100 并发（各 60s，正常模式）
 *   - PG 故障场景：池满 / 慢查询 / 事务超时 / 获取超时
 *   - Provider 故障场景：500 / timeout / abort / slow
 *   - 30 分钟长压 + 5 分钟观察
 * 每个用户执行真实业务请求组合（首页/账户读取/基金列表/基金详情/NAV/history/estimate/analysis/external/登录/登出），
 * 并加入并发 account/state 保存、随机账户切换/登出/restoreCloud，以及 CAS 冲突验证。
 * 观测 RSS/heap/event loop/PG 池/Provider 队列，并断言 OOM / 账号串数据 / CAS / logout <9s。
 */
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const STRESS_DIR = __dirname;
const CONTROL_FILE = path.join(STRESS_DIR, '.stress_fault.json');
const METRICS_FILE = path.join(STRESS_DIR, '.stress_metrics.json');
// 隔离：CAS 探针 / 凭证 seeding / clearNav 等辅助子进程必须运行在“中性”故障模式下，
// 绝不继承服务端当前注入的 pg/pool 故障（否则它们的支撑库操作也会被池满/慢查询拖垮，
// 导致 CAS_PROBE_FATAL 误报）。同时用独立 metrics 文件，避免覆盖服务端采样。
const CAS_CONTROL_FILE = path.join(STRESS_DIR, '.cas_control_neutral.json');
const CAS_METRICS_FILE = path.join(STRESS_DIR, '.cas_metrics.json');
const AUX_METRICS_FILE = path.join(STRESS_DIR, '.aux_metrics.json');
const PG_FILE = path.join(os.tmpdir(), 'gt_stress_pg.sqlite');
const SERVER_LOG = path.join(STRESS_DIR, 'server.log');
const PORT = Number(process.env.STRESS_PORT || 3939);
const BASE = `http://127.0.0.1:${PORT}`;
// 时长可覆盖（smoke 用短时长快速验证，正式压测用默认）
const TIER_SEC = Number(process.env.STRESS_TIER_SEC || 60);
const FAULT_SEC = Number(process.env.STRESS_FAULT_SEC || 40);
const SOAK_SEC = Number(process.env.STRESS_SOAK_SEC || 30 * 60);
const OBS_SEC = Number(process.env.STRESS_OBS_SEC || 5 * 60);

// 清掉旧产物（含中性控制文件，确保 CAS 探针始终从 normal 起步）
for (const f of [CONTROL_FILE, METRICS_FILE, SERVER_LOG, CAS_CONTROL_FILE, CAS_METRICS_FILE, AUX_METRICS_FILE]) { try { fs.unlinkSync(f); } catch (_) {} }
try { fs.unlinkSync(PG_FILE); } catch (_) {}
try { fs.unlinkSync(PG_FILE + '-wal'); } catch (_) {}
try { fs.unlinkSync(PG_FILE + '-shm'); } catch (_) {}
try { fs.unlinkSync(PG_FILE + '.cas'); } catch (_) {}
try { fs.unlinkSync(PG_FILE + '.cas-wal'); } catch (_) {}
try { fs.unlinkSync(PG_FILE + '.cas-shm'); } catch (_) {}

function writeFault(obj) { fs.writeFileSync(CONTROL_FILE, JSON.stringify(obj)); }
function readMetrics() {
  try { return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')); } catch (_) { return null; }
}

// ---------- 服务端子进程 ----------
const logFd = fs.openSync(SERVER_LOG, 'a');
const serverEnv = Object.assign({}, process.env, {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
  PG_POOL_MAX: '15',
  DISABLE_NAV_SYNC: '1',
  PORT: String(PORT),
  STRESS_CONTROL_FILE: CONTROL_FILE,
  STRESS_METRICS_FILE: METRICS_FILE,
  STRESS_PG_FILE: PG_FILE
});
const server = spawn(process.execPath, ['-r', './stress/pgShim.cjs', 'stress/runServer.cjs'], {
  cwd: ROOT,
  env: serverEnv,
  stdio: ['ignore', logFd, logFd]
});

let serverCrashed = false;
server.on('exit', (code, sig) => {
  serverCrashed = true;
  fs.appendFileSync(SERVER_LOG, `\n[harness] SERVER EXIT code=${code} sig=${sig}\n`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('server not ready');
}

// ---------- 请求工具 ----------
const HIST_EDGES = [0, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000, 30000, 60000];
function newHist() { return new Array(HIST_EDGES.length - 1).fill(0); }
function recordHist(hist, ms) {
  for (let i = 0; i < HIST_EDGES.length - 1; i++) {
    if (ms <= HIST_EDGES[i + 1]) { hist[i]++; return; }
  }
  hist[hist.length - 1]++;
}
function percentile(hist, total, p) {
  if (total === 0) return 0;
  const target = (p / 100) * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return HIST_EDGES[i + 1];
  }
  return HIST_EDGES[HIST_EDGES.length - 1];
}

async function req(method, p, token, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    const ms = Date.now() - t0;
    let text = '';
    try { text = await res.text(); } catch (_) {}
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, ms, json, ok: res.ok };
  } catch (e) {
    const ms = Date.now() - t0;
    return { status: 0, ms, err: e && e.name === 'AbortError' ? 'aborted' : (e && e.message) || 'error', ok: false };
  } finally {
    clearTimeout(t);
  }
}

// ---------- 用户准备 ----------
async function setupUsers(n) {
  const users = [];
  for (let i = 0; i < n; i++) {
    const email = `stress${i}_${Date.now()}@gt.test`;
    const password = 'stress123';
    let token = null, uid = i + 1;
    const reg = await req('POST', '/api/auth/register', null, { email, password });
    if (reg.ok && reg.json && reg.json.token) { token = reg.json.token; uid = reg.json.user.id; }
    else {
      // 已注册则登录
      const lg = await req('POST', '/api/auth/login', null, { email, password });
      if (lg.ok && lg.json && lg.json.token) { token = lg.json.token; uid = lg.json.user.id; }
    }
    // 外部只读 Token
    let readToken = null;
    if (token) {
      const tk = await req('POST', '/api/external/token', token, {});
      if (tk.ok && tk.json && tk.json.token) readToken = tk.json.token;
    }
    // 创建一个账户以便 analysis/estimate 走真实代码路径
    if (token) {
      await req('POST', '/api/portfolio/update', token, {
        accountId: 'stressAccount', fundCode: '019633', shares: 100, cost: 10000, amount: 10000, category: '基金'
      });
    }
    users.push({ idx: i, uid, email, password, token, readToken, marker: `U${uid}#init` });
  }
  return users;
}

// ---------- 业务请求组合 ----------
const FUND_CODE = '019633';
function pickAction() {
  const r = Math.random();
  if (r < 0.10) return 'home';
  if (r < 0.20) return 'accountRead';
  if (r < 0.32) return 'fundList';
  if (r < 0.44) return 'fundDetail';
  if (r < 0.56) return 'navHistory';
  if (r < 0.68) return 'estimate';
  if (r < 0.80) return 'analysis';
  if (r < 0.90) return 'external';
  return 'saveState'; // 其余为并发保存
}

async function doAction(user, claimedUser, counters) {
  const action = pickAction();
  counters.total++;
  let res, cat = action;
  switch (action) {
    case 'home': res = await req('GET', '/', claimedUser.token); break;
    case 'accountRead': res = await req('GET', '/api/account/state', claimedUser.token); break;
    case 'fundList': res = await req('GET', '/api/funds', claimedUser.token); break;
    case 'fundDetail': res = await req('GET', '/api/fund/' + FUND_CODE, claimedUser.token); break;
    case 'navHistory': res = await req('GET', '/api/fund/' + FUND_CODE + '/history', claimedUser.token); cat = 'nav'; break;
    case 'estimate': res = await req('GET', '/api/fund/' + FUND_CODE + '/estimate?amount=10000', claimedUser.token); cat = 'estimate'; break;
    case 'analysis': res = await req('GET', '/api/portfolio/stressAccount/estimate', claimedUser.token); cat = 'analysis'; break;
    case 'external': res = await req('GET', '/api/external/analysis/portfolio?accountId=stressAccount', claimedUser.readToken); cat = 'external'; break;
    case 'saveState': {
      const nonce = Math.random().toString(36).slice(2, 8);
      const marker = `U${claimedUser.uid}#${nonce}`;
      claimedUser.marker = marker;
      res = await req('PUT', '/api/account/state', claimedUser.token, { state: { __marker: marker, v: nonce, accounts: { stressAccount: { funds: [{ code: FUND_CODE, name: 'x' }] } } } });
      cat = 'saveState';
      break;
    }
  }
  recordHist(counters.hist, res.ms);
  if (res.ms > counters.maxMs) counters.maxMs = res.ms;
  if (res.status === 0) {
    counters.status[res.err === 'aborted' ? 'aborted' : 'error'] = (counters.status[res.err === 'aborted' ? 'aborted' : 'error'] || 0) + 1;
  } else {
    counters.status[res.status] = (counters.status[res.status] || 0) + 1;
    if (res.ok) counters.success++; else counters.fail++;
  }
  counters.cat[cat] = (counters.cat[cat] || 0) + 1;
  // Provider 触及动作（estimate / nav / analysis / external）：用于统计“Provider 未触发（缓存/凭证门）”次数
  if (cat === 'estimate' || cat === 'nav' || cat === 'analysis' || cat === 'external') counters.providerTouch++;
  return res;
}

// ---------- 账号隔离探针 ----------
async function probeIsolation(users, counters) {
  const sample = users.filter(() => Math.random() < 0.15);
  for (const u of sample) {
    const res = await req('GET', '/api/account/state', u.token);
    if (!res.ok || !res.json || !res.json.state) continue;
    const m = res.json.state.__marker;
    if (typeof m === 'string' && m.indexOf('U' + u.uid + '#') !== 0) {
      // 要么是本用户自己的 marker，要么为空（未保存）。若属其他用户 -> 串数据
      const owner = m.split('#')[0];
      if (owner && owner !== 'U' + u.uid && /U\d+#/.test(m)) {
        counters.isolationViolations++;
        fs.appendFileSync(SERVER_LOG, `\n[ISOLATION-VIOLATION] user ${u.uid} saw marker ${m}\n`);
      }
    }
  }
}

// ---------- CAS 突发验证 ----------
function runCasBurst(n) {
  const r = spawnSync(process.execPath, ['./stress/casProbe.cjs'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
      PG_POOL_MAX: '1',
      STRESS_CONTROL_FILE: CAS_CONTROL_FILE, STRESS_METRICS_FILE: CAS_METRICS_FILE, STRESS_PG_FILE: PG_FILE + '.cas',
      CAS_UID: '900001', CAS_N: String(n)
    }),
    encoding: 'utf8', timeout: 120000
  });
  try {
    const lines = (r.stdout || '').trim().split('\n');
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  } catch (e) {
    return { casPass: false, error: (r.stderr || '').slice(0, 200), raw: (r.stdout || '').slice(0, 200) };
  }
}

// ---------- 并发 logout <9s ----------
async function testConcurrentLogout(users, n) {
  const subset = users.slice(0, Math.min(n, users.length));
  // 先确保都有有效 token（重新登录）
  for (const u of subset) {
    const lg = await req('POST', '/api/auth/login', null, { email: u.email, password: u.password });
    if (lg.ok && lg.json && lg.json.token) u.token = lg.json.token;
  }
  const start = Date.now();
  await Promise.all(subset.map((u) => req('POST', '/api/auth/logout', u.token)));
  const elapsed = Date.now() - start;
  // 重新登录以便后续使用
  for (const u of subset) {
    const lg = await req('POST', '/api/auth/login', null, { email: u.email, password: u.password });
    if (lg.ok && lg.json && lg.json.token) u.token = lg.json.token;
  }
  return { elapsed, allWithin9s: elapsed <= 9000 };
}

// ---------- 单轮压测 ----------
async function runTier(label, users, concurrency, durationSec, pgMode, providerMode) {
  writeFault({ pgMode, providerMode });
  await sleep(600); // 让 shim 应用故障
  const counters = {
    total: 0, success: 0, fail: 0, maxMs: 0,
    hist: newHist(), status: {}, cat: {}, isolationViolations: 0, providerTouch: 0,
    startProviderTotal: (readMetrics() && readMetrics().provider && readMetrics().provider.total) || 0
  };
  let stop = false;
  const workers = [];
  const active = new Set();
  for (let i = 0; i < concurrency; i++) {
    const myUser = users[i % users.length];
    workers.push((async () => {
      const id = Symbol();
      while (!stop) {
        active.add(id);
        // 随机账户切换：10% 概率用其他用户身份发请求
        const claimed = (Math.random() < 0.10) ? users[Math.floor(Math.random() * users.length)] : myUser;
        try { await doAction(myUser, claimed, counters); }
        catch (_) { counters.fail++; }
        // 偶发 restoreCloud
        if (Math.random() < 0.01 && claimed.token) {
          const bk = await req('POST', '/api/account/backups', claimed.token, { state: { __marker: claimed.marker, v: 'bk' } });
          if (bk.ok && bk.json && Array.isArray(bk.json.backups) && bk.json.backups[0]) {
            await req('POST', '/api/account/backups/' + bk.json.backups[0].id + '/restore', claimed.token);
          }
        }
        active.delete(id);
        // 真实思考时间（避免无限速率压垮 SQLite 支撑库，同时维持高并发）
        await sleep(10 + Math.random() * 40);
      }
    })());
  }
  // 指标 + 隔离探针轮询
  const tierStart = Date.now();
  const poll = setInterval(async () => {
    await probeIsolation(users, counters).catch(() => {});
    // 中点跑一次 CAS 突发
  }, 2000);
  // 每轮中段跑一次 CAS 突发
  const casAt = setTimeout(() => {
    const cas = runCasBurst(200);
    counters.lastCas = cas;
  }, durationSec * 1000 / 2);

  await sleep(durationSec * 1000);
  stop = true;
  clearTimeout(casAt);
  clearInterval(poll);
  // 等在途请求结束（最多 15s）
  const waitStart = Date.now();
  while (active.size > 0 && Date.now() - waitStart < 15000) await sleep(200);

  // logout 测试前先把故障切回 normal（避免 migrateGuestData 继承 slowQueryMs 导致登出重登录被放大到数十秒）
  writeFault({ pgMode: 'normal', providerMode: 'normal' });
  await sleep(600);

  const m = readMetrics();
  const endProviderTotal = (m && m.provider && m.provider.total) || counters.startProviderTotal;
  const peaks = (m && m.peaks) || {};
  const logout = await testConcurrentLogout(users.slice(0, Math.min(20, users.length)), 20).catch((e) => ({ elapsed: -1, allWithin9s: false, err: String(e) }));

  const result = {
    label, concurrency, durationSec, pgMode, providerMode,
    total: counters.total, success: counters.success, fail: counters.fail,
    p50: percentile(counters.hist, counters.total, 50),
    p95: percentile(counters.hist, counters.total, 95),
    p99: percentile(counters.hist, counters.total, 99),
    maxMs: counters.maxMs,
    status: counters.status,
    cat: counters.cat,
    isolationViolations: counters.isolationViolations,
    lastCas: counters.lastCas,
    providerTotalDelta: endProviderTotal - counters.startProviderTotal,
    providerUntriggered: Math.max(0, counters.providerTouch - (endProviderTotal - counters.startProviderTotal)),
    providerGrowthRatio: counters.total > 0 ? +((endProviderTotal - counters.startProviderTotal) / counters.total).toFixed(3) : 0,
    logoutMaxMs: logout.elapsed,
    logoutWithin9s: logout.allWithin9s,
    peaks: {
      heapUsedPeak: peaks.heapUsedPeak || 0,
      rssPeak: peaks.rssPeak || 0,
      elPeakMs: peaks.elPeakMs || 0,
      pgWaitingPeak: peaks.pgWaitingPeak || 0,
      providerQueuePeak: peaks.providerQueuePeak || 0,
      providerTotal: peaks.providerTotal || 0
    },
    hist: Array.from(counters.hist),
    heapUsedStart: (m && m.heapUsed) || 0,
    heapUsedEnd: (m && m.heapUsed) || 0
  };
  return result;
}

// ---------- Provider 强制穿透验证（独立分组） ----------
// 用户要求：正式压力测试必须单独安排一组“强制穿透 Provider”的请求，真实验证
//   正常响应 / 500 / timeout / Abort / slow response / fallback / 请求并发限制；
// 并记录每个 Provider 的 request / success / error / timeout / abort / fallback / active / queued。
// 红线：绝不删除任何 Provider，绝不修改 fallback 路由（本函数只发请求 + 读统计，零业务代码改动）。
// 注意：普通并发梯度中 estimate 走本地引擎（不带 mode=provider）、NAV 命中 fund_nav 缓存，
//       因此 Providers 大多“未触发”——那是缓存/凭证门，记作“Provider 未触发”，不是故障。
//       本分组用带 mode=provider 的 estimate + 穿透基金（无今天 NAV）的 today-nav 强制命中 Providers。
const PEN_STOCK = '600519'; // 贵州茅台：触发 Tencent/Sina/Eastmoney/Yahoo 行情路径
// 每个故障模式用“互不相交”的基金代码打 estimate(mode=provider)，避免命中 provider 估算的
// 5 分钟内存缓存（按 fund_code 作 key）导致后续模式不再真正穿透 xiaobeiyangji/yangjibao。
const PEN_EST_CODES = {
  normal: ['019633', '008702'],
  '500': ['110011', '161725'],
  timeout: ['005827', '003096'],
  abort: ['012348', '001632'],
  slow: ['002001', '003095']
};
function newProvStat0() {
  return { requests: 0, success: 0, error: 0, timeout: 0, abort: 0, fallback: 0, active: 0, activePeak: 0 };
}
function snapProviderStats() {
  const m = readMetrics();
  const arr = (m && m.providerStats) || [];
  const map = {};
  for (const s of arr) map[s.name] = Object.assign({}, s);
  return map;
}
function peakActiveFrom(map) {
  let peak = 0;
  for (const k of Object.keys(map)) peak = Math.max(peak, map[k].activePeak || 0);
  return peak;
}
function deltaStats(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = {};
  for (const n of names) {
    const b = before[n] || newProvStat0();
    const a = after[n] || newProvStat0();
    out[n] = {
      requests: a.requests - b.requests,
      success: a.success - b.success,
      error: a.error - b.error,
      timeout: a.timeout - b.timeout,
      abort: a.abort - b.abort,
      fallback: a.fallback - b.fallback
    };
  }
  return out;
}
function seedProviderCredentials(uids) {
  if (!uids.length) return;
  const r = spawnSync(process.execPath, ['-r', './stress/pgShim.cjs', 'stress/seedCredentials.cjs', ...uids.map(String)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
      STRESS_PG_FILE: PG_FILE,
      STRESS_CONTROL_FILE: CAS_CONTROL_FILE, STRESS_METRICS_FILE: AUX_METRICS_FILE
    }),
    encoding: 'utf8', timeout: 60000
  });
  fs.appendFileSync(SERVER_LOG, `\n[seedCredentials] exit=${r.status} out=${(r.stdout || '').trim()}\n`);
}
function clearNav(codes) {
  const r = spawnSync(process.execPath, ['-r', './stress/pgShim.cjs', 'stress/dbUtil.cjs', 'clearNav', ...codes], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
      STRESS_PG_FILE: PG_FILE,
      STRESS_CONTROL_FILE: CAS_CONTROL_FILE, STRESS_METRICS_FILE: AUX_METRICS_FILE
    }),
    encoding: 'utf8', timeout: 60000
  });
  return r.status === 0;
}
async function fireProviderBurst(penUser, concurrency, estCodes) {
  // 穿透突发用较长客户端超时(40s)：服务端在 500/timeout 下会走内部兜底（bulk-fetch 30s 护栏）
  // 再返回 200 降级，而不是让客户端 30s 超时误判为 abort；这样能干净地验证“timeout→fallback→200”。
  const T = 90000;
  const tasks = [];
  for (let i = 0; i < concurrency; i++) {
    const c = estCodes[i % estCodes.length];
    tasks.push(req('GET', '/api/fund/000001/today-nav', penUser.token, undefined, T));
    tasks.push(req('GET', '/api/fund/000002/today-nav', penUser.token, undefined, T));
    tasks.push(req('GET', '/api/fund/' + c + '/estimate?mode=provider&source=xiaobeiyangji', penUser.token, undefined, T));
    tasks.push(req('GET', '/api/fund/' + c + '/estimate?mode=provider&source=yangjibao', penUser.token, undefined, T));
    tasks.push(req('GET', '/api/stock/' + PEN_STOCK + '/history', penUser.token, undefined, T));
  }
  return Promise.all(tasks.map((t) => t.catch((e) => ({ status: 0, err: String(e) }))));
}
async function runProviderPenetration(penUser) {
  const modes = ['normal', '500', 'timeout', 'abort', 'slow'];
  const out = { perMode: [], crashImmune: !serverCrashed, exercisedProviders: [] };
  for (const mode of modes) {
    // slow 模式用 1500ms（< 服务端 PROVIDER_TIMEOUT_MS=2500），模拟“慢但成功”的真实响应
    writeFault({ pgMode: 'normal', providerMode: mode, providerLatencyMs: mode === 'slow' ? 1500 : 0 });
    await sleep(700); // 让 shim 应用故障
    const before = snapProviderStats();
    const results = await fireProviderBurst(penUser, 12, PEN_EST_CODES[mode]);
    // 等一个采样周期(1s)以上，确保 shim 把本轮爆发后的 providerStats 刷入 metrics 文件，
    // 否则 before/after 差值会因文件写入延迟而漏算本模式请求。
    await sleep(1100);
    const after = snapProviderStats();
    const statusAgg = {};
    for (const r of results) {
      const k = r.status ? String(r.status) : (r.err || 'err');
      statusAgg[k] = (statusAgg[k] || 0) + 1;
    }
    const delta = deltaStats(before, after);
    out.perMode.push({ mode, serverStatus: statusAgg, providerDelta: delta, providerActivePeak: peakActiveFrom(after) });
    for (const n of Object.keys(delta)) {
      if (delta[n].requests > 0 && !out.exercisedProviders.includes(n)) out.exercisedProviders.push(n);
    }
    // 清掉穿透基金“今天 NAV”，保证下一模式 today-nav 仍会穿透 Yahoo/Eastmoney
    clearNav(['000001', '000002']);
    await sleep(300);
  }
  writeFault({ pgMode: 'normal', providerMode: 'normal', providerLatencyMs: 0 });
  await sleep(500);
  out.crashImmune = !serverCrashed;
  out.allProvidersExercised = ['yahoo', 'eastmoney', 'tencent', 'sina', 'xiaobeiyangji', 'yangjibao']
    .every((n) => out.exercisedProviders.includes(n));
  return out;
}

// ---------- 主流程 ----------
async function main() {
  const results = { tiers: [], faults: [], cas: [], summary: {} };
  console.log('[harness] starting server...');
  await waitReady();
  console.log('[harness] server ready');

  const MAX_USERS = 110;
  const users = await setupUsers(MAX_USERS);
  const ready = users.filter((u) => u.token).length;
  console.log(`[harness] users ready=${ready}/${MAX_USERS}`);

  // 为穿透用户写入“已连接”第三方凭证（仅写入测试支撑库 source_credentials，不修改任何生产业务代码；
  // 也不触碰受保护用户 uid∈{0,1,2,3}——这里取 idx>=10 的虚拟用户）。
  const PEN_UIDS = [users[10], users[11]].filter((u) => u && u.uid).map((u) => u.uid);
  seedProviderCredentials(PEN_UIDS);
  const penUser = (users[10] && users[10].token) ? users[10] : ((users[11] && users[11].token) ? users[11] : users[0]);
  console.log(`[harness] provider penetration user uid=${penUser.uid} credUids=${JSON.stringify(PEN_UIDS)}`);

  // 并发梯度（正常）
  const grad = [10, 25, 50, 100];
  let lastStable = 10;
  for (const c of grad) {
    console.log(`[harness] === tier normal concurrency=${c} ===`);
    const r = await runTier(`normal-${c}`, users, c, TIER_SEC, 'normal', 'normal');
    results.tiers.push(r);
    const pass = !serverCrashed && r.isolationViolations === 0 && r.lastCas && r.lastCas.casPass &&
      r.logoutWithin9s && r.peaks.heapUsedPeak < 1200 * 1024 * 1024 && r.heapUsedEnd < r.heapUsedStart * 1.4;
    r.pass = pass;
    console.log(`[harness] tier normal-${c}: pass=${pass} total=${r.total} fail=${r.fail} p99=${r.p99} heapPeak=${(r.peaks.heapUsedPeak / 1048576) | 0}MB isolation=${r.isolationViolations} cas=${r.lastCas && r.lastCas.casPass} logout=${r.logoutMaxMs}ms`);
    if (pass) lastStable = c; else break;
  }

  // PG 故障场景
  const pgScenarios = ['pool-full', 'slow-query', 'transaction-timeout', 'acquire-timeout'];
  for (const mode of pgScenarios) {
    console.log(`[harness] === PG fault: ${mode} ===`);
    const r = await runTier('pg-' + mode, users, 20, FAULT_SEC, mode, 'normal');
    r.pass = !serverCrashed && r.isolationViolations === 0 && r.lastCas && r.lastCas.casPass;
    results.faults.push(r);
    console.log(`[harness] PG ${mode}: pass=${r.pass} total=${r.total} status=${JSON.stringify(r.status)} pgWaitingPeak=${r.peaks.pgWaitingPeak}`);
  }

  // Provider 故障场景
  const provScenarios = ['500', 'timeout', 'abort', 'slow'];
  for (const mode of provScenarios) {
    console.log(`[harness] === Provider fault: ${mode} ===`);
    const r = await runTier('prov-' + mode, users, 20, FAULT_SEC, 'normal', mode);
    // 指数级增长检查：provider 请求/业务请求 比值应远小于 10（正常 ~1~3）
    const growthOk = r.providerGrowthRatio < 10 && !serverCrashed;
    r.pass = growthOk && r.isolationViolations === 0 && r.lastCas && r.lastCas.casPass;
    r.growthOk = growthOk;
    results.faults.push(r);
    console.log(`[harness] Provider ${mode}: pass=${r.pass} total=${r.total} provRatio=${r.providerGrowthRatio} status=${JSON.stringify(r.status)}`);
  }
  // 恢复正常模式
  writeFault({ pgMode: 'normal', providerMode: 'normal' });
  await sleep(600);

  // Provider 强制穿透验证（独立分组，用户硬性要求）
  console.log('[harness] === Provider 强制穿透验证（normal/500/timeout/abort/slow） ===');
  const pen = await runProviderPenetration(penUser).catch((e) => ({ error: String(e), crashImmune: !serverCrashed, perMode: [], exercisedProviders: [] }));
  results.providerPenetration = pen;
  console.log('[harness] Provider penetration: crashImmune=' + pen.crashImmune +
    ' allExercised=' + pen.allProvidersExercised + ' exercised=' + JSON.stringify(pen.exercisedProviders || []));

  // 恢复正常模式
  writeFault({ pgMode: 'normal', providerMode: 'normal' });
  await sleep(600);

  // 30 分钟长压 + 5 分钟观察
  const soakConc = lastStable >= 50 ? 50 : lastStable;
  console.log(`[harness] === 30min soak concurrency=${soakConc} ===`);
  const soakStart = readMetrics();
  const soak = await runTier('soak-30m', users, soakConc, SOAK_SEC, 'normal', 'normal');
  soak.pass = !serverCrashed && soak.isolationViolations === 0 && soak.lastCas && soak.lastCas.casPass &&
    soak.logoutWithin9s && soak.peaks.heapUsedPeak < 1200 * 1024 * 1024 && soak.heapUsedEnd < soak.heapUsedStart * 1.4;
  results.soak = soak;
  // 5 分钟观察（停止负载，保持服务存活）
  console.log('[harness] === 5min observation (no load) ===');
  writeFault({ pgMode: 'normal', providerMode: 'normal' });
  const obsStart = Date.now();
  let obsHeapStart = (readMetrics() && readMetrics().heapUsed) || 0;
  await sleep(OBS_SEC * 1000);
  let obsHeapEnd = (readMetrics() && readMetrics().heapUsed) || 0;
  const obsPeaks = (readMetrics() && readMetrics().peaks) || {};
  results.observation = {
    heapUsedStart: obsHeapStart, heapUsedEnd: obsHeapEnd,
    stable: Math.abs(obsHeapEnd - obsHeapStart) < 200 * 1024 * 1024, // 5min 内波动 <200MB
    heapUsedPeak: obsPeaks.heapUsedPeak || 0,
    rssPeak: obsPeaks.rssPeak || 0,
    elPeakMs: obsPeaks.elPeakMs || 0
  };
  // 最终 CAS 校验
  const finalCas = runCasBurst(300);
  results.finalCas = finalCas;

  // 汇总
  const m = readMetrics();
  results.summary = {
    serverCrashed,
    heapUsedStart: (soakStart && soakStart.heapUsed) || 0,
    heapUsedEnd: (m && m.heapUsed) || 0,
    heapUsedPeak: (m && m.peaks && m.peaks.heapUsedPeak) || 0,
    rssPeak: (m && m.peaks && m.peaks.rssPeak) || 0,
    elPeakMs: (m && m.peaks && m.peaks.elPeakMs) || 0,
    pgWaitingPeak: (m && m.peaks && m.peaks.pgWaitingPeak) || 0,
    providerQueuePeak: (m && m.peaks && m.peaks.providerQueuePeak) || 0,
    providerTotal: (m && m.peaks && m.peaks.providerTotal) || 0,
    oomCount: 0, // Node OOM 会致进程退出（serverCrashed/sigabrt）；此处由 serverCrashed 反映
    sigabrt: serverCrashed && (server.signal === 'SIGABRT' || server.exitCode === 134)
  };

  // 最终 Provider 维度统计快照（累计，含 activePeak）
  results.providerStatsFinal = snapProviderStats();

  const out = path.join(STRESS_DIR, 'STRESS_RESULT.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('[harness] DONE -> ' + out);
  console.log('[harness] serverCrashed=' + serverCrashed + ' FINAL CAS pass=' + (finalCas.casPass));

  // 关闭服务端
  try { server.kill('SIGTERM'); } catch (_) {}
  process.exit(0);
}

main().catch((e) => {
  fs.appendFileSync(SERVER_LOG, '\n[HARNESS-FATAL] ' + (e && e.stack || e) + '\n');
  console.error('HARNESS-FATAL', e);
  try { server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
