#!/usr/bin/env bash
# ============================================================
# Genius Trader —— Render PostgreSQL -> CloudBase PostgreSQL 迁移脚本（模板）
# 仅在本机运行；不要提交到仓库（含真实连接串）。
# 前提：本机已装 psql / pg_dump（macOS: brew install postgresql；Windows: 装 PostgreSQL 或单独 psql）。
# 关键顺序：先建空 PG -> 先恢复 dump -> 再在云托管注入 DATABASE_URL 重启，避免表结构冲突。
# ============================================================
set -euo pipefail

# ====== 由你填写（从控制台复制，勿入库）======
# Render 生产库（Render 控制台 -> Web Service genius-trader -> Environment -> DATABASE_URL）
export RENDER_DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB?sslmode=require"
# CloudBase 新建 PostgreSQL（CloudBase/TencentDB 控制台复制，地域必须上海 ap-shanghai）
export CLOUDBASE_DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB?sslmode=require"

BACKUP="render_backup_$(date +%F).sql"

echo "== [1] 备份 Render 生产库 =="
pg_dump "$RENDER_DATABASE_URL" --no-owner --no-acl --clean --if-exists > "$BACKUP"
echo "备份完成: $BACKUP  ($(wc -l < "$BACKUP") 行)"

echo "== [2] 恢复到 CloudBase PostgreSQL（目标须为空库）=="
# 若云托管曾用该 DATABASE_URL 启动过、已建了空表，先清空再恢复：
#   psql "$CLOUDBASE_DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$CLOUDBASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$BACKUP"
echo "恢复完成"

echo "== [3] 逐表 COUNT 校验：CloudBase 侧 =="
psql "$CLOUDBASE_DATABASE_URL" -t -A -c "
SELECT 'users',              count(*) FROM users
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'user_data',count(*) FROM user_data
UNION ALL SELECT 'portfolio',count(*) FROM portfolio
UNION ALL SELECT 'source_credentials', count(*) FROM source_credentials
UNION ALL SELECT 'read_tokens',count(*) FROM read_tokens;
"

echo "== [4] 逐表 COUNT 校验：Render 侧（用于对比，两遍数字必须一致）=="
psql "$RENDER_DATABASE_URL" -t -A -c "
SELECT 'users',              count(*) FROM users
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'user_data',count(*) FROM user_data
UNION ALL SELECT 'portfolio',count(*) FROM portfolio
UNION ALL SELECT 'source_credentials', count(*) FROM source_credentials
UNION ALL SELECT 'read_tokens',count(*) FROM read_tokens;
"

echo "== [5] 迁移后服务侧校验（在云托管注入 DATABASE_URL 并重启后再跑）=="
BASE="https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com"
echo "-- /api/health（database 应变 postgres）--"
curl -sS "$BASE/api/health"; echo
echo "-- /api/account/state（应返回真实用户，非空）--"
curl -sS "$BASE/api/account/state"; echo
echo "-- /api/provider/yangjibao/status（logged_in:true 即 Token 解密成功）--"
curl -sS "$BASE/api/provider/yangjibao/status"; echo
echo "-- /api/provider/xiaobeiyangji/status（logged_in:true 即 Token 解密成功）--"
curl -sS "$BASE/api/provider/xiaobeiyangji/status"; echo
echo "== 完成 =="
