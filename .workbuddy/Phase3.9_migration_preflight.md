# Phase 3.9 —— PostgreSQL 迁移前安全准备与容量实测（只读评估，未执行迁移）

> 阶段性质：**准备与评估**，不是执行。全程零生产写入。
> 红线遵守：未执行 pg_dump、未创建 Neon、未改 DATABASE_URL、未部署、未迁移、未改 GitHub、未改任何生产数据、未读取/输出/保存任何 Secret 真实值。

---

## 一、本阶段所做（方法论）

1. 读取并核对 `server/scripts/phase38_inspect_db.js` —— 确认其为纯只读（仅 SELECT / 元数据，无 INSERT/UPDATE/DELETE/DROP/ALTER），且不打印任何凭据/敏感字段。
2. **增强**该脚本：新增「预计 dump 大小」估算（`pg_database_size` 字节数 × 25%，区间 15%–40%）。
3. 检查 `pg_dump` / `pg_restore` / `psql` 能力 —— 项目内无备份脚本；本机/沙箱 PATH 上不存在这些二进制。
4. `SOURCE_SECRET_KEY` 依赖静态核查（仅确认依赖关系，**绝不读取/输出/保存真实值**）。
5. 核实 Neon 2026-08 官方价格（neon.com/pricing，含第三方交叉验证）。
6. 评估 Neon 与本项目的适配性。

---

## 二、容量实测（精确值待补）

> ⚠️ **本沙箱 `DATABASE_URL` 未设置，且无生产凭据、红线禁止处理 Secret，故无法在此直连生产库。**
> 以下精确值需在你拥有 `DATABASE_URL` 的环境运行 `node server/scripts/phase38_inspect_db.js` 取得（脚本只连库、只打印元数据，不打印凭据）。

### 待补值（运行脚本后填充）

| 项目 | 值 |
|---|---|
| PostgreSQL 精确版本 | 待补（如 PostgreSQL 15.x） |
| 数据库精确大小（在库） | 待补 |
| 预计 dump 大小（pg_dump -Fc） | 待补（脚本自动估算 ≈ 在库 × 25%） |
| 核心数据规模 | users / sessions / user_data / portfolio / source_credentials / fund / fund_nav / fund_holdings + read_tokens / account_backups |

### 各表行数 / 大小（待补，运行脚本取得）

| 表名 | 行数 | 在库大小 | 核心 | 状态 |
|---|---:|---:|---|---|
| users | 待补 | 待补 | ✅ | |
| sessions | 待补 | 待补 | ✅ | |
| user_data | 待补 | 待补 | ✅ | |
| portfolio | 待补 | 待补 | ✅ | |
| source_credentials | 待补 | 待补 | ⚠️ | 含 AES 密文 |
| read_tokens | 待补 | 待补 | ⚠️ | |
| account_backups | 待补 | 待补 | ✅ | |
| fund | 待补 | 待补 | ✅ | |
| fund_nav | 待补 | 待补 | ✅ | 历史净值（量级最大） |
| fund_holdings | 待补 | 待补 | ✅ | 前十大 |
| fund_estimate | 待补 | 待补 | | 缓存 |
| stock_price | 待补 | 待补 | | 缓存 |
| fund_calibration | 待补 | 待补 | | 缓存 |
| data_sync_state | 待补 | 待补 | ⚠️ | PG 自举缺失（见 3.8 漂移告警） |

**估算口径**：整库 < 50 MB（57 基金 + 少量用户/账户；fund_nav 历史行为量级最大）。故 dump 文件预计 < 15 MB（压缩后），秒级备份/恢复。

---

## 三、pg_dump / pg_restore 能力检查

| 项 | 结论 |
|---|---|
| 项目内备份脚本 | ❌ 无。仅有 `accountBackupService.js`（账户 JSON 快照，仍落在**同一 PG 内**，非库级备份、非迁移工具）。 |
| 本机/沙箱 PATH 上 `pg_dump` | ❌ 不存在 |
| `pg_restore` / `psql` | ❌ 均不存在 |
| 项目数据库驱动 | ✅ `pg` npm 驱动 v8.23.0（仅运行时连接用，**不含** pg_dump 二进制） |

