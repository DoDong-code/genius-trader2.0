/**
 * stress/dbUtil.cjs — 仅测试用：支撑库直接操作。
 *
 * 子命令：
 *   clearNav <code> [code...]   删除指定基金的 fund_nav（让其“今天 NAV 缺失”，
 *                               ensureTodayNav 缓存未命中 → 强制穿透 Yahoo/Eastmoney）。
 *
 * 不修改任何业务代码；经 pgShim 的 FakePool 操作同一支撑库。
 * 用法：node -r ./stress/pgShim.cjs stress/dbUtil.cjs clearNav 000001 000002
 */
'use strict';
require('./pgShim.cjs');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const { run } = require('../server/database/dbAsync');

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'clearNav') {
    const codes = args.filter((c) => /^\d{6}$/.test(c));
    for (const c of codes) {
      await run('DELETE FROM fund_nav WHERE fund_code = ?', [c]);
      console.log(`[dbUtil] clearNav fund_code=${c}`);
    }
  } else {
    console.error('dbUtil: unknown command ' + cmd);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('dbUtil FATAL', e && e.stack || e);
  process.exit(1);
});
