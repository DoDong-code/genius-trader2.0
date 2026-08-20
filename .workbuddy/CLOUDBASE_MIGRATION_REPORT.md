# Genius Trader —— Render → 腾讯云 CloudBase 云托管 迁移报告

> 生成时间：2026-08-15
> 源仓库：`https://github.com/DoDong-code/genius-trader2.0`
> 后端工作目录：`genius-trader2.0`（已浅克隆至本地）
> 小程序工作目录：`mp1`（独立于 2.0 仓库，单独改造）
> 迁移原则：新旧并行、绝不删除 Render / 生产 DB / 用户 / Token / 生产数据。

---

## 0. 总体结论（先说重点）

| 维度 | 状态 | 说明 |
|---|---|---|
| 后端代码改造（不重写、保留业务逻辑） | ✅ 已完成 | `server/index.js`、`yangjibao.js`、`package.json`、`Dockerfile`、`.dockerignore`、`.env.example` |
| AI 构建修复 | ✅ 已完成 | `build:ai` 预构建 + `esbuild` 显式依赖，去掉 `npx` 临时下载 |
| 启动安全修复 | ✅ 已完成 | 云模式不 Seed、SQLite 失败不拖垮服务、生产禁写示例账户 |
| 养基宝二维码 Base64 | ✅ 已完成 | 后端 `qrcode` 本地生成，不再依赖第三方图片域名 |
| 小程序统一请求层 | ✅ 已完成 | `config/api.js` + `utils/request.js` + 两页面收口 |
| **CloudBase 实际部署** | ✅ 已部署 | 容器运行于 `cloud1` 环境，公网域名已通，`/api/health` 返回 200（SQLite 空环境模式） |
| **PostgreSQL 备份 + 迁库** | ⏳ 待用户 | 涉及生产数据，需用户/DBA 在控制台执行并校验 |
| **填 `config/api.js` 三值** | ⏳ 待用户 | `CLOUD_ENV_ID` / `CLOUD_SERVICE_NAME` / `PUBLIC_API_BASE` |
| **SOURCE_SECRET_KEY 沿用策略确认** | ✅ 已确认 | Render/CloudBase 均未设，均回退同一 fallback 字面量，历史 Token 可解密 |

**沙箱已验证**：`npm install`（含 qrcode/esbuild/pg）、`QRCode.toDataURL` 产出 `data:image/png;base64,...`、`npm run build:ai` 打包出 `server/services/ai/index.js` 且 `node --check` 通过、所有改动文件 `node --check`/ESM 校验通过。

---

## A. CloudBase（环境 ID、云托管服务名称、部署状态）

| 项 | 值 | 状态 |
|---|---|---|
| CloudBase 环境 ID | `cloud1-d6gh61ypfd7fcbc28`（环境名 `cloud1`） | ✅ 已确认 |
| 云托管服务名称 | `genius-trader-003`（容器，已部署 Live） | ✅ 已确认 |
| 公网访问地址 | `https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com` | ✅ 已确认 |
| 部署状态 | 已部署，容器运行中，`/api/health` 返回 200（HTTP 200，upstream 200） | ✅ 已验证 |
| 部署方式 | 容器化（非云函数），`node:22-alpine` 镜像，运行完整 Node 服务 | ✅ 已就绪 |
| 访问方式 | 小程序 `wx.cloud.callContainer`；Web 用公网 HTTPS 域名 | ✅ 已就绪 |

- **Dockerfile 已编写（最终部署版）**：`FROM node:22-alpine`，`npm install --omit=dev` → `COPY . .` → `ENV NODE_ENV=production` / `ENV PORT=3000` / `EXPOSE 3000` → `CMD ["npm","start"]`（即 `node server/index.js`）。不硬编码端口，使用 CloudBase 注入的 `$PORT`。
- **.dockerignore 已编写**：忽略 `node_modules` / `.git` / `.env` / `server/data/*.sqlite*` 等，避免密钥与本地缓存进镜像。
- **部署来源建议**：GitHub 源（连接 `DoDong-code/genius-trader2.0`）或 Docker 镜像源。容器启动命令即 `node server/index.js`。
- **环境变量**：必须在云托管控制台注入 `.env.example` 中所有项（尤其 `DATABASE_URL`、`SOURCE_SECRET_KEY`、各 `AI_*_API_KEY`、`APP_URL`、`YJB_*`、`XBYJ_*`）。**CloudBase 控制台内配置密钥，切勿写进镜像或仓库。**

