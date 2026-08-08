# Genius trader
![Uploading image.png…]()

## 账号与云端存储

- 支持邮箱注册 / 登录，密码使用 scrypt 加盐哈希，会话为 30 天有效的 Bearer Token。
- 登录后，手动账户、策略等数据自动同步到云端；养基宝 / 小倍养基等同步账户与第三方凭证按用户隔离。
- 未登录时保持原有本地模式（浏览器 localStorage + 本地 SQLite），完全兼容旧数据。

### 部署到 Render

1. 在 Render 创建 PostgreSQL（免费档即可），复制 **Internal Database URL**。
2. 在 Web Service 的环境变量中新增 `DATABASE_URL`，粘贴该连接串（含密码，勿写入代码仓库）。
3. 可选：设置 `SOURCE_SECRET_KEY`（第三方凭证加密密钥，不设置时使用开发默认值并输出警告）。
4. 启动命令使用 `npm start`（即 `node server/index.js`）；检测到 `DATABASE_URL` 后自动切换到 PostgreSQL。

仓库内的 `render.yaml` 为 Blueprint 一键部署模板（会同时创建数据库）。
