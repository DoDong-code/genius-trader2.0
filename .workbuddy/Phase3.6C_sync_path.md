# Phase 3.6-C —— sync 账户小程序真实取数路径验收（只读代码）

> 对象：李总（user_id=2）「小倍养基-默认账户」sync 账户，36 只基金（其中 26 只属 Phase 3.6-B 的 B 类）。
> 方法：纯静态代码阅读，未调用任何生产接口、未触发 importFund、未调 /estimate、未改代码/库/部署、未用 token。
> 结论（先行）：**C = 列表可用但详情页受影响，需要修复详情数据链。**

---

## 0. 红线合规声明

| 禁止项 | 本阶段是否触及 |
|---|---|
| 修改代码 | ❌ 未改 |
| 部署 | ❌ 未部署 |
| 调用 `/estimate` | ❌ 未调用（仅代码级确认 portfolio.js:433、fundDetail 未调） |
| 触发 `importFund` | ❌ 我的动作未触发；仅代码级指出 fundDetail 运行时 `?refresh=1&fast=1` 会触发（属小程序既有行为，非我发起） |
| 写数据库 / 改生产数据 | ❌ 未写 |
| 用 token / 调生产接口 | ❌ 未用、未调（纯本地读码） |

---

## 1. 代码路径追踪（登录 → 账户恢复 → 列表 → 详情）

### 1.1 登录 / 账户恢复
- `app.js:69 restoreAuth()` → `GET /api/auth/me` 校验 token → 拉 `loadStateFromCloud()`。
- `app.js:341 loadStateFromCloud()` → **`GET /api/account/state`** → 把 `res.state.accounts[].funds[]` 整体写入 `globalData.accounts`。
  - **这就是 sync 账户的「provider snapshot 落地点」**：小倍养基同步进来的每只基金（code/name/amount/holdingProfit/today/hold/transactions…）都作为 fund 对象存在 `accounts['小倍养基-默认账户'].funds[]` 里。
- `app.js:511 isSyncAccount(acc)`：`accountType==='sync' || __source` 判定 sync 账户（用于改名/解绑等逻辑，不影响取数路径）。

### 1.2 基金列表（portfolio 页）
- `portfolio.js:255 refreshData()`：直接读 `app.getActiveAccount().funds`（即上面的 snapshot）。
- `portfolio.js:544 filterAndSortFunds()` 把每只基金映射为展示行：
  - 基金名称 `f.name` ← snapshot ✅
  - 持有金额 `f.amount` ← snapshot ✅
  - 持有收益 `f.holdingProfit` ← snapshot ✅
  - 今日收益 `amt × f.today`（或 `f.todayEstimate`）← snapshot 的 `today`/`todayEstimate` ✅
  - 持有收益率 `f.holdingRate||f.hold` ← snapshot ✅
- `portfolio.js:621 _refreshNavDatesIfNeeded()`：对每只基金调 **`/api/fund/:code?fast=1`** —— **仅用于「数据标识徽章」（navDate）**，是装饰性字段，非核心数据。
  - 对 B 类（无 latest_nav）：返回空 → 徽章走灰色「估值/小倍/养基宝」兜底，**不影响列表核心字段**。
- `portfolio.js:433 refreshEstimatesBySource()`：仅当用户手动切到 **yjb/xbyj** 才调 `/api/fund/:code/estimate`；默认 `local` 源**完全不调 estimate**。

### 1.3 基金详情（fundDetail 抽屉 / 全页）
入口 `portfolio.js:785 openDetailDrawer` → `fundDetail` 组件（或 `pages/fund/fund.js` 深链，逻辑同一组件）。

`fundDetail.js:112 initDetail(code)` 并行两层取数：

| 层 | 方法 | 接口 | 用途 | 是否依赖 /api/fund/:code |
|---|---|---|---|---|
| ① 本地快照 | `loadFundLocalDetails` (L122) | 无（读 `globalData.accounts` snapshot） | 名称/金额/持有收益/今日%/交易记录/成本 | ❌ 否 |
| ② 服务端 | `fetchFundServerDetails` (L167) | **`/api/fund/:code?refresh=1&fast=1`** | history(曲线/业绩)、holdings(前十大)、data_status | ✅ 是 |
| ② 附属 | `_enrichHoldingsQuotes` (L226) | **`/api/stock/:code`** | 持仓股票今日涨幅 | ✅ 是（仅当 holdings 非空） |
| ② 附属 | `loadCalibration` (L249) | `/api/fund/:code/calibration` | 估值校准结果（只读，非 estimate/非 import） | 部分（不影响核心） |

- `fetchFundServerDetails` 成功分支（L173-195）：`res.history → serverHistory`、`res.holdings → majorHoldings`、`res.data_status.label → dataStatusLabel`。
  - **history 为空 → `chartStatus:'empty'`，绝不伪造**（L195, L204）。
