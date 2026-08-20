# Phase 3.8 —— PostgreSQL 迁移与低成本方案评估

> 阶段性质：**静态代码分析 + 只读（受限）盘点 + 方案评估**。
> 红线遵守：未执行任何 INSERT/UPDATE/DELETE/DROP/ALTER；未执行 `importFund`；未调 `refresh=1`/`fast=1`/`estimate`；未改业务代码/数据库结构/环境变量/mp1；未部署；未删除 Render PostgreSQL；未执行任何迁移；未输出任何 Token/密码/连接串/Secret。

---

## 1. 当前数据库架构

```
DATABASE_URL（未设置 → 回退 SQLite；设置 → PostgreSQL）
        │
        ▼
server/database/dbAsync.js   ← 统一异步访问层（业务代码唯一入口）
        ├─ isCloud() = Boolean(process.env.DATABASE_URL)
        ├─ PostgreSQL 模式：new Pool({ connectionString: DATABASE_URL, ssl:{rejectUnauthorized:false}, max:5 })
        └─ SQLite 模式：./server/data/portfolio.sqlite（node:sqlite，DatabaseSync）
        │
        ▼
业务 Service（authService / portfolioService / fundService / sourceCredentials /
accountStateService / estimateService / calibrationEngine / stockHistoryService …）
```

- **入口文件**：`server/database/dbAsync.js`（生产 PG）与 `server/database/db.js`（本地 SQLite 回退）。
- **PG 连接方式**：`pg` 驱动 `Pool`，连接串直接取自 `process.env.DATABASE_URL`，SSL 关闭证书校验（`rejectUnauthorized:false`），连接池上限 5。
- **DATABASE_URL 使用位置**：仅 `dbAsync.js:23`（连接串）+ `isCloud()` 判定。`db.js` 仅在无 `DATABASE_URL` 时作为 SQLite 回退被 `dbAsync` 内部调用。
- **SQLite fallback**：`db.js` 用 `node:sqlite` 的 `DatabaseSync`，仅当 `DATABASE_URL` 未设置时启用，用于本地开发/测试。
- **Schema 初始化方式**：**代码自举**，无 `.sql` / migration 文件。PG 端由 `ensureCloudSchema()`（`dbAsync.js:137`）在应用启动时（`index.js:157 await ensureCloudSchema()`）执行 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，覆盖 11 张表。
- **seed 脚本**：`server/scripts/seedFunds.js`（仅写入基金基础行，非 DB 级备份）。
- **backup / restore 脚本**：**无任何 `pg_dump` / `pg_restore` / dump / 数据库级备份脚本**。`server/services/accountBackupService.js` 仅是「按账户 JSON 快照」写入 `account_backups` / `user_data` 表，**不是数据库级备份**。

### ⚠️ 关键发现：SQLite 与 PG schema 漂移
- `db.js:85` 创建了 `data_sync_state` 表（SQLite 路径）。
- `ensureCloudSchema()`（PG 路径）**未包含 `data_sync_state`**。
- 但 `fundService.js:212/222` 在生产 PG 模式下会 `SELECT/INSERT data_sync_state`。
- 结论：当前生产 PG 之所以可用，是因为该表在更早的 schema 版本/手动创建时已存在。**若在新 PG 上「仅依赖 ensureCloudSchema 自举」而从头建库，会缺 `data_sync_state` 表 → 相关查询报错。**
- 迁移对策：`pg_dump` 会连同该表一并导出，restore 后无碍；但若有人选择「新建空库 + 自举」，必须在 `ensureCloudSchema` 补建该表（详见 §13 迁移步骤）。

---

## 2. 数据库表清单（PG 模式，由 `ensureCloudSchema` 定义）

| 表名 | 核心 | 说明 |
|---|---|---|
| users | ✅ | 邮箱账户（id / email / password_hash） |
| sessions | ✅ | 登录会话（token PK → users.id） |
| user_data | ✅ | 账户状态快照 JSON（按 user_id） |
| portfolio | ✅ | 持仓明细（user_id, account_id, fund_code, shares, cost, amount…） |
| source_credentials | ⚠️ | 第三方同步凭证（token/refresh_token/cookie **AES-256-GCM 加密**） |
| read_tokens | ⚠️ | 只读分享令牌（token_hash） |
| account_backups | ✅ | 账户级 JSON 备份历史 |
| fund | ✅ | 基金基础数据（fund_code PK, name, type, company） |
| fund_nav | ✅ | 基金净值历史（fund_code, date, nav, acc_nav） |
| fund_holdings | ✅ | 前十大持仓（fund_code, stock_code, weight, report_date） |
| fund_estimate |  | 估值缓存（fund_code, trade_date, …） |
| stock_price |  | 个股行情缓存 |
| fund_calibration |  | 估值校准样本 |
| data_sync_state |  | 同步状态标记（**PG 自举缺失，见 §1**） |