**结论**：执行正式 `pg_dump` 前，**必须在操作机器安装 PostgreSQL 客户端工具**（含 pg_dump/pg_restore/psql）：
- Windows：从 https://www.postgresql.org/download/windows/ 安装，或单独取 EDB `psql` 包。
- macOS：`brew install libpq`（或 `brew install postgresql`）。
- Linux：`apt install postgresql-client`。

> 重要澄清：`pg_dump` 是逻辑导出，导出的是**表中已落库的密文**（source_credentials 的 token 等仍 AES-256-GCM 加密），并非明文密钥/Token。但文件敏感，须离线加密保管；且**解密依赖 `SOURCE_SECRET_KEY`（不在库内）**，故「完整备份 = 本地 dump 文件 + SOURCE_SECRET_KEY 真实值」两者缺一不可——这进一步说明密钥保全比数据 dump 更紧急。

---

## 四、SOURCE_SECRET_KEY 风险确认（不读/不输出/不保存真实值）

| 检查项 | 结论 |
|---|---|
| 用在哪里 | `server/utils/crypto.js`（AES-256-GCM，密钥 = SHA256(SOURCE_SECRET_KEY)）；`server/services/sourceCredentials.js`（token / refresh_token / cookie 加密落库） |
| 哪些数据依赖它 | `source_credentials` 表三字段：token、refresh_token、cookie（全部密文，依赖该密钥解密） |
| Render 是否环境变量注入 | 是。`render.yaml:15-16` 由 Render `generateValue: true` **随机生成**；生产环境经环境变量注入，无 dotenv 文件 |
| 迁移后是否必须保持完全一致 | ✅ 必须。密钥变更/丢失 → 所有加密同步凭证无法解密 → 养基宝/小倍同步功能清零 |
| Key 改变影响 | 历史同步账户（天才2.0/李总等）的 OAuth 凭证全部失效，需用户重新授权（不可自动恢复） |
| 是否存在 fallback key | ⚠️ `crypto.js` 有 `DEV_FALLBACK_KEY`（仅当未设 env 时启用，**生产不应触发**）。**不存在**能解密「用生产密钥加密数据」的备用密钥 |
| 风险等级 | 🔴 **最高**（比数据丢失更致命：基金数据可重新 importFund，但用户 OAuth 凭证无法重新生成，需人工重新授权） |

**红线声明**：本阶段未读取、未输出、未保存该密钥任何真实值。该值须由你在 Render 控制台**离线**复制保全（与 dump 文件分开存放）。

---

## 五、Neon 当前官方价格（2026-08，仅供参考，实际以 neon.com/pricing 为准）

| 方案 | 月费 | 存储 | 计算 | 关键限制 / 特点 |
|---|---:|---|---|---|
| **Free** | **$0** | 0.5 GB/项目 | 100 CU-hr/月，自动缩容到 0（空闲 5 分钟暂停） | 无信用卡；100 项目/账号；6 小时 PITR；5 GB 出网 |
| **Launch** | 按量，无最低消费（2025-12 起取消最低） | $0.35/GB-月 | $0.106/CU-hr，最高 16 CU | 7 天 PITR；500 GB 出网；典型 ~$15/月（间歇负载 1 GB） |
| **Scale** | 按量 | $0.35/GB-月 | $0.222/CU-hr，最高 56 CU | 30 天 PITR；SLA/HIPAA/SOC2；典型 ~$701/月（高负载 100 GB） |

- 1 CU ≈ 1 vCPU + 4 GB RAM。
- 换算 RMB（1 ≈ ¥7.2）：Free = ¥0；Launch 低流量约 **¥1–15/月**；最差约 ¥108/月。

---

## 六、Neon 适配性评估

**结论：✅ 适合（强烈推荐 Free → Launch）**

