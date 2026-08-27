# 生产稳定性修复 — 最终报告（2026-08-26）

> 范围：`C:\Users\Administrator\Desktop\Codex3\genius-trader2.0`
> 节点：P0-4 账户生命周期竞态回归测试调试 + 全量测试修复 + 生产启动验收

---

## 1. 概览 / 本次完成工作

- 定位并修复 **1 个真实生产 Bug**：`server/api/external.js` 的 `handleExternalApi` 在每次已鉴权的只读外部 API 请求上都抛 `userId is not defined`（ReferenceError → 500），导致整个只读 Token 数据接口不可用。
- 修复 **5 个测试替身（fixture）缺陷**：它们没有正确模拟真实 `pg` 的 `{rows, rowCount}` 返回形状及 CAS 自增/条件更新语义，导致 `node --test` 有 13 项误报失败。修复为正确模拟（**未削弱任何断言**）。
- 全量测试由「13 失败」转为 **90/90 全通过**（17 个测试文件）。
- `npm run build` 成功；生产启动 Smoke 测试通过。
- 数据源保护红线全程未触碰（无 Provider 删除/修改，仅 `fetch` 包裹超时）。

---

## 2. 修复的生产 Bug（按优先级）

### P0 — `handleExternalApi` 的 `userId` ReferenceError（真实生产 Bug）
- **根因**：`runInRequestScope(async () => { ... }, { userId })` 的第二个实参 `{ userId }` 在 `handleExternalApi` 的**外层作用域**求值，但 `userId` 仅在内层 `async` 回调里 `const userId = auth.userId` 声明（行 103）。外层 `userId` 未定义 → 每次调用直接抛 `ReferenceError: userId is not defined`，早于任何路由处理，已鉴权请求必 500。
- **修复**（`server/api/external.js`）：把 OPTIONS 预检、速率限制、Token 校验（`const userId = auth.userId`）全部**移到 `runInRequestScope` 之前**；随后 `return runInRequestScope(async () => { ... 路由处理 ... }, { userId })`。`userId` 现在在外层已定义，且按 P0-4 设计意图正确写入 `scope.meta`（供写时身份校验读取）。请求作用域仍包裹所有分析路由（`buildAnalysisPortfolio`/`loadUserAccounts` 的 `requestMemo` 去重不受影响）。
- **影响**：只读外部分析 API（portfolio / analysis / analysis/ai / accounts / fund / history / estimate）恢复可用。

---

## 3. 变更文件清单（逐文件）

### 生产代码
| 文件 | 变更 |
|---|---|
| `server/api/external.js` | **修复** `handleExternalApi`：将鉴权/速率限制前置，`userId` 在入域前确定并传入 `scope.meta`。删除原行 265 的越界 `{ userId }` 引用（详见 §4）。 |

### 测试替身（fixture 修正，非生产逻辑）
| 文件 | 变更 |
|---|---|
| `server/tests/accountLifecycleRace.test.js` | fake `pg` 的 `SELECT data FROM user_data` 分支原返回裸数组，改为返回 `{ rows, rowCount }`（与真实 `pg` 一致），否则 `queryCloud` 取 `result.rows` 为 `undefined` → `get()` 抛 `rows[0]` 错。 |
| `server/tests/accountCas.test.js` | 重写了 mock `dbAsync.run`：正确模拟 `INSERT … DO NOTHING`（行缺失才写）、`UPDATE … revision+1`（自增）、`UPDATE … SET revision=? WHERE revision=?`（原子条件更新，冲突返回 `changes:0`），修复原实现把 `revision` 用 `params[1]` 覆盖为 `undefined` 的缺陷。 |
| `server/tests/noSyncIo.test.js` | fake `pg` 改为持有共享 `store={rev,data}` 并跟踪 CAS 语义（原实现对 `SELECT revision` 永远返回空行，导致 `(undefined).revision` 抛错）。本测试仅断言「无同步 IO」，不受影响。 |
| `server/tests/accountStateSize.test.js` | 同上，fake `pg` 加共享 `store` 与 CAS 语义，并保留 `FakePool._writeCount` 全局写计数（用于「超大体量不落库」断言）。 |
| `server/tests/calibration.test.js` | `test.after` 清理 `fs.rmSync` 在沙箱（safe-delete 拦截）下会失败 → 包 `try/catch` 改为 best-effort；真实校准断言不受影响（2 项均通过）。 |
| `server/tests/accountLifecycleRace.test.js`（调试期） | 曾临时加 `dbAsync.js` 调试日志，已**还原**，无净变更。 |

