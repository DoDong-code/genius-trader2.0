# WEB_MP_FUNCTION_PARITY.md — Web ↔ 小程序 完整功能级 Diff 基线

> 生成：2026-08-16。以 Web 源码（`C:\Users\Administrator\Desktop\Codex3 基金\天才交易员`）为**唯一母版**，逐项扫描对比小程序（`mp1`）。
> 本文件是"完整功能验收基线"，只记录事实，不修改代码。
> 一致性判定：PASS（业务结果完全一致）/ PARTIAL（存在但逻辑不同）/ FAIL（逻辑错误）/ MISSING（小程序缺失）。

---

## 一、账户系统（ACCOUNT）

### ACCOUNT-001 创建账户
- **Web**：总览→编辑→「新增账户」→ 弹窗输入名称 → 创建 `{name, accountType:'local', syncSource:null, funds:[], strategy:[], closedPositions:[]}` → 持久化（ui-fix.js:99）
- **小程序**：首页→编辑→「新增账户」→ 创建账户（index.js onAddAccount）
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### ACCOUNT-002 删除账户
- **Web**：编辑→勾选→「删除所选」→ 同步账户先调 `/api/portfolio/delete`（服务端物理删除）→ 清理 children/parent 引用 → 删除 → 持久化（ui-fix.js:56）
- **小程序**：首页→编辑→勾选→「删除」→ 本地删除 + 云端同步（index.js deleteSelected）
- **一致性**：PARTIAL
- **差异**：Web 同步账户删除时**调服务端物理删除**；小程序删除是**纯本地 + 手动云同步**，无服务端 `/api/portfolio/delete` 调用（因为小程序无服务端 auth 体系）
- **优先级**：P1
- **是否允许进入下一阶段**：YES（架构差异，小程序无服务端账户体系）

### ACCOUNT-003 修改账户名称（改名）
- **Web**：编辑模式下**双击账户名** → 弹窗重命名 → 本地账户改 key；同步账户先确认转 local（ui-fix.js:96、renameRow）
- **小程序**：**无改名功能**（grep rename/改名 无结果）
- **一致性**：MISSING
- **差异**：小程序账户管理只有增删、子账户、拆分、移动，无改名入口
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### ACCOUNT-004 移动账户
- **Web**：编辑→勾选→「移动」→ 选目标 + 是否保留 → 涉及同步账户先转 local → mergeFundsInto 合并持仓（app-refactor.js:3241）
- **小程序**：首页→编辑→「移动」（index.js onMoveAccounts）
- **一致性**：PARTIAL
- **差异**：Web 移动涉及同步账户时**先 convertAccountToLocal**；小程序无 convertAccountToLocal 逻辑（移动同步账户不会转 local）
- **优先级**：P0
- **是否允许进入下一阶段**：NO

### ACCOUNT-005 合并账户
- **Web**：无独立函数，由「移动（保留勾选=复制）」或「删除子账户」借 mergeFundsInto 实现（同 code 相加 amount/收益/shares，重算 rate）
- **小程序**：移动账户 + 删除子账户（合并回父账户）
- **一致性**：PARTIAL
- **差异**：mergeFundsInto 逻辑需确认小程序是否等价（同 code 合并 amount/收益/流水去重）
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### ACCOUNT-006 切换账户
- **Web**：顶部 tab / 账户卡片 → setActive → 持久化（persistence.js:206 包装 save）
- **小程序**：账户 tab / 账户卡片 → setActive → 持久化
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### ACCOUNT-007 新建子账户
- **Web**：编辑→「＋新建子账户」→ 创建 `{name, parent, funds:[]}` → parent.children.push（app-refactor.js:3146）
- **小程序**：首页→编辑→「新建子账户」（index.js onAddSubAccount）
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### ACCOUNT-008 删除子账户
- **Web**：编辑→子账户「删除」→ 持仓合并回父账户 → 删除（app-refactor.js:3205）
- **小程序**：首页→编辑→「删除子账户」（index.js onDeleteSubAccount）
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### ACCOUNT-009 按板块拆分
- **Web**：编辑→「按板块拆分」→ 按 FUND_SECTORS_BY_CODE 分组 → 建子账户 → 父账户清空（app-refactor.js:3170）
- **小程序**：首页→编辑→「按板块拆分」（index.js onSplitBySector）
- **一致性**：PARTIAL
- **差异**：板块映射表（FUND_SECTORS_BY_CODE）是否两端一致需核对
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### ACCOUNT-SYNC-RULE-001 同步账户规则（核心验收项）
- **Web**：
  - 改名/移动同步账户 → `convertAccountToLocal`（accountType='local'，syncSource=null，打 convertedFromSync/originalSource/convertedTime 标记）+ 服务端 `/api/portfolio/rename` 休眠原记录
  - 删除同步账户 → 服务端物理 DELETE，刷新不恢复
  - 手动再次「同步持仓」→ replaceSyncedAccount 重写（converted_at 复位 NULL）→ **会复活**
