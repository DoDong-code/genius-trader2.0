# 按钮「进行中」状态审计报告

> 触发：设置页 → 第三方基金同步 →「同步持仓」点击后没有同步中状态。
> 范围：`genius-trader2.0` 的 mp1（微信小程序）+ app-refactor.js（Web）+ server/api/provider.js。
> 原则：verification-before-modify —— 本轮只审计，不改代码，等确认后再动。

---

## 一、问题定位（用户报的那个按钮）

| 项 | 现状 |
|---|---|
| 位置 | `mp1/pages/setting/setting.wxml:177 / 178 / 204 / 205`（同步持仓 / 覆盖重导 × 养基宝 / 小倍） |
| 处理函数 | `mp1/pages/setting/setting.js:471 syncProvider(source, overwrite)` |
| 现有反馈 | 仅 `wx.showLoading({ title: '正在同步持仓...' })`（**无 mask**） |
| 缺口 | ① 按钮本身无 `disabled`、无文案变化；② 无 mask → 用户可继续点击、可重复触发同步；③ 离开页面/被其它 `hideLoading` 覆盖后状态消失 |
| 为什么不会秒回 | 后端 `/api/provider/:source/import`（`server/api/provider.js:103`）是**串行**的：养基宝每账户一次 `/fund_hold` HTTP（且经 `withLimit` 全局并发闸门）+ 每账户一次 `replaceSyncedAccount` 写库；小倍另需一次批量估值接口 |
| Web 端对照 | `app-refactor.js:1509 runProviderImport()` **已有** busy：`btn.disabled = true` + 文案「同步中…」 |
| 判定 | **B：小程序端实现缺失（Web ↔ mp1 parity 缺口）**，不是后端慢的问题 |

---

## 二、P0 —— 明确需要补进行中态（非秒回 或 可重复点击）

| # | 端 | 位置 | 操作 | 现状 | 建议 |
|---|---|---|---|---|---|
| 1 | mp1 | `setting.js:471` | 同步持仓 / 覆盖重导（4 个按钮） | 全局 loading 无 mask，按钮无态 | disabled + 「同步中…」，与 Web 对齐 |
| 2 | mp1 | `setting.js:698 onXbyjSms` | 小倍「验证码」 | 无任何 loading，无防重，无 60s 倒计时（Web 有倒计时） | disabled + 「发送中…」+ 60s 倒计时 |
| 3 | mp1 | `setting.js:712 onXbyjLogin` | 小倍「登录」 | showLoading 无 mask，按钮无态 | disabled + 「登录中…」 |
| 4 | mp1 | `setting.js:686 / 739` | 养基宝 / 小倍「退出登录」 | 无任何 loading | disabled + 「退出中…」 |
| 5 | mp1 | `portfolio.js:263 onRefreshClick` | 持仓页刷新估值 | showLoading 无 mask | 加 mask + 防重 |
| 6 | Web | `app-refactor.js:3404` | 小倍「验证码」 | 请求中无 busy，只有**成功后**才倒计时 | 请求前 disabled + 「发送中…」 |
| 7 | Web | `app-refactor.js:3440` | 小倍「登录」 | **完全无 busy**（与小程序反了） | disabled + 「登录中…」 |
| 8 | Web | `app-refactor.js:2772` | 生成只读 Token | 无 busy | disabled + 「生成中…」 |
| 9 | Web | `app-refactor.js:3093` | 撤销 Token | 无 busy | disabled + 「撤销中…」 |
| 10 | Web | `app-refactor.js:2838` | 复制账户分析 JSON（拉 15 日净值 + 十大持仓，最慢的一项） | 只有 toast 提示，按钮可重复点 | disabled + 「获取中…」 |

## 三、P1 —— 建议补（低风险，非阻塞）

| # | 端 | 位置 | 操作 | 现状 |
|---|---|---|---|---|
| 11 | Web | `app-refactor.js:3248 / 1624` | AI 提问 | 回答区有「AI 正在思考…」，但按钮未禁用 → 可重复提交，白烧 token |
| 12 | Web | `app-refactor.js:3598 / 3660` | 账户重命名 / 移动账户 | 网络请求，无 busy |
| 13 | Web | `app-refactor.js:3390 / 3466` | 养基宝 / 小倍退出登录 | 无 busy |
| 14 | mp1 | `index.js:203` | 首页联网更新估值 | showLoading 无 mask |

