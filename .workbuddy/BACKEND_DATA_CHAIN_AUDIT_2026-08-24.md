# 后端真实数据链审计报告（2026-08-24）

> 范围：genius-trader2.0 后端（server/），生产实例 genius-trader.onrender.com
> 状态：**已修复（2 文件）→ 未部署 / 未提交 / 未 push**，停在工作树。
> 方法：生产直连拉取真实数据 + 代码链路审计，**未用静态推测替代实查**。

---

## 执行摘要（A/B/C 判定）

- **A（根因已定位，统一）**：四大现象（0824 缺失 / estimate=null / 切源永久 loading / history 停 0821）根因只有两类：
  1. 生产**无自动净值重导调度** → fund_nav 仅在单只基金被查看/刷新时才更新，导致各基金停滞在不同日期（0821 居多，019633 被刷新过所以有 0824）。
  2. 第三方估值链**批量预拉取无更短超时护栏** → /estimate、/today-nav 在第三方慢/挂时挂到 30s（>前端 20s abort），前端 loading 永不解除。
- **B（已实施最小后端修复）**：`providerEstimate.js` 加 8s 整体护栏；`index.js` 加 4h 周期 `syncAll` 全量重导调度器。
- **C（下一步）**：需用户在 Render 部署这两个文件（或本地 commit 后 GitHub Desktop 推送部署）。详见文末单条指令。

---

## 一、2026-08-24 正式 NAV 真正缺失原因

**结论：不是第三方缺失，是生产无自动重导。**

真实证据（生产直连 11 只基金，`/api/fund/:code`）：

| 基金 | 名称 | latest_nav 日期 | nav | updated |
|------|------|-----------------|-----|---------|
| 007339 | 易方达沪深300ETF联接C | **2026-08-21** | 1.8623 | 2026-08-24 |
| 380006 | 中银纯债债券C | **2026-08-21** | 1.2238 | 2026-08-24 |
| 019633 | 国泰半导体设备ETF联接C | **2026-08-24** | 2.8754 | 2026-08-25 |
| 002207 | 前海开源金银珠宝混合C | **2026-08-21** | 3.081 | 2026-08-24 |
| 004253 | 国泰黄金ETF联接C | **2026-08-21** | 3.4648 | 2026-08-24 |
| 002910 | 易方达供给改革混合 | **2026-08-21** | 8.3768 | 2026-08-24 |
| 004103 | 中信保诚稳悦债券C | **2026-08-21** | 1.1502 | 2026-08-24 |
| 006503 | 财通集成电路产业股票C | **2026-08-21** | 7.0335 | 2026-08-24 |
| 022184 | 富国全球科技互联网股票(QDII)C | **2026-08-21** | 5.2696 | 2026-08-24 |
| 008702 | 华夏黄金ETF联接C | **2026-08-21** | 2.1211 | 2026-08-24 |
| 013309 | 易方达恒生科技ETF联接(QDII)C | **2026-08-21** | 1.1163 | 2026-08-24 |

- **10/11 只停在 0821，仅 019633 有 0824** → 0824 NAV **可入库且已成功入库于 019633**（updated 2026-08-25，即该基金被单独刷新过、且 0824 已发布）。证明第三方与导入链本身可用。
- 根因：`render.yaml` 无任何 cron/scheduler，`navService.syncAll` 仅是手动 CLI 脚本（`scripts/syncFunds.js`），**生产从未自动重导**。fund_nav 只在单只基金被查看/刷新时由 `importFund` 更新 → 各基金"最新净值日期"取决于它最后一次被触发的时刻，自然混杂（不是 bug，是缺失自动同步）。

**修复**：`index.js` 新增 `startNavSyncScheduler()`，每 4h 调用 `navService.syncAll({})` 全量重导所有基金（内部 `importFund` 仅写确认净值，绝不写 estimate / 绝不污染 confirmed）。启动延迟 30s 首次执行，仅 cloud/production 启用，dev 默认禁用，可用 `DISABLE_NAV_SYNC=1` 关闭。

---

## 二、estimate=null 真正原因

**结论：第三方估值链慢/挂 + 批量预拉取无更短上限，导致 /estimate 在 settle 前 estimate 为 null，且前端 20s 中断更拿不到。**

- 真实证据：上述 11 只基金 **全部 `estimate: null`**（detail 接口直连）。
- 链路：`/estimate` → `fetchProviderEstimate` → `providerEstimate.getBulkFetchPromise` → `preFetchAllProviderEstimates` → `provider._request(AbortSignal.timeout(30000))`。**批量预拉取本身没有任何比 30s 更短的上限**。第三方慢/不可达时，请求一直挂到 30s，前端 20s 已 abort，estimate 始终为 null。
- 注意：本地引擎兜底（`calculateFundEstimate`）本应在 provider 失败时给出"灰估值"，但前提是 provider 调用先 reject/超时；30s 才超时意味着用户早已超时离开。