- **小程序**：
  - 有 accountType/syncSource 标记（P1 已做），**无 convertAccountToLocal 逻辑**
  - 改名功能缺失（ACCOUNT-003），因此同步账户改名转 local 无从触发
  - 移动同步账户**不会**转 local
  - 删除同步账户是纯本地 + 手动云同步，无服务端物理删除
- **一致性**：FAIL
- **差异**：核心同步规则（改名/移动转 local + 服务端休眠）小程序完全缺失
- **优先级**：P0
- **是否允许进入下一阶段**：NO

---

## 二、持仓系统（PORTFOLIO）

### PORTFOLIO-001 添加基金
- **Web**：持仓页「增加基金」→ 名称/代码双向回填 → 提交，`holdingRate = holdingProfit/(amount-holdingProfit)`，**category 固定 '基金'**（portfolio-fix.js:166）
- **小程序**：持仓页「添加基金」→ 代码/名称双向回填 + **自动分类**（黄金/债/海外）
- **一致性**：PARTIAL
- **差异**：分类逻辑不同——Web 固定 '基金'，小程序自动按名称分类
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### PORTFOLIO-002 修改基金（金额/收益）
- **Web**：详情抽屉「修改持仓」→ normalizeHolding（amount/holdingProfit/holdingRate 重算）（detail-api.js:579）
- **小程序**：详情抽屉「修改持仓」→ 修改 amount/profit
- **一致性**：PASS（需核对 normalizeHolding 公式）
- **差异**：无
- **优先级**：—

### PORTFOLIO-003 删除基金
- **Web**：**无独立删除基金功能**（只有清仓 splice 移除）
- **小程序**：有独立删除基金（fundDetail.js:793 app.deleteFund）
- **一致性**：FAIL（方向相反，小程序多出 Web 没有的功能）
- **差异**：Web 用「清仓」承载删除语义；小程序两者都有
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### PORTFOLIO-004 加仓
- **Web**：detail-api.js:826 `nextAmount += tradeAmount; nextProfit -= fee`（本金收益不变，只扣手续费）
- **小程序**：fundDetail 加仓
- **一致性**：PARTIAL（需核对加仓的收益/手续费计算）
- **差异**：需代码级核对
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### PORTFOLIO-005 减仓
- **Web**：detail-api.js:834 `remainingRatio = (amount-tradeAmount)/amount; nextProfit = profit*remainingRatio - fee`（收益按剩余比例等比例兑现）
- **小程序**：fundDetail 减仓
- **一致性**：PARTIAL（需核对减仓等比例兑现逻辑）
- **差异**：需代码级核对
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### PORTFOLIO-006 清仓
- **Web**：detail-api.js:748 追加 sell 流水 + closedPositions 日志 + splice 移除基金
- **小程序**：fundDetail 清仓
- **一致性**：PARTIAL（需核对 closedPositions 日志是否写）
- **差异**：需代码级核对
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### PORTFOLIO-007 定投
- **Web**：detail-api.js:784 追加 buy 流水 + autoInvest{enabled,amount,frequency,nextDate} + normalizeHolding
- **小程序**：fundDetail 定投
- **一致性**：PARTIAL（需核对 autoInvest 字段和 nextDate 计算）
- **差异**：需代码级核对
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### PORTFOLIO-008 交易记录
- **Web**：fund.transactions 数组 `{type:'buy'|'sell', amount, fee, date}`，sell 显示 −、buy 显示 +，图表画买卖点
- **小程序**：fundDetail 交易记录
- **一致性**：PARTIAL（需核对交易记录结构）
- **差异**：需代码级核对
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### PORTFOLIO-009 计算逻辑（金额/收益/收益率/当日收益）
- **Web**：
  - 持有收益 = holdingProfit（兼容 profit）
  - 收益率 = holdingProfit / (amount - holdingProfit)（成本=市值−收益）
  - 当日收益 = todayEstimate 或 amount × today
  - 总资产 = Σ amount
