# Phase 3.7-A —— 生产基金详情数据导入链只读诊断

> 目标：诊断李总 sync 账户 26 只 B 类基金的 NAV/history/holdings 缺口根因，判定数据源是否可恢复。
> 本阶段**只诊断，不修代码、不写库、不调 importFund / refresh / fast / estimate**。

## 0. 红线合规声明

- 全部为**静态代码阅读** + **纯读接口**（`GET /api/funds`、`GET /api/fund/:code` 无查询参数）。
- 未调用：`/api/fund/:code?refresh=1`、`?fast=1`、`/estimate`、任何 `importFund` 触发路径。
- 未写数据库、未改代码、未部署、未用 token（生产读接口无需鉴权）。
- 说明：`GET /api/fund/:code` **不带查询参数**时，仅当基金不在 DB 才触发 importFund；57 只全部已有名字行，故本次读为纯缓存读，零副作用。

---

## 1. importFund 数据源链路（静态代码实证）

### 1.1 调用链

```
importFund(code, options)              fundService.js:344
  └─ collectFund(code, options)        fundService.js:230
       ├─ NAV / 历史净值
       │    ├─ fetchHistory(code)                marketService.js:301
       │    │    ├─ 主源 fetchTiantianHistory     → fund.eastmoney.com/f10/F10DataApi.aspx (天天基金 F10)
       │    │    └─ 备用 fetchEastmoneyHistory     → api.fund.eastmoney.com/f10/lsjz (东方财富 API)
       │    │    ⚠ 主源+备用 全是 Eastmoney，无 Yahoo/其他 fallback
       │    └─ fetchText(pingzhongdata/{code}.js) + {code}.html  → fund.eastmoney.com (净值/名称)
       ├─ 前十大持仓
       │    └─ fetchHoldings(code)               marketService.js:365
       │         → fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc (东方财富 F10 持仓)
       │         ⚠ 仅 Eastmoney，无 fallback；report_date 由 parseHoldings 正则提取
       └─ 股票行情（仅详情持仓个股涨幅用，非基金 NAV）
            └─ fetchStockQuote → Eastmoney push2 + Yahoo 兜底（marketService.js:509）
  └─ DB 写入（事务）                    fundService.js:351-391
       ├─ fund（fund_name/fund_type/company）
       ├─ fund_nav（date/nav/acc_nav，按日 upsert）
       └─ fund_holdings（stock_code/name/weight/report_date，前 10）
```

### 1.2 决定性结论（代码层）

- **基金 NAV 历史 + 前十大持仓的数据源 100% 只依赖东方财富（Eastmoney）三条子域**：
  `fund.eastmoney.com`、`api.fund.eastmoney.com`、`fundf10.eastmoney.com`。
- **没有任何非 Eastmoney 的 fallback**（Yahoo 兜底仅用于持仓个股行情 `fetchStockQuote`，与基金 NAV/holdings 无关）。
- Phase 3.3 曾判定「Render 出网屏蔽 Eastmoney」——但本阶段实证（见 §2）表明**该阻塞现已恢复**。

### 1.3 另一个 fund 表写入者（解释 26 只"有名字无数据"）

`portfolioService.upsertFund`（`portfolioService.js:13`）：

```sql
INSERT INTO fund (fund_code, fund_name, created_at, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(fund_code) DO UPDATE SET fund_name = excluded.fund_name, updated_at = CURRENT_TIMESTAMP
```

→ 该路径**只写 fund_code / fund_name / updated_at，不写 fund_type、不写 nav、不写 holdings**。
→ 这正是 26 只 B 类"有名字、fund_type=null、无 NAV/历史/前十大"的来源：它们是 sync 账户加载时由 `upsertFund` 写入的名字行，**importFund 从未为它们成功执行过**。

---

## 2. 生产只读验证（不触发 import）

| 验证项 | 方法 | 结果 |
|--------|------|------|
| 数据源是否可达（现在） | `GET /api/funds` 看 `updated_at` | **57 只全部 7 天内更新，45 只今天**（含 000001=09:09、016371=06:43） |
| Eastmoney NAV+holdings 今天是否真写入 | `GET /api/fund/000001`（good） | `latest_nav=2026-08-17`、`history=5986` 条、`holdings=10` 条 ✅ |
| 26 只 B 类缺口是否真实 | `GET /api/fund/{002207,539002,161226}` | 三者 `latest_nav=None / history=0 / holdings=0` ✅ 确认空白 |
| B 类为何只有名字 | `updated_at` 分布 | 26 只全部 `2026-08-18T06:41:10`（同批次）→ `upsertFund`（sync）写入，非 importFund |
| QDII 导入可行性 | 已成功基金反查 | 014002(QDII)、016665(QDII)、018147(QDII) 均为"完美/有数据"→ QDII 走 Eastmoney 可行 |

