#!/usr/bin/env bash
# ============================================================
# 在腾讯云新建 TencentDB for PostgreSQL（上海），用于 Genius Trader 迁库
# 前提（一次性）：
#   1) pip install tccli
#   2) tccli configure   -> 填你的 SecretId / SecretKey，Default Region 填 ap-shanghai
# 注意：这是付费资源，创建后立即计费；用完可按需销毁。
# 重要：--SpecCode / --Zone 必须与你账户控制台的 PostgreSQL 购买页一致，
#       下方值是常见默认值，若报错请到控制台购买页核对规格码/可用区。
# ============================================================
set -euo pipefail

REGION="ap-shanghai"
ZONE="ap-shanghai-1"          # 按控制台「可用区」核对
SPEC="cdb.pg.s1.small"        # 实例规格码（务必在购买页核实）
INSTANCE_NAME="genius-trader-pg"

echo "== [1] 创建 PostgreSQL 实例（上海）=="
tccli postgres CreateDBInstances \
  --Region "$REGION" \
  --Zone "$ZONE" \
  --DBInstanceName "$INSTANCE_NAME" \
  --DBVersion "13.0" \
  --DBCharset UTF8 \
  --SpecCode "$SPEC" \
  --Storage 50 \
  --InstanceCount 1 \
  --Period 1 \
  --AutoRenewFlag 0 \
  --ProjectId 0

echo "== [2] 实例就绪后，查询内网/外网地址与端口 =="
tccli postgres DescribeDBInstances \
  --Region "$REGION" \
  --Filters "[{\"Name\":\"db-instance-name\",\"Values\":[\"$INSTANCE_NAME\"]}]"

echo "== [3] 若控制台未设密码，初始化管理员密码 =="
echo "   先把上一步拿到的 DBInstanceId 填进去，再执行："
echo "   tccli postgres InitDBInstances --Region $REGION --DBInstanceId <实例ID> --AdminName root --AdminPassword '<强密码>'"

echo "== [4] 拼出连接串，填到云托管 genius-trader-003 的环境变量 DATABASE_URL =="
echo "   格式：postgresql://<账号>:<密码>@<地址>:<端口>/<库名>?sslmode=require"
echo "   ⚠️ 同时确认云托管环境变量里 SOURCE_SECRET_KEY 保持「不设」（复用 fallback 字面量），勿设新随机值。"
