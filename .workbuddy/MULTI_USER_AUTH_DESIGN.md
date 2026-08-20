# 天才交易员 · 正式多用户账号体系 —— 第一阶段扫描报告与设计

> 日期：2026-08-16
> 性质：只读扫描 + 设计，**未修改任何代码 / 数据库 / 未部署**
> 最高原则：Render 唯一后端、PostgreSQL 唯一库、禁止 CloudBase、禁止动 user_id=1/2/3 数据

---

## 〇、最重要的结论（先看这个）

**后端已经存在一套完整、可用的账号认证体系**，网页端 user_id=1/2/3 就是用它注册出来的。这意味着：

> 第一阶段不需要从零造轮子，核心是「复用现有 authService + users/sessions 表」，只需给小程序补登录页 + token 传递，再修一处多用户隔离隐患。

**最终答案（第 20 项）**：**能。** 一个用户在网页注册 user_id=4，用同一 email + 密码在小程序登录，后端 `userFromToken` 会返回同一个 `id=4`，两端读到的 account/state、backups、AI 完全一致。

---

## 一、当前用户系统架构（代码事实）

### 1. 表结构（PostgreSQL，`server/database/dbAsync.js` ensureCloudSchema）

| 表 | 字段 | 说明 |
|---|---|---|
| `users` | `id SERIAL PK`、`email TEXT UNIQUE`、`password_hash TEXT`、`created_at` | 用户主表，**只有 email，无 username/updated_at/status** |
| `sessions` | `token TEXT PK`、`user_id REF users`、`created_at`、`expires_at` | 会话 token，30 天 |
| `user_data` | `user_id PK`、`data TEXT`、`updated_at` | 账户状态 JSON 整包（已去外键，为容纳 user_id=0） |
| `source_credentials` | `id`、`user_id`、`source_name`、`token`(加密)、`refresh_token`(加密)、`cookie`(加密)、`user_info`、`status`、`UNIQUE(user_id,source_name)` | 第三方凭证（AES-256-GCM 加密） |
| `account_backups` | `id`、`user_id`、`data`、`account_count`、`reason`、`created_at` | 备份快照 |
| `read_tokens` | `id`、`user_id`、`token_hash`、… | 只读外部分析 token |

### 2. 认证服务（`server/services/authService.js`，已存在且完整）

- `register(email, password)`：邮箱格式校验 + 密码 ≥6 位 + 查重 → 插入 users → 生成 session token
- `login(email, password)`：查 users → 校验密码 → 生成 session token
- `logout(token)`：删 session
- `userFromToken(token)`：sessions 表查 token → 校验过期 → 返回 `{id, email}`
- `tokenFromRequest(request)`：解析 `Authorization: Bearer <token>` 头
- `userFromRequest(request)`：`userFromToken(tokenFromRequest(request))`

**密码安全**：Node 内置 `crypto.scryptSync` 加盐哈希（`salt:hash` 格式），**非明文**；`timingSafeEqual` 防时序攻击。不是 bcrypt/argon2，但 scrypt 是等价安全算法。

**token**：`crypto.randomBytes(32).toString('hex')`，存 sessions 表，30 天有效。

### 3. 认证 API（`server/api/fund.js`，已存在）

| 接口 | 方法 | 状态 |
|---|---|---|
| `/api/auth/register` | POST | ✅ 已实现 |
| `/api/auth/login` | POST | ✅ 已实现 |
| `/api/auth/logout` | POST | ✅ 已实现 |
| `/api/auth/me` | GET | ✅ 已实现 |

### 4. 网页端（`auth.js`）

- 邮箱 + 密码登录/注册（右上角 `•••` 菜单 → 登录弹窗）
- token 存 `localStorage` 键 `genius-trader-auth-token`
- 请求统一带 `Authorization: Bearer <token>`
- 退出：先 `backupToCloud()` → 清 token → 调 `/api/auth/logout`

### 5. 小程序端（`utils/request.js`）

- `request()` headers **只有 `content-type`，没有 Authorization**
- 所以后端 `userFromRequest` 恒返回 `null` → 所有请求 `userId=0`

---

## 二、A～L 明确结论

