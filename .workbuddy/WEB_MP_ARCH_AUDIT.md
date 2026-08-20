# WEB_MP_ARCH_AUDIT.md — 第三方登录 vs 开发管理权限 架构审计

> 生成：2026-08-16。纯审计，未修改代码/数据库/API。
> 目标：彻底解耦「养基宝登录」与「微信小程序开发管理权限」。

---

## 一、当前架构（完整调用链）

### 1. 养基宝二维码登录

```
小程序 setting.js fetchYjbQrcode()
  ↓ http.post('/api/provider/yangjibao/qrcode')
小程序 utils/request.js request()
  ↓ 优先 wx.cloud.callContainer（CloudBase 云托管，需环境绑定 AppID）
  ↓ 失败回退 wx.request 公网域名
后端 genius-trader 服务（CloudBase 云托管，公网域名 genius-trader-297358...run.tcloudbase.com）
  ↓ api/provider.js → providers/yangjibao.js getQRCode()
  ↓ fetch('http://browser-plug-api.yangjibao.com/qr_code')   ← 后端调用，小程序不接触
  ↓ 拿到 qr_content，用 qrcode npm 包转 base64 data URI
  ↓ 返回 { qr_id, qr_url, qr_data_url, qr_base64 }
小程序 直接用 qr_data_url（data:image/png;base64）展示 <image>
```

### 2. 小倍养基短信登录

```
小程序 setting.js onXbyjSms/onXbyjLogin
  ↓ http.post('/api/provider/xiaobeiyangji/sendSMS'|'login')
  ↓ 同一 request 层（callContainer 优先 / wx.request 回退）
后端 xiaobeiyangji.js → fetch('https://api.xiaobeiyangji.com/...')
  ↓ 后端调用，小程序不接触
```

### 3. 登录状态保存

- 第三方凭证 token → 后端 `services/sourceCredentials.js` → **Postgres 表 source_credentials**（user_id, source_name, token, status...）
- 小程序本地 → `app.globalData.providerStatus`（仅显示状态，非真实 token）
- **小程序无 wx.login**（无 code2Session/access_token/authorization_code），只有 `wx.getUserProfile`（头像昵称）

### 4. CloudBase / Render 分工

| 职责 | 载体 |
|---|---|
| 小程序接口（fund/provider/market/ai） | CloudBase 云托管 genius-trader 服务 |
| 业务数据库 | Postgres（Render External URL） |
| 第三方凭证 token | Postgres source_credentials 表 |
| 前端云同步（accounts collection） | wx.cloud.database（CloudBase 云数据库）+ localStorage 降级 |
| 养基宝/小倍真实 API | 后端 providers/（yangjibao.js / xiaobeiyangji.js） |

---

## 二、第三方平台授权到底用在哪

**结论：养基宝二维码登录根本不需要微信第三方平台授权。**

代码里没有任何「微信第三方平台 API / open platform / 微搭」调用。授权第三方平台（微搭低代码）**唯一的作用**是让 `wx.cloud.callContainer` 的 `-501000 Invalid host` 消失——即把小程序 AppID 绑定到 CloudBase 环境 `cloud1`。

而这个「绑定」动作，走的是**微搭低代码的授权流程**，副作用是把微信公众平台的「开发管理」托管给了腾讯云。

---

## 三、养基宝二维码（完整请求）

| 项 | 值 |
|---|---|
| Request URL（小程序→后端） | `POST /api/provider/yangjibao/qrcode` |
| 调用文件 | `pages/setting/setting.js` → `fetchYjbQrcode()` |
| 传输通道 | `utils/request.js`（callContainer 优先 / wx.request 回退） |
| 后端接口 | `server/api/provider.js` → `provider.getQRCode()` |
| 后端真实数据源 | `providers/yangjibao.js` → `http://browser-plug-api.yangjibao.com/qr_code` |
| 二维码图片 | 后端 `qrcode` 包生成 base64（`qr_data_url`），小程序直接展示 |

**关键**：二维码图片是后端生成的 base64 data URI，小程序 `<image>` 直接用，**不需要 downloadFile、不需要任何第三方图片域名**。

---

## 四、「请求域名未配置」的真正原因

**真正请求的 URL**：`https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com/api/...`

- 授权微搭时：callContainer 直连成功（环境已绑定），不需要 request 合法域名
- 解除授权后：callContainer 报 `-501000 Invalid host` → 回退 `wx.request` 公网域名 → 该域名**不在 request 合法域名白名单** → 报「请求域名未配置」

所以「请求域名未配置」和「第三方授权」是**同一枚硬币的两面**，都是「小程序请求自己后端」这一件事的不同通道。

---

## 五、代码哪里依赖了第三方平台授权

| 位置 | 依赖 |
|---|---|
| `utils/request.js` `useContainerMode()` | 依赖 `wx.cloud.callContainer`（需 CloudBase 环境绑定 AppID） |
| `utils/request.js` `initCloud()` | 依赖 `wx.cloud.init`（需绑定云环境） |
| `utils/request.js` `dbCollection()` | 依赖 `wx.cloud.database`（需绑定云环境，否则降级 localStorage） |

**没有任何一处**直接依赖「微搭 / 第三方平台 / open platform」API。依赖的是 **CloudBase 环境绑定**，而这个绑定当前只能通过微搭授权完成，副作用是托管开发权限。

---

## 六、最小修改方案（推荐：方案 A）

**目标：不授权第三方平台 + 开发管理自主 + 体验版正常 + 养基宝登录正常 + 同步正常**

### 方案 A（推荐）：wx.request 直连公网域名，彻底放弃 callContainer

1. **微信公众平台 → 开发设置 → 服务器域名 → request 合法域名**，添加：
   `https://genius-trader-297358-8-1468165942.sh.run.tcloudbase.com`
2. **修改 `utils/request.js`**：`useContainerMode()` 恒返回 false（或删除 callContainer 分支），所有请求走 `wx.request` 公网域名
3. **云同步降级说明**：`wx.cloud.database` 因环境未绑定会降级 localStorage（单机）。若需跨设备云同步，走方案 C。

代价：callContainer 的「无需域名白名单」优势放弃；云数据库降级本地。

### 方案 B：保留 callContainer，但找不托管开发权限的绑定方式

需要到 CloudBase 控制台确认是否有「直接绑定小程序 AppID」的入口（不经过微搭授权）。**从现有经验看，CloudBase 的「小程序认证」就是微搭授权流程，方案 B 大概率不可行。**

### 方案 C（彻底解耦 + 保留云同步）：云同步改走后端接口

- 前端云同步从 `wx.cloud.database` 改为后端接口（后端已有 `/api/account/state` GET/PUT，需补鉴权或改走 sourceCredentials）
- 这样小程序**完全不依赖 CloudBase 环境绑定**，request 合法域名只配置自己的公网域名

### 附带：删除冗余的 qrserver.com 兜底

`setting.js:524` 的 `api.qrserver.com` 兜底是冗余的（后端已返回 base64），应删除，避免多一个不在白名单的外部域名。

---

## 七、如果确实无法解耦

若 CloudBase 官方只允许「微搭授权」这一种绑定方式（无法在不托管开发权限的前提下绑定环境），则唯一出路是**方案 A 或 C**（放弃 callContainer / 云数据库，改走公网域名）。这时：

- 开发测试小程序保持自己管理（用方案 A 的 request 合法域名即可测试养基宝登录）
- 生产小程序若坚持用 callContainer，才考虑授权，但必须接受「开发管理被托管」的事实

**结论：养基宝登录能力本身不需要第三方平台授权，完全可以靠 request 合法域名 + 公网域名解耦。**
