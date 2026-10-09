-- ============================================================================
-- Genius Trader 2.0 — 生产库「数值列越界」迁移方案（待确认，未经授权请勿执行）
-- ============================================================================
-- 背景：
--   生产崩溃日志 backend_neon.log 第 225 行：
--     [NAV-SYNC] weekly-history failed: value "3735971251" is out of range for type integer
--   3735971251 ≈ 37.36 亿元，远超真实基金单位净值（通常 0.5~15）。该值来自上游 HTML/JSON
--   解析错位（把基金规模/份额字段误读为 nav），被 importFund 写入 fund_nav / fund_holdings
--   的「数值列」。若生产实际列类型为 INTEGER（INT32 上限 2,147,483,647），则直接 integer
--   out of range → 事务失败 → aborted 连接被复用 → 25P02 → 进程崩溃重启。
--
-- 代码侧已修复（src 层面，已提交本仓库，未部署）：
--   marketService.js / fundService.js 在解析与写入前对 nav/acc_nav/weight 做 0<nav<1e5、
--   0<=acc_nav<1e5、0<=weight<=100 的越界过滤，异常行直接丢弃，从源头杜绝 37 亿级脏值入库。
--   该修复已能「止血」（不再产生越界 INSERT），但：
--     (a) 若生产列实为 INTEGER，正常 nav（如 3.735）入库会被截断/取整，数据精度受损；
--     (b) 已入库的历史脏行（若有）仍需清理。
--   因此本 SQL 仅用于「把越界列改为 REAL（或至少 BIGINT）」+「清理历史脏行」，属数据正确性修复。
--
-- 重要原则（用户硬约束）：
--   * 不靠猜测把所有 integer 改成 bigint —— 仅针对「实际为 INTEGER 且承载净值/权重」的列。
--   * 先只读核查实际列类型，再按需 ALTER；绝不在未确认前执行。
--   * 不打印、不改动任何 token / cookie / 密钥。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 步骤 0（只读）：核查 fund_nav / fund_holdings 的实际列类型与越界行数
-- ----------------------------------------------------------------------------
-- 在任何写入之前，先确认生产库真实 schema。重点列：
--   fund_nav.nav        （应为 REAL）
--   fund_nav.acc_nav    （应为 REAL）
--   fund_holdings.weight（应为 REAL）
SELECT
  table_name,
  column_name,
  data_type,
  character_maximum_length,
  numeric_precision,
  numeric_scale
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('fund_nav', 'fund_holdings')
  AND column_name IN ('nav', 'acc_nav', 'weight')
ORDER BY table_name, column_name;

-- 核查是否真的存在越界脏行（按代码防火墙口径：nav/acc_nav ∈ (0,1e5)、weight ∈ [0,100]）
-- 若 fund_nav.nav 当前为 INTEGER，下面查询本身可能因比较float而告警，仅作诊断参考。
SELECT 'fund_nav' AS tbl, count(*) AS suspect_rows
FROM fund_nav
WHERE nav IS NULL OR nav <= 0 OR nav >= 100000 OR acc_nav IS NULL OR acc_nav < 0 OR acc_nav >= 100000
UNION ALL
SELECT 'fund_holdings' AS tbl, count(*) AS suspect_rows
FROM fund_holdings
WHERE weight IS NULL OR weight < 0 OR weight > 100;

-- ----------------------------------------------------------------------------
-- 步骤 1（条件执行，仅当步骤 0 显示该列为 INTEGER 时）：把列改为 REAL
-- ----------------------------------------------------------------------------
-- 用 DO 块判断 data_type，避免盲目 ALTER（满足「不靠猜测全改 bigint」）。
-- 仅当列确为 integer 才改；已是 real/双精度则跳过。
DO $$
DECLARE
  col_type text;
BEGIN
  -- fund_nav.nav
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'fund_nav' AND column_name = 'nav';
  IF col_type = 'integer' THEN
    ALTER TABLE fund_nav ALTER COLUMN nav TYPE REAL USING nav::real;
    RAISE NOTICE 'fund_nav.nav: integer -> REAL';
  ELSE
    RAISE NOTICE 'fund_nav.nav 已是 %，跳过', col_type;
  END IF;

  -- fund_nav.acc_nav
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'fund_nav' AND column_name = 'acc_nav';
  IF col_type = 'integer' THEN
    ALTER TABLE fund_nav ALTER COLUMN acc_nav TYPE REAL USING acc_nav::real;
    RAISE NOTICE 'fund_nav.acc_nav: integer -> REAL';
  ELSE
    RAISE NOTICE 'fund_nav.acc_nav 已是 %，跳过', col_type;
  END IF;

  -- fund_holdings.weight
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'fund_holdings' AND column_name = 'weight';
  IF col_type = 'integer' THEN
    ALTER TABLE fund_holdings ALTER COLUMN weight TYPE REAL USING weight::real;
    RAISE NOTICE 'fund_holdings.weight: integer -> REAL';
  ELSE
    RAISE NOTICE 'fund_holdings.weight 已是 %，跳过', col_type;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 步骤 2（条件执行）：清理已入库的历史越界脏行（仅删除明显异常行，不删正常数据）
-- ----------------------------------------------------------------------------
-- 说明：仅删除 nav/acc_nav/weight 超出合理范围的行；正常净值行不受影响。
-- 若步骤 1 已把列改为 REAL，下面比较可安全执行。执行前建议先 SELECT 确认删除集合。
-- 风险：删除是不可逆的。请先运行下方 SELECT 预览，确认无误后再执行 DELETE。
SELECT fund_code, date, nav, acc_nav
FROM fund_nav
WHERE nav IS NULL OR nav <= 0 OR nav >= 100000 OR acc_nav IS NULL OR acc_nav < 0 OR acc_nav >= 100000;

-- 预览无误后，取消下一行注释执行删除：
-- DELETE FROM fund_nav
-- WHERE nav IS NULL OR nav <= 0 OR nav >= 100000 OR acc_nav IS NULL OR acc_nav < 0 OR acc_nav >= 100000;

-- ----------------------------------------------------------------------------
-- 步骤 3（可选）：回填被删除的缺口行
-- ----------------------------------------------------------------------------
-- 删除越界行后，对应基金会出现历史净值缺口。可用仓库内审计/回填工具按基金重新拉取：
--   node scripts/nav-backfill.js            # 审计+幂等回填（不虚构净值，第三方无法提供的如实报告）
-- 该步骤不在本 SQL 内执行，避免与生产写入并发。
-- ============================================================================
-- 结论 / 审批：
--   [ ] 步骤 0 只读核查已完成，已确认需改列（附 data_type 结果）
--   [ ] 步骤 1 ALTER 已执行（或确认无需执行）
--   [ ] 步骤 2 删除集合已 SELECT 预览并确认
--   [ ] 步骤 3 回填计划已安排（或确认无需回填）
-- 未经上述逐项确认，请勿执行任何写入语句。