---

## 3. 数据量（精确值需在生产环境运行只读脚本）

> 本沙箱 `DATABASE_URL` 未设置，且严禁处理 Secret，故**无法在此直连生产 PostgreSQL 实跑 SELECT**。
> 已生成只读脚本 `server/scripts/phase38_inspect_db.js`（仅 SELECT/元数据，不写库），可在「已设置 DATABASE_URL 的生产/可连环境」运行取得精确行数与库大小。

**基于 Phase 3.6 / 3.7 已确认事实的规模估算：**
- 基金目录：**57 只**（仅 13 只基础数据完整，38 只三项全缺，5 只剩 NAV+history，1 只过期）。
- `fund_nav`：最完整基金（如 000001）约 5986 行；全 57 只即便全部补齐也仅约 30 万行量级。
- 账户数据：天才2.0(17) + 李总(36) 去重 46 只持仓；`portfolio` 行数约数十；`user_data`/`source_credentials`/`sessions` 均为个位数到数十。
- **综合判断：整库体量极小，预计 < 50 MB（含索引）。** 即便最坏情况（57 只基金全量净值）也 < 100 MB。
- 因此：迁移数据量极小，**pg_dump/restore 秒级完成**，对任何候选主机都无压力。

---

## 4. 数据库版本 / 容量 / 表结构（精确值见 §3 脚本）

- **PostgreSQL 版本**：未知（本环境无法查询）。Render 托管 PostgreSQL 支持 13–16，生产实例具体版本需在生产环境 `SELECT version()` 取得。
- **数据库名称 / schema**：`public`（默认 schema，代码中所有表均无 schema 前缀）。
- **表数量**：14（含 `data_sync_state`）。
- **数据库总大小**：见 §3 估算 < 50 MB。

> 以上「精确值」由 `phase38_inspect_db.js` 在生产环境一键取得，非本阶段臆测。

---

## 5. PostgreSQL 特性使用情况（静态扫描结果）

| 特性 | 是否使用 | 位置/说明 |
|---|---|---|
| SERIAL（自增） | ✅ | dbAsync.js 多表 id SERIAL |
| TIMESTAMPTZ | ✅ | 所有时间字段 |
| TEXT / REAL / INTEGER | ✅ | 主流类型 |
| ON CONFLICT … DO UPDATE | ✅ | upsert（sourceCredentials/fundService/estimate 等） |
| RETURNING | ✅ | authService.js:53 注册返回 id |
| REFERENCES … ON DELETE CASCADE | ✅ | fund→fund_nav/holdings/estimate 外键 |
| JSON / JSONB | ❌ | 无；`user_info` 以 TEXT 存 JSON 字符串 |
| ARRAY | ❌ | 无 |
| UUID | ❌ | 无（主键用 SERIAL / TEXT） |
| 扩展（extension） | ❌ | 无 CREATE EXTENSION |
| CTE / 窗口函数 | 未发现强依赖 | 未见 |

**结论：所用特性均为 PostgreSQL 标准语法，无任何厂商独占特性。** 任意 PostgreSQL 兼容主机（Supabase / Neon / Railway / DigitalOcean / 自建 / 甚至保留 Render）**理论上只需修改 `DATABASE_URL` 即可运行，无需改业务代码、无需改 schema（schema 自举）。**

---

## 6. SQLite fallback 分析

- SQLite 路径由 `db.js`（`node:sqlite`）提供，仅当 `DATABASE_URL` 缺失时启用。
- **不推荐作为生产数据库**，原因：
  1. 文件型数据库，无网络并发/连接池，多请求下易锁（`SQLITE_BUSY`）。
  2. 无托管备份/高可用，实例重启/磁盘损坏即丢。
  3. `db.js` 与 `dbAsync.js` 的 DDL 已出现 `data_sync_state` 漂移，双实现长期维护成本高。
  4. 本项目已设计为「生产用 PG、本地用 SQLite 回退」，**SQLite 的定位就是开发/测试缓存，不是生产源**。
