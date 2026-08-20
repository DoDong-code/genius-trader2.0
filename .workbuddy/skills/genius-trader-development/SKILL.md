---
name: genius-trader-development
description: |
  Genius Trader（天才交易员）项目的默认开发规范与唯一后端架构约束。本项目后续开发必须先加载本 Skill。
  专门负责本项目的后端、网页端、微信小程序开发、架构重构、数据迁移、部署和验收。

  触发场景（遇到任一即必须加载本 Skill）：
  - Genius Trader / 天才交易员 项目的后端、网页端、微信小程序开发
  - 架构重构、数据迁移、部署、验收
  - 涉及 users / sessions / user_data / source_credentials / account_backups 的任何改动
  - 多用户数据隔离、user_id=0 游客规则、Authorization Token、登录/注册/退出
  - account/state、账户备份、第三方数据源（养基宝/小倍养基）凭证
  - Git / GitHub / Render 部署、数据库迁移、敏感信息处理
  - 禁止重新引入 CloudBase / wx.cloud 的场景
agent_created: true
---

# genius-trader-development

> Genius Trader / 天才交易员 项目的默认开发规范。本项目后续开发必须默认加载本 Skill，作为最高优先级的开发约束。

---

## 一、项目架构

- **项目名称**：Genius Trader / 天才交易员
- **核心仓库**：`DoDong-code/genius-trader2.0`
- **生产后端**：`https://genius-trader.onrender.com`
- **生产数据库**：Render PostgreSQL
- **后端**：Node.js
- **启动**：`node server/index.js`
- **Render**：GitHub main → Render 自动部署
- **小程序**：微信小程序 `mp1`
- **小程序部署**：微信开发者工具手动编译 / 上传体验版

> 禁止把小程序部署流程与 Render Git 部署混淆。

---

## 二、核心架构原则

- **唯一后端**：Render
- **唯一生产数据库**：PostgreSQL
- **禁止重新引入**：CloudBase、wx.cloud、wx.cloud.database、wx.cloud.callContainer、CloudBase 云托管
- **禁止**为了功能简单而重新建立第二套数据库
- **禁止**出现「小程序 → CloudBase、网页 → Render」这种双后端结构

所有正式用户数据统一：

```
客户端 → Render API → PostgreSQL
```

---

## 三、用户体系

`users` 表已存在：

- id
- email
- password_hash
- created_at

`sessions` 表已存在：

- token
- user_id
- expires_at

现有用户（**数据禁止删除、覆盖、合并、迁移、修改 user_id**，除非用户明确要求）：

| user_id | 网页账号 |
|---------|----------|
| 1 | 天才 |
| 2 | 李总 |
| 3 | 稳健组合 / 成长组合 |

---

## 四、游客体系

- `user_id=0`：专门代表未登录游客
- 未登录：没有 Authorization → 后端 `userId = 0`
- 登录后：`Authorization: Bearer <token>` → 后端 `userId = req.user.id`

**绝对禁止前端传 userId / user_id / query.userId / body.userId**。

用户身份必须由：

```
Authorization Token → sessions → req.user.id
```

确定。

---

## 五、账户数据

核心接口：

- `GET /api/account/state`
- `PUT /api/account/state`

- 正式用户：`user_id = req.user.id`
- 游客：`user_id = 0`

账户数据必须严格隔离。例如：

- 天才 → `user_id=1`
- 李总 → `user_id=2`

绝对不能：`user_id=1` 读取 `user_id=2`。

---

## 六、source_credentials

`source_credentials` 必须严格按 `userId` 隔离。

- 允许：`WHERE user_id = ?`
- 禁止：`user_id=0` fallback
- 禁止：最近任意用户 credential
- 禁止：全局最近 credential
- 禁止：跨用户 credential fallback

尤其是养基宝、小倍养基，必须属于当前用户。

任何新函数都必须明确接收 `userId`，并在 SQL 中使用 `WHERE user_id = ?`。

---

## 七、account_backups

账户备份必须严格按 `user_id` 隔离。