| 评估维度 | 结果 |
|---|---|
| PostgreSQL 兼容 | ✅ 完全线协议兼容；本项目 SQL 仅 SERIAL / TIMESTAMPTZ / ON CONFLICT / RETURNING / 外键，**无 JSONB/ARRAY/UUID/扩展** → 零业务代码改动 |
| 数据量 | ✅ < 50 MB，远小于 Free 0.5 GB 上限 |
| 流量 | ✅ 个人基金小程序，间歇访问；100 CU-hr/月足够；缩容到 0 后首查冷启动数百毫秒，可接受 |
| 迁移工程量 | ✅ 仅改 `DATABASE_URL` 一处；后端主机不变 → mp1 不变 |
| 三重保险 | ✅ 可先 pg_dump 到本地，再 restore 到 Neon，原库保留至确认稳定 |

**注意事项**：
- Free 计算超过 100 CU-hr/月会暂停计算至下个计费周期；个人低频不会触顶，但建议在 Neon 控制台设消费告警，必要时升 Launch。
- **无中国大陆区域**（AWS `ap-southeast-1` 新加坡最近），与 Render 现状一致，延迟可接受。
- Free 仅 6 小时 PITR；生产建议 Launch 的 7 天 PITR。

---

## 七、迁移前必须准备（硬前提）

| # | 前置项 | 责任方 | 本阶段状态 |
|---|---|---|---|
| 1 | ⛔ **SOURCE_SECRET_KEY 真实值离线保全**（Render 控制台复制，与 dump 分离保管） | 用户 | 未做（最高优先） |
| 2 | 在操作机器安装 PostgreSQL 客户端（pg_dump/pg_restore/psql） | 用户 | 未装 |
| 3 | 取得旧库 `DATABASE_URL`（Render 控制台，备份用；不落地明文） | 用户 | 未取 |
| 4 | 在 Neon 注册并新建 project（Free 即可），取得新连接串 | 用户 | 未创建（本阶段禁止） |
| 5 | 运行 `phase38_inspect_db.js` 取得精确版本/大小/行数/预计 dump | 用户+脚本 | 脚本就绪，未跑 |
| 6 | 准备本地备份目录（空间 > 预计 dump 大小） | 用户 | — |
| 7 | 准备备份完整性校验（pg_restore --list 或临时库试跑） | 见备份方案 | 已规划 |
| 8 | 准备回滚方案（改回 DATABASE_URL 或 restore dump） | 见备份方案 | 已规划 |
| 9 | 确认账户快照不受影响（user_data 含快照、fund_nav/holdings 公共层，均随库迁移；mp1 不变） | 已确认 | ✅ |
| 10 | 准备迁移后只读校验（重跑 inspect + 关键表行数比对 + API/小程序联调） | 见备份方案 | 已规划 |

---

## 八、是否具备进入正式迁移的条件

- **方案与工具层面**：✅ 已具备。脚本就绪、备份方案就绪（见 `Phase3.9_backup_plan.md`）、Neon 适配确认、零代码改动确认、回滚方案就绪。
- **用户侧硬前提**：⛔ 3 项未执行 = ① SOURCE_SECRET_KEY 真实值保全；② 安装 pg_dump；③ 取得两端连接串。
- **结论**：**方法学条件已满足，物理前提未就绪。** 在 ①②③ 完成前，不得执行任何迁移。本阶段仅完成「准备与评估」，未执行迁移、未动生产库。

---

## 九、红线最终确认

> 本阶段仅进行了静态分析和只读（受限）查询。
> 未修改生产数据库。
> 未执行 importFund。
> 未执行 pg_dump / pg_restore。
> 未创建 Neon 数据库。
> 未修改用户数据。
> 未修改 SOURCE_SECRET_KEY（亦未读取/输出/保存真实值）。
> 未修改环境变量 / DATABASE_URL。
> 未部署。
> 未删除 Render PostgreSQL。
> 未执行数据库迁移。
> 未修改 GitHub。

---

## 十、进度

**总进度：94%｜目标：小程序可用**

（本阶段为迁移前准备与评估，不代表已完成迁移。真正完成迁移 + 通过只读校验 + mp1 联调后，再重算进度。）
