# WEB_MP_API_PARITY.md — Web ↔ 小程序 API 完整对照

> 生成：2026-08-16。Web 后端源码根：`Codex3 基金/天才交易员/server/`（入口 `index.js` → `api/fund.js` 转发 `api/provider.js`、`api/external.js`）。
> 小程序请求层：`mp1/utils/request.js` + `config/api.js`。
> 一致性：PASS（地址/方法/参数一致）· PARTIAL（有差异）· MISSING（小程序未调用，架构差异）· FAIL（错误地址/错误服务名）。

---

## 〇、生产配置核对（防止调用 localhost / Render / 错误服务名）

| 项 | Web（生产） | 小程序 config/api.js | 结论 |
|---|---|---|---|
| 服务名 | `genius-trader` | `CLOUD_SERVICE_NAME='genius-trader'` | ✅ 一致 |
| 环境 ID | `cloud1-d6gh61ypfd7fcbc28` | `CLOUD_ENV_ID='cloud1-d6gh61ypfd7fcbc28'` | ✅ 一致 |
| 公网域名 | `genius-trader-297358-8-1468165942.sh.run.tcloudbase.com` | `PUBLIC_API_BASE` 同值 | ✅ 一致 |
| 数据库 | PostgreSQL (Render External URL) | 后端 health 返回 `database: postgres` | ✅ 一致 |
| SOURCE_SECRET_KEY | `genius-trader-dev-only-source-secret` | 服务端解密用 | ✅ 一致 |

**残留风险（需修）**：`utils/request.js` 第 5 行 `const DEFAULT_API_BASE = 'http://localhost:3000';`，`getApiBase()` 在 CloudBase 配置齐全时返回 `PUBLIC_API_BASE`（安全），但 `localhost` 兜底分支仍存在 → 见 DIFF-API-001（P1）。

---

## 一、基金数据类（FUND）

| # | Web 地址 | Method | 小程序地址 | Method | 参数 | 一致性 |
|---|---|---|---|---|---|---|
| 1 | `/api/fund/:code` | GET | `/api/fund/${code}?refresh=1&fast=1` | GET | code 路径参数；refresh/fast 查询 | PASS |
| 2 | `/api/fund/:code/history` | GET | （未调用，详情内联 history） | — | — | MISSING（小程序走 #1 拿全量，无需独立） |
| 3 | `/api/fund/:code/estimate` | GET | `/api/fund/${code}/estimate?amount=&mode=provider&source=` | GET | amount/mode/source | PASS |
| 4 | `/api/fund/:code/calibration` | GET | `/api/fund/${code}/calibration` + `?recalibrate=1` | GET | recalibrate 强制重算 | PASS |
| 5 | `/api/funds` | GET | `/api/funds` | GET | 无 | PASS（返回 DB 已导入基金，非全量目录） |
| 6 | `/api/fund/import/:code` | POST | （未调用） | — | — | MISSING（小程序添加基金走本地 + #1） |
| 7 | `/api/stock/:code` | GET | （未调用） | — | — | MISSING（前十大持仓不拉个股实时涨跌，P2） |

## 二、行情类（MARKET）

| # | Web 地址 | Method | 小程序地址 | Method | 一致性 |
|---|---|---|---|---|---|
| 8 | `/api/market/status` | GET | `/api/market/status` | GET | PASS |
| 9 | `/api/market/indices` | GET | `/api/market/indices` | GET | PASS |

## 三、AI 类（AI）

| # | Web 地址 | Method | 小程序地址 | Method | 参数 | 一致性 |
|---|---|---|---|---|---|---|
| 10 | `/api/ai/analyze` | POST | `/api/ai/analyze` | POST | 账户/持仓/策略（见 AI-007 账户参数核对） | PASS（地址一致，参数需核对账户一致性） |
| 11 | `/api/ai/chat` | POST | `/api/ai/chat` | POST | 同上 | PASS |
| 12 | `/api/ai/models` | GET | （未调用） | — | — | MISSING（小程序固定模型，不拉列表） |

## 四、第三方同步类（PROVIDER）