- 用户 A：只能看到 A 的 backups
- 用户 B：只能看到 B 的 backups

禁止全局备份列表。禁止根据 backup id 直接恢复而不验证 user_id。

恢复必须：`WHERE id=? AND user_id=?`。

---

## 八、Token

- 小程序 token：`genius-trader-auth-token`
- 密码：绝对禁止保存

Token 统一由 `utils/request.js` 管理，包括：

- `getAuthToken()`
- `setAuthToken()`
- `clearAuthToken()`

所有 API 请求由 `request.js` 统一自动注入 `Authorization: Bearer <token>`。页面代码禁止自己拼 Authorization。

---

## 九、401

`request.js` 统一处理 401。

正常 API 401：

- 清除 token
- 清除 `app.globalData.auth`

但**绝对不能删除 `genius-trader-portfolio-v2`**，不能删除用户本地账户，不能无限重试。

登录 / 注册接口的 401：作为登录/注册失败处理。

---

## 十、登录 / 注册

当前采用：邮箱 + 密码。

不使用：用户名、微信授权、CloudBase、腾讯云身份认证。

现有接口：

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

注册成功 / 登录成功：保存 token，然后 `GET /api/auth/me` 建立 `app.globalData.auth`。

---

## 十一、微信绑定规划

微信登录不是当前阶段默认实现。未来第三阶段才允许做：

```
微信身份 → 绑定现有 users.id → 同一个 user_id
```

目标：

- 网页账号 `user_id=1` 绑定微信 → 微信 identity → `user_id=1`
- 以后微信登录 → `user_id=1`；网页登录（邮箱+密码）→ `user_id=1`
- 两端共享 account/state、source_credentials、backups、AI 数据

禁止重新建立第二套微信用户数据库。

微信绑定必须采用 `identity → existing user_id`，而不是「微信登录 → 新建重复用户」。

---

## 十二、本地账户

- 小程序本地缓存：`genius-trader-portfolio-v2`
- 游客可以拥有本地账户
- 登录后正式用户使用 `/api/account/state`
- 游客数据不自动迁移到正式用户

除非用户明确要求，否则禁止自动合并游客数据。

---

## 十三、缓存原则

本地缓存只能作为客户端缓存 / 离线数据，不能作为正式用户唯一数据源。

正式用户：PostgreSQL 是最终数据源。

本地缓存 vs 服务器数据冲突时，必须根据明确的 updatedAt / 版本规则处理。禁止简单「本地覆盖服务器」或「服务器无条件覆盖本地」。

---

## 十四、数据安全原则

任何开发任务开始前：先扫描。

- 涉及数据库的任务：先只读检查
- 涉及迁移：先备份
- 禁止直接 `UPDATE` / `DELETE` / `DROP` / `ALTER`（除非用户明确批准）
- 尤其禁止修改 `user_id=1/2/3`

没有用户明确授权，不得：删除数据、迁移数据、合并账号、修改数据库结构。

---

## 十五、Debug 接口

Debug 接口必须：只读、脱敏、需要 `DEBUG_KEY`。

例如：`/api/debug/database`、`/api/debug/account-summary`。

禁止返回：密码、token、credential 原文、完整用户 data。

只能返回：count、user_id、长度、时间、账户名称摘要、连接状态。

任何 debug API 禁止成为生产数据修改入口。

---

## 十六、敏感信息

绝对禁止：

- 把 API Key 写进代码
- 把 DEBUG_KEY 写进代码
- 把 DATABASE_URL 写进代码
- 提交 `.env`
- 输出 `password_hash`
- 输出 `source_credentials.token`
- 把用户 Token 写进日志

发现敏感信息：立即停止任务。

---

## 十七、代码修改流程

所有较大的任务：

1. **第一阶段**：只读扫描
2. **第二阶段**：输出当前架构、影响范围、修改文件、数据库影响、风险、回滚方式
3. **第三阶段**：实施
4. **第四阶段**：语法检查
5. **第五阶段**：只读验证
6. **第六阶段**：用户确认

禁止扫描完直接大规模修改。