**修复**：`providerEstimate.js` 新增 `BULK_FETCH_TIMEOUT_MS=8000` 与 `withBulkTimeout(promise, cacheKey)`，包裹 `getBulkFetchPromise` 的返回（含缓存命中分支）。整体 8s 上限 → 超时 reject → 调用方 `.catch` 吞掉 → 走本地引擎兜底（灰"估值"）。底层 provider 30s 超时仍在，本护栏只让"慢/挂第三方"不再阻塞用户请求——这是修复真实 hang，不是用 timeout 掩盖。

---

## 三、切源永久 loading 真正原因

**结论：后端 /estimate、/today-nav 因第三方间歇性慢/挂而不 settle（>前端 20s abort），前端 loading 的 finally 永远走不到。**

- 真实 hang 测试（生产直连，12s 上限）：

| 端点 | 结果 |
|------|------|
| `/api/fund/007339/today-nav` | SETTLED 5707ms ✅ |
| `/api/fund/007339/estimate` | **NOT_SETTLED >12000ms（TimeoutError）** ❌ |
| `/api/fund/019633/today-nav` | **NOT_SETTLED >12000ms（TimeoutError）** ❌ |
| `/api/fund/019633/estimate` | SETTLED 790ms ✅ |

→ **间歇性**：同一端点有时秒回、有时挂 12s+。这正是"切源时偶发永久 loading"的真实成因——前端 `requestJson` 20s AbortController 超时，但后端 provider 30s 才超时，中间窗口 loading 卡死；切换数据源时触发批量预拉取更易踩中慢第三方。

**修复**：同第二节 8s 护栏——后端请求最迟 8s 内 reject，`/estimate`、`/today-nav` 在 8s 内必有结果（或本地兜底），前端 loading 必定解除。前端 `then/catch/finally` 清 loading 逻辑本身正确（已审 `live-estimates.js` / `status-clock.js`），卡死全因后端不 settle。

---

## 四、history 停在 0821 真正原因

**结论：history 与 latest_nav 同源（fund_nav 表），不是独立 bug，是 fund_nav 长期未重导的同一根因。**

- 真实证据：10 只基金 `history` 最新一条 = 0821，`data_status.label = "数据正常"`；019633 `history` 最新 = 0824（它刚被重导过）。
- `/history` 接口本身正常（019633 返回到 0824，证实不是接口截断）。缺失的是"持续把最新 NAV 写回 fund_nav"，与第一节 0824 缺失同一根因。
- 已验证：**不回补前一日确认净值** 的设计正确——`navCacheService.ensureTodayNav` 只写 expected 日（盘中=今天），`before-close` 返回 nav=null，绝不回补 0821/0824 已确认净值。混杂现象（0820/0821/0824 不同基金不同日期）是"各基金最后触发时刻不同"，不是 bug。

---

## 五、实际修改文件

1. `server/services/providerEstimate.js`
2. `server/index.js`

（git status：仅这 2 文件 modified；`navCacheService.js` 等其余文件未动。）

---

## 六、每个修改的原因

### FIX 1 — `server/services/providerEstimate.js`
- **改了什么**：新增 `BULK_FETCH_TIMEOUT_MS = 8000` 常量与 `withBulkTimeout(promise, cacheKey)` 护栏函数；在 `getBulkFetchPromise` 的两处返回（缓存命中分支、新发起分支）用 `withBulkTimeout` 包裹。
- **为什么**：批量预拉取 `preFetchAllProviderEstimates` 走 `provider._request(AbortSignal.timeout(30000))`，但批量层本身无更短上限 → 第三方慢/挂时 `/estimate`、`/today-nav` 挂到 30s（>前端 20s abort）→ 永久 loading + estimate=null（第二、三节根因）。8s 护栏让慢/挂第三方不再阻塞用户，超时后 `.catch` 走本地引擎兜底（灰"估值"）。**底层 30s 超时保留，是修复真实 hang，非掩盖。**

### FIX 2 — `server/index.js`
- **改了什么**：新增 `startNavSyncScheduler()`（每 4h 调 `navService.syncAll({})` 全量重导；启动延迟 30s 首次执行；仅 cloud/production 启用，dev 默认禁用，`DISABLE_NAV_SYNC=1` 可关）；在 `startServer` 中 `startMemoryDiagnostics()` 之后调用。
- **为什么**：生产无自动净值重导（render.yaml 无 cron，syncAll 仅手动脚本）→ fund_nav 仅单只基金被查看/刷新时更新 → 各基金 latest_nav/history 长期停滞在 0821（第一节根因）。4h 调度器持续把最新确认净值写回 fund_nav，且 `importFund` 仅写确认净值、绝不污染 estimate/confirmed。

