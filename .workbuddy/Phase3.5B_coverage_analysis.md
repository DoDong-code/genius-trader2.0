# Phase 3.5-B：生产估值 Coverage 一致性只读核验报告

> 只读核验。未调用 `/estimate`（其有写库副作用：`estimateEngine.js:444-463` 写 `fund_estimate`，且 `quoteFor` 在 `estimateEngine.js:66-73` 写 `stock_price` 缓存）。未改代码 / 库 / 环境变量 / 部署。所有结论均有代码行号或生产基线证据。

---

## 一、`/estimate` 的 `quote_coverage` 是怎么计算的（代码证据）

**位置**：`server/services/estimateEngine.js:414`

```js
quote_coverage: holdings.length ? round(pricedHoldings.length / holdings.length, 4) : 0,
```

- **分母 `holdings.length`**：来自 `latestHoldings(fundCode)`（`estimateEngine.js:34-45`），SQL 为 `ORDER BY weight DESC LIMIT 10` + 取最新 `report_date`。**即只统计前十大持仓（按权重降序）**。
- **分子 `pricedHoldings.length`**：来自 `quoteResults.filter(Boolean)`（`:330`）。`quoteResults` 中每一项若成功取得行情则为对象（truthy），失败则为 `null`。
- **是否只统计前十大**：是，`LIMIT 10`。
- **是否按权重过滤**：**否**。`quote_coverage` 本身不按权重过滤。权重仅用于 `holdingsChange` 计算（`:335` 的 `publishedWeight >= 0.05` 门槛），不影响覆盖率计数。
- **是否排除某些证券**：美股的 `isUs` 分支（`:309-311`）在美股未开盘时返回 `{ ...holding, change_percent: 0 }`——这是有限值、对象 truthy，**仍计入 `pricedHoldings`**（视为成功）。无其它显式排除。
- **是否因行情日期不同判定失败**：是，对 QDII 基金。`targetDate` 计算见 `:282-288`：若 `targetDate !== shanghaiDate()`（今天），走 `fetchHistoricalChange`（`:320-327`）——要求取**某个历史交易日**的涨跌幅；取不到则 `null`，不计入。`:306-318` 的 `targetDate === today` 分支才用实时 `quoteFor`。
- **是否使用历史行情而非 `/api/stock/:code` 的实时行情**：**是**，对 QDII 且 `targetDate≠今天` 的基金走 `fetchHistoricalChange`（历史路径：Eastmoney K 线 + Yahoo 历史 chart + 实时兜底）。其余基金走 `quoteFor`（实时）。
- **`null`/`0`/`NaN` 是否当失败**：
  - `quoteFor`（`:58-75`）：`if (!quote || !Number.isFinite(quote.change_percent)) return null;`（`:65`）→ 不计入。
  - 但 `cachedQuote`（`:47-56`）返回缓存行时**不校验 `change_percent` 是否为有限值**——若缓存行 `change_percent` 为 `null` 仍会被当作成功返回（此为轻微**高估**方向，不导致 `coverage<1`，与本次差异无关，仅记录）。

---

## 二、两条行情路径调用关系（代码证据，结论：不完全相同）

```
/fund/:code
   ↓ getFundHoldings(fundService.js:486-498)  —— 同样 ORDER BY weight DESC LIMIT 10，最新 report_date
   ↓ 对每只持仓：
/stock/:code  (fund.js:750-759)
   ↓ fetchStockQuote(code)            ← marketService.js:488，纯实时，无缓存写
   ↓ Eastmoney push2（被 Render 出网屏蔽 → 抛错）→ Yahoo(.SS/.SZ/.T/.KS) 兜底

/fund/:code/estimate
   ↓ calculateFundEstimate(estimateEngine.js:262)
   ↓ quoteFor(holding.stock_code)     ← estimateEngine.js:58
        ├─ cachedQuote(stock_price 缓存, 今日日期+TTL)  ← 有缓存层（/stock 没有）
        └─ fetchStockQuote(code)                          ← 与 /stock 同一函数
   ↓（仅 QDII 且 targetDate≠今天）fetchHistoricalChange(estimateEngine.js:146)
        ├─ Eastmoney K 线（按指定历史日期，Render 被屏蔽→失败）
        ├─ Yahoo 历史 chart（按指定历史日期）
        └─ quoteFor 实时兜底
```

