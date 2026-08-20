# 项目长期约定（Genius Trader 小程序）

> 本项目跨会话复用的关键约定与坑。追加式维护。

## 默认开发规范（Skill）

- 项目级 Skill `genius-trader-development` 已安装于 `.workbuddy/skills/genius-trader-development/SKILL.md`，是**本项目后续开发的默认开发规范**。
- 凡涉及 Genius Trader 后端/网页/小程序开发、架构重构、数据迁移、部署、验收，必须先加载该 Skill（含 users/sessions/user_data/source_credentials/account_backups 隔离、user_id=0 游客、单后端 Render+PostgreSQL、禁止 CloudBase/wx.cloud、禁止前端传 userId、数据安全与 Git/Render 规则等 25 章 + L0-L5 风险等级）。
- 与本文档约定冲突时，以 Skill 为准。

## 微信小程序开发坑（必须遵守）

1. **Page data 里禁止放 Set / Map / 函数 / 类实例**。微信 data 会经过 JSON 序列化，Set/Map 会退化成 `{}`，`.has()` 变 undefined 报错。
   - 防并发/去重标记用普通对象 `{}`（`obj[key] = true`）或实例变量 `this._xxx`。
   - 局部变量/模块级常量的 Set 不受影响（不经 data 序列化）。

2. **判断"是否有限数"用 `Number.isFinite(x)`，不要用 `Number.isFinite(Number(x))`**。因为 `Number(null)=0`、`Number('')=0` 会把空值误判成 0。

3. **小程序原生 `input` 在 iOS 真机上禁用 `-webkit-text-fill-color`（尤其值带 CSS 变量 `var(...)`）**。该 WebKit 私有属性在微信原生 input 组件 + iOS WKWebView 上解析 CSS 变量会失效，导致输入文字渲染为透明/不绘制（开发者工具 Chromium 内核正常，iPhone 真机不可见但值存在）。**输入框文字色用硬编码 `color: #xxx` 最稳**，配合 `caret-color` 同色即可。

## 后端接口约定

- 后端服务名：`genius-trader`（CloudBase 云托管），环境 `cloud1-d6gh61ypfd7fcbc28`，公网域名 `genius-trader-297358-8-1468165942.sh.run.tcloudbase.com`（**默认测试域名，微信 MP 公众平台禁止在正式环境使用**——若列入 request 合法域名会在控制台红色警告）。
- **mp1 当前生产路径**：业务请求统一 `wx.request` → Render 公网域名 `https://genius-trader.onrender.com`（`config/api.js:9` PUBLIC_API_BASE）。**MP 代码已经没有任何路径调用 Cloud Run 默认域名**，公众平台「request 合法域名」残留的 `*.sh.run.tcloudbase.com` 项可安全删除。
- CloudBase 端 `genius-trader` 服务仍在线（`genius-trader-006`，status=normal，AccessTypes=[OA,PUBLIC,MINIAPP]），但 CustomDomainName/Names 空——若想从 Render 切到 CloudBase 必须先配自有 ICP 域名。
- `/api/fund/:code` 返回 `res.history` + `res.latest_nav{date,nav,acc_nav}`（无 changePercent，涨跌幅需用 officialNavChange 从 history 算）。
- `/api/fund/:code/calibration` 冷启动时可能临时 500，属正常（回退机制兜底）。
- `/api/provider/*/import` 走 callContainer 可能 102002（响应大），回退 wx.request 才成功，属正常。

## 数据模型约定

- 账户对象字段：`name / accountType('local'|'sync') / syncSource / parent / children / funds / strategy / closedPositions`。
- 同步账户规则：改名/移动 → `convertAccountToLocal`（accountType='local'、syncSource=null、convertedFromSync=true、originalSource 记录）。
- 基金字段：`amount / holdingProfit / holdingRate / hold / today / todayEstimate / transactions / autoInvest`。当日收益优先 `todayEstimate`。
- 收益率公式：`holdingRate = holdingProfit / (amount - holdingProfit)`。
- 数据标识三态：① navDate===expected 且有官方涨跌幅 → 蓝「已更新」；② 非交易日有 navDate → 蓝；③ 其他 → 灰「估值/小倍/养基宝」。

## 部署与 Git 约定

- **后端工作目录（2026-08-17 起，实测确认）= `C:\Users\Administrator\Desktop\Codex3 基金\genius-trader2.0`**（仓库根目录本身为纯英文 `genius-trader2.0`，套在 CJK 父目录 `Codex3 基金` 下；因 `.git` 在英文目录内，Bash `cd` / `node --check` / `git diff` / `git rev-parse` 均正常工作，GitHub Desktop 可正常打开）。这是从 GitHub `DoDong-code/genius-trader2.0`@main 重新 clone 的副本，**Phase 2 的 11 个文件改动在此提交并 push**。
- ⚠️ **旧仓库 `C:\Users\Administrator\Desktop\Codex3 基金\天才交易员` 的 `.git` 已损坏**：pack 数据文件（`.pack`）丢失，仅剩 `.idx`，`refs/heads/main` 与 `packed-refs` 缺失，无法被任何 git 打开。其源码文件完好可作参考，但**不要再对其做 git 操作**。后续后端 git 操作一律在 `genius-trader2.0` 目录进行。
- **⚠️ 2026-08-20 工作区迁移：`C:\Users\Administrator\Desktop\小程序` 文件夹已弃用**。mp1 小程序源码已迁入 `genius-trader2.0\mp1`（删除 mp1/.git 后入库，commit `ff2fcba`），项目数据 `.workbuddy`（memory/skills/Phase 报告）已复制到 `genius-trader2.0\.workbuddy`（与旧目录内容一致）。**今后所有 mp1 开发/检查路径 = `C:\Users\Administrator\Desktop\Codex3 基金\genius-trader2.0\mp1`**；项目 memory/skill 主数据源 = `genius-trader2.0\.workbuddy`。旧 `小程序\mp1` 已删、旧 `小程序\.workbuddy` 弃用保留（勿再读写，勿删 `.workbuddy` 之外内容）。
- 后端部署源：GitHub `DoDong-code/genius-trader2.0`@main，push 后 Render 自动部署。
- **agent 无 GitHub 凭据（无 gh/token/SSH，/dev/tty 不可用），无法 push**；用户本地有 GitHub Desktop。**以后需要推送时，直接告诉用户「请在 GitHub Desktop 推送」即可，不要反复尝试 push**。
- 小程序 mp1 随主仓库 git 管理（手动上传体验版到微信；mp1 不再有独立 .git）。⚠️ mp1 的 `.gitignore` 不含 `miniprogram_npm` 等，未来若引入 npm 依赖注意补忽略。
- 本地 clone 与远程分叉时：先 `git ls-remote` 确认远程，必要时直接备份 + 重新 clone；**不要 stash/reset --hard**（曾因此损坏过 .git）。
- 本机 Windows 环境 Recycle Bin COM 不可用（`SendToRecycleBin` 报「系统不支持该功能」），大目录删除需分步（先删 node_modules 再删剩余）。