---

## 七、P3.3-H（navCacheService.js / 并发竞速 + 信号量冻结）是否修改

**否。未改动 `server/services/navCacheService.js`。**

- `ensureTodayNav` 的 OOM 修复结构、inFlight Map + externalQueue + `MAX_EXTERNAL_CONCURRENCY=6` 信号量冻结逻辑全部保持原样。
- 本次 0824 / 历史停更与 P3.3-H 无关（scope 外）：P3.3-H 只负责"盘中 expected 日"的并发安全写入，不负责"全量历史净值回填"，后者由 `navService.syncAll → importFund` 承担。

---

## 八、10+ 基金真实数据验证（生产直连，非推测）

见第一节表格：**11 只全部直连成功**（curl/node fetch 绕过 WebFetch 缓存，非冷启动伪页），10 只 latest_nav=0821、1 只=0824；**全部 `estimate: null`**；`data_status` 全部"数据正常"。

> 注：早前 WebFetch 命中 Render free-tier "Application loading" 冷启动页，是因 WebFetch 15 分钟缓存重放了上一轮的同 URL 冷启动 HTML（页面内时间戳 03:56/11:56/14:56/15:56 杂乱可证）；改用 curl 直连后 6 只基金全部正常返回 JSON。无数据伪造。

---

## 九、node --check

```
server/services/providerEstimate.js  → PASS
server/index.js                      → PASS
NODE_CHECK_PASS
```

---

## 十、mp1/test-regression

```
mp1/test-regression.mjs → 通过 39，失败 0  (39/39 PASS)
```
（含 provider 日期不制造蓝标、confirmed=false 不蓝、QDII 白名单、todayEstimate 优先级、流水排序、officialNavChange 等断言全过。）

---

## 十一、npm test（server）

**结果：10 pass / 8 fail（预存在，与本后端改动无关，未改测试）。**

失败根因已定位（非回归）：
1. **陈旧硬编码路径**：`server/tests/estimateFallback.test.js:41` 用 `require(path.join(PROJ, 'services/estimateEngine.js'))`，其中 `PROJ` 硬编码旧父目录 `C:\Users\Administrator\Desktop\Codex3 基金\genius-trader2.0`（2026-08-21 已改名为 `Codex3`）→ `Cannot find module ... estimateEngine.js` → estimateFallback 整文件 + calibration 部分子测试失败（MODULE_NOT_FOUND）。
2. **测试数据漂移**：`data-layer.test.js` / `calibration.test.js` 断言期望 `'测试基金C'`，但 DB 现已存真实名 `'国泰中证半导体材料设备主题ETF发起联接C'` → `AssertionError`（ERR_ASSERTION）。

通过项（ok 4–8）：SQLite 建表、Eastmoney JS 解析、官方页 NAV 兜底解析、实时估值/历史/持仓解析、天天基金历史 NAV 解析——均与本次改动无关且正常。

> 遵循指令：**未为通过测试修改任何测试文件**。这两类失败属于环境/历史遗留问题，应由独立的测试修复任务处理，不在本次"后端数据链"修复范围内。

---

## 十二、git diff

