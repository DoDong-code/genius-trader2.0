/**
 * stress/seedCredentials.cjs — 仅测试用：为指定 userId 写入“已连接”的第三方凭证。
 *
 * 不修改任何业务代码：复用服务端 server/utils/crypto.encryptText 生成 AES-GCM 密文，
 * 再经 dbAsync（云端 DATABASE_URL 路径，走 pgShim 的 FakePool）写入 source_credentials。
 * 这样服务端 getCredential 能正常解密并返回 connected，从而使 xiaobeiyangji / yangjibao
 * Provider 路径真正被执行（强制穿透），而非因“无凭证”直接返回 null。
 *
 * 用法：node -r ./stress/pgShim.cjs stress/seedCredentials.cjs <uid> [uid...]
 *       环境变量 STRESS_PG_FILE 指定支撑库；DATABASE_URL 必须设置。
 */
'use strict';
require('./pgShim.cjs');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const { encryptText } = require('../server/utils/crypto');
const { run } = require('../server/database/dbAsync');

const SOURCES = ['xiaobeiyangji', 'yangjibao'];
const TOKEN = 'stress-provider-token-' + Date.now();
const encToken = encryptText(TOKEN);

(async () => {
  const uids = process.argv.slice(2).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  if (!uids.length) {
    console.error('seedCredentials: no uid given');
    process.exit(1);
  }
  for (const uid of uids) {
    for (const src of SOURCES) {
      await run(
        `INSERT OR IGNORE INTO source_credentials (user_id, source_name, token, refresh_token, cookie, status, created_at, updated_at)
         VALUES (?, ?, ?, '', '', 'connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [uid, src, encToken]
      );
    }
    console.log(`[seedCredentials] uid=${uid} sources=${SOURCES.join(',')} status=connected`);
  }
  // 校验：读取回来确认能解密（模拟 getCredential）
  const { get } = require('../server/database/dbAsync');
  const row = await get('SELECT user_id, source_name, token, status FROM source_credentials WHERE user_id = ?', [uids[0]]);
  if (row && row.token) {
    const { decryptText } = require('../server/utils/crypto');
    const dec = decryptText(row.token);
    console.log(`[seedCredentials] verify uid=${uids[0]} source=${row.source_name} decryptOk=${dec && dec.length > 0}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('seedCredentials FATAL', e && e.stack || e);
  process.exit(1);
});