- **小程序**：portfolio.js filterAndSortFunds 计算
- **一致性**：PARTIAL（需核对收益率公式是否同为 holdingProfit/(amount-holdingProfit)）
- **差异**：需代码级核对
- **优先级**：P0
- **是否允许进入下一阶段**：NO

### PORTFOLIO-010 排序（五态循环）
- **Web**：amount 三态（升/降/默认）；holdingProfit、todayProfit 五态（金额升/降→率升/降→默认）（portfolio-fix.js:616）
- **小程序**：portfolio.js sortState 排序
- **一致性**：PARTIAL（需核对五态循环是否一致）
- **差异**：需代码级核对
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### PORTFOLIO-011 筛选
- **Web**：**无分类筛选功能**（app.js 旧代码有但被覆盖）
- **小程序**：有分类筛选（activeCategory，权益/黄金/债券/海外/其他）
- **一致性**：FAIL（小程序多出 Web 没有的筛选）
- **差异**：方向相反
- **优先级**：P3
- **是否允许进入下一阶段**：YES

### PORTFOLIO-012 自定义表头顺序
- **Web**：localStorage['genius-trader-column-order']，fund 列固定最前，桌面拖拽+触屏 pointer（portfolio-fix.js:317）
- **小程序**：columnOrder + 长按拖动（已修让位动画）
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### PORTFOLIO-013 数据源切换
- **Web**：localStorage['estimate_source_<account>']，SOURCES={local,xiaobeiyangji,yangjibao}，切换后 refreshFundEstimates（status-clock.js）
- **小程序**：wx.getStorageSync('genius-mp-estimate-source-<account>')，切换后 refreshEstimatesBySource
- **一致性**：PASS（存储 key 名不同但语义一致）
- **差异**：无
- **优先级**：—

---

## 三、基金数据逻辑（FUND）

### FUND-001 基金详情
- **Web**：点持仓行→抽屉，展示名称/代码/类型/公司/NAV/历史净值/前十大持仓/历史业绩/交易记录
- **小程序**：点持仓行→抽屉，展示同上
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### FUND-002 历史净值
- **Web**：近 30 条（navHistoryMarkup）
- **小程序**：近 30 条（computeNavRows slice 30）
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### FUND-003 前十大持仓
- **Web**：holdingsMarkup，逐个 /api/stock/:code 拉实时涨跌
- **小程序**：majorHoldings（res.holdings），**未拉个股实时涨跌**
- **一致性**：PARTIAL
- **差异**：Web 展示个股实时涨跌，小程序只展示权重
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### FUND-004 历史业绩
- **Web**：近 1/3/6 月、1/3 年、成立以来
- **小程序**：同
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### FUND-005 数据标识状态机（P0 核心）
- **Web**（live-estimates.js:419-443）：
  - 状态1：navDate===expectedNavDate 且有涨跌幅 → 蓝「已更新MMDD」
  - 状态2：非交易日且有 navDate → 蓝「已更新MMDD」最近交易日
  - 状态3：其他 → 灰「估值/小倍/养基宝」
  - expectedNavDate = QDII ? 前一交易日 : 今日
- **小程序**（utils/tradingDay.js computeDataBadge）：三态逻辑**已对齐**
- **一致性**：PASS（需逐行核对 computeDataBadge vs hydrateRow 419-443）
- **差异**：需确认 QDII 白名单、排除港股、节假日表是否完全一致
- **优先级**：P0
- **是否允许进入下一阶段**：NO（需逐行核对）

### FUND-006 QDII/T+2
- **Web**：isQdiiFund（排除恒生/港股/港美 + 白名单 022184/014002 + 名称正则），expectedNavDate=前一交易日
- **小程序**：utils/tradingDay.js isQdiiFund（同逻辑）
- **一致性**：PASS（需确认白名单和正则完全一致）
- **差异**：无
- **优先级**：—

