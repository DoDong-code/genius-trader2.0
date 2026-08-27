/**
 * stress/casProbe.cjs — 直接验证账户状态 CAS（saveUserState 的 rev 分支）。
 * 与压测服务端共享同一 STRESS_PG_FILE 支撑库，因此验证的是服务端真实写入路径。
 * 不修改任何业务代码，仅 require 当前本地代码并并发调用。
 */
'use strict';
require('./pgShim.cjs'); // 安装 pg/fetch 垫片（同支撑库）
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const { saveUserState, getUserState } = require('../server/services/accountStateService');
const { get } = require('../server/database/dbAsync');

async function getRev(uid) {
  const row = await get('SELECT revision FROM user_data_rev WHERE user_id = ?', [uid]);
  return row ? Number(row.revision) || 0 : 0;
}

(async () => {
  const UID = Number(process.env.CAS_UID || 900001);
  const N = Number(process.env.CAS_N || 200);
  let accepted = 0, conflicts = 0, errors = 0;

  // 基线：无 rev 写入，revision 从 0 -> 1
  await saveUserState(UID, { __marker: 'CAS_BASE', v: 0 });
  const baseRev = await getRev(UID);

  // 并发：N 个客户端全部携带 rev = baseRev（即“当前 revision”）。
  // 因 CAS 原子条件更新 WHERE revision = baseRev，只有一个能命中推进到 baseRev+1，
  // 其余全部 stale（revision 已变）-> REVISION_CONFLICT(409)。绝不允许 last-write-wins。
  // 限制并发写入数为 8，避免单文件 SQLite 的写串行化把“传输层 SQLITE_BUSY”误算成 CAS 错误。
  const tasks = [];
  let active = 0;
  const waitSlot = () => new Promise((res) => {
    const tryGo = () => { if (active < 8) { active++; res(); } else setTimeout(tryGo, 5); };
    tryGo();
  });
  const freeSlot = () => { active--; };
  for (let i = 0; i < N; i++) {
    const marker = 'CAS_WIN_' + i;
    tasks.push(
      (async () => {
        await waitSlot();
        try {
          await saveUserState(UID, { __marker: marker, v: i }, { rev: baseRev });
          accepted++;
        } catch (e) {
          if (e && (e.code === 'REVISION_CONFLICT' || e.statusCode === 409)) conflicts++;
          else { errors++; console.error('CAS_ERR', e && e.message); }
        } finally {
          freeSlot();
        }
      })()
    );
  }
  await Promise.all(tasks);

  // 验证：最终落库数据必须是“某一个胜出写入”的 marker，且 revision 恰好 +1（无多写/无撕裂）
  const finalData = await getUserState(UID);
  const finalRev = await getRev(UID);
  const finalMarker = finalData && finalData.__marker;
  const dataIntegrityOk =
    typeof finalMarker === 'string' &&
    finalMarker.indexOf('CAS_WIN_') === 0 &&
    finalRev === baseRev + 1 &&
    errors === 0;

  // 额外：stale 再次写入必须被拒（rev 已是 baseRev+1，再传 baseRev 必 409）
  let staleRejected = false;
  try {
    await saveUserState(UID, { __marker: 'CAS_STALE', v: 999 }, { rev: baseRev });
  } catch (e) {
    if (e && (e.code === 'REVISION_CONFLICT' || e.statusCode === 409)) staleRejected = true;
  }

  const result = {
    uid: UID,
    n: N,
    baseRev,
    finalRev,
    accepted,
    conflicts,
    errors,
    finalMarker,
    dataIntegrityOk,
    staleRejected,
    casPass: accepted === 1 && conflicts === N - 1 && dataIntegrityOk && staleRejected
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
})().catch((e) => { console.error('CAS_PROBE_FATAL', e); process.exit(1); });
