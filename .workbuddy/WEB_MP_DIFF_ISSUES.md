# WEB_MP_DIFF_ISSUES.md — Web ↔ 小程序差异与问题清单

> 生成：2026-08-16。仅记录差异和问题（FAIL / PARTIAL / MISSING），按优先级排序。
> 来源：4 个并行子代理扫描 Web 源码 + 小程序源码对照。

---

## P0 — 核心业务错误（数据错误 / 账户错误 / 收益错误 / 业务结果不同）

### DIFF-001 同步账户改名/移动不转本地
- **功能**：ACCOUNT-SYNC-RULE-001
- **Web行为**：同步账户改名/移动 → `convertAccountToLocal`（accountType='local'，syncSource=null，打 convertedFromSync 标记）+ 服务端 `/api/portfolio/rename` 休眠原记录
- **小程序行为**：有 accountType/syncSource 标记，但**无 convertAccountToLocal 逻辑**；改名功能本身缺失；移动同步账户不转 local
- **差异**：同步账户改名/移动后，Web 转本地账户（不再自动同步），小程序仍保持 sync 状态
- **原因**：小程序 P1 只做了账户标记，未实现 convertAccountToLocal + 改名入口
- **优先级**：P0
- **建议**：补 convertAccountToLocal 逻辑 + 改名入口；移动同步账户时先转 local

### DIFF-002 AI 结果跨账户串显
- **功能**：AI-008
- **Web行为**：`loadCachedAiResult` 回退全局 `LAST_AI_ANALYSIS` → 未分析账户显示其他账户的 AI 结论（app-refactor.js:154）
- **小程序行为**：`analysis.js:169` 同样的回退逻辑 `LAST_AI_ANALYSIS_<账户名> || LAST_AI_ANALYSIS`
- **差异**：无（两端同款 bug）
- **原因**：全局键回退设计缺陷
- **优先级**：P0
- **建议**：去掉全局键回退，只读 `LAST_AI_ANALYSIS_<账户名>`；或按账户隔离存储

### DIFF-003 AI 账户参数错位
- **功能**：AI-007
- **Web行为**：服务端 `/api/ai/analyze` **忽略** client 的 portfolio.account，改用云端 state.active（fund.js:256 + portfolioAnalysisService.js:157）→ "账户 A 显示、账户 B 请求"
- **小程序行为**：本地账户直接传（无服务端 auth），理论上无此 bug
- **差异**：Web 有账户错位 bug；小程序架构不同（本地账户），需确认小程序 AI 请求用的是当前账户
- **原因**：Web 服务端忽略 client 账户参数
- **优先级**：P0
- **建议**：确认小程序 AI 请求用当前账户（本地），Web 端另行修复（不在本阶段）

### DIFF-004 收益/收益率计算逻辑需逐行核对
- **功能**：PORTFOLIO-009
- **Web行为**：收益率 = holdingProfit / (amount - holdingProfit)（成本=市值−收益）；当日收益 = todayEstimate 或 amount×today
- **小程序行为**：portfolio.js filterAndSortFunds 计算，公式需核对
- **差异**：待核对
- **原因**：尚未做代码级公式对比
- **优先级**：P0
- **建议**：逐行对比 portfolio.js 的计算公式 vs Web 的 todayProfitOf/normalizeHolding

### DIFF-005 数据标识状态机需逐行核对
- **功能**：FUND-005
- **Web行为**：live-estimates.js:419-443 三态判定（navDate===expectedNavDate + 涨跌幅 → 蓝；非交易日 → 蓝；其他 → 灰）
- **小程序行为**：utils/tradingDay.js computeDataBadge 三态
- **差异**：待逐行核对（QDII 白名单、排除港股、节假日表、expectedNavDate）
- **原因**：两端独立实现，需确认完全一致
- **优先级**：P0
- **建议**：逐行对比 computeDataBadge vs hydrateRow 419-443 + isQdiiFund/isTradingDay/getPreviousTradingDay

---

## P1 — 核心功能不可用 / 逻辑缺失

### DIFF-006 改名功能缺失
- **功能**：ACCOUNT-003
- **Web行为**：编辑模式双击账户名 → 弹窗改名（本地改 key / 同步转 local）
- **小程序行为**：无改名功能
- **差异**：MISSING
- **原因**：小程序账户管理未实现改名
- **优先级**：P1
- **建议**：补改名入口（点击账户名 → 弹窗），同步账户改名转 local

### DIFF-007 移动/合并账户的同步规则缺失
- **功能**：ACCOUNT-004 / ACCOUNT-005
- **Web行为**：移动涉及同步账户先 convertAccountToLocal；合并用 mergeFundsInto（同 code 相加 + 流水去重）
- **小程序行为**：移动账户不转 local；合并逻辑需核对
- **差异**：PARTIAL
- **原因**：convertAccountToLocal 缺失
- **优先级**：P1
- **建议**：移动同步账户时补 convertAccountToLocal；核对 mergeFundsInto 等价性

### DIFF-008 加仓/减仓/清仓/定投计算需核对
- **功能**：PORTFOLIO-004/005/006/007
- **Web行为**：加仓（amount+=tradeAmount，profit-=fee）；减仓（等比例兑现 + 扣 fee）；清仓（流水+closedPositions+splice）；定投（autoInvest 字段）
- **小程序行为**：fundDetail 实现，需代码级核对
- **差异**：待核对
- **原因**：尚未逐行对比
- **优先级**：P1
- **建议**：逐行对比 fundDetail.js 的交易逻辑 vs detail-api.js 818-855

