# 网页端 ↔ 小程序 功能对齐详细清单（逻辑 · UI · 缓存）

> 生成时间：2026-08-16。两端共用同一后端（`server/`），本清单以「网页端已实现并优化的功能」为基准，逐项拆解**逻辑 / UI / 缓存**三层，标注小程序现状与补全内容。
> 核心源码锚点：网页端 `live-estimates.js`（数据标识状态机）、`app-refactor.js`（账户类型/同步标识）、后端 `estimateEngine.js`（估值+缓存）、`calibrationEngine.js`（校准）、`api/fund.js`（路由+fast 缓存）。

---

## 一、两端架构定位（同后端，不同前端栈）

| 维度 | 网页端（Web SPA） | 小程序（mp1） |
|---|---|---|
| 身份 | 邮箱+密码 / Bearer token（`/api/auth/*`） | 微信登录 openid，本地 storage |
| 持仓存储 | 服务端 PostgreSQL（`/api/portfolio/*`） | 本地 storage + 微信云数据库同步 |
| 请求通道 | fetch → 公网域名 | `callContainer` / `wx.request` 回退 |

> 账号体系、持仓存储是各自历史架构，**不强行对齐**。以下聚焦「同后端能力」的**前端逻辑对齐**。

---

## 二、数据标识状态机（★★★ 核心差异，用户重点）

### 网页端逻辑（`live-estimates.js`）

三态判定，每只基金最终落到三种徽章之一：

```
输入：fund(名称/代码) + snapshot.latest_nav.date + estimate(trade_date/source)
  ├─ isTradingDay(今天)          → 周末(Sat/Sun)+2026节假日硬编码表 判定
  ├─ isShanghaiAfterClose()      → 北京时间 ≥ 15:00 判定
  ├─ isQdiiFund(fund)            → 名称匹配 QDII/全球/海外/纳指/标普/日经/德国/法国/印度/越南/美国/道琼斯/欧洲
  │                                （排除 恒生/港股/港美 → 这些当日结算）
  │                                + 白名单 QDII_CODES={022184,014002}
  └─ expectedNavDate = isQdii ? getPreviousTradingDay(今日) : 今日

三态输出：
  ① officialUpdated  = navDate === expectedNavDate 且有涨跌幅
     → 蓝色徽章「已更新MMDD」        （markNavUpdated，官方净值）
  ② !isTrading 且 navDate 存在
     → 蓝色徽章「已更新MMDD」        （非交易日：显示最近交易日净值）
  ③ 其他（交易日盘中/盘后，净值未出）
     → 灰色徽章「估值 / 小倍 / 养基宝」 （markEstimateBadge，label=providerDisplayName(source)）
```

关键细节：
- **美股 T+2 体现**：`expectedNavDate = getPreviousTradingDay(今日)` → 美股基金今天结算的是**上一交易日**净值，故显示「已更新 0813」（若 0814 是今日）。
- **数据源 label**：`source==='xiaobeiyangji'→'小倍'`、`'yangjibao'→'养基宝'`、其余(本地引擎)→'估值'。
- **官方涨跌幅计算** `officialNavChange()`：从 history 里取 `navDate` 当天与前一交易日的净值 `curr/prev-1`，而非直接用 estimate 的涨跌幅。
- **非交易日**：走 ②，展示最近一个交易日的净值（不会显示"待估值"）。
- **第三方已更新净值**（盘中收盘后第三方返回确认净值）：另有 `markProviderUpdated` 蓝徽章「小倍MMDD/养基宝MMDD」（当前代码定义了但主流程走 ①②③）。

### UI（`layout.css`）