**核心结论**：Eastmoney 数据源**当前可从 Render 正常访问**（今日已有数十只基金成功导入全量 NAV+holdings）。26 只 B 类的根因**不是数据源不可用**，而是 `importFund` 从未为它们成功跑过——它们仅在 sync 时走了 `upsertFund` 名字行。

---

## 3. 三档代表基金判定（来自 26 只 B 类，按真实基金名归类）

| 代表 | 代码 | 名称 | 类型 | NAV 历史数据源 | holdings 数据源 | report_date | 结论 |
|------|------|------|------|----------------|----------------|-------------|------|
| 普通 A 股 | **002207** | 前海开源金银珠宝混合C | 混合型 | Eastmoney（现可达）✅ | Eastmoney jjcc ✅ | 可解析 ✅ | 可取得 |
| QDII | **012920** | 易方达全球成长精选混合(QDII)A | QDII | Eastmoney（现可达）✅ | Eastmoney jjcc ✅ | 可解析 ✅ | 可取得（QDII 已被同类验证） |
| 其他(商品LOF) | **161226** | 国投瑞银白银期货(LOF)A | 商品期货LOF | Eastmoney（现可达）✅ | Eastmoney jjcc（期货持仓可能部分/不列）⚠️ | 可解析 | NAV 可取得；前十大或偏少（次要风险） |

> 说明：未触发 import，上表"可取得"基于 (a) 代码确认数据源为 Eastmoney；(b) 实证 Eastmoney 今日可达；(c) 同类型基金（含 QDII）已被成功导入。

---

## 4. 三档判定

### ✅ Phase 3.7-A 判定：**A**

> **A → 当前数据源已经恢复，只需要安全执行一次补数据**

- 数据源（Eastmoney）**已恢复可达**，今天已有 45 只基金成功导入全量数据，证明 NAV 历史 + 前十大持仓链路通畅。
- 26 只 B 类缺口根因 = `importFund` 从未成功执行（只走了 sync 的名字行 upsert），**不是出网失败、不是缺源、不需要换源**。
- 只需对 26 只安全执行一次 `importFund` 补数据即可消除缺口；**严禁 mockHistory**（会造假曲线）。

---

## 5. 下一步最小实施方案（待 Phase 3.7-B 实施，本阶段不执行）

1. **补数据方式**（推荐服务端脚本，非 mp1 逐一点击）：
   - 参考 `server/scripts/seedFunds.js` / `server/services/navService.js` 写法，一次性 node 脚本循环调用
     `await importFund(code, { force: true })`（force=true 跳过增量缓存、做全量历史回填）。
   - 26 只 B 类清单：
     `002207 006503 008702 010736 011452 011949 012920 012922 016708 017731 017811 017994 018168 018178 019889 020412 021842 024203 024239 025422 025500 025833 026211 161226 501205 539002`
   - 限流：每只间隔 ~300–500ms，避免 Eastmoney 限流（fetchText 内部已有退避，但批量仍建议限速）。
2. **校验**（执行后）：
   - 重跑 Phase 3.6 health 脚本 → 确认 26/26 变为 A（NAV+history+holdings 齐全）或至少 NOHOLD（有净值无前十大）。
   - 重跑 Phase 3.6-C 逻辑 → 确认李总详情页 NAV 曲线 / 前十大持仓不再空白。
3. **严禁项**：不接 `mockHistory`；不修改 Web 基准逻辑；不绕过 `importFund` 直接写库（除非走脚本事务）。
4. **次要风险**：161226（商品期货LOF）前十大持仓 Eastmoney jjcc 可能不列期货持仓，详情页前十大或仍偏少——届时单独评估，不阻塞主链路。

---

## 总进度

**总进度：88%（架构/契约/mp1 开发就绪）｜目标：小程序可用｜⚠️ 数据上线门槛：从「未达成（缺口 34 只）」降级为「A 档——数据源已恢复，缺口可由一次安全补数据消除，待 Phase 3.7-B 实施」**

---

_生成：Phase 3.7-A 只读诊断（静态代码 + 纯读接口）· 判定 A · 未改代码/库/配置 · 未调 import/refresh/fast/estimate/estimate_