### DIFF-009 同步持仓的删除逻辑缺失
- **功能**：SYNC-004
- **Web行为**：refreshSyncedAccounts 删除本地 sync 账户不在服务端的账户
- **小程序行为**：_mergeImportedAccounts 无此删除逻辑（只新增/更新）
- **差异**：PARTIAL
- **原因**：小程序同步导入未实现"服务端已删则本地也删"
- **优先级**：P1
- **建议**：_mergeImportedAccounts 加删除逻辑

### DIFF-010 同步账户持久化策略不同
- **功能**：SYNC-005
- **Web行为**：buildPersisted 排除 sync 账户（不写 localStorage/云端），只备份 strategy 到 syncMeta
- **小程序行为**：同步账户会写入 localStorage
- **差异**：PARTIAL
- **原因**：小程序无 buildPersisted 排除逻辑
- **优先级**：P1
- **建议**：saveState 时排除 sync 账户（或接受架构差异）

### DIFF-011 Loading 转圈排查
- **功能**：SYNC-006
- **Web行为**：按钮级 loading（disabled），无全局 showLoading/hideLoading
- **小程序行为**：wx.showLoading/hideLoading，用户反馈"同步持仓一直转圈"
- **差异**：待排查 hideLoading 配对
- **原因**：syncProvider 的 success/error/finally 是否都 hideLoading
- **优先级**：P1
- **建议**：核对 setting.js syncProvider 的 showLoading/hideLoading 配对

### DIFF-012 AI 分析模块覆盖需核对
- **功能**：AI-001~006
- **Web行为**：buildDecisionReport 输出持仓分析/资产配置/操作策略/清仓记录/风险评分/调仓提醒/投资策略
- **小程序行为**：analysis 页需核对各模块是否都实现
- **差异**：待核对
- **原因**：尚未逐模块对比
- **优先级**：P1
- **建议**：逐模块核对 analysis 页 vs buildDecisionReport

---

## P2 — 体验问题

### DIFF-013 前十大持仓个股实时涨跌
- **功能**：FUND-003
- **Web行为**：逐个 /api/stock/:code 拉个股实时涨跌
- **小程序行为**：只展示权重，不拉实时涨跌
- **差异**：PARTIAL
- **原因**：小程序未实现 loadStockRealtimeDetails
- **优先级**：P2
- **建议**：可选补个股实时涨跌

### DIFF-014 缓存 TTL 前端内存缓存
- **功能**：FUND-008
- **Web行为**：detailApiFundCache 5min TTL（5 分钟内二次打开不请求）
- **小程序行为**：无前端内存缓存（每次进都请求 fast）
- **差异**：PARTIAL
- **原因**：小程序未实现 detailApiFundCache
- **优先级**：P2
- **建议**：加前端内存缓存（5min TTL）

### DIFF-015 谁快谁先出 + 第三方更正
- **功能**：FUND-008
- **Web行为**：本地引擎先出 + 2.5s 后第三方更正
- **小程序行为**：无
- **差异**：PARTIAL
- **原因**：小程序未实现
- **优先级**：P2
- **建议**：可选补

### DIFF-016 分类口径不同
- **功能**：PORTFOLIO-001 / PORTFOLIO-013
- **Web行为**：添加基金固定 category='基金'
- **小程序行为**：自动按名称分类（黄金/债/海外）
- **差异**：PARTIAL（口径不同）
- **原因**：小程序多做了自动分类
- **优先级**：P2
- **建议**：统一口径（或接受小程序改进）

### DIFF-017 updatedAt 方向相反
- **功能**：CLOUD-005
- **Web行为**：无冲突保护（last-write-wins）
- **小程序行为**：有 updatedAt 比较（本地新则不覆盖）
- **差异**：FAIL（方向相反，小程序优于 Web）
- **原因**：小程序单独做了改进
- **优先级**：P2
- **建议**：保留小程序改进（优于 Web），记录即可

---

## P3 — 优化 / 次要

### DIFF-018 删除基金方向相反
- **功能**：PORTFOLIO-003
- **Web行为**：无独立删除（只有清仓）
- **小程序行为**：有独立删除基金
- **差异**：FAIL（方向相反）
- **优先级**：P3
- **建议**：保留小程序删除（用户需要），记录即可

### DIFF-019 估值校准方向相反
- **功能**：FUND-007
- **Web行为**：前端无触发（纯服务端自动）
- **小程序行为**：有校准按钮+结果展示
- **差异**：FAIL（方向相反）
- **优先级**：P3
- **建议**：保留小程序校准按钮（优于 Web），记录即可

### DIFF-020 分类筛选方向相反
- **功能**：PORTFOLIO-011
- **Web行为**：无分类筛选
- **小程序行为**：有分类筛选
- **差异**：FAIL（方向相反）
- **优先级**：P3
- **建议**：保留小程序筛选，记录即可

### DIFF-021 头像/昵称方向相反
- **功能**：CLOUD-001
- **Web行为**：无（只有邮箱）
- **小程序行为**：有（微信头像昵称）
- **差异**：FAIL（方向相反，架构差异）
- **优先级**：P3
- **建议**：保留（微信体系独有）

### DIFF-022 外部 Token 缺失
- **功能**：SETTING-003
- **Web行为**：有外部 Token（生成/吊销）
- **小程序行为**：无（callContainer 直连用不到）
- **差异**：MISSING（架构差异，不适用）
- **优先级**：P3
- **建议**：不补（架构差异）