### 清理
- 删除 `server/tests/_oom_probe.js`、`server/tests/_verify_h.js`（前序会话遗留的临时调试脚本，非 `.test.js`、无引用）。

---

## 4. 删除 / 移除的代码

- `server/api/external.js` 原第 265 行：`, { userId });` 中越界的 `userId` 引用（伴随把鉴权逻辑从回调顶部上移）。**非业务规则删除**，仅修正词法作用域错误。
- `dbAsync.js` 调试期临时 `console.error('[DBG-...]')` 两处——已还原，源码零净变更。
- 无任何 Provider、路由、`fallback`、数据源相关代码被删除（见 §9）。

---

## 5. P0 / P1 状态表

| 项 | 内容 | 状态 |
|---|---|---|
| P0-2 | `unref()` 定时器类（acquireClient 超时 / transaction watchdog / httpClient / portfolioAnalysisService） | ✅ 已修（请求路径 `unref` 全部移除，注释标注「严禁 unref」） |
| P0-3 | 云端请求路径不触发同步 IO / 同步 SQLite | ✅ 已修并验证（`noSyncIo` 2/2） |
| P0-4 | 账户生命周期竞态 CAS（服务端隔离 + 陈旧写入拒绝） | ✅ 已修并验证（7/7 + accountCas 5/5 + accountStateGuard 7/7） |
| P0-5 | `user_data_rev` CAS 修订号（消除 last-write-wins） | ✅ 已修（原子条件 UPDATE，accountStateService.js） |
| P0-6 | Provider `fetch` 超时/中止包裹 | ✅ 已修（fetchWithTimeout 统一） |
| P1-7 | Token 校验缓存 / 节流 / 撤销 / 速率限制 | ✅ 已修并验证（tokenHardening 4/4） |
| P1-8 | acquire/transaction 超时真实触发 + 连接释放 + waiting 不增长 | ✅ 已修并验证（dbAsync 9/9） |
| P1-9 | 跨实例调度去重（advisory lock + sync_markers） | ✅ 已修并验证（advisoryLock 4/4；PG `sync_markers` 表已建） |
| P1-10 | `aiBundle` 生产安全（绝不 `execSync`） | ✅ 已修并验证（aiBundle 3/3） |
| P1-11 | 账户状态体积上限 `MAX_BODY_BYTES` | ✅ 已修并验证（accountStateSize 3/3 + 旧客户端兼容） |
| **本次** P0（external API） | `handleExternalApi` `userId` ReferenceError | ✅ 已修并验证（external 5/5 + smoke 200） |

---

## 6. 测试结果汇总（PASS / FAIL）

- 命令：`node --test server/tests/*.test.js`（`npm test`）
- 总计 **90 个测试，17 个测试文件，0 失败**（修复前为 13 失败）。
- 失败项与根因（均已修复）：

| 失败用例 | 根因 | 类别 | 修复 |
|---|---|---|---|
| accountCas 1–5 | mock `run` 未模拟 CAS，把 `revision` 覆盖为 `undefined` | 测试替身 | 重写 mock `run` |
| accountStateSize 21 | fake `pg` 对 `SELECT revision` 返回空行 | 测试替身 | fake 加共享 store |
| noSyncIo 1 | fake `pg` 对 `SELECT revision` 返回空行 | 测试替身 | fake 加共享 store |
| accountLifecycleRace 1,2,3,5,6 | fake `pg` 对 `SELECT data` 返回裸数组 | 测试替身 | 改返回 `{rows,rowCount}` |
| external 1–6（只读 Token） | **生产 Bug**：`userId` ReferenceError | 生产代码 | 重构 `handleExternalApi` |
| calibration（file-level） | `test.after` `fs.rmSync` 被沙箱 safe-delete 拦截 | 环境 | 清理改 best-effort |

所有「测试替身」类修复**只是让 fake 正确模拟真实 `pg`**，断言本身（修订号递增、冲突拒绝、隔离、无同步 IO、超大体量不落库）全部保留并增强覆盖。

---