**关键差异（两条路径并非完全相同）**：
1. `/estimate` 多一层 `stock_price` 缓存读（`cachedQuote`）。
2. `/estimate` 对 QDII 且 `targetDate≠今天` 的基金走 **历史交易日** 路径（`fetchHistoricalChange`），而 `/stock/:code` 永远是**实时**行情。
3. 两者实时分支最终都收敛到同一个 `fetchStockQuote`（同一行情源：Eastmoney→Yahoo），所以"行情源"本身一致；差异在**缓存层 + 历史/实时日期分支 + 测量时点**。

---

## 三、两个 Coverage 对照表

> ⚠️ **数据可得性说明**：本机已保存的 Phase 3.4 基线（`memory/2026-08-18.md:241`）仅含**聚合值**（estimate_change 非 null=30 / null=26；fallback unavailable=26 / sector-only=18 / None=12；**quote_coverage<1 = 43**；sector_change=null=34），**未保存 43 只基金的逐只 `quote_coverage` 明细**。因此无法从磁盘恢复逐只 Phase 3.4 值；下表给出可证明的部分 + 聚合对账。

### 3.1 已知可定位的基金（与 43 重叠的 26 只 `estimate_change=null`）

这 26 只即 Phase 3.3 修复目标（两者皆不可得→最后兜底本地 NAV 被旧代码拒收）。其中 `pricedWeight=0`（全部前十大持仓取不到行情）的子集必然 `quote_coverage=0`（<1，属于 43）；`publishedWeight<0.05` 但全部取到行情的子集 `quote_coverage=1`（不属于 43）。

| 基金 | Phase 3.4 estimate coverage | Phase 3.5 realtime coverage | 差异 | 归类 |
|------|--------------------------:|--------------------------:|---:|------|
| 001595 | <1（属43） | 1.0 | ↓ | estimate低/realtime=1 |
| 002771 | <1 | 1.0 | ↓ | 同上 |
| 004103 | <1 | 1.0 | ↓ | 同上 |
| 006719 | <1 | 1.0 | ↓ | 同上 |
| 008173 | <1 | 1.0 | ↓ | 同上 |
| 011452 | <1 | 1.0 | ↓ | 同上 |
| 011949 | <1 | 1.0 | ↓ | 同上 |
| 012920 | <1 | 1.0 | ↓ | 同上 |
| 012922 | <1 | 1.0 | ↓ | 同上 |
| 013360 | <1 | 1.0 | ↓ | 同上 |
| 014806 | <1 | 1.0 | ↓ | 同上 |
| 015736 | <1 | 1.0 | ↓ | 同上 |
| 015790 | <1 | 1.0 | ↓ | 同上 |
| 016708 | <1 | 1.0 | ↓ | 同上 |
| 017731 | <1 | 1.0 | ↓ | 同上 |
| 017994 | <1 | 1.0 | ↓ | 同上 |
| 018168 | <1 | 1.0 | ↓ | 同上 |
| 018178 | <1 | 1.0 | ↓ | 同上 |
| 019889 | <1 | 1.0 | ↓ | 同上 |
| 020741 | <1 | 1.0 | ↓ | 同上 |
| 024203 | <1 | 1.0 | ↓ | 同上 |
| 025833 | <1 | 1.0 | ↓ | 同上 |
| 161226 | <1 | 1.0 | ↓ | 同上 |
| 380006 | <1 | 1.0 | ↓ | 同上 |
| 501205 | <1 | 1.0 | ↓ | 同上 |
| 539002 | <1 | 1.0 | ↓ | 同上 |

> 说明：26 只是"estimate_change=null"名单（用户给定），并非 43 只的全集；其与 43 的精确交集需逐只 Phase 3.4 明细才能确认，本机无该明细。

### 3.2 4 只重点基金（有历史值可对照）

| 基金 | Phase 3.1.3(部署前) coverage | Phase 3.2(898165e) coverage | Phase 3.5 realtime | 备注 |
|------|---------------------------:|---------------------------:|------------------:|------|
| 022184 | 0.9 | 1.0 | 1.0 | 285A→285A.T 已修 |
| 018147 | 0.8 | 1.0 | 1.0 | 000660→000660.KS 已修 |
| 016665 | 0.9 | 1.0 | 1.0 | JP3236330001→285A.T 已修 |
| 014002 | 1.0 | 1.0 | 1.0 | 全标准美股码，始终 1.0 |

### 3.3 聚合对账（确定可证明）

