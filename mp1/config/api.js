// config/api.js
// 微信小程序统一后端接入配置。
//
// 最终架构：小程序所有业务请求统一走 wx.request → Render 后端 → PostgreSQL。
// 已彻底移除 wx.cloud（callContainer / database / init）依赖，不再需要
// CloudBase 环境绑定小程序 AppID，也不再触发微搭第三方平台授权托管开发管理。

// 生产 API 基地址（Render 后端）
export const PUBLIC_API_BASE = 'https://genius-trader.onrender.com';