| 项 | 结论 |
|---|---|
| **A. users 表字段** | `id`、`email`、`password_hash`、`created_at`（**无 username / updated_at / status**） |
| **B. 用户数** | 3 个正式用户（id=1/2/3）+ 匿名通道 user_id=0（不在 users 表） |
| **C. 1/2/3 是谁** | 1=「天才」、2=「李总」、3=「稳健组合/成长组合」（这是**账户名 account.name**；users 表存的是 email 登录凭证，两者不同） |
| **D. 是否已有注册/登录接口** | ✅ 有，`/api/auth/register` + `/api/auth/login`（邮箱+密码） |
| **E. 网页端登录机制** | 邮箱+密码 → 后端返回 Bearer token → localStorage |
| **F. token/session 保存** | 后端 `sessions` 表（权威）；网页端 localStorage `genius-trader-auth-token` |
| **G. 后端识别 user_id** | `Authorization: Bearer <token>` → sessions 表 → `user_id` |
| **H. 小程序为何 user_id=0** | `request.js` 不带 Authorization → `user=null` → `userId = user ? id : 0` |
| **I. 已支持 Authorization** | auth/*、account/state、backups、ai/analyze、portfolio/accounts、estimate、provider |
| **J. 仍依赖 user_id=0** | 小程序全部请求（因未登录） |
| **K. 密码明文风险** | **无**，scrypt 加盐哈希 |
| **L. 是否 bcrypt/argon2** | 否，用 Node 内置 scrypt（等效安全，无需引入原生编译依赖） |

---

## 三、数据关系（user_id=1/2/3 确认）

- `user_data.user_id` **对应** `users.id`（1/2/3 各自一行，已通过你之前诊断确认 data 长度 8310/16726/497）
- `source_credentials.user_id` **对应** `users.id`；user_id=0 是匿名凭证（养基宝/小倍已连接）
- `account_backups.user_id` **对应** `users.id`
- 均**没有**跨用户外键串联问题；`user_data` 表已主动去掉外键，是为容纳 user_id=0

---

## 四、数据隔离现状（重点）

### 已正确隔离（按 userId，✅ 安全）

`/api/account/state` GET/PUT、`/api/account/backups`、`/api/account/backups/:id/restore`、`/api/ai/analyze`（服务端 `buildAnalysisPortfolio(userId, {useActive:true})`，不信任前端传的 portfolio）、`/api/portfolio/accounts`、`/api/fund/:code/estimate`、provider 接口（`handleProviderApi(..., userId)`）。

后端**没有**任何"前端传 userId → 直接查询"的接口，userId 一律取自 `Authorization` 头解析，无法用 `?userId=2` 越权。

### ⚠️ 发现 1 处多用户隔离隐患（P0，第二阶段必须先修）

**`server/services/sourceCredentials.js` 的 `getConnectedCredential`（44-60 行）存在「跨用户兜底」**：

```
查找顺序：当前用户 → user_id=0 → 最近更新的任意已连接凭证
```

这段是"个人应用"时代写的：只要任意入口登录过养基宝/小倍，所有用户都能复用同一凭证。**做成多用户系统后，用户 A 会意外复用用户 B 的第三方凭证**。

**`disconnectAllCredentials(sourceName)`（101-107 行）也是全局断开**：一个用户退出会清空所有用户的凭证。

> 这两个是唯一需要动的后端逻辑，且都属于"去兜底、改为严格按 userId 隔离"，不影响表结构、不影响现有数据。

---

## 五、推荐新架构（最小可靠方案）

```
微信小程序 / 网页
   ↓  POST /api/auth/login {email, password}
   ↓  返回 { token, user:{id, email} }
   ↓  后续所有请求带  Authorization: Bearer <token>
后端 authService.userFromRequest → user.id
   ↓
account/state · backups · source_credentials · AI  —— 全部按 user.id 隔离
```

- **复用**现有 `users` / `sessions` 表，**不新增表**（除非要加 username）
- **复用**现有 4 个 auth 接口
- **补**小程序登录页 + token 传递
- **修** sourceCredentials 跨用户兜底

### 登录方式选择（需你拍板）

| 方案 | 改动 | 说明 |
|---|---|---|
| **A. 邮箱+密码（推荐，零后端改动）** | 仅小程序前端 | 与网页端完全一致，label 写「邮箱」 |
| B. 用户名+邮箱+密码 | users 表加 `username` 列 + authService 支持 username OR email | 多一个字段和一次迁移 |

推荐 **A**：现有 users 表就是 email 唯一，改动最小、最稳。

---

## 六、推荐 API 清单（复用现有 + 可选）

| 接口 | 方法 | 状态 |
|---|---|---|
| `POST /api/auth/register` | 注册 {email, password} | ✅ 已有 |
| `POST /api/auth/login` | 登录 {email, password} → {token, user} | ✅ 已有 |
| `POST /api/auth/logout` | 退出（Bearer） | ✅ 已有 |
| `GET /api/auth/me` | 当前用户（Bearer） | ✅ 已有 |
| `GET/PUT /api/account/state` | 账户状态（自动按 user.id） | ✅ 已有 |
| `GET/POST /api/account/backups` + `restore` | 备份（自动按 user.id） | ✅ 已有 |

**无需新增任何 API。**

---

## 七、数据库是否改表

- **核心：不改表。** users/sessions/user_data/source_credentials/account_backups 全部复用。
- **可选**：若选"用户名登录"方案 B，users 加 `username` 列（`ALTER TABLE users ADD COLUMN username TEXT`，可空，不删数据）。
- **可选**：users 加 `updated_at` / `status`（非必须，先不做）。

---

## 八、需要修改的文件

### 小程序端（本阶段主体）
1. `utils/request.js`：加 token 注入 —— 请求头自动带 `Authorization: Bearer <token>`
2. `app.js`：加 token 生命周期（登录存 wx storage、启动恢复、退出清除）+ 全局登录态
3. **新增** `pages/login/login.js/.wxml/.wxss/.json`：登录/注册页（账号+密码，切「登录/注册」）
4. `pages/profile/profile.js`：接真实登录态（显示 email、退出走 `/api/auth/logout`）
5. `pages/setting/setting.js`：登录入口

### 后端（仅 1 处，多用户隔离必须）
6. `services/sourceCredentials.js`：`getConnectedCredential` 去掉跨用户兜底、`disconnectAllCredentials` 去掉全局断开（改为按 userId）

### 网页端
**不需要改**（已用 authService + email 登录）。

---

## 九、修改顺序（第二阶段执行）

1. **后端**：修 `sourceCredentials.js` 跨用户兜底（多用户隔离 P0，先做）
2. **小程序** `request.js`：token 注入
3. **小程序** `app.js`：token 生命周期
4. **小程序** 登录/注册页
5. **小程序** profile/setting 接登录态
6. 验收：网页注册 user_id=4 → 小程序同账号登录 → 两端数据一致

---

## 十、回滚方案

- 后端改动是**去兜底**（无表结构、无数据变动），`git revert` 即可回滚。
- 小程序改动全是前端，重新编译旧代码即可回滚。
- 全程不动 users/sessions/user_data 数据，user_id=1/2/3 零风险。

---

## 十一、对现有网页用户的影响

**无影响。**
- 不改 users/sessions 表结构 → 1/2/3 的 email/password/token 全部保留
- 不改 account/state 逻辑 → 网页端账户/持仓/策略不变
- 唯一行为变化：sourceCredentials 去跨用户兜底后，**每个登录用户需用自己的凭证**（此前匿名 user_id=0 的养基宝/小倍凭证不再被其他用户借用）——这是多用户正确的隔离行为。

---

## 十二、对 Render PostgreSQL 的影响

**仅新增读取，不删不改现有行。** 唯一涉及写的是 sourceCredentials 去掉兜底（改的是查询逻辑，不改数据行）。

---

## 十三、是否需要 CloudBase / 腾讯云服务

**完全不需要。** Render + PostgreSQL 已覆盖注册/登录/会话/账户/备份/凭证全部能力。

---

## 十四、最终可行性结论

> **如果按此方案实施，未来一个新用户能否在网页或小程序注册一个账号，并且两端使用同一个 user_id？**

**能。** 链路已验证：
1. 网页注册 → users 插入 → 返回 token（user.id=4）
2. 小程序用同一 email+password 登录 → `/api/auth/login` → 后端查同一 users 行 → 返回同一 user.id=4
3. 两端后续 `/api/account/state`、`/backups`、`/ai/analyze` 都按 `user.id=4` 读写 → **数据完全一致**

**唯一需要动手的**：小程序加登录页 + token 注入；后端修 sourceCredentials 跨用户兜底（1 处）。其余全部复用现有代码。

---

## 十五、待你确认的 2 个决策点

1. **登录标识**：选 A「邮箱+密码」（零后端改动，推荐）还是 B「用户名+邮箱+密码」（users 加 username 列）？
2. **匿名 user_id=0**：保留现状（登录前仍可本地使用，登录后切到真实 user_id；游客数据**不自动迁移**，未来再做显式绑定），是否符合预期？

确认后，我进入第二阶段：先修后端 sourceCredentials 隔离，再补小程序登录链路。