- **结论**：生产必须留在 PostgreSQL；SQLite 仅作本地回退。本次迁移目标是换一个 PostgreSQL 主机，而不是退到 SQLite。

---

## 7. SOURCE_SECRET_KEY 专项检查（机密不输出）

- **用在哪里**：`server/utils/crypto.js` —— AES-256-GCM 加解密；密钥 = `SHA-256(process.env.SOURCE_SECRET_KEY)`。
- **哪些数据依赖它**：`source_credentials` 表的 `token` / `refresh_token` / `cookie`（养基宝、小倍养基等第三方同步凭证），均为加密后落库；读取时按当前密钥解密。
- **Render 生产是否通过环境变量注入**：是。`render.yaml:15-16` 以 `generateValue: true` 由 Render **随机生成**并保持为环境变量；`.env.example:12-13` 明确注释「从 Render 迁移必须沿用同一值」。
- **迁移后是否必须保持完全一致**：**是。绝对必须。** 密钥一旦改变，`decryptText` 解出空串 → 所有历史同步凭证无法解密 → 用户必须重新授权养基宝/小倍。
- **Key 改变会影响什么**：天才2.0、李总及其他用户的「同步账户」全部失效，需手动重新连接数据源。
- **是否存在 fallback key**：存在 `DEV_FALLBACK_KEY = 'genius-trader-dev-only-source-secret'`（`crypto.js:11`），仅用于本地开发；生产未设置 `SOURCE_SECRET_KEY` 时会回退到此并打印警告。**生产绝不能依赖它**——它和 Render 生成值不同，用它会解密失败。
- **历史数据无法解密的风险**：**有，且是本次迁移的最大单点风险**（详见 §16）。

> 报告中仅记录「已配置 / 未确认」，**绝不输出真实值**。

---

## 8. 当前备份/恢复能力

- **数据库级备份脚本**：**无**（无 pg_dump / pg_restore / dump / 自动化备份）。
- **应用级备份**：`accountBackupService.js` 提供「按账户 JSON 快照」写入 `account_backups` 表 + `user_data`；这是业务容错，**不能替代数据库级备份**，且它本身也存于该 PostgreSQL 中。
- **结论**：当前**没有任何独立的、可离线保存的数据库备份**。迁移本身（pg_dump → 新库）既是迁移也是首次真正备份，**必须在 2026-09-07 之前完成**。
- **建议（不执行）**：在迁移当天对旧库执行一次 `pg_dump -Fc` 落盘为离线文件，作为救命备份。

---

## 9. 候选数据库方案对比（价格为 2026-08 公开价/估算，实际以供应商当前价格为准）

| 方案 | 月成本(估, USD) | 数据量限制 | PG兼容 | 备份 | 运维 | 稳定性 | 推荐 |
|---|--:|---|---|---|---|---|---|
| **A. 留 Render 付费 PG**（Basic-256MB） | ~$7（1GB 存储） | 1GB | 原生 | 无自动备份(需自建 dump) | 低(同平台) | 中(免费 Web 会暂停) | 备选(零迁移) |
| **B. Neon Free** | **$0** | 0.5GB / 100 CU-h | 原生 | 7天历史(免费档) | 低(改连接串) | 中(空闲暂停,冷启动几百ms) | **推荐(最省)** |
| **B2. Neon Launch(按量)** | ~$1–15 | 可扩 | 原生 | 7天 | 低 | 高(可设最小算力常驻) | **推荐(可靠)** |
| C. Supabase Pro | $25+ | 8GB | 原生 | 7天 | 中(功能冗余) | 高 | 不推荐(贵,功能用不上) |
| D. Railway Hobby | $5 起(实际 ~$10–25) | 按量 | 原生 | 需自管 | 中 | 中(无 HA) | 可选 |
| E. DigitalOcean 托管 PG | $15.15 起(1vCPU/1G/10G) | 10G 起 | 原生 | 每日备份+PITR | 低(扁平定价) | 高 | 推荐(稳定生产) |
| F. VPS 自建(Hetzner CX22 €4.5 / DO Droplet $4–6) | $5–6 | 自管 | 原生 | 自管 | 高(自己运维) | 取决于你 | 可选(最便宜但最累) |

> 汇率参考：1 USD ≈ 7.2 RMB（仅供参考）。所有数字为当前公开价估算，下单前请以供应商官网为准。