- `_resolveCurrentNav(sHistory)` (L376)：**当日净值/净值日期/今日收益从 history 末条推导**；history 空则早退（字段保持空）。
- `calculatePerformanceMetrics(sHistory)` (L306)：history<2 则早退，perf 保持默认 `—`。

### 1.4 关键发现：mock 兜底存在但**未接入**
- `utils/mockHistory.js` 定义 `generateMockHistory(code)`：当 `/api/fund/:code` 不可用时**按 code 确定性生成假 NAV 曲线**，意图"使历史净值/业绩/趋势图始终有数据"。
- 但**全局 grep 确认：该函数无任何 `import` 调用**（仅文件定义 + 注释）。`fundDetail.js` 未引入它。
- 因此 B 类详情页**显示真实空态（"暂未同步到历史净值"），而非假曲线**——数据诚实，但详情不完整。

---

## 2. 一、逐项回答（sync 账户）

| 问题 | 答案 |
|---|---|
| sync 账户基金列表的数据来源 | **provider snapshot**（`/api/account/state` → `accounts[].funds[]`），不经 `/api/fund/:code` 取核心字段 |
| 基金名称/净值/收益的数据来源 | 名称/金额/持有收益/今日%/收益率 **全部来自 snapshot**；净值曲线/当日净值数字 **来自 `/api/fund/:code` history** |
| 是否调用 `/api/fund/:code` | 列表仅 `?fast=1`（徽章装饰）；详情 `?refresh=1&fast=1`（history/holdings）。**核心列表数据不依赖它** |
| 是否调用 `/api/fund/:code/estimate` | 默认 `local` 源**不调**；仅用户手动切 yjb/xbyj 才调（opt-in） |
| 是否直接使用 provider snapshot | **是**——列表与详情的持仓级 KPI 直接用 snapshot；history/holdings 才走服务端 |
| snapshot 是否含 latest_nav | ❌ 不含（snapshot 只有 code/name/amount/holdingProfit/today/hold/transactions/costNav 等持仓级字段） |
| snapshot 是否含 today | ✅ 含（`f.today`，小倍养基同步的当日%） |
| snapshot 是否含 total_profit | 含持有收益 `holdingProfit`（组合总收益由列表聚合） |
| snapshot 是否含 amount | ✅ 含 |
| snapshot 是否含 fund name/code | ✅ 含 |
| 详情页是否强依赖 /api/fund/:code | **部分强依赖**：history（曲线/业绩/当日净值）、holdings（前十大）强依赖；名称/金额/收益不依赖 |
| 详情页是否强依赖 history | ✅ 是（曲线、净值表、业绩、当日净值均来自 history） |
| 详情页是否强依赖 holdings | ✅ 是（前十大持仓 tab） |
| 详情页是否强依赖 /api/stock/:code | 仅当 holdings 非空才调；B 类无 holdings → 不调 |

---

## 3. 真实数据链（李总 sync 账户）

```
李总 sync账户（小倍养基-默认账户）
   │
   ├─ GET /api/account/state  ──►  accounts[].funds[]  = provider snapshot
   │         │
   │         ├─►【列表 portfolio】读 snapshot：
   │         │     名称 ✅快照  金额 ✅快照  持有收益 ✅快照
   │         │     今日收益 ✅快照(today)  持有收益率 ✅快照
   │         │     (徽章) /api/fund/:code?fast=1 → 装饰，B类走灰色兜底
   │         │
   │         └─►【详情 fundDetail】
   │                ├─ loadFundLocalDetails：名称✅ 金额✅ 今日收益✅ 持有收益✅ 交易✅  ← snapshot
   │                ├─ fetchFundServerDetails → /api/fund/:code?refresh=1&fast=1
   │                │      ├─ history → 曲线/净值表/业绩/当日净值  ← B类【空】
   │                │      └─ holdings → 前十大持仓              ← B类【空】
   │                ├─ _enrichHoldingsQuotes → /api/stock/:code  ← B类无holdings不触发
   │                └─ loadCalibration → /api/fund/:code/calibration（只读，不影响核心）
```

### 字段逐项标记（B 类 26 只）

| 页面字段 | 数据来源 | B 类状态 |
|---|---|---|
| 基金名称 | snapshot | ✅ 完整 |
| 持有金额 | snapshot | ✅ 完整 |
| 持有收益 | snapshot | ✅ 完整 |
| 今日收益/今日% | snapshot(today) | ✅ 完整 |
| 持有收益率 | snapshot(hold) | ✅ 完整 |
| 交易记录 | snapshot(transactions) | ✅ 完整（若有） |
| 当日净值 / 净值日期 | history(_resolveCurrentNav) | ❌ 缺失（header 行 `wx:if` 隐藏） |
| 历史净值曲线 | history | ❌ 缺失 → 空态"暂未同步到历史净值" |
| 历史净值表(navRows) | history | ❌ 缺失 → 空态 |
| 历史业绩(近1月~成立) | history | ❌ 缺失 → 全显示 `—` |
| 前十大持仓 | holdings | ❌ 缺失 → 空态"无主要成份公开披露" |
| 持仓股票今日涨幅 | /api/stock | ❌ 不触发（无 holdings） |
| 数据标识徽章 | /api/fund/:code?fast=1 | ⚠️ 有 fallback（灰色，不阻塞） |