---

## 十八、Git 规则

后端：

```
GitHub main → Render 自动部署
```

后端修改必须：明确 `git diff` → 确认范围 → commit → push → Render 自动部署。

小程序：当前不作为 Git 部署系统。微信开发者工具：编译 → 预览 → 体验版。

不要因为小程序 Git 工作区有历史改动而随意 `git add .` / `git commit` / `git push`，除非用户明确要求整理小程序 Git。

---

## 十九、Render 规则

- Render：GitHub main 自动部署
- 部署前：确认 commit、确认 diff、确认数据库风险
- 部署后检查 `/api/health`：必须 HTTP 200，并确认 `database = postgres`
- 涉及数据库必须额外检查数据数量
- Render 免费实例存在冷启动，不能把 30 秒左右启动误判为数据库故障

---

## 二十、数据库迁移原则

任何数据库迁移：

1. 只读检查
2. 数据快照
3. 迁移脚本
4. 执行
5. 数据数量对比
6. 业务接口验证

禁止为了测试直接修改生产数据库。

---

## 二十一、测试优先级

多用户功能必须至少测试：

```
游客 → 注册 → 登录 → account/state → 退出 → 重新登录
```

然后用户 A、用户 B 互相验证：

- 账户不能串
- credential 不能串
- backup 不能串
- AI 数据不能串

---

## 二十二、禁止架构倒退

任何新功能都不能重新引入：

- CloudBase
- wx.cloud
- 第二数据库
- 第二用户体系
- 前端 userId
- 全局 credential
- 全局账户
- 全局 backup

如果新需求看起来需要这些东西：先停下来解释原因。

---

## 二十三、最终产品目标

最终产品：网页 + 微信小程序，共享：

- 同一个用户体系
- 同一个 user_id
- 同一个 PostgreSQL
- 同一套账户数据
- 同一套策略
- 同一套基金数据
- 同一套 AI 分析
- 同一套 credential
- 同一套备份

最终用户体验：

1. 第一次：邮箱注册 → 账号建立 → 绑定微信
2. 以后：网页邮箱登录、小程序微信登录 → 同一个 user_id

---

## 二十四、每次任务最终报告

每次开发完成后必须输出：

1. 修改文件
2. 新增文件
3. 删除文件
4. API 修改
5. 数据库修改
6. 数据是否变化
7. 用户隔离影响
8. CloudBase 是否涉及
9. Render 是否涉及
10. Git 是否 commit
11. Git 是否 push
12. 是否部署
13. 测试结果
14. 已知问题
15. 下一步建议

---

## 二十五、最高优先级原则

- 正确性 > 快速修改
- 数据安全 > 功能速度
- 用户隔离 > 便利性
- 单一数据源 > 临时 workaround
- 可回滚 > 大规模一次性修改

如果：

- 不确定 → 不要猜，先扫描
- 涉及生产数据 → 先只读
- 涉及用户身份 → 先验证 user_id
- 涉及数据库 → 先备份
- 涉及大规模重构 → 先输出设计，再实施
- 用户没有明确要求 → 不要自动 push、不要自动部署、不要自动迁移、不要删除数据

---

## 附：开发任务风险等级（L0–L5）

| 等级 | 性质 | 示例 | 处理要求 |
|------|------|------|----------|
| L0 | 只读扫描 | 查看代码、查接口、读表结构 | 无副作用，可直接执行 |
| L1 | 前端代码修改 | 小程序 / 网页 UI、逻辑 | 语法检查 + 只读验证 |
| L2 | 后端代码修改 | 路由、service（不改表结构） | 明确 diff + 语法检查 + 只读验证 |
| L3 | 数据库结构变更 | 加表、加列、迁移脚本 | 先只读 + 数据快照 + 用户确认 |
| L4 | 生产数据变更 | UPDATE / DELETE / 迁移用户数据 | 先备份 + 用户明确批准 |
| L5 | 破坏性操作 | DROP、跨用户合并、改 user_id=1/2/3 | 禁止（除非用户书面明确授权） |