---

## 10. 推荐方案

> **推荐方案：B（Neon Serverless PostgreSQL）—— 保留 Render Web 服务不变，仅把其 `DATABASE_URL` 环境变量指向 Neon。**

- **为什么最便宜**：Neon Free 档 **$0/月** 即可满足（数据量 < 50MB ≪ 0.5GB 限制；低频访问，冷启动几百 ms 对 personal 小程序可接受）。若担心免费档暂停/额度，升级 Launch 按量约 **$1–15/月**，仍可设最小算力常驻消除冷启动。
- **为什么适合当前项目**：项目只依赖一个 PostgreSQL 连接串，Neon 是原生 PG，连接串直接替换即可；后端（Render Web）与小程序（mp1）**零改动**。
- **为什么风险可控**：PostgreSQL 标准语法，无厂商锁定；`pg_dump` 全量迁移秒级；可随时换主机。
- **月成本**：**$0（Free）~ $15（Launch 常用区间）**。远低于 Supabase Pro $25 与 Render 整包。
- **零迁移工程量**：仅改一个环境变量 + 一次 pg_dump/restore。

**备选（零改动最省心）**：方案 A —— 直接在 Render 把免费 PG 升级为付费 Basic-256MB（~$7/月），连 `DATABASE_URL` 域名都不用换，最省事，但仍在 Render 体系内。
**稳定生产备选**：方案 E —— DigitalOcean 托管 PG（$15.15/月起，扁平定价、每日备份+PITR），适合想要「设完忘掉」的长期稳定。

---

## 11. 预计成本

- **最经济路径（Neon Free）**：**$0/月**（≈ ¥0）。
- **带可靠性（Neon Launch 或 DO $15）**：**$15/月**（≈ ¥108）。
- **留在 Render 付费 PG**：**$7/月**（≈ ¥50）+ 若 Web 也需常驻再 +$7。
- **一次性迁移成本**：几乎为 0（数据量极小，人工 1–2 小时）。
- 对比：Supabase Pro $25/月（≈ ¥180）性价比最低（大量功能用不上）。

---

## 12. 迁移工程量

针对推荐方案（B：Render Web 不变 + Neon PG）：

| 项目 | 是否需改 | 说明 |
|---|---|---|
| 业务代码（fundService/marketService 等） | ❌ 否 | 仅依赖 DATABASE_URL，PG 标准语法 |
| 数据库结构（schema） | ❌ 否（自举） | ensureCloudSchema 自动建表；但需确保 `data_sync_state` 随 pg_dump 带入 |
| mp1 小程序代码 | ❌ 否 | 仅访问 `genius-trader.onrender.com`，后端主机不变则无需改 |
| 环境变量 | ✅ 是 | 仅改 Render 上 `DATABASE_URL` 一个值 |
| 重新导入基金数据 | ❌ 否 | pg_dump 已含 fund/fund_nav/fund_holdings |
| 重新登录 | ❌ 否 | users/sessions 随库迁移 |
| Token 重新生成 | ❌ 否 | 会话令牌随之迁移 |
| SOURCE_SECRET_KEY | ✅ 必须「保持不变」 | 沿用 Render 原值，绝不重新生成 |

**预计修改文件数：0 个业务文件；仅 1 个环境变量。** 工程量极小。

---

## 13. 迁移步骤（仅规划，本阶段不执行）

```text
旧 Render PostgreSQL
   ↓ ① 先在 Render 控制台「复制并离线保存」当前 SOURCE_SECRET_KEY 值（最关键！）
   ↓ ② pg_dump -Fc 旧库 → backup.pre20260907.dump（离线救命备份）
   ↓ ③ 在 Neon 新建项目，取得新连接串
   ↓ ④ pg_restore 到新库（含 data_sync_state 等全部表）
   ↓ ⑤ 只读校验：运行 phase38_inspect_db.js 比对行数/大小
   ↓ ⑥ 在 Render 控制台把 DATABASE_URL 改为 Neon 连接串（保持 SOURCE_SECRET_KEY 不变）
   ↓ ⑦ 重新部署 Render Web（或等其自动拉取环境变量）
   ↓ ⑧ API 验证：/api/health、/api/funds、登录、同步账户读取
   ↓ ⑨ 小程序验证：mp1 登录/持仓/详情页
   ↓ ⑩ 稳定观察 24–48h
```

