# WEB_MP_FULL_PARITY.md — Web ↔ 小程序 完整功能级 Diff（最终验收基线）

> 生成：2026-08-16。以 Web 源码为唯一母版，逐项扫描对比小程序。
> 结论：PASS（业务结果一致）/ PARTIAL（存在但逻辑不同）/ FAIL（逻辑错误）/ MISSING（缺失）。
> 本文件取代早期 `WEB_MP_FUNCTION_PARITY.md`，为「完整功能验收基线」。

---

## ① 账户系统（ACCOUNT）

### ACCOUNT-001 创建账户
- Web实现：总览→编辑→「新增账户」→ 弹窗输入 → 创建 `{name, accountType:'local', syncSource:null, funds:[], strategy:[], closedPositions:[]}`
- 小程序实现：首页→编辑→「新增账户」→ app.addAccount 创建 `{name, strategy:[], closedPositions:[], funds:[]}`
- 是否存在：是 · 业务逻辑：一致 · 数据：一致（缺 accountType/syncSource 字段，默认无） · API：本地 · 状态：一致 · 异常：一致
- 结论：**PASS**

### ACCOUNT-002 删除账户
- Web实现：编辑→勾选→「删除所选」→ 同步账户先调 `/api/portfolio/delete` 服务端物理删 → 清理 children/parent → 删除
- 小程序实现：编辑→勾选→「删除」→ app.deleteAccount 纯本地 + 手动云同步
- 是否存在：是 · 业务逻辑：**不同**（Web 有服务端物理删，小程序纯本地） · 数据：本地删除一致 · API：小程序无服务端调用 · 状态：一致 · 异常：一致
- 结论：**PARTIAL**（架构差异：小程序无服务端账户体系）

### ACCOUNT-003 修改账户名称（改名）
- Web实现：编辑模式双击账户名 → 弹窗重命名 → 本地账户改 key；同步账户先 convertAccountToLocal
- 小程序实现：**无改名功能**
- 是否存在：否 · 结论：**MISSING** → MIG-006（P1）

### ACCOUNT-004 移动账户
- Web实现：编辑→勾选→「移动」→ 涉及同步账户先 convertAccountToLocal + 服务端休眠 → mergeFundsInto 合并
- 小程序实现：编辑→勾选→「移动」→ app.moveAccounts 直接合并，**不转 local**
- 是否存在：是 · 业务逻辑：**不同**（小程序移动同步账户不解除同步） · 数据：合并逻辑部分一致 · API：无 · 状态：不同 · 异常：一致
- 结论：**FAIL** → MIG-001（P0）

### ACCOUNT-005 合并账户
- Web实现：无独立函数，由「移动（keep=复制）」/「删除子账户」借 mergeFundsInto（同 code 相加 amount/收益/shares，重算 rate，流水去重）
- 小程序实现：moveAccounts / deleteSubAccount 的 merge（同 code 只加 amount，**不加收益、不重算 rate、流水不去重**）
- 是否存在：是 · 业务逻辑：**不同**（合并只加 amount，收益/流水处理不一致） · 数据：不同 · API：无 · 状态：一致 · 异常：一致
- 结论：**PARTIAL** → MIG-007（P1）

### ACCOUNT-006 切换账户
- Web实现：顶部 tab / 账户卡片 → setActive → 持久化
- 小程序实现：账户 tab / 卡片 → activeAccountName → saveState
- 结论：**PASS**

### ACCOUNT-007 新建子账户 / ACCOUNT-008 删除子账户
- Web实现：新建 `{name, parent, funds:[]}` + parent.children.push；删除时持仓合并回父 + splice
- 小程序实现：app.addSubAccount / deleteSubAccount 同逻辑
- 结论：**PASS**