> ⚠️ 未部署前，`wx.cloud.callContainer` 无法联调。部署后用 `/api/health` 验证。

---

## B. 数据库（PostgreSQL 地址、数据完整性、数量、不曝密码）

| 项 | 值 / 状态 |
|---|---|
| PostgreSQL 地址 | **Render 现有 PostgreSQL（External Database URL）**，已由用户填入 CloudBase `genius-trader-003` 的环境变量 `DATABASE_URL`（选 A：直连 Render 库，未新建 TencentDB）。密码不输出。 |
| 数据是否完整迁移 | ✅ **选 A 同源库，无迁库，数据天然一致**（CloudBase 与 Render 同读一份 Render PG） |
| 用户数量 `users` | N/A（选 A 下同源库，无需 COUNT 对比） |
| portfolio 数量 `portfolio` | N/A（同上） |
| source_credentials 数量 `source_credentials` | N/A（同上；加密 Token 同库同 fallback 密钥，可解密） |
| DB 密码 | **不输出、不写入报告、不写入仓库。** 仅存于 CloudBase 环境变量 / 密钥。 |

**实测验证（2026-08-15，用户重新部署后）**：
- `GET /api/health` 返回 `{"success":true,"service":"fund-data","database":"postgres",...}` → **`database` 已从 sqlite 切到 `postgres`，选 A 生效** ✅
- `GET /api/provider/yangjibao/status` / `xiaobeiyangji/status` 返回 `logged_in:false` → **非解密失败**，系 curl 无登录态（session cookie）且小程序尚未切到 CloudBase 所致；真实验证需小程序切 CloudBase 后点一次同步，或见下方方式二只读验证。
- `GET /api/account/state` 返回 `请先登录` → 同上，依赖 session。

**机制（已确认保留）**：
- 设置 `DATABASE_URL` 即启用 PostgreSQL 异步模式（`database/dbAsync.js` 的 `isCloud()` 判断），所有业务表（users / sessions / user_data / portfolio / source_credentials / read_tokens）走 Postgres。
- 未设置 `DATABASE_URL` 时回退本地 SQLite（`database/db.js`），仅作可重建缓存（fund / nav / holdings / estimate），不存业务/用户数据。
- 不 DROP / 不清空 / 不覆盖任何表。`ensureCloudSchema()` 仅做必要建表（IF NOT EXISTS 语义），不破坏既有数据。

**当前阶段数据库策略决策（2026-08-15，用户选 A）**：采用**零成本过渡方案**——CloudBase 云托管 `genius-trader-003` 的 `DATABASE_URL` 直接填 **Render 现有 PostgreSQL 的 External Database URL**（从 Render 控制台 Databases → 实例 → Connect 复制；注意必须是 **External 公网串**，不是 Web Service Environment 里的 internal 串，否则 CloudBase 解析不到）。后端算在 CloudBase、数据仍在 Render PG，**不新建 TencentDB、不迁库、无新增费用**；历史 Token 因同库同 fallback 密钥可解密。⚠️ 代价：CloudBase(上海) ↔ Render Postgres(多在美西) 跨区延迟较高；待彻底脱离 Render 时再执行下方备份步骤（pg_dump Render PG → 恢复到上海 TencentDB → 切 DATABASE_URL）。**（2026-08-15 已按此方案实施并实测：`/api/health` 返回 `database:"postgres"`，选 A 生效）**。

**迁移前备份步骤（彻底脱离 Render 时执行，当前暂缓）**：
1. 在 Render 控制台对生产 Postgres 执行 `pg_dump`：`pg_dump "$RENDER_DATABASE_URL" > render_backup_$(date +%F).sql`
2. 本地/临时保存该 `.sql`（不要进仓库，单放加密盘或私有对象存储）。
3. 在 CloudBase 控制台新建 PostgreSQL 实例，取得新 `DATABASE_URL`。
4. 恢复：`psql "$NEW_DATABASE_URL" < render_backup_$(date +%F).sql`
5. 校验：逐表 `COUNT(*)` 比对 Render 与 CloudBase 数量一致；抽样核对 `source_credentials` 行数与一条记录的密文可解密。

