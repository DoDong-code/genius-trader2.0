/**
 * 云端账户状态存储：登录用户的手动账户 / 策略 / 设置（JSON 整包）
 *
 * P0-5（2026-08-26）：引入修订号（revision）实现 CAS（compare-and-swap），
 * 杜绝 last-write-wins：
 *   - user_data_rev 表按 user_id 记录当前 revision。
 *   - 写入时若调用方传入 expectedRev 且不等于服务器当前 revision，则拒绝（409 冲突），
 *     防止「A 晚返回的请求覆盖 B」「logout 后老 PUT 继续上传」「debounce save 覆盖 restore」、
 *     「账号切换覆盖新账号」、「网络延迟旧 PUT 覆盖新 PUT」。
 *   - 成功写入后 revision + 1。
 *   - 旧客户端不传 expectedRev（undefined）时退化为「接受并自增」，保持向后兼容。
 */
const { get, run, transaction } = require('../database/dbAsync');

// 账户状态体积硬上限（P1-11）：与 HTTP 层 MAX_BODY_BYTES 对齐（32MB），作为落库前的二次防线。
// 防止超大 JSON 占用连接、磁盘带宽与堆内存（解 OOM）。保持 user_data 表结构兼容（仍整包存 data 文本）。
const MAX_BODY_BYTES = Math.max(1, Number(process.env.MAX_BODY_BYTES || 32 * 1024 * 1024));

async function getUserState(userId) {
  const row = await get('SELECT data FROM user_data WHERE user_id = ?', [userId]);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (error) {
    return null;
  }
}

// 读取当前 revision（不存在返回 0）。
async function getRevision(userId) {
  const row = await get('SELECT revision FROM user_data_rev WHERE user_id = ?', [userId]);
  return row ? Number(row.revision) || 0 : 0;
}

async function saveUserState(userId, state, options = {}) {
  // 超大体量保护（P1-11）：在落库 / 事务前快速拒绝，避免大对象占用连接与磁盘带宽。
  // 序列化后的字节数即最终写入 user_data.data 的体积，据此判定。
  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_BODY_BYTES) {
    const err = new Error(
      `账户状态体积过大（${serialized.length} 字节，上限 ${MAX_BODY_BYTES} 字节），拒绝写入`
    );
    err.code = 'STATE_TOO_LARGE';
    err.statusCode = 413;
    throw err;
  }
  const expectedRev = options.rev;
  return transaction(async (db) => {
    let newRev;
    if (expectedRev === undefined) {
      // 旧客户端（未传 rev）：向后兼容，接受并自增。
      // 先确保行存在，再原子 +1（并发安全：PG 对匹配行加行锁，串行自增）。
      await db.run(
        `INSERT INTO user_data_rev (user_id, revision) VALUES (?, 0)
         ON CONFLICT(user_id) DO NOTHING`,
        [userId]
      );
      const upd = await db.run('UPDATE user_data_rev SET revision = revision + 1 WHERE user_id = ?', [userId]);
      if (upd.changes === 0) {
        // 极端并发插入竞态：行仍缺失时直接插入（revision=1）
        await db.run(
          `INSERT INTO user_data_rev (user_id, revision) VALUES (?, 1)
           ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1`,
          [userId]
        );
      }
      newRev = Number((await db.get('SELECT revision FROM user_data_rev WHERE user_id = ?', [userId])).revision);
    } else {
      // 携带 rev 的客户端：原子条件更新——仅当服务器当前 revision == expectedRev 才推进。
      // WHERE revision = ? 由 PG 行锁串行化，杜绝 TOCTOU 并发竞态（两并发写只有一个能命中）。
      await db.run(
        `INSERT INTO user_data_rev (user_id, revision) VALUES (?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
        [userId, expectedRev]
      );
      const upd = await db.run(
        'UPDATE user_data_rev SET revision = ? WHERE user_id = ? AND revision = ?',
        [expectedRev + 1, userId, expectedRev]
      );
      if (upd.changes === 0) {
        const err = new Error('账户状态已被其他写入更新（revision 冲突），请刷新后重试');
        err.code = 'REVISION_CONFLICT';
        err.statusCode = 409;
        throw err;
      }
      newRev = expectedRev + 1;
    }
    await db.run(
      `INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
      [userId, serialized]
    );
    return newRev;
  });
}

function accountShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function countAccounts(accounts) {
  const shape = accountShape(accounts);
  return shape ? Object.keys(shape).length : 0;
}

function countFunds(accounts) {
  const shape = accountShape(accounts);
  if (!shape) return 0;
  return Object.keys(shape).reduce((sum, name) => {
    const acc = shape[name];
    return sum + (acc && Array.isArray(acc.funds) ? acc.funds.length : 0);
  }, 0);
}

/**
 * 防误覆盖判断（2026-08-26）：云端已有账户数据时，拒绝空 state 覆盖。
 * 覆盖场景：state 为空 / accounts 不存在 / accounts 非对象（含数组）/
 * accounts={} / 云端有持仓但新 state 账户全部为空（被错误恢复成空账户）。
 * @param {object|null} existing 云端现有 state
 * @param {object|null} incoming 待写入的新 state
 * @returns {boolean} true = 属于空覆盖，应拒绝
 */
function isEmptyStateOverwrite(existing, incoming) {
  const existingCount = countAccounts(existing && existing.accounts);
  if (existingCount === 0) return false;
  const incomingAccounts = accountShape(incoming && incoming.accounts);
  if (!incomingAccounts) return true;
  const incomingCount = Object.keys(incomingAccounts).length;
  if (incomingCount === 0) return true;
  const existingFunds = countFunds(existing && existing.accounts);
  const incomingFunds = countFunds(incomingAccounts);
  if (existingFunds > 0 && incomingFunds === 0) return true;
  return false;
}

module.exports = {
  getUserState,
  saveUserState,
  getRevision,
  isEmptyStateOverwrite,
  MAX_BODY_BYTES
};
