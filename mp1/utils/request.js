// utils/request.js
// 统一请求层：所有业务请求走 wx.request → Render 后端。
// 已彻底移除 wx.cloud（initCloud / callContainer / database）依赖。
import { PUBLIC_API_BASE } from '../config/api.js';

export { PUBLIC_API_BASE };

// 默认 API 基地址：本地开发可手动覆盖 api_base_url；否则走 Render 生产域名。
export function getApiBase() {
  const stored = wx.getStorageSync('api_base_url');
  if (stored && !/localhost|127\.0\.0\.1/i.test(stored)) {
    return stored;
  }
  return PUBLIC_API_BASE;
}

// ---- 登录 token 管理（正式多用户：邮箱+密码登录，Bearer token 存本地）----
const TOKEN_KEY = 'genius-trader-auth-token';

export function getAuthToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

export function setAuthToken(token) {
  try { wx.setStorageSync(TOKEN_KEY, token || ''); } catch (e) { /* ignore */ }
}

export function clearAuthToken() {
  try { wx.removeStorageSync(TOKEN_KEY); } catch (e) { /* ignore */ }
}

// token 失效统一处理：清 token + 清 auth（不删本地账户数据、不自动 logout、不触发重试）
function handleUnauthorized() {
  clearAuthToken();
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.auth = { token: '', user: null };
    }
  } catch (e) { /* ignore */ }
}

// 统一请求封装：仅 wx.request，超时 30s，成功/失败均正确结束 Loading。
// 所有请求自动注入 Authorization: Bearer <token>（如有登录态），页面无需自行拼接。
export function request(url, options = {}) {
  const method = options.method || 'GET';
  const headers = { 'content-type': 'application/json', ...options.headers };
  const token = getAuthToken();
  if (token && !headers['Authorization']) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const data = options.data || {};

  if (!options.silent) {
    wx.showLoading({ title: options.loadingText || '加载中...', mask: true });
  }
  const finish = () => { if (!options.silent) wx.hideLoading(); };

  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : `${getApiBase()}${url}`;
    // 开发者工具性能保护：每个请求都打 console.log 会在 devtools 单线程渲染下累积成百上千条，
    // 导致模拟器主线程打满、界面点不动（真机正常）。默认关闭，按需开启：
    //   wx.setStorageSync('debug_requests', true)
    if (wx.getStorageSync('debug_requests')) {
      console.log('[request] wx.request ->', fullUrl);
    }
    wx.request({
      url: fullUrl,
      method,
      data,
      header: headers,
      timeout: 30000,
      success(res) {
        finish();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          // 401 统一处理：登录/注册接口的 401 是「凭证错误」，其余接口是「token 失效」
          const isAuthEndpoint = /\/api\/auth\/(login|register)/.test(url);
          if (!isAuthEndpoint) {
            handleUnauthorized();
            if (!options.silent) {
              wx.showToast({ title: '登录已失效，请重新登录', icon: 'none', duration: 3000 });
            }
          }
          const errMsg = (res.data && res.data.error) || '登录已失效，请重新登录';
          reject(new Error(errMsg));
        } else {
          const errMsg = res.data && res.data.error ? res.data.error : `请求失败 (${res.statusCode})`;
          if (!options.silent) wx.showToast({ title: errMsg, icon: 'none', duration: 3000 });
          reject(new Error(errMsg));
        }
      },
      fail(err) {
        finish();
        const raw = (err && (err.errMsg || err.message)) || '';
        const msg = /domain|合法域名|url not in/i.test(raw)
          ? '请求域名未配置，请在小程序后台配置 request 合法域名'
          : (raw || '网络连接错误');
        if (!options.silent) wx.showToast({ title: msg, icon: 'none', duration: 3500 });
        reject(new Error(msg));
      }
    });
  });
}

// Helper methods
export const http = {
  get: (url, data, options = {}) => request(url, { ...options, method: 'GET', data }),
  post: (url, data, options = {}) => request(url, { ...options, method: 'POST', data }),
  put: (url, data, options = {}) => request(url, { ...options, method: 'PUT', data }),
  delete: (url, data, options = {}) => request(url, { ...options, method: 'DELETE', data })
};