| # | Web 地址 | Method | 小程序地址 | Method | 一致性 |
|---|---|---|---|---|---|
| 13 | `/api/provider/:source/qrcode` | POST | `/api/provider/yangjibao/qrcode` | POST | PASS |
| 14 | `/api/provider/:source/status?qr_id=` | GET | `/api/provider/yangjibao/status?qr_id=` | GET | PASS |
| 15 | `/api/provider/:source/sendSMS` | POST | `/api/provider/xiaobeiyangji/sendSMS` | POST | PASS |
| 16 | `/api/provider/:source/login` | POST | `/api/provider/xiaobeiyangji/login` | POST | PASS |
| 17 | `/api/provider/:source/import` | POST | `/api/provider/${source}/import` `{overwrite}` | POST | PASS |
| 18 | `/api/provider/:source/logout` | POST | `/api/provider/yangjibao/logout` + `/xiaobeiyangji/logout` | POST | PASS |
| 19 | `/api/provider/:source/status`（查凭证） | GET | `/api/provider/${key}/status` | GET | PASS（loadProviderStatus 用） |

## 五、账号/云同步/账户服务端类（AUTH / ACCOUNT / PORTFOLIO-SERVER）

> 这些是 Web 服务端多用户体系的核心，小程序因「微信 openid + CloudBase DB/localStorage」架构，**不调用**。属架构差异（MISSING/不适用），非缺陷。

| # | Web 地址 | Method | 用途 | 小程序 | 一致性 |
|---|---|---|---|---|---|
| 20 | `/api/auth/register` | POST | 邮箱注册 | 微信 openid，不调 | MISSING（架构） |
| 21 | `/api/auth/login` | POST | 邮箱登录 | 微信登录 | MISSING（架构） |
| 22 | `/api/auth/logout` | POST | 退出 | 本地清 openid | MISSING（架构） |
| 23 | `/api/auth/me` | GET | 查当前用户 | — | MISSING（架构） |
| 24 | `/api/account/state` GET | GET | 拉云端状态 | CloudBase DB / localStorage | MISSING（架构） |
| 25 | `/api/account/state` PUT | PUT | 存云端状态 | saveStateToCloud | MISSING（架构） |
| 26 | `/api/portfolio/delete` | POST | 服务端物理删同步账户 | 本地 delete + 手动云同步 | MISSING（架构） |
| 27 | `/api/portfolio/rename` | POST | 同步账户改名休眠 | **缺失**（见 MIG-001，本地 convertAccountToLocal 可补） | MISSING（架构） |
| 28 | `/api/portfolio/update` | POST | replaceSyncedAccount | _mergeImportedAccounts | MISSING（架构） |
| 29 | `/api/portfolio/accounts` | GET | 拉账户列表 | 本地 globalData.accounts | MISSING（架构） |
| 30 | `/api/external/*`（analysis/token） | GET/POST | 只读外部分析 + Token | callContainer 直连，不调 | MISSING（架构） |

---

## 六、差异问题清单

### DIFF-API-001  request.js localhost 兜底残留
- **位置**：`mp1/utils/request.js:5` `const DEFAULT_API_BASE = 'http://localhost:3000';`
- **风险**：`getApiBase()` 当前配置齐全时返回 PUBLIC_API_BASE（安全），但若未来 CLOUD_ENV_ID 配置缺失，会回退 `wx.getStorageSync('api_base_url') || 'http://localhost:3000'`，可能打到 localhost 404。
- **优先级**：P1
- **建议**：`DEFAULT_API_BASE` 改为 `PUBLIC_API_BASE`，彻底移除 localhost 字面量。

### DIFF-API-002  无 `/api/portfolio/rename` 服务端休眠
- **影响**：Web 同步账户改名/移动时调服务端休眠原记录；小程序无服务端账户体系，无法调。但**本地 convertAccountToLocal**（改 accountType/syncSource/打标记）可在小程序本地完成，业务结果（解除同步、不再自动恢复）等价。
- **优先级**：P0（随 MIG-001 修复）

### DIFF-API-003  估值/校准/详情参数已对齐，无错误服务名
- 确认 `config/api.js` 服务名已从 `genius-trader-003` 修正为 `genius-trader`（历史 bug 已修，勿回退）。

---

## 七、统计

- Web 端点总数：约 30 个（含 external/token）
- 小程序已调用：18 个（fund/estimate/calibration/funds/market×2/ai×2/provider×10）
- 地址一致（PASS）：18 个
- 架构性不调用（MISSING/不适用）：12 个
- 需修复（P1）：DIFF-API-001（localhost 残留）