```
标识位置：在「代码 · 板块」那一行的【最前面】（代码左边），insertBefore(meta.firstChild)
徽章样式：
  .nav-updated-badge  → 背景 rgba(0,0,0,.05) 浅灰底 + 文字 #0071e3 蓝色  → 「已更新0814 / 小倍0814 / 养基宝0814」
  .nav-estimate-badge → 背景 rgba(0,0,0,.05) 浅灰底 + 文字 #86868b 灰色  → 「估值 / 小倍 / 养基宝」
文本：
  desktop:「已更新0811」/「小倍0811」/「养基宝0811」/「估值」
  mobile :「08-11」/「08-11」/「08-11」/「估值」
```

### 小程序现状（`portfolio.js` 435-460 行）

```
当前 dataBadge 仅两态，无交易日/收盘/QDII/日期判断：
  灰「估值」（本地估算）
  蓝「养基宝/小倍」（第三方，仅看 estimateSource + 是否已连接）
位置：在「代码 · 板块」行的【右边】（需移到代码左边）
```

### 补全内容（待做）
1. 新增工具函数：`isTradingDay / isShanghaiAfterClose / isQdiiFund / getPreviousTradingDay / providerDisplayName`。
2. 每只基金拉取 `latest_nav.date` + `history`，计算 `officialNavChange`，判定三态。
3. `dataBadge` 输出：`{text, tone}` 改为 蓝「已更新MMDD」/ 蓝「小倍MMDD」/ 蓝「养基宝MMDD」/ 灰「估值」/ 灰「小倍」/ 灰「养基宝」。
4. WXML 徽章移到代码左边。

---

## 三、账户同步标识（★★）

### 网页端逻辑（`app-refactor.js` 13-40、531-539 行）

```
账户类型：accountType = 'sync' | 'local'（兼容旧 __source 字段）
  ensureAccountType(acc)：__source 存在 → sync + syncSource；否则 local
  isSyncAccount(acc)    ：accountType==='sync' 或 (无 accountType 且有 __source)

账户管理列表渲染：
  同步账户名后追加 <span class="synced-badge">同步</span>
  父账户追加 <span class="parent-badge">N 子账户</span>

来源：养基宝/小倍一键导入的账户 → 服务端加载时标记 accountType=sync，不持久化本地
修改同步账户 → convertAccountToLocal() 解除同步（保留数据+来源记录）
```

### 小程序现状
- 无 accountType/syncSource/isSyncAccount 概念；账户列表无「同步」徽章。

### 补全内容（待做）
1. 账户对象加 `accountType`/`syncSource` 字段。
2. 第三方导入（onYjbImport/onXbyjImport）时标记 `accountType='sync'` + `syncSource='yangjibao'|'xiaobeiyangji'`。
3. 账户列表 WXML 同步账户名后加「同步」徽章（复用 synced-badge 样式）。

---

## 四、基金估值引擎

### 网页端逻辑（后端 `estimateEngine.js`）
- `calculateFundEstimate(code)`：最新持仓 `weight × 个股涨跌幅` → holdingsChange；板块基准 sectorBenchmarks → sectorChange；债券基金特殊处理。
- QDII 基金 targetDate = `getNextTradingDay(latest_nav.date)`（美股 T+1）。
- `confidenceFor()`：覆盖率+已发布权重+板块可得性 → high/medium/low。
- 三种 mode（`api/fund.js` estimate 路由）：
  - `mode=local`：仅本地引擎
  - `mode=provider`：仅第三方（无数据回退本地但保留 source 标识）
  - 默认：本地引擎 + 第三方**并行，谁快谁先出**

### 小程序现状
- `refreshEstimatesBySource` 只按 source 拉 estimate，未用「谁快谁先出」默认模式，无 confidence 展示。

---

## 五、基金校准（★ 本次补全，用户已确认要做）

### 网页端逻辑（后端 `calibrationEngine.js`）
- `calibrateFund(code, {force})`：历史净值回测，MSE 最小化网格搜索最优 `holdingsWeight / sectorWeight / cashAdjustment`。
- 结果存 `fund_calibration` 表；非 force 直接返回缓存。
- 输出：`calibrated / holdings_weight / sector_weight / cash_adjustment / mae / rmse / direction_accuracy / sample_size / calibrated_at`。
- 路由：`GET /api/fund/:code/calibration`（`?recalibrate=1` 强制重算）。

