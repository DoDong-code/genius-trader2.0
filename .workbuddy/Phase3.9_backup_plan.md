# Phase 3.9 —— 正式备份操作方案（pg_dump 离线备份）

> 目标：在 Render 免费 PostgreSQL 于 **2026-09-07** 暂停/删除前，建立 **「原库 + 本地完整备份 + 新库」三重保险**，避免拿生产库玩俄罗斯轮盘。
> 本文件为操作手册；**本阶段不执行其中任何命令**，仅规划。执行将在你授权后的「Phase 3.10 迁移执行」阶段进行。

---

## 红线（本方案遵守）

- 不修改生产数据（仅只读导出）
- 不修改 `DATABASE_URL`（本方案只备份，不改指向）
- 不在本阶段创建 Neon 库（由你在 Neon 控制台自行创建）
- 不部署、不迁移、不修改 GitHub
- 不输出任何连接串 / Token / 密钥真实值到文件或对话
- 备份文件含 `source_credentials` 密文，须离线加密保管；**解密依赖 SOURCE_SECRET_KEY（不在库内），须另行保全**

---

## 前置条件（执行备份前必须完成）

1. 在操作机器安装 PostgreSQL 客户端（提供 `pg_dump` / `pg_restore` / `psql`）。
   - Windows：https://www.postgresql.org/download/windows/ 或 EDB `psql` 包
   - macOS：`brew install libpq`
   - Linux：`sudo apt install postgresql-client`
2. 从 Render 控制台取得旧库 `DATABASE_URL`（仅用于备份/只读，后续通过环境变量传入，不写进脚本源码）。
3. 准备本地备份目录，确保磁盘空闲 > 预计 dump 大小（当前估算 < 15 MB，留 100 MB 余量即可）。
4. **已离线保全 `SOURCE_SECRET_KEY` 真实值**（与备份文件分开存放——缺一不可）。

---

## 步骤一：取得连接串（用户操作，本阶段不执行）

- 登录 Render → 你的 Web 服务 → Environment → 复制 `DATABASE_URL`。
- 仅在后续命令通过**环境变量**传入，不写进任何文件/脚本源码、不出现在对话。

---

## 步骤二：执行 pg_dump（离线、逻辑备份）

```bash
# 用环境变量传入连接串，避免明文出现在命令行历史/脚本
export OLD_DB_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME"

mkdir -p "$HOME/Desktop/备份"
DUMP="$HOME/Desktop/备份/genius-trader-pg-$(date +%Y%m%d).dump"

pg_dump -Fc --no-owner --no-acl "$OLD_DB_URL" -f "$DUMP"
echo "dump size:"; ls -lh "$DUMP"
```

说明：
- `-Fc` 自定义格式：压缩、可并行恢复、支持 `pg_restore --list`。
- `--no-owner --no-acl`：避免恢复时因角色/权限差异报错。
- 导出的是**密文**（token 等仍 AES 加密），不是明文密钥；文件敏感，须加密存储/离线保管。
- 备份**不含** `SOURCE_SECRET_KEY`（它在环境变量，不在库内）→ 必须另外保全密钥。

---

## 步骤三：校验备份完整性（任选其一）

```bash
# 方式 A：列出备份内容（不真正恢复），确认表齐全
pg_restore --list "$DUMP" | head -40

# 方式 B（推荐）：恢复到临时空库试跑，验证可恢复性
createdb temp_restore_test
pg_restore -Fc --no-owner --no-acl -d temp_restore_test "$DUMP"
psql temp_restore_test -c "SELECT count(*) FROM fund_nav;"
psql temp_restore_test -c "SELECT count(*) FROM source_credentials;"
dropdb temp_restore_test
```

---

## 步骤四：密钥与备份分离保管

- **备份文件**：离线/加密盘，标注日期（如 `genius-trader-pg-202608xx.dump`）。
- **SOURCE_SECRET_KEY**：独立离线密码管理器（不可与 dump 放同一明文处）。
- 两者齐全 = 完整可恢复备份。

---

## 步骤五：回滚 / 恢复（仅在迁移出问题时执行，本阶段不执行）

```bash
export NEW_DB_URL="<Neon 连接串>"
pg_restore -Fc --no-owner --no-acl --clean --if-exists -d "$NEW_DB_URL" "$DUMP"
```

> ⚠️ 恢复后必须在目标环境（Render 或 Neon）的环境变量中**保持/填入原 SOURCE_SECRET_KEY**，否则同步凭证无法解密。

---

## 三重保险说明

1. **原库（Render）** —— 2026-09-07 前持续可用，作为最终回退源。
2. **本地完整备份（pg_dump .dump）** —— 独立于云厂商，防止原库被删后无据可恢复。
3. **新库（Neon）** —— 迁移目标；restore 后与原库并行验证，确认无误再切换 `DATABASE_URL`。

---

## 衔接下一步（Phase 3.10 迁移执行，不在本阶段）

1. 在 Neon 控制台新建 project（Free 即可），取得新连接串。
2. `pg_restore` 到 Neon（步骤五）。
3. 运行 `node server/scripts/phase38_inspect_db.js`（指向新库）做只读校验。
4. 改 Render 的 `DATABASE_URL` → Neon 连接串。
5. 重新部署 Render Web 服务。
6. API / 小程序联调。
7. 稳定观察一段时间，确认无误后再决定是否释放 Render 原库。

---

## 红线最终确认

> 本阶段未执行 pg_dump / pg_restore。
> 未创建 Neon 数据库。
> 未修改 DATABASE_URL / 环境变量。
> 未修改生产数据 / 用户数据 / SOURCE_SECRET_KEY。
> 未部署 / 未迁移 / 未修改 GitHub。
> 未输出任何连接串 / Token / 密钥真实值。