> ⚠️ **关键**：`source_credentials` 用 AES-256-GCM 加密，密钥 = `sha256(SOURCE_SECRET_KEY || DEV_FALLBACK_KEY)`。经实测，Render 与 CloudBase 当前均未设 `SOURCE_SECRET_KEY`，均回退到同一 `DEV_FALLBACK_KEY='genius-trader-dev-only-source-secret'`，故密钥一致、历史 Token 可解密。若任一侧改为不同值，历史 Token 将**全部无法解密**。详见 §五。

---

## C. API（旧 Render API → 新 CloudBase API）

所有 REST 路径**原样保留**，仅域名/调用方式变化。小程序统一收口到 `utils/request.js`，自动选择 `callContainer` 或 `wx.request`。

| 旧（Render） | 新（CloudBase） | 说明 |
|---|---|---|
| `https://<render-app>.onrender.com/api/health` | `callContainer /api/health` | 健康检查已返回 `database: postgres/sqlite` |
| `…/api/auth/*` | `callContainer /api/auth/*` | 登录/会话 |
| `…/api/account/state` | `callContainer /api/account/state` | 账户状态 |
| `…/api/portfolio/*` | `callContainer /api/portfolio/*` | 持仓（Postgres） |
| `…/api/provider/:source/*` | `callContainer /api/provider/:source/*` | 第三方同步（养基宝/小倍） |
| `…/api/ai/*` | `callContainer /api/ai/*` | AI 分析/对话（预构建产物） |
| `…/api/market/*` | `callContainer /api/market/*` | 行情（东方财富/Yahoo） |
| `…/api/funds` | `callContainer /api/funds` | 基金列表（SQLite 缓存） |
| `…/api/external/*` | `callContainer /api/external/*` | 外部接口 |

- 旧路径 = 新路径（一致），小程序无需改业务 URL，只改"怎么连"。
- Web 端：把原 Render 域名替换为 `PUBLIC_API_BASE`（CloudBase HTTPS 公网入口），接口路径不变 → **网页版不分叉**。
- request 合法域名：走 `callContainer` 后**免配置** request 合法域名；仅本地开发/未配置云托管时才走 `wx.request` 且需 `api_base_url`。

---

## D. 微信小程序（确认 `wx.cloud.callContainer` 是否已经工作）

| 项 | 状态 | 说明 |
|---|---|---|
| `config/api.js`（CLOUD_ENV_ID / CLOUD_SERVICE_NAME / PUBLIC_API_BASE） | ✅ 三值已填 | `CLOUD_ENV_ID=cloud1-d6gh61ypfd7fcbc28`、`CLOUD_SERVICE_NAME=genius-trader-003`、`PUBLIC_API_BASE=https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com`；`CLOUDBASE_ENABLED=Boolean(前两值)` 自动 true |
| `utils/request.js` 统一层 | ✅ 已修复优先级 | 原 `api_base_url` 强制关闭 callContainer 的逻辑已删除，CloudBase 配置优先；`api_base_url` 仅作为 wx.request fallback 基地址 |
| `wx.cloud.init` 幂等初始化 | ✅ 已完成 | `initCloud()` 已内置，缺 appId/游客模式优雅降级 |
| 分析页 `analysis.js` | ✅ 已收口 | 4 处直连 `wx.request` 改为 `http.get/http.post`（含 `/api/fund/*`、`/api/ai/analyze`、`/api/market/status`、`/api/ai/chat`），改 async/await + try/catch/finally 保留 loading/错误 UI |
| 设置页 `setting.js` | ✅ 已收口并修正默认值 | 测试按钮改 `getApiBase()` 兜底；API 基地址输入框默认显示 `PUBLIC_API_BASE` 而非 `http://localhost:3000` |
| **实际联调是否工作** | 🔧 三值已填并加固 request.js（callContainer 失败/404 自动回退公网域名，2026-08-15），待用户重新编译验证 | 用户首次联调养基宝二维码报 404：根因是 storage 里旧 `api_base_url`（如 localhost:3000）触发原 `useContainerMode()` 强制回退 HTTP。已二次加固：`getApiBase()` 配 CloudBase 时强制用 `PUBLIC_API_BASE`（忽略旧 `api_base_url`）；`request()` 中 callContainer 返回非 2xx 或失败**自动回退** `wx.request` 到 `PUBLIC_API_BASE`（该公网域名已 curl 实测 `POST /api/provider/yangjibao/qrcode`=200）。需用户重新编译后点养基宝同步，确认 `logged_in:true`；DevTools 建议勾选「不校验合法域名」以便回退通道可达公网域名。 |