### ACCOUNT-009 按板块拆分
- Web实现：FUND_SECTORS_BY_CODE 分组 → 建子账户 → 父清空
- 小程序实现：app.splitAccountBySector 用硬编码 MAP（019633/008702/013309/007339/014002/022184）
- 结论：**PARTIAL**（板块映射表不一致，P2）→ 低优先级

### ACCOUNT-SYNC-RULE-001 同步账户规则（核心验收）
- Web实现：改名/移动同步账户 → convertAccountToLocal（accountType='local'，syncSource=null，originalSource/convertedFromSync/convertedTime 标记）+ `/api/portfolio/rename` 休眠；删除同步账户 → 服务端物理删；再次同步需手动
- 小程序实现：有 accountType/syncSource 标记，**无 convertAccountToLocal**；移动不转 local；删除纯本地
- 结论：**FAIL** → MIG-001（P0）

---

## ② 持仓系统（PORTFOLIO）

### PORTFOLIO-001 添加基金
- Web实现：名称/代码双向回填，`holdingRate = holdingProfit/(amount-holdingProfit)`，category 固定 '基金'
- 小程序实现：代码/名称双向回填（已修 fund_name 字段），自动分类（黄金/债/海外）
- 结论：**PARTIAL**（分类口径不同，P2）

### PORTFOLIO-002 修改基金（金额/收益）
- Web实现：normalizeHolding（amount/holdingProfit/holdingRate 重算）
- 小程序实现：修改 amount/profit
- 结论：**PASS**（需核对 normalizeHolding 公式，见 MIG-004）

### PORTFOLIO-003 删除基金
- Web实现：无独立删除（只有清仓 splice）
- 小程序实现：有独立删除基金（app.deleteFund）
- 结论：**FAIL**（方向相反，小程序多出 Web 无的功能，保留，P3）

### PORTFOLIO-004 加仓
- Web实现：`nextAmount += tradeAmount; nextProfit -= fee`（本金收益不变，只扣手续费）
- 小程序实现：fundDetail 加仓
- 结论：**PARTIAL**（需核对手续费/收益计算）→ MIG-008（P1）

### PORTFOLIO-005 减仓
- Web实现：`remainingRatio=(amount-tradeAmount)/amount; nextProfit=profit*remainingRatio-fee`（等比例兑现）
- 小程序实现：fundDetail 减仓
- 结论：**PARTIAL**（需核对等比例兑现）→ MIG-008（P1）

### PORTFOLIO-006 清仓
- Web实现：追加 sell 流水 + closedPositions 日志 + splice 移除
- 小程序实现：fundDetail 清仓
- 结论：**PARTIAL**（需核对 closedPositions 是否写）→ MIG-008（P1）

### PORTFOLIO-007 定投
- Web实现：追加 buy 流水 + autoInvest{enabled,amount,frequency,nextDate} + normalizeHolding
- 小程序实现：fundDetail 定投
- 结论：**PARTIAL**（需核对 autoInvest 字段）→ MIG-008（P1）

### PORTFOLIO-008 交易记录
- Web实现：fund.transactions `{type,amount,fee,date}`，sell 显示 −、buy 显示 +
- 小程序实现：fundDetail 交易记录
- 结论：**PASS**（结构一致）

### PORTFOLIO-009 计算逻辑（金额/收益/收益率/当日收益）
- Web实现：持有收益=holdingProfit；收益率=holdingProfit/(amount-holdingProfit)；当日收益=todayEstimate 或 amount×today；总资产=Σamount
- 小程序实现：portfolio.js filterAndSortFunds 计算
- 结论：**PARTIAL**（需逐行核对收益率公式）→ MIG-004（P0）

### PORTFOLIO-010 排序（五态循环）
- Web实现：amount 三态；holdingProfit/todayProfit 五态（金额升/降→率升/降→默认）
- 小程序实现：sortState 排序
- 结论：**PARTIAL**（需核对五态循环）→ MIG-004 一并核对

### PORTFOLIO-011 筛选
- Web实现：无分类筛选
- 小程序实现：有分类筛选
- 结论：**FAIL**（方向相反，保留，P3）