## 7. Build 结果

- 命令：`npm run build`（`node scripts/build-static.js`）
- 结果：**成功**（`BUILD_EXIT=0`，产物 `dist/`）。
- 备注：vite 报若干 `<script …> can't be bundled without type="module"` 警告——**预存非致命**，不影响产物生成与启动；属历史前端脚本标记问题，不在本次范围。

---

## 8. 生产启动 Smoke 测试结果

- 方式：单进程启动 `startServer(4399,'127.0.0.1')`（本地 SQLite 模式，无需活 PG），真实 HTTP 请求验证。
- 结果：
  - `GET /api/health` → **200**
  - `generateToken(1)` → **ok**（len=43）
  - `saveUserState(1, …)` → **ok**
  - `GET /api/external/analysis/portfolio`（带有效 Bearer Token）→ **200**（**正是原 `userId` Bug 触发的路径，现已恢复**）
  - `GET /api/external/analysis/portfolio`（无 Token）→ **401**（符合预期，未泄露数据）
- 结论：服务可正常启动，只读外部 API 在鉴权通过后正常返回。

---

## 9. 数据源保护确认（红线）

- **未删除/未修改任何基金数据源、第三方 Provider、`fallback` 路由**：Tencent / Sina / Eastmoney / Yahoo 及既有生产 Provider 全部保留（名称仍出现在 `fundService` / `marketService` / `navCacheService` / `estimateEngine`）。
- **仅做超时/中止包裹**：`fetch` 统一替换为 `fetchWithTimeout`（出现于 `providers/xiaobeiyangji.js`、`providers/yangjibao.js`、`services/fundService.js`、`services/marketService.js`、`services/estimateEngine.js`、`services/navCacheService.js`）。无路由优先级 / Provider 选择逻辑改动。
- **Before/After 路由对比**：
  - Before：`provider._request` 内联 `AbortSignal.timeout(30000)`（请求路径 `unref` 隐患 + 硬超时）。
  - After：统一 `fetchWithTimeout(url, { timeout, … })`（封装 `AbortController` + 不 `unref` 的定时器），调用方签名与 `fallback` 链路不变。
- **`?token=` 删除红线**：未触碰任何 `source_credentials` / token URL 拼接逻辑。
- **`sync_markers` 放置正确性**：SQLite 由 `db.js`（行 184，`CREATE TABLE IF NOT EXISTS sync_markers`）建立；PostgreSQL 由 `dbAsync.ensureCloudSchema()`（行 360）建立，均 `IF NOT EXISTS`；`getSyncMarker`/`setSyncMarker` 走各自表，云端不依赖 SQLite `sync_markers`，迁移/启动不会破坏现有数据。

---

## 10. 残留风险与下一步

1. **云端 PG 路径未端到端联调**：Smoke 测试在本地 SQLite 模式下进行（沙箱无活 PG / `DATABASE_URL`）。`handleExternalApi` 的路由逻辑与 DB 无关（仅经 `dbAsync` 抽象），行为在 PG 模式一致；**建议 Render 部署后对 `/api/external/analysis` 用真实只读 Token 做一次线上 Smoke**（A 类：上线后补一次）。
2. **`index.js` 调度器 / `providerEstimate` 缓存清扫的 `unref()` 保留**：属后台定时器（不阻塞进程退出），符合设计；非请求路径，不在本次红线范围。
3. **`calibration.test.js` 清理 best-effort**：若沙箱拦截 `fs.rmSync`，`server/tests/calibration-test-*` 临时目录可能残留，无害，可手动清理。
4. **`scope.meta.userId` 写时校验**：当前外部 API 为只读，写时身份校验不在此路径；现金代码 `userId` 已正确入域，P0-4 服务端防线保持生效。
5. **下一步（单条）**：将本次修改提交（`git commit`），推送前请在 GitHub Desktop 完成 push（Agent 无 GitHub 凭据，不得代 push）。

---

### 附：本次会话真实改动文件
- `server/api/external.js`（生产 Bug 修复）
- `server/tests/accountLifecycleRace.test.js`、`accountCas.test.js`、`noSyncIo.test.js`、`accountStateSize.test.js`、`calibration.test.js`（替身/清理修正）
- 删除：`server/tests/_oom_probe.js`、`server/tests/_verify_h.js`