---

## 4. 二、26 只 B 类分析（provider snapshot 能否覆盖）

| 维度 | provider snapshot 覆盖？ | 结论 |
|---|---|---|
| 列表（名称/金额/收益/今日%） | ✅ 全覆盖 | 列表**不降级**，B 类在列表正常显示 |
| 详情 KPI（金额/收益/今日%） | ✅ 覆盖 | 详情头部核心数字正常 |
| 详情 NAV 曲线 / 当日净值 | ❌ 不覆盖（需 history） | **仍缺失** |
| 详情 前十大持仓 | ❌ 不覆盖（需 holdings） | **仍缺失** |
| 详情 持仓股票涨幅 | ❌ 不覆盖（需 /api/stock，且依赖 holdings） | **仍缺失** |

**判定：**
- 若仅看「列表可用」→ B 类对 sync 账户**降级为「后端基金资料缺失，但小程序核心列表可用」** ✅
- 若看「详情完整」→ provider snapshot **不能覆盖** NAV 曲线/前十大/股票涨幅 → 详情页**仍受影响**。

→ 综合：**列表解锁，详情未解锁**。B 类从「硬阻塞」降级为「列表可用 + 详情部分降级」。

---

## 5. 三、详情页专项检查（26 只 B 类逐项目）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 净值是否显示 | ❌ 不显示 | `currentNavDate` 空 → header 净值行 `wx:if` 隐藏（fundDetail.wxml:19） |
| 历史曲线是否显示 | ❌ 不显示（空态） | `chartStatus:'empty'` → "📈 暂未同步到历史净值"（L79-82） |
| 前十大持仓是否显示 | ❌ 不显示（空态） | `majorHoldings` 空 → "该基金无主要成份公开披露"（L183-186） |
| 持仓股票涨跌是否显示 | ❌ 不显示（不触发） | 无 holdings → 不调 `/api/stock`，且列表为空 |
| 当日收益是否显示 | ✅ 显示 | 来自 snapshot `f.today`（L143） |
| 持有收益/金额/收益率 | ✅ 显示 | 来自 snapshot（L138-144） |
| 历史业绩 | ⚠️ 显示 `—` | history<2 早退，perf 默认 `—`（非崩溃） |
| 是否崩溃/假数据 | ✅ 不崩溃、不造假 | 全程空态降级；mockHistory 未接入 |

**结论：详情页不崩溃、不显示假数据，但 26 只 B 类点进去后「净值曲线 / 前十大持仓 / 持仓股票涨跌 / 当日净值数字」四项为空。**

---

## 6. 四、最终判定

### **C = 列表可用但详情页受影响，需要修复详情数据链**

理由：
1. **列表完全绕过 B 类缺口**：sync 账户列表（名称/金额/收益/今日%）100% 来自 provider snapshot，不经 `/api/fund/:code` 取核心字段。26 只 B 类在列表正常显示 → **小程序核心持仓列表对李总可用**。
2. **详情页仍命中缺口**：详情的 NAV 曲线、当日净值、前十大持仓、持仓股票涨幅强依赖 `/api/fund/:code`(history/holdings) + `/api/stock/:code`，对 B 类为空 → **详情 drill-down 不完整**。
3. **不阻塞但需修复**：李总能用小程序看整体持仓与核心数字；但点进 26 只 B 类基金看不到净值走势与持仓结构。属体验降级，非硬崩溃。

### 修复详情数据链的可行路径（待 Phase 3.7，本阶段不执行）
- **路径 1（推荐，真实数据）**：修复出网/换源后对这些基金执行 `importFund`，补齐 history + holdings。
- **路径 2（真实数据）**：扩展小倍养基 sync 导入，把 NAV 历史 + 前十大也写入 snapshot（需后端配合）。
- **路径 3（不推荐）**：接入 `utils/mockHistory.js` 作兜底 → 会显示**按 code 生成的假曲线**，对真实持仓是**数据造假风险**，不建议用于生产持仓。

---

## 7. 总进度

**总进度：88%（架构/契约/mp1 开发就绪）｜目标：小程序可用｜⚠️ 数据上线门槛：列表可达标、详情需修复（sync 账户 B 类 26 只详情 NAV 曲线/前十大为空；非硬阻塞，属 C 类「列表可用详情受影响」）**

---

_生成：Phase 3.6-C（只读代码验收）· 追踪 mp1 登录→账户恢复→列表→详情全链路 · 未调 /estimate、未触 importFund、未改代码/库/部署、未用 token · 已确认 mockHistory 未接入_