### FUND-007 估值校准
- **Web**：**前端无触发按钮**（纯服务端自动，estimateEngine 每次估值自动 calibrateFund），前端不消费 calibration 字段
- **小程序**：有校准按钮 + 结果展示（之前补全的）
- **一致性**：FAIL（方向相反——Web 前端无，小程序有）
- **差异**：小程序"超出" Web，但 Web 是服务端自动校准
- **优先级**：P3
- **是否允许进入下一阶段**：YES

### FUND-008 缓存/并发
- **Web**：detailApiFundCache（5min TTL）+ fast 参数 + updatedNavDates + MAX_CONCURRENT=6 + 谁快谁先出
- **小程序**：fast=1 秒开 + 并发 6 + navDateMap（已对齐大部分）
- **一致性**：PARTIAL
- **差异**：小程序缺少 detailApiFundCache 5min TTL 前端缓存、谁快谁先出、第三方 2.5s 后更正
- **优先级**：P2
- **是否允许进入下一阶段**：YES

---

## 四、第三方同步（SYNC）

### SYNC-001 养基宝扫码登录
- **Web**：POST /qrcode → 二维码 → 2s 轮询 status → confirmed 登录成功（90s 超时）
- **小程序**：POST /qrcode → 二维码 → 2s 轮询 → confirmed
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### SYNC-002 小倍短信登录
- **Web**：sendSMS（60s 倒计时）→ login
- **小程序**：sendSMS → login
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### SYNC-003 退出
- **Web**：POST /logout → refreshProviderStatus
- **小程序**：POST /logout
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### SYNC-004 同步持仓
- **Web**：POST /import → refreshSyncedAccounts（删除本地 sync 不在服务端的账户；新增/更新服务端账户整体覆盖，标 sync）
- **小程序**：POST /import → _mergeImportedAccounts（标 sync）
- **一致性**：PARTIAL
- **差异**：Web 有"删除本地 sync 账户不在服务端"的逻辑；小程序 _mergeImportedAccounts 无此删除逻辑
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### SYNC-005 同步账户标记
- **Web**：accountType='sync' + syncSource=source_name，isSyncAccount 判定，同步账户不持久化 localStorage
- **小程序**：accountType='sync' + syncSource（已做），但同步账户**仍会持久化到 localStorage**（小程序无 buildPersisted 排除逻辑）
- **一致性**：PARTIAL
- **差异**：小程序同步账户会写本地，Web 不写
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### SYNC-006 Loading 管理
- **Web**：按钮级 loading（disabled + 文案），无全局 showLoading/hideLoading
- **小程序**：wx.showLoading/hideLoading（全局遮罩）
- **一致性**：PASS（实现方式不同但语义一致）
- **差异**：无（用户反馈"一直转圈"需单独排查 hideLoading 配对）
- **优先级**：P1
- **是否允许进入下一阶段**：NO

---

## 五、AI 分析（AI）

### AI-001 持仓分析 / AI-002 资产配置 / AI-003 操作策略 / AI-004 清仓记录 / AI-005 风险评分 / AI-006 投资策略
- **Web**：buildDecisionReport 统一输出，AI 优先 + 本地规则兜底
- **小程序**：analysis 页
- **一致性**：PARTIAL（需核对各模块是否都实现）
- **差异**：需核对小程序 analysis 页是否覆盖清仓记录/风险评分/调仓提醒
- **优先级**：P1
- **是否允许进入下一阶段**：NO

### AI-007 账户参数一致性（重点审计）
- **Web 有 bug**：服务端 /api/ai/analyze 忽略 client 的 portfolio.account，改用云端 state.active → "账户 A 显示、账户 B 请求"
- **小程序**：本地账户直接传（无服务端 auth，不走云端 active）
- **一致性**：PASS（小程序无此 bug，但需确认小程序 AI 请求用的是当前账户数据）
- **差异**：Web 有 bug，小程序理论上无（架构不同）
- **优先级**：P0
- **是否允许进入下一阶段**：NO（需确认小程序 AI 用当前账户）