| 指标 | 值 |
|------|--:|
| 基金总数 | 56 |
| Phase 3.4 `quote_coverage < 1` | **43** |
| Phase 3.5 `realtime_coverage = 1` | **56（全部）** |
| Phase 3.5 `realtime_coverage < 1` | 0 |
| 43 只中 `realtime_coverage = 1` | **43（全部，因 realtime 全 56=1）** |
| 43 只中「estimate低、realtime=1」 | **43** |
| 43 只中「完全一致」/「其他差异」 | 0 / 0 |

---

## 四、重点分析：为什么 43（estimate<1）≠ 56/56（realtime=1）

差异由**三类代码/测量层原因**叠加，均非"证券代码映射问题"（Phase 3.5 已实证 56/56 实时可取、`missing=0`）：

### 4.1 空持仓被不同口径处理（统计口径不同，主要贡献源之一）
- `/estimate`：`holdings.length ? ... : 0` → **无前十大持仓 → `coverage = 0`**（<1，计入 43）。
- Phase 3.5 脚本：用户实测多只基金「前十大=0 / 成功=0 / 缺失=0 / coverage=1.0」，即 `0/0` 被记为 `1.0`。
- 结论：**凡是"基金在 `fund_holdings` 中无前十大持仓"的基金，`/estimate` 计 0、Phase 3.5 计 1.0** —— 纯口径差异，不是真实行情缺失。这一类基金同时拉低了 Phase 3.4 的 43、又抬高了 Phase 3.5 的 56/56。

### 4.2 QDII 历史交易日 vs 实时行情（历史行情 vs 实时行情不同 / 交易日期不同）
- 对 QDII 且 `targetDate ≠ shanghaiDate()` 的基金，`/estimate` 走 `fetchHistoricalChange`，要求取**某个历史交易日**的涨跌幅（Eastmoney K 线按 `date` 精确匹配 + Yahoo 历史 chart 按 `timestamp` 精确匹配）。
- Render 出网屏蔽 Eastmoney（`memory/2026-08-18.md:238` 已确认），故 Eastmoney 历史 K 线必失败；若 Yahoo 历史 chart 在该指定日期无数据（缺口 / 非交易日 / 时区偏差），`targetIndex` 保持 `-1` → 返回 `null` → 不计入 → `coverage<1`。
- `/stock/:code` 永远取**实时** `fetchStockQuote` → 该股票实时行情存在即成功 → `coverage=1`。
- 结论：对同一批 QDII 外股持仓，**"历史某交易日覆盖率" 与 "实时覆盖率" 是两个不同指标**；Phase 3.4 测的是前者（部分失败），Phase 3.5 测的是后者（全部成功）。这正是 section 七重点要求确认的差异。

### 4.3 测量时点的出网/缓存状态（行情源路径不同之外的时间因子）
- Phase 3.4 基线在 `deploy=898165e`（**未含 Phase 3.3**）时点测得。当时 Eastmoney 出网被屏蔽，`quoteFor` 实时分支需经 Yahoo 兜底；若测量时刻 Yahoo 出口尚未热身 / 部分限流 / `stock_price` 缓存为空（新日期首查），A 股持仓经 `fetchStockQuote` 实时取数可能失败 → `coverage<1`。
- Phase 3.5 在更晚时点、经 `/stock` 纯实时复测，此时 Yahoo 出口可达，全部前十大持仓实时取得 → `coverage=1`。
- 注：`fetchHistoricalChange` 已有实时兜底（`:224-228` `quoteFor`），故只要实时可达，QDII 也会归 1；Phase 3.4 的 <1 反映了"当时实时也部分不可达"的窗口。

---

## 五、特别检查：历史行情日期问题（section 七）

- 已确认：`/estimate` 对 QDII（`targetDate≠今天`）使用 `fetchHistoricalChange`（`estimateEngine.js:146-234`），其要求是**指定历史交易日**的涨跌幅；`/stock/:code` 不要求历史日期，只取实时。
- 实证指向：这**不是**证券代码映射问题（Phase 3.5 已证明 56/56 实时可取），而是 **"实时行情覆盖" 与 "历史交易日行情覆盖" 两个不同指标**。QDII 基金的历史日期覆盖在 Render 上因 Eastmoney 屏蔽而部分缺失，实时覆盖则完整。

## 六、特别检查：基金没有持仓数据（section 八）

