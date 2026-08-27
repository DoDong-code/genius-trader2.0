/**
 * stress/runServer.cjs — 压测用的服务端启动器（不修改业务代码）。
 * 直接调用 server/index.js 已导出的 startServer(port)，便于指定测试端口。
 * 垫片通过 `node -r ./stress/pgShim.cjs` 预加载注入。
 */
'use strict';
const { startServer } = require('../server/index.js');
const port = Number(process.env.STRESS_PORT || 3939);
startServer(port).catch((e) => {
  console.error('[runServer] startServer failed:', e);
  process.exit(1);
});
