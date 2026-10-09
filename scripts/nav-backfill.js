#!/usr/bin/env node
'use strict';
/*
 * nav-backfill.js — 历史净值缺口审计与幂等回填（只读审计优先，按需回填）
 *
 * 用法（在仓库根目录执行，需能连上 genius_trader 数据库，即生产 DATABASE_URL）：
 *   node scripts/nav-backfill.js                 # 仅审计，打印缺口，不写库
 *   node scripts/nav-backfill.js --apply         # 审计 + 幂等回填（importFund）
 *   node scripts/nav-backfill.js --apply --window=365 --concurrency=3
 *
 * 说明：
 *   - 审计只读 fund_nav 表，对比「最近 N 个交易日」与已存净值，列出每只基金的缺失日期区间。
 *   - 回填调用现有 importFund（增量补齐，ON CONFLICT 不覆盖已有正确数据，不虚构净值）。
 *   - 不打印任何 API Key / Token / Cookie。
 *   - 第三方无法提供的更早历史会如实保留缺口，绝不插值或伪造正式净值。
 *
 * 注意：本脚本直接操作数据库，请在本地有备份 / 可回滚的环境下运行；生产环境建议先跑一次
 * 不带 --apply 的审计确认范围，再决定回填。
 */

const path = require('path');
const dbAsync = require(path.join(__dirname, '..', 'server', 'database', 'dbAsync'));
const { auditNavGaps, backfillNavGaps } = require(path.join(__dirname, '..', 'server', 'services', 'navSyncService'));

function parseArgs(argv) {
  const args = { apply: false, windowDays: 250, concurrency: 2 };
  argv.forEach(a => {
    if (a === '--apply') args.apply = true;
    let m = a.match(/^--window=(\d+)$/); if (m) args.windowDays = Number(m[1]);
    m = a.match(/^--concurrency=(\d+)$/); if (m) args.concurrency = Number(m[1]);
  });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('[nav-backfill] initializing DB connection...');
  await dbAsync.ensureCloudSchema();

  console.log(`[nav-backfill] AUDIT: scanning gaps (window=${args.windowDays} trading days)...`);
  const gaps = await auditNavGaps({ windowDays: args.windowDays });
  const totalMissing = gaps.reduce((s, g) => s + g.missingCount, 0);
  console.log(`[nav-backfill] AUDIT RESULT: ${gaps.length} funds have gaps, ${totalMissing} missing NAV dates total`);
  gaps.forEach(g => {
    console.log(`  ${g.fund_code}  ${(g.fund_name || '').padEnd(18)}  missing=${String(g.missingCount).padStart(4)}  ${g.range}`);
  });

  if (!args.apply) {
    console.log('\n[nav-backfill] DRY RUN — no writes performed.');
    console.log('[nav-backfill] Re-run with --apply to backfill idempotently (importFund, ON CONFLICT no-overwrite).');
    process.exit(0);
  }

  console.log(`\n[nav-backfill] APPLY: backfilling ${gaps.length} funds (concurrency=${args.concurrency})...`);
  const result = await backfillNavGaps({ windowDays: args.windowDays, concurrency: args.concurrency });
  const failed = result.filled.filter(f => f.error);
  const ok = result.filled.filter(f => !f.error);
  console.log(`[nav-backfill] BACKFILL DONE: ${ok.length} ok, ${failed.length} failed`);
  failed.slice(0, 30).forEach(f => console.log(`  FAIL ${f.fund_code}: ${f.error}`));

  // 回填后复审计，报告残留缺口（第三方无法提供的更早历史如实保留）
  const after = await auditNavGaps({ windowDays: args.windowDays });
  const residual = after.reduce((s, g) => s + g.missingCount, 0);
  console.log(`\n[nav-backfill] RESIDUAL missing after backfill: ${residual} dates across ${after.length} funds`);
  if (after.length) {
    console.log('[nav-backfill] NOTE: residual gaps mean third-party sources could NOT provide earlier history — NOT fabricated.');
    after.slice(0, 20).forEach(g => console.log(`  STILL MISSING ${g.fund_code} ${g.missingCount} ${g.range}`));
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[nav-backfill] FATAL', err && err.message ? err.message : err);
  process.exit(1);
});
