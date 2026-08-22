/**
 * 账户备份服务：服务器端快照，最多保留 5 个，超出自动删除最旧。
 * user_id=0 表示匿名/本地模式（与 portfolioService/sourceCredentials 一致）。
 */
const { get, run, all } = require('../database/dbAsync');

const MAX_BACKUPS = 5;

// 创建快照，超出 5 个自动删除最旧
async function createBackup(userId, state, reason = 'manual') {
  const accountCount = state && state.accounts && typeof state.accounts === 'object'
    ? Object.keys(state.accounts).length
    : 0;
  await run(
    'INSERT INTO account_backups (user_id, data, account_count, reason, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [userId, JSON.stringify(state), accountCount, reason]
  );
  
  // 安全分步清理，避免 SQLite 在 subquery 限制中使用 LIMIT
  const rows = await all(
    'SELECT id FROM account_backups WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, MAX_BACKUPS]
  );
  const idsToKeep = (rows || []).map(r => r.id);
  if (idsToKeep.length > 0) {
    const placeholders = idsToKeep.map(() => '?').join(',');
    await run(
      `DELETE FROM account_backups WHERE user_id = ? AND id NOT IN (${placeholders})`,
      [userId, ...idsToKeep]
    );
  }
  return true;
}

// 列出最近 5 个备份（不含 data 全文，仅元信息）
async function listBackups(userId) {
  const rows = await all(
    'SELECT id, account_count, reason, created_at FROM account_backups WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, MAX_BACKUPS]
  );
  return (rows || []).map(r => ({
    id: Number(r.id),
    account_count: Number(r.account_count) || 0,
    reason: r.reason || '',
    created_at: r.created_at
  }));
}

// 读取某个备份的完整数据
async function getBackup(userId, backupId) {
  const row = await get(
    'SELECT data FROM account_backups WHERE user_id = ? AND id = ?',
    [userId, Number(backupId)]
  );
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}

// 删除某个备份（仅限本人）
async function deleteBackup(userId, backupId) {
  const result = await run(
    'DELETE FROM account_backups WHERE user_id = ? AND id = ?',
    [userId, Number(backupId)]
  );
  return result;
}

module.exports = {
  createBackup,
  listBackups,
  getBackup,
  deleteBackup,
  MAX_BACKUPS
};