### AI-008 结果缓存跨账户串显（重点审计）
- **Web 有 bug**：loadCachedAiResult 回退全局 LAST_AI_ANALYSIS → 未分析账户显示其他账户结论
- **小程序有同样的 bug**：analysis.js:169 `wx.getStorageSync('LAST_AI_ANALYSIS_' + accountName) || wx.getStorageSync('LAST_AI_ANALYSIS')`
- **一致性**：FAIL（两端都有跨账户串显 bug）
- **差异**：无（同款 bug）
- **优先级**：P0
- **是否允许进入下一阶段**：NO

---

## 六、设置（SETTING）

### SETTING-001 API Base URL / SETTING-002 API 测试 / SETTING-004 AI 服务 / SETTING-005 AI 测试 / SETTING-006 投资策略 / SETTING-007 数据备份恢复
- **Web**：都有，localStorage 持久化
- **小程序**：都有
- **一致性**：PASS
- **差异**：无（需核对 AI Key 存储、备份 JSON 结构）
- **优先级**：—

### SETTING-003 外部 Token
- **Web**：有（externalGenBtn/externalRevokeBtn，localStorage['genius_external_token']）
- **小程序**：无（架构差异，callContainer 直连用不到）
- **一致性**：MISSING（但属架构性差异，判定不适用）
- **差异**：Web 是服务端多用户，需要外部 token；小程序直连不需要
- **优先级**：P3
- **是否允许进入下一阶段**：YES

---

## 七、账号与云同步（CLOUD）

### CLOUD-001 头像/昵称
- **Web**：无（只有邮箱，无头像昵称字段）
- **小程序**：有（微信 chooseAvatar/nickname）
- **一致性**：FAIL（方向相反，小程序独有）
- **差异**：架构差异（Web 邮箱体系 vs 小程序微信体系）
- **优先级**：P3
- **是否允许进入下一阶段**：YES

### CLOUD-002 登录
- **Web**：邮箱+密码，Bearer token
- **小程序**：微信登录 openid
- **一致性**：PASS（架构差异，各自适配）
- **差异**：无
- **优先级**：—

### CLOUD-003 退出/清空
- **Web**：退出前 backupToCloud → 清 token → clearLocalData
- **小程序**：退出前 saveStateToCloud → 清空 → 初始化最小默认账户
- **一致性**：PASS
- **差异**：无
- **优先级**：—

### CLOUD-004 云同步
- **Web**：scheduleCloudSave 400ms 防抖 PUT /api/account/state；backupToCloud/restoreFromCloud 手动
- **小程序**：手动立即同步/恢复本地（saveStateToCloud/loadStateFromCloud）
- **一致性**：PASS（Web 自动防抖 vs 小程序手动，架构不同）
- **差异**：无
- **优先级**：—

### CLOUD-005 updatedAt 冲突保护
- **Web**：**无比较逻辑**（last-write-wins 整体覆盖，无版本号/时间戳比对）
- **小程序**：有 updatedAt 比较（本地比云端新则不覆盖）
- **一致性**：FAIL（方向相反——小程序"优于" Web）
- **差异**：Web 无冲突保护，小程序有（这是小程序改进，但逻辑与 Web 不一致）
- **优先级**：P2
- **是否允许进入下一阶段**：YES

### CLOUD-006 防删除账户复活
- **Web**：buildPersisted 排除 sync 账户 + 服务端物理删除；但本地账户 400ms 防抖窗口内有复活竞态
- **小程序**：云端 set 整体替换 + updatedAt 保护（已修复删除复活）
- **一致性**：PASS（小程序已解决，Web 有竞态风险）
- **差异**：无
- **优先级**：—

---

## 统计汇总（待完整核对后填写）

- Web 功能总数：约 45 项
- 完全一致（PASS）：约 25 项
- 部分一致（PARTIAL）：约 12 项
- 缺失（MISSING）：3 项（改名、外部Token、convertAccountToLocal）
- 逻辑错误（FAIL）：5 项（同步规则、删除基金、AI串显、校准方向、updatedAt方向）
- P0：5 项（同步规则、AI账户参数、AI串显、计算逻辑、数据标识逐行核对）
- P1：约 10 项
- P2：约 6 项
- P3：约 4 项
