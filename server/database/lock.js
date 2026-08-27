/**
 * 跨实例分布式锁（P1-9）：多实例部署（如 Render 多副本）下，
 * 定时任务（每日 NAV / 每周历史 / 每季度持仓）只能由一个实例执行，
 * 避免重复同步、重复写库、触发上游 API 限流。
 *
 * 云端（PostgreSQL）：使用 `pg_try_advisory_xact_lock(key1, key2)` ——
 *   - 事务级建议锁，非阻塞（try 不等待），已被其他实例持有时立即返回 false → 本实例跳过。
 *   - 事务结束（COMMIT/ROLLBACK）或连接断开（实例崩溃）时自动释放，无需手动 unlock。
 * 本地（SQLite / 单机）：用进程内 Set 做等效去重（多实例问题在单机不存在）。
 *
 * 用法：
 *   const { acquired, result, reason } = await withAdvisoryLock('nav-sync:daily', async () => { ... });
 *   if (!acquired) { /* 另一实例持有，跳过 *\/ }
 */
const { isCloud, acquireClient } = require('./dbAsync');

// 进程内锁（仅本地/非云端使用）
const localLocks = new Set();

/**
 * 将任意锁名稳定映射为 PostgreSQL advisory lock 需要的 [int4, int4]。
 * 使用 FNV-1a 变体哈希，保证同一名称在任意实例上得到相同键值。
 */
function advisoryKey(name) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i * 31), 0x01000193) >>> 0;
  }
  return [h1, h2];
}

/**
 * 在分布式锁保护下执行 fn。
 * @returns {Promise<{acquired:boolean, result?:*, reason?:string, error?:*}>}
 */
async function withAdvisoryLock(name, fn) {
  if (!isCloud()) {
    if (localLocks.has(name)) {
      return { acquired: false, reason: 'local-held' };
    }
    localLocks.add(name);
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      localLocks.delete(name);
    }
  }

  const [k1, k2] = advisoryKey(name);
  const client = await acquireClient();
  try {
    await client.query('BEGIN');
    const res = await client.query('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', [k1, k2]);
    const ok = res.rows[0] && res.rows[0].ok === true;
    if (!ok) {
      // 另一实例已持有该锁：回滚事务（释放可能隐含的锁等待），本实例跳过
      await client.query('ROLLBACK').catch(() => {});
      return { acquired: false, reason: 'pg-held' };
    }
    try {
      const result = await fn();
      await client.query('COMMIT');
      return { acquired: true, result };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = {
  withAdvisoryLock,
  advisoryKey,
  __localLocks: localLocks
};