### 小程序现状
- 未接入校准接口，无校准入口/结果展示。

### 补全（本次已做，见下方"本次改动"）

---

## 六、缓存加载策略（★★ 网页端已优化，小程序未跟上）

### 网页端多层缓存

| 层 | 机制 | 位置 |
|---|---|---|
| 详情快照（前端内存） | `detailApiFundCache` 内存缓存，切换 tab 复用 | `detail-api.js` |
| 详情快照（服务端 fast） | `?refresh=1&fast=1` → 立即返回缓存，后台异步增量刷新（持仓季度级、历史每日增量），**抽屉秒开** | `api/fund.js` 466-478 |
| 估值缓存（DB） | `fund_estimate` 表按 `fund_code+trade_date` 缓存，`expires_at` 过期；**盘中过期不可用，盘后过期仍可用(closing_snapshot)** | `estimateEngine.js cachedEstimate` |
| 净值标识缓存（前端） | `updatedNavDates[code]={day,navDate}`，已更新净值基金**切换 tab 不重复请求**，仅手动刷新更新 | `live-estimates.js` 109、389-400 |
| 并发控制 | `MAX_CONCURRENT=6` 队列 `enqueue/drain`，避免多基金同时请求卡顿 | `live-estimates.js` 333-348 |
| 谁快谁先出 | 本地引擎先出，已登录第三方时 2.5s 后拉第三方估值更正 | `live-estimates.js` 498-518 |

### 小程序现状
- fundDetail 详情每次进都拉（无 fast 秒开、无内存缓存）；估值无 DB 缓存利用（后端已有，前端未传 fast）；无并发队列；无 updatedNavDates 级缓存。

### 补全内容（待做）
1. fundDetail 进抽屉用 `?refresh=1&fast=1` 秒开。
2. 估值请求加并发上限（如 4）队列。
3. 已更新净值基金当日缓存，切 tab 不重复请求。

---

## 七、获取数据逻辑（非交易日）

- 非交易日：不显示「待估值」，直接显示**最近交易日净值**（蓝「已更新MMDD」）。
- 数据日期 `dataDateToSet`：优先 `estimate.trade_date/nav_date`，用于顶部「数据：MM-DD」状态。
- 官方涨跌幅优先于估值涨跌幅：`officialUpdated ? officialChange : estimate.estimate_change`。

---

## 八、本次改动（2026-08-16 已补全）

- ✅ **基金校准**：`components/fundDetail` 接入 `/api/fund/:code/calibration`
  - `fundDetail.js`：新增 `calibration`/`isCalibrating` data 字段；`loadCalibration(code)` 进抽屉自动加载已有校准结果（非 force 复用后端缓存）；`onCalibrate()` 手动触发 `?recalibrate=1` 强制重算，展示方向准确率/MAE/样本数。
  - `fundDetail.wxml`：历史净值标题右侧加「校准/重校准」胶囊按钮；下方加校准结果条（已校准/样本不足 + 样本N日 + 方向准确率 + MAE）。
  - `fundDetail.wxss`：新增 `.calibrate-btn` / `.calibration-result` / `.calibration-status` / `.calibration-metric` 样式。
  - 接口实测：`/api/fund/019633/calibration` 返回 200，格式含 `calibrated/sample_size/mae/rmse/direction_accuracy/calibrated_at`（null 已在前端兜底显示「—」）。

## 九、待办优先级

| 优先级 | 项 | 工作量 |
|---|---|---|
| P0 | 数据标识状态机（交易日/收盘/QDII/T+2/已更新MMDD）+ 徽章移到代码左边 | 中 |
| P1 | 账户同步标识（accountType/syncSource + synced-badge） | 中 |
| P1 | 缓存加载（fast 秒开 + 并发队列 + updatedNavDates） | 中 |
| P2 | 估值 confidence 展示 | 低 |