**必须补的一处代码健壮化（迁移后建议，非本阶段执行）**：在 `ensureCloudSchema()` 末尾补建
`CREATE TABLE IF NOT EXISTS data_sync_state (...)`（与 `db.js:85` 对齐），防止将来「新建空库 + 自举」时缺表。本次因走 pg_dump/restore，该表会随数据带入，不影响本次迁移。

---

## 14. 回滚方案

- 回滚极简：**把 Render 的 `DATABASE_URL` 指回旧 Render PG**（在 2026-09-07 删除前）即可。
- 若旧库已被删：用步骤②的 `backup.pre20260907.dump` 在任意 PG 上 `pg_restore` 即可恢复。
- 数据层面无破坏性操作（dump/restore 是只读导出 + 写入新库），旧库保持原样直到确认新库稳定。

---

## 15. 用户数据保护方案

迁移以 **整库 pg_dump/restore** 为单位，天然保证以下全部随库搬移、不被破坏：

- **天才2.0（user_id=1）**：身份(users)、账户(user_data)、17 只基金持仓(portfolio)、收益、同步状态(source_credentials) —— 全部在库内。
- **李总（user_id=2）**：同上，36 只基金持仓。
- **其他用户（含 user_id=0 guest / user_id=3 稳健·成长组合）**：users / sessions / user_data / source_credentials / read_tokens / account_backups 一并迁移，不因迁移丢失。
- **特别保护项**：`SOURCE_SECRET_KEY` 必须原值注入新环境，否则上述所有 `source_credentials` 解密失败（见 §7、§16）。

---

## 16. Render 2026-09-07 到期风险

- Render 免费 PostgreSQL 将于 **2026-09-07 暂停**，之后进入删除流程（免费档无 Grace、无自动迁移）。
- **双重风险叠加**：
  1. **数据丢失风险**：若不在此之前 `pg_dump`，整库（含全部用户账户/持仓/同步凭证/基金历史）**永久不可恢复**。
  2. **密钥丢失风险（更隐蔽、更致命）**：`SOURCE_SECRET_KEY` 由 Render 生成并仅存于其环境变量。若届时连 Render 环境变量都无法查看（或服务被停），该密钥随库/服务消失 → 即便数据迁走，**所有加密的同步凭证也无法解密**，等于同步功能清零。
- **应对（时间线）**：
  - **现在（立即）**：登录 Render 控制台，复制并记录当前 `SOURCE_SECRET_KEY` 真实值到离线安全位置（密码管理器）。**这是第一优先级，比数据 dump 更紧急。**
  - **2026-09-07 前**：完成 pg_dump 离线备份 + 迁移到新 PG。
  - 不要等到最后一刻——Render 可能在到期前就对免费实例限流/只读。

---

## 17. 最终建议

1. **立刻离线保存 `SOURCE_SECRET_KEY`**（Render 环境变量），这是防「同步凭证全灭」的唯一保险。
2. **推荐迁移到 Neon Free/Launch PostgreSQL**，保留 Render Web 服务不变，仅改 `DATABASE_URL`：成本 **$0–15/月**，零业务代码改动，mp1 不变，工程量极小。
3. **2026-09-07 前**完成 `pg_dump` 离线备份 + 迁移；不要依赖免费档自动保留。
4. **迁移后**用 `phase38_inspect_db.js` 只读校验行数/大小，并补建 `data_sync_state` 到 `ensureCloudSchema` 以防未来建空库缺表。
5. **不推荐** Supabase Pro（$25 功能冗余）、不推荐退到 SQLite（非生产级）。
6. 本阶段**仅评估**，未执行任何迁移/写操作。下一步（执行迁移）需你确认并先在 Render 控制台保全密钥后，再按 §13 步骤操作。

---

## 红线最终确认（本阶段）

> **本阶段仅进行了静态分析和只读（受限）查询。**
> **未修改生产数据库。**
> **未执行 importFund。**
> **未修改用户数据。**
> **未修改 SOURCE_SECRET_KEY。**
> **未修改环境变量。**
> **未部署。**
> **未删除 Render PostgreSQL。**
> **未执行数据库迁移。**

---

**总进度：93%｜目标：小程序可用**

> 说明：本阶段为数据库迁移评估，不代表已完成迁移。真正完成数据库迁移并通过数据完整性验证（phase38_inspect_db.js 只读校验 + mp1 联调）后，再重新计算进度。
