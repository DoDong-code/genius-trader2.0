# 小程序功能与问题状态清单

> 快照时间：2026-08-16 14:50。覆盖小程序端（mp1）已实现功能、逻辑优化、已修复问题、未解决问题。
> 配套文档：`WEB_MP_PARITY.md`（网页端↔小程序功能对齐）、`CLOUDBASE_MIGRATION_REPORT.md`（CloudBase 迁移）。

---

## 一、已实现的功能

### 1. 总览页（pages/index）
- 行情指数展示（`/api/market/indices`）
- 账户管理：账户列表、增删账户、子账户、按板块拆分、移动合并
- 账户 tab 切换（全部 / 根账户 / 有持仓账户）
- 账户「同步」徽章（第三方导入的账户显示 sync 标识）
- 数据源切换（本地估算 / 养基宝 / 小倍）
- 顶部时间 + 绿点日期 + 刷新按钮（左对齐组）

### 2. 持仓页（pages/portfolio）
- 持仓列表：排序（金额/收益/收益率五态循环）、分类筛选
- 账户 tab（仅显示有持仓账户，无"全部"）
- 数据源切换（弹窗式，与网页端对齐）
- 数据标识状态机（三态徽章，见"逻辑优化"）
- 自定义表头顺序（长按拖动，让位动画）
- 添加基金：代码 / 名称双向自动回填 + 自动分类
- 基金详情抽屉（右侧滑入，右滑关闭）

### 3. 分析页（pages/analysis）
- 持仓分析、资产配比分析、投资操作策略、已清仓退出记录（辅助文案已精简）

### 4. 基金详情抽屉（components/fundDetail）
- KPI 卡片（当前金额 / 今日收益 / 持有收益 / 收益率）
- 历史净值走势图（canvas，含交互指示器/图例/成本线）
- 前十大持仓、历史业绩、交易记录（tab 切换）
- **估值校准**（接入 `/api/fund/:code/calibration`，展示方向准确率/MAE/样本数）
- 修改持仓 / 加仓 / 减仓 / 清仓 / 定投

### 5. 设置页（pages/setting）
- 数据源接口配置 + 接口连通性测试（默认走 CloudBase 公网域名）
- 天才(AI)服务配置 + 连通性测试（默认问题"今天几号"）
- 投资策略条目
- 第三方基金同步（养基宝扫码登录 / 小倍短信登录 / 同步持仓 / 退出）
- 数据备份与恢复（导出 / 导入 JSON 文件）

### 6. 账号二级页（pages/profile）
- 改头像（chooseAvatar）、改昵称（nickname input）
- 云同步（立即同步 / 恢复本地 / 上次同步时间）
- 退出登录并清空（退出前自动同步一次，清空后初始化最小默认账户）

### 7. 云同步（手动模式）
- 手动「立即同步」推送云端 + 「恢复本地」拉回
- `updatedAt` 时间戳保护（本地比云端新则不覆盖）
- 云端写入用 `set`（整体替换，防删除账户复活）

---

## 二、逻辑优化（对齐网页端已做过优化的部分）

### 1. 数据标识状态机（utils/tradingDay.js，核心）
三态判定，每只基金落到三种徽章之一：
- ① 官方净值已更新到预期日期（QDII ? 前一交易日 : 今日）→ 蓝「已更新0814」
- ② 非交易日（周末 + 2026 节假日硬编码）但有 navDate → 蓝「已更新0814」最近交易日
- ③ 其他（盘中/盘后净值未出）→ 灰「估值 / 小倍 / 养基宝」

支撑工具：`shanghaiDate / isShanghaiAfterClose / isTradingDay / isQdiiFund(排除港股+白名单) / getPreviousTradingDay / formatMMDD / providerDisplayName / computeDataBadge / officialNavChange`

- **美股 T+2**：QDII 基金 `expectedNavDate = 前一交易日`，显示前一日净值
- 徽章位置：代码 · 板块行的**代码左边**（对齐网页端 insertBefore）

### 2. 缓存加载（多层）
- 详情抽屉 `?refresh=1&fast=1` 秒开（先返回缓存，后台异步增量刷新）
- `updatedNavDates` 等价物：当日已更新净值的基金跳过重请求
- 并发上限 6（`_refreshNavDatesIfNeeded` / `refreshEstimatesBySource` 队列调度）
- 加载状态标记 `isSyncingNavDates`（头部转圈提示）

### 3. 账户同步标识
- `accountType='sync'|'local'` + `syncSource`，第三方导入账户标 sync
- 账户管理列表显示「同步」徽章

### 4. 手动云同步模式
- 从"改一次自动同步一次"改为"手动立即同步"，云端由用户完全控制
- 退出登录前自动同步一次（推云端，catch 静默）

### 5. 添加基金双向自动回填
- 代码→名称：`/api/fund/:code` 详情，读取 `fund_name` 字段（修复了 `f.name` 字段名 bug）
- 名称→代码：内置常见基金目录 + 后端 /api/funds 合并，相关度评分匹配（相等>前缀>包含）