**"所见即所得"已落实**：四环境（开发工具 / 真机预览 / 体验版 / 正式版）默认都走同一个云托管服务，无环境差异、无需合法域名配置。

> 验证步骤（待用户）：填三值 → 部署 CloudBase → 开发者工具中调 `/api/health`，日志应显示 `database: postgres (cloud)` 且不再走 `wx.request`。

---

## E. 第三方基金（养基宝、小倍养基）

| Provider | 接口协议 | CloudBase 适配 | 状态 |
|---|---|---|---|
| 养基宝 YangJiBao | HTTP `http://browser-plug-api.yangjibao.com`（签名 md5） | 后端保留 HTTP 地址（环境变量 `YJB_BASE_URL`，默认不变）；小程序不直接访问该域名 | ✅ 代码就绪 |
| 小倍养基 XiaoBei | HTTPS `https://api.xiaobeiyangji.com`（版本 `3.5.7.0`） | 后端访问（`XBYJ_BASE_URL`/`XBYJ_VERSION`）；小程序不直接访问 | ✅ 代码就绪 |

- 二者均由小程序经 `callContainer` 调后端 `/api/provider/:source/*`，后端再出网访问第三方 → 小程序侧无第三方域名白名单问题。
- **风险点（已记录）**：CloudBase 国内区对外访问 **Yahoo Finance（美股行情）可能不通**；东方财富（净值）一般可用。如 Yahoo 不通，需在 CloudBase 配置出网代理或改用可访问的数据源。建议部署后在 `/api/market/status` 实测。
- 凭证：养基宝/小倍登录 Token 存 `source_credentials`，AES-256-GCM 加密（见 §B、§I）。

---

## F. 二维码（确认是否已经不需要第三方 downloadFile）

✅ **已确认：不再需要第三方 downloadFile。**

- 改动：`server/providers/yangjibao.js` 引入 `qrcode` 包，`getQRCode()` 在后端把养基宝登录串生成为 PNG 的 Base64 data URI：
  - 返回 `{ qr_id, qr_url, qr_data_url: "data:image/png;base64,...", qr_base64 }`
- 小程序收到 `qr_data_url` 直接 `<image src="{{qr_data_url}}">` 展示，**不再**用 `wx.downloadFile` 拉第三方图片，也不依赖 `qrserver.com` 等外部图床。
- 沙箱已验证：`QRCode.toDataURL(...)` 输出 `data:image/png;base64,iVBORw0K...`（长度约 2578），可正常渲染。
- 前端若已在 `setting.js` 用此字段直接展示，则无需任何额外改动；如需确认前端取值字段，验证 `qr_data_url` 是否被渲染即可。

---

## G. 短信（确认实际能否发送短信）

| 项 | 状态 | 说明 |
|---|---|---|
| 短信 Provider / 配置 | ✅ 代码沿用（未重写） | 小倍相关短信逻辑保持在原 Provider 内 |
| 实际能否发送 | ⏳ 待验证 | 取决于 CloudBase 出网是否放行短信网关 + 凭证是否有效 |

- 短信依赖后端出网访问短信网关。CloudBase 国内区默认出网策略需确认是否放行该网关域名/端口。
- **必须在部署后实测一次真实短信发送**（如登录验证码 / 通知），不能仅凭代码推断。
- 若 CloudBase 出网受限：在云托管网络配置中放行短信网关，或改用腾讯云 SMS 等云内服务（属后续增强，不在本次"不重写"范围内）。

