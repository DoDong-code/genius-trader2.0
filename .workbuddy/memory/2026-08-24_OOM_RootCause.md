# Phase 3.3-G：Render 再次 OOM — 根因定位（只读 + mock 探针）

> 阶段结论：OOM 根因不在 P3.3 已修的 `ensureTodayNav` 路径，而在 `estimateEngine.calculateAccountEstimate` 路径（股票行情并发无限制）。
> 本阶段**只做定位**，未改任何生产代码。修复待用户确认后再做。

## 一、Render 在线 commit 确认（关键前置，需用户核对）
- 本地仓库 `genius-trader2.0` HEAD = `628ba74`（".2"），工作树干净。
- P3.3 修复已落库：
  - `.1` = `providerEstimate.js`(LRU+TTL+MAX=2000) + `navCacheService.js`(MAX_EXTERNAL_CONCURRENCY=6)
  - `.2` = `dbAsync.js`(lock/statement timeout + dedicated client) + `index.js`(schema 不阻塞 listen)
- **但 agent 无法读取 Render 实例，不能确认 Render 实际运行的是哪个 commit。** 若 Render 仍跑旧 commit（未部署 P3.3），本身就足以解释 OOM —— 用户必须在 Render 控制台确认"Deployed Commit"= 628ba74。

## 二、探针证据（server/tests/_oom_probe.js，mock，无真实请求）
**A 路径：ensureTodayNav（P3.3 已加 MAX=6 闸门）**
- 10/50/100 funds → actual maxConcurrent 均 = 4（≤6），peak RSS 53/59/66 MB。
- 结论：**有界、无害**。P3.3 对该路径有效。

**B 路径：calculateAccountEstimate（无并发闸门）**
- 10 funds → maxConcurrent 100；50 → 500；100 → 1000。
- maxConcurrent == funds × holdings（每个持仓一次 `fetchStockQuote`/`fetchHistoricalChange`）。
- 结论：**完全无界**。真实生产中 = 单次冷缓存账户估值即触发 500~1000 个并发出站 HTTP。

## 三、根因
- **主因：B（刷新并发无限制）+ F（Promise.all 瞬时峰值）**，位于 `calculateAccountEstimate`：
  `Promise.all(positions.map(calculateFundEstimate))` 内每个 `calculateFundEstimate`
  → `Promise.all(holdings.map(quoteFor))` + `fetchHistoricalChange`，
  叶子节点 `fetchStockQuote`/`fetchHistoricalChange` 直接 `fetch`（marketService），**没有任何 concurrency limiter**（与 `ensureTodayNav` 的 MAX=6 不同）。
- **次因：G（response/Buffer 未释放）**：`marketService.fetchText` 用 `await response.text()` 缓冲整段响应体；1000 并发时 body 同时驻留。
- **放大器**：`estimateEngine.cachedEstimate` 在收盘前 expired→返回 null，使 `fund_estimate` 缓存在交易时段形同虚设 → 每 5 分钟 / 每次页面加载 / 每次切数据源都重算 → 重复爆发。
- **为何 P3.3 没修好**：P3.3 只修了 nav 路径（A），完全没碰 account-estimate 路径（B）。

## 四、具体调用链
```
/api/account/:id/estimate  (api/fund.js:814)
  → calculateAccountEstimate(accountId)  (estimateEngine.js:480)
    → Promise.all(positions.map(calculateFundEstimate))   // 无限制，N 个并发
      → 每个 calculateFundEstimate (estimateEngine.js:275)
        → Promise.all(holdings.map(quoteFor))              // 无限制，×10 并发
          → quoteFor → fetchStockQuote (marketService:489) // 直接 fetch，无 limiter
          → fetchHistoricalChange (eastmoney kline + yahoo chart)
```
对比被 P3.3 保护的 nav 路径：`ensureTodayNav` → `runExternal` → `pumpExternal`（MAX_EXTERNAL_CONCURRENCY=6）。B 路径**没有等价闸门**。

## 五、分类（A–K）
- 主：B（刷新并发无限制）+ F（Promise.all 瞬时峰值）
- 次：G（response/Buffer 未释放）
- 放大器：cachedEstimate 收盘前 expired→null（交易时段缓存失效，重复爆发）
- 排除：A(刷新循环 无)、C(externalQueue 无界 实测有界≤6)、D(pendingBulkFetches 泄漏 .finally 清理 安全)、E(estimateCache 单 entry 过大 小扁平对象+2000 上限)、H(preFetch 双重放大 30s节流+去重 已基本缓解)、I(DB pool 非主因)、J(native memory 非主因)

## 六、建议修复（待确认，本阶段未实施）
1. **给股票行情路径加并发闸门**：复用 `navCacheService` 的 `externalQueue`/信号量模式（或抽公共 `withConcurrencyLimit`），`calculateFundEstimate`/`quoteFor`/`fetchHistoricalChange` 全部经统一 limiter（建议 6~8）。
2. **请求级去重/合并**：同一 account 的并发 `calculateAccountEstimate` 共享一次 in-flight 计算（避免 N 个重叠重算）。
3. **修正 cachedEstimate 收盘前行为**：交易时段允许返回"略旧但有效"的 estimate（缩短重算触发），或把重算的并发限制在闸门内。
4. **轻量 [MEMORY] 诊断**（用户 3.3-G 第八节要求）：每 60s 采样 rss/heapUsed/externalQueue/pendingBulkFetches/activeExternal，仅打点不刷屏。

## 七、预计影响
- 不改：单次冷缓存账户估值 = 数百~上千并发出站请求 → 512MB Render 实例反复 OOM 重启。
- 改后：并发被压到 ≤6~8，单账户估值峰值内存可控，OOM 消除；估值延迟略有上升（串行化），但可接受。

## 八、下一步（单条）
- **用户**：在 Render 控制台确认当前 Deployed Commit 是否为 `628ba74`；并把最近一次 OOM 前 5 分钟的 `/api/account/*/estimate` 请求频次回报。
- 确认后，agent 再实施"股票行情并发闸门 + 请求合并"修复（不动 P3.3 已修文件以外不必要处）。