### 6. 弹窗铺满（iOS 真机渲染修复）
- 去掉所有弹窗 `backdrop-filter` 模糊（iOS 会导致 fixed 子元素宽度异常）
- 详情抽屉滚动容器从原生 `scroll-view` 改为普通 `view + overflow-y:auto`（原生 scroll-view 会裁剪 fixed 弹窗）

---

## 三、已修改过的问题（按批次）

### 批次 1：体验版 5 问题
1. API 默认地址测试失败 → 测试默认走 CloudBase 公网域名，清除 localhost 缓存
2. 自动同步旧文案 + 退出前自动同步
3. 第三方基金无法登录 → 错误引导（绑 AppID / 加合法域名两步方案）
4. 清空恢复出厂与退出登录重复 → 删危险区域，退出后初始化为「主账户+1基金」
5. 自定义表头长按拖动按钮一直变 → 拖动期间不重排，松手才更新

### 批次 2：弹窗白边 + 滑动条 + tab 闪现 + 数据标识状态机
6. 修改持仓弹窗两边白边（form-grid 溢出 padding）
7. 详情抽屉滑动条（app.wxss 全局隐藏 + overscroll-behavior）
8. 长按隐藏分析页 tab 闪现（custom-tab-bar 加 pageLifetimes.show）
9. 数据标识状态机（P0，三态 + QDII T+2 + 徽章移代码左边）

### 批次 3：P1 账户同步标识 + 缓存加载
10. 账户「同步」徽章（accountType/syncSource）
11. 详情抽屉 fast 秒开 + 估值请求并发上限 6

### 批次 4：默认账户 + localhost 回退
12. 默认账户精简为「主账户+1基金」
13. apiBaseUrl 去掉 localhost 回退，清除残留缓存

### 批次 5：关键 bug + 弹窗彻底修
14. **CLOUD_SERVICE_NAME 不匹配**（genius-trader-003 → genius-trader，callContainer 路由失败根因）
15. 名称联想（fund_name 字段名 bug + 内置目录 + 相关度评分）
16. 退出账号清空第三方登录态 + 同步 UI 简化
17. 弹窗两边白边彻底修（所有子元素 padding）
18. 滑动条加固（bounces + enhanced）
19. 真机白边（去 backdrop-filter + 100vw）
20. 编辑页白边最终根因（drawer transform → 原生 scroll-view 裁剪 → 改普通 view）
21. 所有弹窗去模糊 + 抽屉右滑关闭

---

## 四、还未修改的问题（待办）

### 高优先级
1. **体验版二维码困境**（未解决）
   - 授权腾讯云（微搭低代码）换取 callContainer，导致微信公众平台"开发管理"被托管，体验版二维码入口消失
   - 微信生态绑定规则，两者难兼得
   - 备选：用「预览」功能测试（不依赖体验版二维码）

2. **iOS 系统边缘左滑退出小程序**（未解决）
   - iOS 系统级边缘手势优先于应用 touch，无法拦截
   - 彻底解决需把基金详情从"抽屉覆盖层"改为独立页面（navigateTo），架构改动待确认

### 中优先级
3. **三方账号同步"一直转圈"**（需排查）
   - 用户反馈同步持仓时 loading 不消失，需确认 syncProvider 的 showLoading/hideLoading 配对

4. **服务 MinNum=0 冷启动延迟**（CloudBase 配置）
   - 空闲会缩容到 0 实例，长时间不用后首次打开慢 10-30 秒
   - 建议 CloudBase 控制台把最小实例数改成 1（用户操作）

### 低优先级
5. **估值 confidence 展示**（P2，未做）
   - 后端 estimate 返回 confidence（high/medium/low），前端未展示

6. **全量基金搜索接口**（名称联想受限于内置目录）
   - 内置目录约 50 只，冷门基金匹配不到
   - 彻底方案：后端加 `/api/fund/search?q=xxx` 调天天基金 fundcode_search.js（需重新部署）

7. **基金估值校准未覆盖全量**（B 类遗留）
   - 已接入校准接口，但"股票行情 /api/stock/:code"（B2）和"恢复默认状态"（B3）未实现

---

## 附：当前 CloudBase 后端状态（连接器查实）

| 项 | 值 |
|---|---|
| 服务名 | genius-trader（版本 006，FlowRatio 100%） |
| 公网域名 | genius-trader-297358-8-1468165942.sh.run.tcloudbase.com |
| 环境 ID | cloud1-d6gh61ypfd7fcbc28 |
| 数据库 | Render PostgreSQL（选 A 复用，DATABASE_URL 已注入） |
| SOURCE_SECRET_KEY | fallback 字面量（genius-trader-dev-only-source-secret） |
| 健康检查 | /api/health → 200，database=postgres |