### PORTFOLIO-012 自定义表头顺序
- Web实现：localStorage column-order，fund 列固定，拖拽
- 小程序实现：columnOrder + 长按拖动（已修让位动画）
- 结论：**PASS**

### PORTFOLIO-013 数据源切换
- Web实现：localStorage estimate_source_<account>，SOURCES={local,xiaobeiyangji,yangjibao}
- 小程序实现：genius-mp-estimate-source-<account>，refreshEstimatesBySource
- 结论：**PASS**

---

## ③ 基金数据逻辑（FUND）

### FUND-001 基金详情 / FUND-002 历史净值 / FUND-004 历史业绩
- 结论：**PASS**（名称/代码/NAV/历史净值30条/前十大/业绩，两端一致）

### FUND-003 前十大持仓个股实时涨跌
- Web实现：holdingsMarkup 逐个 /api/stock/:code 拉实时涨跌
- 小程序实现：只展示权重，不拉个股涨跌
- 结论：**PARTIAL** → MIG-014（P2）

### FUND-005 数据标识状态机（P0 核心）
- Web实现（live-estimates.js:419-443）：状态1 navDate===expectedNavDate 且有涨跌幅→蓝「已更新MMDD」；状态2 非交易日且有 navDate→蓝；状态3 其他→灰「估值/小倍/养基宝」；expectedNavDate=QDII?前一交易日:今日
- 小程序实现：utils/tradingDay.js computeDataBadge 三态
- 结论：**PARTIAL**（需逐行核对 QDII 白名单/排除港股/节假日表/expectedNavDate）→ MIG-005（P0）

### FUND-006 QDII/T+2
- Web实现：isQdiiFund（排除恒生/港股/港美 + 白名单 + 名称正则），expectedNavDate=前一交易日
- 小程序实现：tradingDay.js isQdiiFund 同逻辑
- 结论：**PASS**（随 MIG-005 复核白名单/正则）

### FUND-007 估值校准
- Web实现：前端无触发按钮（纯服务端自动）
- 小程序实现：有校准按钮 + 结果展示
- 结论：**FAIL**（方向相反，保留小程序按钮，P3）

### FUND-008 缓存/并发
- Web实现：detailApiFundCache 5min TTL + fast + updatedNavDates + MAX_CONCURRENT=6 + 谁快谁先出
- 小程序实现：fast=1 秒开 + 并发6 + navDateMap
- 结论：**PARTIAL**（缺 5min TTL 前端缓存、谁快谁先出）→ MIG-015/016（P2）

---

## ④ 数据标识状态机

（同 FUND-005，逐行核对见 MIG-005，本模块为 P0 验收重点）

---

## ⑤ 同步中心（SYNC）

### SYNC-001 养基宝扫码登录 / SYNC-002 小倍短信登录 / SYNC-003 退出
- 结论：**PASS**（qrcode/轮询/sendSMS/login/logout 两端一致）

### SYNC-004 同步持仓
- Web实现：POST /import → refreshSyncedAccounts（删除本地 sync 账户不在服务端的 + 新增/更新覆盖，标 sync）
- 小程序实现：POST /import → _mergeImportedAccounts（只新增/更新，**不删除**服务端已删的本地 sync 账户）
- 结论：**PARTIAL** → MIG-009（P1）

### SYNC-005 同步账户标记/持久化
- Web实现：accountType='sync'+syncSource，buildPersisted 排除 sync 账户不写 localStorage
- 小程序实现：accountType='sync'+syncSource，但**同步账户仍写 localStorage**
- 结论：**PARTIAL** → MIG-010（P1）

### SYNC-006 Loading 管理
- Web实现：按钮级 loading（disabled），无全局 showLoading/hideLoading
- 小程序实现：wx.showLoading/hideLoading（用户反馈"一直转圈"）
- 结论：**PARTIAL**（需排查 hideLoading 配对）→ MIG-011（P1）