> 验收时把"成功收到一条真实短信"作为硬性项（见文末验收清单）。

---

## H. AI（确认 API Key 和 AI 服务正常）

| 项 | 状态 | 说明 |
|---|---|---|
| AI 构建 | ✅ 已修复 | `build:ai` 预构建 `src/services/ai/index.ts` → `server/services/ai/index.js`（`esbuild --bundle --platform=node --format=cjs`）；`package.json` 加 `esbuild ^0.28.2` 显式依赖；`server/index.js` 加 `ensureAiBundle()` 本地兜底，失败仅影响 `/api/ai/*`，**绝不阻断整体服务** |
| AI API Key | ⏳ 待填 | `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 在 CloudBase 控制台注入；未配置时对应模型不可用但不影响其他功能 |
| AI 服务实际可用 | ⏳ 待验证 | 部署后调 `/api/ai/analyze` 或 `/api/ai/chat` 实测 |

- 沙箱已验证：`npm run build:ai` 产出 `server/services/ai/index.js`（约 20.9KB）且 `node --check` 通过。
- 预构建产物随镜像打包（`Dockerfile` 中 `RUN npm run build:ai`），容器启动不再临时 `npx`，消除生产构建不确定性。

---

## I. Render（暂时保持运行；明确安全关闭时机）

**当前决策：Render 保持运行，作为备用与回滚源。绝不立即关闭。**

**什么时候可以安全关闭 Render（全部满足后方可）：**

1. ✅ CloudBase 部署成功，`/api/health` 返回 `database: postgres (cloud)`。
2. ✅ 生产 PostgreSQL 已从 Render 备份并恢复至 CloudBase，且 `users` / `portfolio` / `source_credentials` 三表 `COUNT(*)` 与 Render 一致。
3. ✅ `source_credentials` 抽样解密成功（确认 `SOURCE_SECRET_KEY` 沿用 Render 同一值，历史 Token 可用）。
4. ✅ 小程序 `wx.cloud.callContainer` 联调通过（四环境均 200，含登录、持仓、第三方同步、AI、行情）。
5. ✅ 短信实测可发送；养基宝/小倍同步实测成功；东方财富/Yahoo 行情实测（Yahoo 不通需有预案）。
6. ✅ Web 端切换 `PUBLIC_API_BASE` 后全功能回归通过。
7. ✅ 并行运行期（建议 ≥ 7 天）内，CloudBase 无异常、用户无集中报错、数据无丢失/错乱。
8. ✅ 已保留 Render 最近一次完整备份（DB dump + 镜像/配置），确认可回滚。

**满足上述 8 条后**，才可：
- 在 Render 暂停（Pause）而非删除服务 → 仍可快速恢复；
- 观察 1–2 周无问题后，再考虑彻底删 Render 服务与旧 DB（删除前再次确认备份独立留存）。

> ⚠️ **禁止**在 §B 数据迁移校验完成前关闭 Render——否则一旦 CloudBase 出故障将无回滚源。Render 当前 `SOURCE_SECRET_KEY` 未设、回退 fallback 字面量（`genius-trader-dev-only-source-secret`），CloudBase 与之相同；迁移期间且关闭前必须保持该密钥一致（详见 §五）。

---

## 附：用户侧待办清单（必须手动执行，沙箱无法代做）

1. 填 `mp1/config/api.js`：`CLOUD_ENV_ID`、`CLOUD_SERVICE_NAME`、`PUBLIC_API_BASE`。
2. 确认 `SOURCE_SECRET_KEY` **沿用 Render 生成的同一随机值**（或新建时生成强密钥，但新建会导致历史 Token 失效，需重绑养基宝/小倍）。
3. CloudBase 控制台：建环境 → 建云托管服务（容器，GitHub/Docker 源）→ 注入全部环境变量（含 `DATABASE_URL`、各 `AI_*_API_KEY`、`APP_URL`、`YJB_*`、`XBYJ_*`）。
4. 备份 Render PostgreSQL（`pg_dump`）→ 新建 CloudBase PostgreSQL → `psql` 恢复 → 逐表 `COUNT(*)` 校验。
5. 部署后在微信开发者工具与真机按 §22 逐项功能测试（登录 / 账户 / 持仓 / 第三方同步 / AI / 行情 / 短信 / 二维码展示）。
6. 全部通过且并行运行 ≥7 天无异常，按 §I 的 8 条逐步停用 Render（先 Pause 再观察，最后才删）。

## 附：已交付/已改文件清单

后端（`genius-trader2.0`）：
- `server/index.js`：AI 预构建兜底 + 启动安全（SQLite 失败降级、云模式禁 Seed、确保云 Schema）
- `server/providers/yangjibao.js`：二维码本地 Base64 生成
- `package.json`：`esbuild`/`pg`/`qrcode` 依赖 + `build:ai` 脚本
- `Dockerfile` / `.dockerignore`：容器化部署配置
- `.env.example`：补齐全部环境变量与沿用密钥警告

小程序（`mp1`）：
- `config/api.js`：CloudBase 环境/服务/公网地址配置（待填值）
- `utils/request.js`：统一请求层（callContainer 优先 + wx.request 回退 + 幂等 initCloud）
- `pages/analysis/analysis.js`：4 处直连请求收口为 http.get/post
- `pages/setting/setting.js`：测试地址改 `getApiBase()` 兜底

---

## 阶段二：CloudBase「空环境部署」准备（2026-08-15 补充）

> 本阶段目标：完成 CloudBase 资源规划 + Docker 兼容性确认 + 环境变量清单 + 无 DB 启动验证。**不迁移数据库、不碰 Render。**

### 🔴 部署前必须合入的两个代码修复（本地实测发现）
1. **致命启动崩溃（TDZ）**：原 `server/index.js` 在模块顶部过早调用 `ensureAiBundle()`（第 38 行），而该函数内使用的 `path`/`fs` 在后续第 41–42 行才用 `const` 声明，运行时抛 `ReferenceError: Cannot access 'path' before initialization`，**容器一启动即崩**。`node --check` 查不出（只查语法）。
   - 修复：把 `const fs = require('node:fs'); const path = require('node:path');` 上移到 `.env` 加载块之后、AI 构建块之前，删除下方重复声明。**本地已实测启动通过**。
2. **生产禁写示例数据**：`ensureInitialSeed()` 在「无 DATABASE_URL」时仍会向本地 SQLite 写入示例基金（008702 / 019633），违反「生产禁止自动写示例」。改为 `if (!isCloud() && process.env.NODE_ENV !== 'production')`；并在 `Dockerfile` 增加 `ENV NODE_ENV=production`。空环境部署（无 DATABASE_URL + production）实测：服务干净启动，**不再 seed**。

### 一、CloudBase 连接状态（硬规则前提）
- **本会话未连接 CloudBase（无 CloudBase 连接器/凭证）**，因此无法代你在微信云开发控制台创建环境或部署。
- **需要你在微信云开发控制台创建环境。** 不要假设已有环境。

### 待创建资源清单
| # | 资源 | 说明 |
|---|---|---|
| 1 | CloudBase 环境 | 在云开发控制台为该小程序开通 CloudBase，得到**环境 ID** |
| 2 | 云托管服务 | 容器服务，得到**服务名称**（如 `genius-trader`） |
| 3 | PostgreSQL 数据库 | 本阶段**先不建/不迁**（见阶段三）；后续再建空实例 |
| 4 | 服务名称 | 自定义，对应 `X-WX-SERVICE` 头 |
| 5 | 环境 ID | 控制台生成，填入 `mp1/config/api.js` 的 `CLOUD_ENV_ID`（本阶段留空） |

### 二、最简创建方案
- 目标：把现有 **Node HTTP Server + REST API 原样容器化**，**不用云函数、不重写 API、不改业务逻辑**。`/api/...` 全部保留。
- 路径：云开发控制台 → 云托管 → 新建服务（来源选 **Docker** / 关联 GitHub `DoDong-code/genius-trader2.0`）→ 使用仓库根 `Dockerfile` → 监听端口 `3000` → 健康检查路径 `/api/health` → 在「环境变量」面板配置下表变量。

### 三、Docker 兼容性确认
- 现有 `Dockerfile`（`node:22-alpine`、监听 `0.0.0.0` 并读取注入的 `PORT`、`CMD npm start` → `node server/index.js`）**直接适用于 CloudBase 云托管**，无需改写 Render。
- 仅新增 `ENV NODE_ENV=production`（容器兼容 + 关闭示例 seed）。CloudBase 注入 `PORT`，服务 `process.env.PORT || process.env.FUND_API_PORT || 3000` 已支持。

### 四、环境变量清单（完整扫描 `process.env`，18 个变量 + 文档项）
> 不输出任何真实 Secret。Render 列基于 `render.yaml` 判断；未在 yaml 中的变量代码均有默认值或可选。

| 变量名 | 用途 | 必须 | Render 当前 | CloudBase 是否必须复制 |
|---|---|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串；设置即启用云模式 | 本阶段否 / 迁库阶段**是** | yaml: fromDatabase | 下一阶段复制（自建/外部 PG） |
| `SOURCE_SECRET_KEY` | AES-256-GCM 密钥 = sha256(本值)，加密养基宝/小倍 Token | **是（生产）** | yaml: generateValue（随机） | **必须复制 Render 同一值** |
| `PORT` | 服务端口 | 否（CloudBase 注入/默认 3000） | 默认 | 不需 |
| `FUND_API_PORT` | 端口兜底 | 否 | 默认 3000 | 不需 |
| `NODE_ENV` | 控制 seed/构建行为 | 否（Dockerfile 已设 production） | 未设 | 不需（已 bake） |
| `FUND_DB_PATH` | SQLite 缓存文件路径 | 否（默认 server/data/portfolio.sqlite） | 默认 | 可选（容器可写，或设 /tmp） |
| `YJB_BASE_URL` | 养基宝 API（HTTP） | 否（默认官方地址） | 默认 | 可选（保持默认） |
| `YJB_SECRET` | 养基宝签名密钥 | 否（代码有公开默认） | 默认 | 可选 |
| `XBYJ_BASE_URL` | 小倍 API（HTTPS） | 否（默认官方地址） | 默认 | 可选 |
| `XBYJ_VERSION` | 小倍接口版本 | 否（默认 3.5.7.0） | 默认 | 可选 |
| `OPENAI_API_KEY` | OpenAI | 否（可选 AI） | 未设 | 按需 |
| `DEEPSEEK_API_KEY` | DeepSeek | 否（可选 AI） | 未设 | 按需 |
| `KIMI_API_KEY` | Kimi | 否（可选 AI） | 未设 | 按需 |
| `MOONSHOT_API_KEY` | Kimi 旧品牌别名（=KIMI_API_KEY） | 否 | 未设 | 与 KIMI 二选一 |
| `CLAUDE_API_KEY` | Claude 别名（=ANTHROPIC_API_KEY） | 否 | 未设 | 与 ANTHROPIC 二选一 |
| `ANTHROPIC_API_KEY` | Anthropic Claude | 否（可选 AI） | 未设 | 按需 |
| `GEMINI_API_KEY` | Google Gemini | 否（可选 AI） | 未设 | 按需 |
| `DISABLE_HMR` | Vite 开发 HMR 开关 | 否（仅构建期，运行时无关） | 未设 | 不需 |
| `APP_URL` | 自引用公网地址（**.env.example 文档项，代码未读取**） | 否 | 未设 | 可选 |
| `NODE_VERSION` | **仅 Render 用**（告知 Node 版本） | 否 | yaml: 22 | CloudBase 不需（Dockerfile 锁 node:22） |

### 五、SOURCE_SECRET_KEY（最高优先级，已核实修正）
- **实测修正（2026-08-15）**：Render 生产服务当前**实际未配置** `SOURCE_SECRET_KEY` 环境变量（控制台仅见 `DATABASE_URL`）。代码 `getKey()` 在缺失时回退到硬编码字面量 `DEV_FALLBACK_KEY = 'genius-trader-dev-only-source-secret'`。即 Render 历史 Token 是用**该 fallback 字面量**加密/解密的，并非 `render.yaml` 的 `generateValue` 随机值（`generateValue` 未实际应用于当前生产服务）。
- **CloudBase 当前同样未设 `SOURCE_SECRET_KEY`** → 部署后用同一 fallback 字面量 → 与 Render **密钥一致**，历史 `source_credentials` 可解密。✅（实测 `/api/health` 200，空环境阶段已用该密钥）
- **结论**：迁库阶段**不必**强行复制一个"随机值"；只要 CloudBase 保持不单独设 `SOURCE_SECRET_KEY`（或显式设成与 Render 完全相同的 fallback 字面量），历史 Token 即可解密。若将来要换成真正的强随机密钥，必须在 Render 与 CloudBase **同时**更换，否则历史 Token 失效需重绑养基宝/小倍。
- 本阶段遵守硬规则：不修改 Render、不重新生成、不改动历史凭证。

### 六、无 DATABASE_URL 启动验证（已本地实测）
- 以 `DATABASE_URL=` + `NODE_ENV=production` 启动：服务正常监听 `0.0.0.0:PORT`，`/api/health` 返回 200 `{database: <sqlite路径>}`；**且不写入任何示例数据**。
- 结论：**空环境部署可不配置 DATABASE_URL**，服务能启动并通过健康检查。登录/持仓/第三方同步/AI 等因无 Postgres 暂不可用，属预期（数据库迁移在下一阶段）。

### 七、空环境部署目标
- CloudBase → Node 容器 → `/api/health` 200 → 再测 `/api/...`（无 DB 时部分接口报错属正常）。

### 八、小程序暂不切换
- 保持 `mp1/config/api.js` 中 `CLOUD_ENV_ID=''`、`CLOUD_SERVICE_NAME=''`，小程序仍走 Render，不影响线上版本。

### 九、部署完成后报告（2026-08-15 实测回填）

| # | 项 | 结果 |
|---|---|---|
| ① | CloudBase 环境是否创建 | ✅ 已创建，环境名 `cloud1`，环境 ID `cloud1-d6gh61ypfd7fcbc28` |
| ② | 云托管服务名 | `genius-trader-003`（容器，Live） |
| ③ | 环境 ID | `cloud1-d6gh61ypfd7fcbc28` |
| ④ | 访问方式 | 公网 HTTPS：`https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com`；小程序仍走 Render（未切换） |
| ⑤ | Docker 构建是否成功 | ✅ 成功（镜像 ~277MB 推至 TCR，`create_eks_virtual_service: succ`） |
| ⑥ | Node 服务是否启动 | ✅ 启动成功，监听 `0.0.0.0:3000`（health 返回 `service:"fund-data"`） |
| ⑦ | 健康检查是否成功 | ✅ `GET /api/health` → HTTP 200，`{"success":true,"database":"/app/server/data/portfolio.sqlite",...}` |
| ⑧ | 必填变量是否就绪 | 空环境阶段仅 `NODE_ENV=production`/`PORT` 已 bake；`SOURCE_SECRET_KEY` 未设（自动回退 fallback，与 Render 一致）；`DATABASE_URL` / 各 `AI_*_API_KEY` 等**迁库与 AI 阶段再补** |
| ⑨ | 可否迁移 PostgreSQL | ⏳ 待下一阶段：在 CloudBase 建 PG → 配 `DATABASE_URL` → 从 Render `pg_dump` 恢复 → 逐表校验。空环境当前为 SQLite，不影响先行验证 |

**空环境阶段结论**：CloudBase 容器已成功部署并对外提供 REST API，健康检查通过，采用 SQLite 兜底（无 `DATABASE_URL`）。登录/持仓/第三方同步/AI 等依赖 Postgres 的接口暂不可用，属预期。Render 生产服务仍在 `https://genius-trader.onrender.com` 正常运行，二者并行。下一步进入「配置 DATABASE_URL → 迁库 → 验证历史 Token 解密」。

### 十、产品界面不确定时
- 若控制台的服务类型/数据库配置与预期不符，**停在这里**告诉我具体界面，我据此给出点击步骤，不自行猜测。