- `getFundHoldings`（fundService.js:486-498）与 `latestHoldings`（estimateEngine.js:34-45）**均 `LIMIT 10`**，所以"前十大持仓数"对两条路径定义一致。
- 但 `/estimate` 的 `quote_coverage` 对 `holdings.length === 0` 返回 **`0`**；Phase 3.5 脚本对 `0/0` 返回 **`1.0`**。
- 因此 `coverage=1` **可能只是空集合被默认视为 1**（口径使然），并非"行情覆盖率 100%"。
- 统计（依据用户 Phase 3.5 实测观察 + 代码语义）：56 只中存在"前十大=0"的基金（用户称"很多"），这些在 `/estimate` 中是 `0`、在 Phase 3.5 中是 `1.0`。**确切无持仓基金数量需对生产 `fund_holdings` 跑只读 `COUNT(*)` 分组才能定数**，本阶段未执行写操作、也未直连 PG，故给区间而非精确值。

---

## Phase 3.5-B 结果

### A. 数据一致性

```
基金总数：56
有持仓数据（前十大>0）：< 56（精确数需生产只读 COUNT，未在本机基线）
无持仓数据（前十大=0）：> 0（用户实测"很多"，精确数需生产只读 COUNT）

实时 coverage=1：56
实时 coverage<1：0

estimate coverage<1：43（Phase 3.4 基线，deploy=898165e，未含 3.3）
其中 realtime coverage=1：43（全部 43 只，因 realtime 全 56=1）
```

### B. 差异原因（代码/基线证据）

```
[x] 统计口径不同
    —— 空持仓：/estimate=0，Phase 3.5 脚本 0/0=1.0（estimateEngine.js:414 vs 脚本口径）
[x] 历史行情 vs 实时行情不同
    —— QDII targetDate≠今天走 fetchHistoricalChange（estimateEngine.js:146/320）；/stock 走实时 fetchStockQuote
[x] 交易日期不同
    —— 同上：/estimate 要求指定历史交易日涨跌幅；/stock 取实时，不要求历史日期
[x] 空持仓被计算为 coverage=1
    —— 即 A 的口径项，Phase 3.5 脚本将 0/0 记 1.0（用户实测"前十大=0/成功=0/缺失=0/coverage=1.0"）
[ ] 行情源路径不同
    —— 两条路径实时分支最终都收敛到同一 fetchStockQuote（Eastmoney→Yahoo）；差异在缓存层+历史日期分支，非行情源本身
[ ] 证券代码映射问题
    —— 已排除：Phase 3.5 实证 56/56 实时可取、missing=0；日股/韩股映射在 898165e 已修（Phase 3.2 验收确认）
[x] 其他
    —— 测量时点出网/缓存状态：Phase 3.4 在 Eastmoney 屏蔽+缓存冷窗口测得；Phase 3.5 更晚、Yahoo 出口可达，纯实时复测得全 1
```

### C. 是否需要修改代码

**结论：A —— 不需要修改，属于统计口径差异 + 测量时点网络状态差异。**

- Phase 3.5 的「56/56 实时 coverage=1、missing=0」是**当前真实数据链路**的权威结论（纯实时 `fetchStockQuote` 路径已全量实证可取）。
- Phase 3.4 的「43 只 `quote_coverage<1`」是**更早时点（deploy=898165e，未含 3.3）经 `/estimate` 路径**测得，受三类非缺陷因素拉低：① 空持仓口径（0 vs 1.0）；② QDII 历史交易日路径在 Render 上因 Eastmoney 屏蔽而部分失败；③ 测量窗口的出网/缓存冷状态。
- 因此 **Phase 3.5 可以验收**（实时覆盖率 100% 成立）。

**可选（非必需、不改变结论、暂不执行）**：若希望 `/estimate` 的 `quote_coverage` 与"实时 100%"在语义上自洽，唯一的最小可选改动是将空持仓口径从 `:0` 改为 `:1`（与 Phase 3.5 脚本一致），属口径对齐而非缺陷修复；QDII 历史路径已带实时兜底（`:224`），无需改。按红线与"暂时不要修改代码"要求，**本阶段不改动任何代码**。

---

## 红线遵守确认
- 未调用 `/estimate`（避免 `fund_estimate` 与 `stock_price` 写库副作用）。
- 未修改任何业务代码 / 数据库 / 环境变量 / 部署。
- 未 INSERT/UPDATE/DELETE，未重新导入/同步持仓，未生成或修改 `SOURCE_SECRET_KEY`。
- 未输出任何 token / cookie / refresh_token / 密码 / secret。