## 四、已有良好进行中态（作为统一范式，不需要改）

| 端 | 位置 | 做法 |
|---|---|---|
| mp1 | `login.wxml:20` / `register.wxml:24` | `disabled="{{loading}}"` + 文案「登录中…」 |
| mp1 | `setting.wxml:53 / 107` | `isTestingApi` / `isTestingAi` + 「测试中...」 |
| mp1 | `analysis.wxml:27-29` | `isLoading` + `loadingText` |
| mp1 | `profile.wxml:48 / 66` | `restoringBackupId === item.id` 精确到行 |
| Web | `app-refactor.js:1513-1520` | `setBusy()`：disabled + opacity + 文案 ← **小程序应对齐这个** |
| Web | `app-refactor.js:2412-2419` | disabled + 「正在调取今日最新估值与诊断...」 |

---

## 五、第三方「交易记录」能否同步 —— 判定：**不能（C）**

### 5.1 接口核实结果（对照两份第三方 API 文档）

| 平台 | 我们用的接口 | 是否存在交易流水接口 | 依据 |
|---|---|---|---|
| 养基宝（老接口 `browser-plug-api`） | `/qr_code`、`/qr_code_state/{id}`、`/user_account`、`/fund_hold` | **无** | 全部端点仅：登录、账户、持仓、收益汇总/曲线、指数、公告、搜索、增删持仓 |
| 养基宝（新接口 `app-api`） | 未接入 | **无** | 端点含持仓、行情、排行、基金详情/净值/估值、股票、自选；`fund_hold_detail` 为持仓明细，非流水 |
| 小倍养基（`api` / `apiv2`） | `send-sms`、`login/phone`、`get-account-list`、`get-hold-list`、`get-optional-change-nav`、`get-fund-detail-v310` | **无** | 全部端点：登录、账户、持仓、估值序列、历史净值、重仓股、自选、大盘、快讯、行业估值、板块、榜单、会员、消息、机会信号 |

**根因**：两家都是「手动 / 截图识别记账」型工具（养基宝甚至开放 `POST /fund_hold` 让用户自己导入持仓、`DELETE /remove_fund_hold` 删除），不是券商交易通道，**不存在成交回报数据**。

### 5.2 现状是什么

`server/services/importProvider.js:59 buildFund()` 生成的是**合成的一条 buy 汇总交易**：
```js
transactions: [{ type: 'buy', amount, date: operation_date }]  // amount = 成本，date = 持仓起始日
```
不是真实流水。且每次同步 / 覆盖重导都会整体替换 `funds`，**会冲掉用户手工补录的交易记录**。

### 5.3 可选替代方案

| 方案 | 说明 | 代价 | 风险 |
|---|---|---|---|
| A. 维持现状 | 继续用合成的 1 条 buy | 0 | 用户手工补录会被同步冲掉 |
| B. 快照 diff 反推（推荐） | 每次同步时对比上次快照的「份额 / 成本」差，差额生成 buy / sell 记录 | 中：需存 last-sync 快照 + 去重键（date+type+amount） | 首次无基线 = 退化为现状；用户在第三方改持仓会被误判为交易 |
| C. 手工补录入入口 | 不改同步逻辑，给「交易记录」加手动添加 | 小 | 与同步覆盖冲突，需先加「同步不覆盖 transactions」保护 |
| D. 真机抓包探测 | 抓 App 包确认是否真有未公开流水接口 | 小（一次抓包） | 大概率确认无；白花时间 |

---

## 六、待确认（未执行任何代码修改）

1. 第二部分清单改哪些范围（P0-1 / P0 全部 / P0+P1 全部 / 暂不改）
2. 进行中态的表现形式（按钮内 disabled+文案 / +全局 mask 双保险 / 带进度计数）
3. 交易记录方案（A / B / C / D）