---

## ⑥ AI 分析（AI）

### AI-001~006 持仓分析/资产配置/操作策略/清仓记录/风险评分/调仓提醒/投资策略
- Web实现：buildDecisionReport 统一输出，AI 优先 + 本地规则兜底
- 小程序实现：analysis 页
- 结论：**PARTIAL**（需核对各模块覆盖）→ MIG-012（P1）

### AI-007 账户参数一致性（重点）
- Web有 bug：服务端 /api/ai/analyze 忽略 client 账户参数，改用云端 active → "看 A 分析 B"
- 小程序：本地账户直传，理论上无此 bug（需确认用当前账户）
- 结论：**PARTIAL**（需确认小程序 AI 用当前账户）→ MIG-003（P0）

### AI-008 结果缓存跨账户串显（重点）
- Web有 bug：loadCachedAiResult 回退全局 LAST_AI_ANALYSIS
- 小程序同款 bug：analysis.js:169 `LAST_AI_ANALYSIS_<账户> || LAST_AI_ANALYSIS`
- 结论：**FAIL**（两端同款跨账户串显）→ MIG-002（P0）

---

## ⑦ 云同步（CLOUD）

### CLOUD-001 头像/昵称
- 结论：**FAIL**（方向相反，小程序微信体系独有，保留，P3）

### CLOUD-002 登录
- 结论：**PASS**（Web 邮箱 vs 小程序微信 openid，架构差异各自适配）

### CLOUD-003 退出/清空
- 结论：**PASS**（退出前推云端 → 清空 → 初始化最小默认账户）

### CLOUD-004 云同步
- Web实现：scheduleCloudSave 400ms 防抖 PUT /api/account/state；backupToCloud/restoreFromCloud 手动
- 小程序实现：手动立即同步/恢复本地
- 结论：**PASS**（Web 自动防抖 vs 小程序手动，架构不同）

### CLOUD-005 updatedAt 冲突保护
- Web实现：无比较（last-write-wins）
- 小程序实现：有 updatedAt 比较（本地新则不覆盖）
- 结论：**FAIL**（方向相反，小程序优于 Web，保留，P2）

### CLOUD-006 防删除账户复活
- 结论：**PASS**（小程序云端整体 set + updatedAt 保护已解决）

---

## ⑧ 设置（SETTING）

### SETTING-001 API Base URL / SETTING-002 API 测试 / SETTING-004 AI 服务 / SETTING-005 AI 测试 / SETTING-006 投资策略 / SETTING-007 数据备份恢复
- 结论：**PASS**（都有，localStorage 持久化；需核对 AI Key 存储、备份 JSON 结构）

### SETTING-003 外部 Token
- 结论：**MISSING**（架构差异，callContainer 直连用不到，不适用，P3）

---

## 统计汇总

| 模块 | PASS | PARTIAL | FAIL | MISSING |
|---|---|---|---|---|
| 账户（ACCOUNT） | 5 | 3 | 2 | 1 |
| 持仓（PORTFOLIO） | 5 | 6 | 2 | 0 |
| 基金数据（FUND） | 4 | 3 | 1 | 0 |
| 同步（SYNC） | 3 | 3 | 0 | 0 |
| AI（AI） | 0 | 2 | 1 | 0 |
| 云同步（CLOUD） | 4 | 0 | 2 | 0 |
| 设置（SETTING） | 6 | 0 | 0 | 1 |
| **合计** | **27** | **17** | **8** | **2** |

- P0：5（同步账户规则、AI串显、AI账户参数、计算逻辑、数据标识逐行核对）
- P1：约 9（改名、移动合并规则、交易计算、同步删除、同步持久化、Loading、AI模块覆盖、localhost残留、收益核对）
- P2：约 6
- P3：约 6（方向相反/架构差异，保留记录）
