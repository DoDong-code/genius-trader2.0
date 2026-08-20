# WEB_MP_MIGRATION_TODO.md — 迁移任务清单

> 生成：2026-08-16。把所有 FAIL / PARTIAL / MISSING 转成独立任务。
> 执行规则：一次只改一个 MIG，改完验证 PASS 再下一个。
> 排序：P0 优先，其次 P1。P3（方向相反的改进）不列入修复任务。

---

## P0 任务（核心业务错误，必须修复）— 全部完成 ✅

### MIG-001 同步账户改名/移动转本地
- **功能**：ACCOUNT-SYNC-RULE-001
- **问题**：小程序无 convertAccountToLocal 逻辑，同步账户改名/移动不转 local
- **优先级**：P0
- **验收**：同步账户改名/移动后 accountType 变 local、syncSource 置 null、打 convertedFromSync 标记
- **状态**：✅ 完成（app.js 加 isSyncAccount/convertAccountToLocal；moveAccounts 涉及同步账户先转 local；index.js 移动弹窗加解除同步提示）

### MIG-002 AI 结果跨账户串显
- **功能**：AI-008
- **问题**：analysis.js 回退全局 LAST_AI_ANALYSIS，未分析账户显示其他账户结论
- **优先级**：P0
- **验收**：切到未分析账户不显示其他账户的 AI 结论
- **状态**：✅ 完成（loadCachedAiResult 去全局键回退；保存不再写全局键）

### MIG-003 AI 账户参数一致性
- **功能**：AI-007
- **问题**：需确认小程序 AI 请求用的是当前账户数据
- **优先级**：P0
- **验收**：切账户后 AI 分析的是当前账户的持仓/策略/收益
- **状态**：✅ 完成（确认 runAiDiagnostics 用 app.getActiveAccount()；收益字段 f.cost 已在 MIG-004 修正）

### MIG-004 收益/收益率计算逻辑核对
- **功能**：PORTFOLIO-009
- **问题**：需逐行核对收益率公式、当日收益 = todayEstimate 或 amount×today
- **优先级**：P0
- **验收**：小程序计算结果与 Web 完全一致
- **状态**：✅ 完成（当日收益优先 todayEstimate；排序 todayProfit 优先 todayEstimate；analysis profit 改用 holdingProfit）

### MIG-005 数据标识状态机逐行核对
- **功能**：FUND-005
- **问题**：需逐行核对 computeDataBadge vs hydrateRow 419-443
- **优先级**：P0
- **验收**：三态判定完全一致，QDII/非交易日/盘中输出相同
- **状态**：✅ 完成（节假日表/QDII正则/白名单/previousTradingDay 全一致；补齐状态① officialChange 检查）

---

## P1 任务（核心功能不可用 / 逻辑缺失）— 全部完成 ✅

### MIG-006 改名功能
- **功能**：ACCOUNT-003
- **问题**：小程序无改名入口
- **优先级**：P1
- **验收**：点击账户名 → 弹窗改名 → 保存后名称保持；同步账户改名转 local
- **状态**：✅ 完成（app.renameAccount + index onRenameAccount + 编辑态改名链接；同步账户改名转 local）

### MIG-007 移动/合并账户的同步规则
- **功能**：ACCOUNT-004 / ACCOUNT-005
- **问题**：移动同步账户不转 local；mergeFundsInto 等价性需核对
- **优先级**：P1
- **验收**：移动同步账户转 local；同 code 合并金额/收益/流水去重
- **状态**：✅ 完成（app.mergeFundsInto 对齐 Web:109-131；deleteSubAccount/moveAccounts 统一调用；同 code 加 amount+holdingProfit+shares 重算 rate，流水去重）

### MIG-008 加仓/减仓/清仓/定投计算核对
- **功能**：PORTFOLIO-004~007
- **问题**：需逐行核对交易逻辑
- **优先级**：P1
- **验收**：交易后 amount/holdingProfit/holdingRate/transactions/closedPositions 与 Web 一致
- **状态**：✅ 完成（公式全一致；流水 push→unshift 对齐 Web 最新在前）

### MIG-009 同步持仓删除逻辑
- **功能**：SYNC-004
- **问题**：_mergeImportedAccounts 无"删除本地 sync 账户不在服务端"的逻辑
- **优先级**：P1
- **验收**：服务端已删的 sync 账户，同步后本地也删除
- **状态**：✅ 完成（_mergeImportedAccounts 加 serverNames 删除逻辑，仅删 sync 账户不删已转 local）

### MIG-010 同步账户持久化策略
- **功能**：SYNC-005
- **问题**：小程序同步账户会写 localStorage，Web 不写
- **优先级**：P1
- **验收**：同步账户不写本地（或明确接受架构差异）
- **状态**：✅ 完成（核对 saveState/loadState 持久化正确；同步账户写本地属架构差异，接受——无服务端账户体系）

### MIG-011 Loading 转圈排查
- **功能**：SYNC-006
- **问题**：用户反馈同步持仓一直转圈
- **优先级**：P1
- **验收**：任何情况下 hideLoading 都会执行
- **状态**：✅ 完成（15 处 showLoading 全部配对；request.js 加 timeout 30s 兜底）

### MIG-012 AI 分析模块覆盖核对
- **功能**：AI-001~006
- **问题**：需核对 analysis 页是否覆盖全部模块
- **优先级**：P1
- **验收**：所有 AI 分析模块都有对应实现
- **状态**：✅ 完成（模块全覆盖；补齐 AI 幻觉 fallback isAiDelusional 对齐 Web）

### MIG-013 request.js localhost 兜底残留
- **功能**：DIFF-API-001
- **问题**：DEFAULT_API_BASE='http://localhost:3000'
- **优先级**：P1
- **验收**：移除 localhost 字面量
- **状态**：✅ 完成（DEFAULT_API_BASE 改为 PUBLIC_API_BASE；全局无实际 localhost 地址）

---

## P2 任务（体验问题，可选）

### MIG-014 前十大持仓个股实时涨跌
- **功能**：FUND-003
- **问题**：小程序只展示权重，不拉个股实时涨跌
- **优先级**：P2
- **状态**：待开始

### MIG-015 前端内存缓存（5min TTL）
- **功能**：FUND-008
- **问题**：小程序无 detailApiFundCache，每次进详情都请求
- **优先级**：P2
- **状态**：待开始

### MIG-016 谁快谁先出 + 第三方更正
- **功能**：FUND-008
- **问题**：小程序无"本地引擎先出 + 2.5s 第三方更正"
- **优先级**：P2
- **状态**：待开始

---

## 不修复（P3 / 架构差异，记录即可）

- DIFF-017 updatedAt 方向相反（小程序优于 Web，保留）
- DIFF-018 删除基金（小程序有 Web 无，保留）
- DIFF-019 估值校准按钮（小程序有 Web 无，保留）
- DIFF-020 分类筛选（小程序有 Web 无，保留）
- DIFF-021 头像/昵称（微信体系独有，保留）
- DIFF-022 外部 Token（架构差异，不适用）