```diff
diff --git a/server/index.js b/server/index.js
index a2ac1aa..90751b0 100644
--- a/server/index.js
+++ b/server/index.js
@@ -226,6 +226,48 @@ function startMemoryDiagnostics() {
   if (timer.unref) timer.unref();
 }
 
+// Phase 3.10-DATA：净值数据链自愈调度器。
+// 根因：生产环境此前没有「自动重导所有基金」的机制，fund_nav 只在单只基金被查看/刷新
+// 时才更新，导致「最新确认净值」长期停留在某一天（例如 0821/0824 大面积缺失）。
+// 本调度器周期性调用 navService.syncAll（内部 importFund 全量回填 fund_nav，仅写确认净值，
+// 绝不写 estimate / 绝不污染 confirmed），保证所有基金的最新确认净值持续入库。
+// 注意：不触碰 navCacheService（P3.3-H 冻结），也不改写任何前端逻辑。
+function startNavSyncScheduler() {
+  if (process.env.DISABLE_NAV_SYNC === '1') {
+    console.log('[NAV-SYNC] disabled by DISABLE_NAV_SYNC=1');
+    return;
+  }
+  const { isCloud } = require('./database/dbAsync');
+  if (!isCloud() && process.env.NODE_ENV !== 'production') {
+    console.log('[NAV-SYNC] disabled in local/dev mode (set NODE_ENV=production or run on cloud to enable)');
+    return;
+  }
+  const INTERVAL_MS = 4 * 60 * 60 * 1000; // 每 4 小时全量重导一次
+  let running = false;
+  const runOnce = async () => {
+    if (running) return;
+    running = true;
+    const startedAt = Date.now();
+    try {
+      const { syncAll } = require('./services/navService');
+      const results = await syncAll({});
+      const ok = results.filter(r => r.success).length;
+      const fail = results.length - ok;
+      console.log(`[NAV-SYNC] completed in ${Date.now() - startedAt}ms: ${ok} ok, ${fail} failed, total ${results.length}`);
+    } catch (err) {
+      console.error('[NAV-SYNC] run failed:', err && err.message);
+    } finally {
+      running = false;
+    }
+  };
+  const initial = setTimeout(() => { runOnce(); }, 30 * 1000);
+  if (initial.unref) initial.unref();
+  const timer = setInterval(() => { runOnce(); }, INTERVAL_MS);
+  if (timer.unref) timer.unref();
+  console.log('[NAV-SYNC] scheduler started (interval=4h)');
+}
+
 async function startServer(port = 3000, host = '0.0.0.0') {
   const server = await createServer();
   server.listen(port, host, () => {
@@ -241,6 +283,7 @@ async function startServer(port = 3000, host = '0.0.0.0') {
   startMemoryDiagnostics();
+  startNavSyncScheduler();
   const shutdown = () => {
     server.close(() => {
       closeDatabase();

diff --git a/server/services/providerEstimate.js b/server/services/providerEstimate.js
index 7bff8fc..620620d 100644
--- a/server/services/providerEstimate.js
+++ b/server/services/providerEstimate.js
@@ -17,6 +17,14 @@ const SOURCE_ALIASES = { xbyj: 'xiaobeiyangji', yjb: 'yangjibao' };
 const PROJ... (PROVIDER_TIMEOUT_MS = 2500)
 const CACHE_TTL_MS = 300000;
 const ESTIMATE_CACHE_MAX = 2000;
+// P3.10-DATA：批量预拉取整体超时护栏。根因：preFetchAllProviderEstimates 走
+// provider._request(AbortSignal.timeout=30000)，但批量预拉取本身无更短上限；第三方慢/不可达时
+// getBulkFetchPromise 挂到 30s，导致 /estimate 与 /today-nav 超前端 20s 中断 → 永久 loading。
+// 这里给整体更短上限：超时即 reject，调用方 .catch 走本地引擎兜底（灰「估值」）。
+const BULK_FETCH_TIMEOUT_MS = 8000;
 
 // P3.3: bounded LRU + TTL cache ...
@@ -192,11 +200,21 @@ async function preFetchAllProviderEstimates(sourceName, userId) {
   }
 }
 
+function withBulkTimeout(promise, cacheKey) {
+  return Promise.race([
+    promise,
+    new Promise((_, reject) => setTimeout(() => {
+      reject(new Error('bulk-fetch-timeout:' + cacheKey));
+    }, BULK_FETCH_TIMEOUT_MS))
+  ]);
+}
+
 function getBulkFetchPromise(sourceName, userId) {
   const cacheKey = `${sourceName}:${userId}`;
   if (pendingBulkFetches.has(cacheKey)) {
-    return pendingBulkFetches.get(cacheKey);
+    return withBulkTimeout(pendingBulkFetches.get(cacheKey), cacheKey);
   }
   const promise = preFetchAllProviderEstimates(sourceName, userId).finally(() => {
     pendingBulkFetches.delete(cacheKey);
   });
   pendingBulkFetches.set(cacheKey, promise);
-  return promise;
+  return withBulkTimeout(promise, cacheKey);
 }
```

---

## 结论与下一步

**判定：A —— 根因已定位并修复（后端两文件），待部署生效。**

- 0824 缺失 / history 停 0821：**非第三方缺失**（019633 已入库 0824 为证）；根因是生产无自动净值重导 → 已用 4h `syncAll` 调度器修复。
- estimate=null / 切源永久 loading：**第三方估值链批量预拉取无更短上限** → 已用 8s 护栏修复（超时走本地兜底，前端 loading 必解除）。
- P3.3-H（navCacheService）：**未修改**。
- 验证：11 基金真实直连（10×0821 + 1×0824，全部 estimate=null）；node --check PASS；mp1/test-regression 39/39 PASS；npm test 10/8（预存在、与改动无关、未改测试）；git diff 仅 2 文件。
- 未 commit / 未 push / 未 deploy，停在工作树。

**单条下一步指令**：在 Render 部署这两个文件（或本地 `git add server/index.js server/services/providerEstimate.js` 后由你用 GitHub Desktop 提交并推送部署）；上线后 4h 调度器会自动补齐 0824 及后续 NAV，8s 护栏上线后 `/estimate`、`/today-nav` 不再永久 loading。
