/**
 * 第三方 Provider API
 *
 * 路由：
 *   POST /api/provider/:source/qrcode       获取二维码（养基宝）
 *   GET  /api/provider/:source/status       轮询扫码状态（?qr_id=）或查询凭证状态
 *   POST /api/provider/:source/sendSMS      发送短信验证码（小倍养基）
 *   POST /api/provider/:source/login        验证码登录（小倍养基）
 *   POST /api/provider/:source/import       一键导入持仓
 *   POST /api/provider/:source/logout       退出登录
 */
const { getProvider } = require('../providers/registry');
const { sendJson } = require('./fund');
const {
  getCredential,
  saveCredential,
  disconnectCredential
} = require('../services/sourceCredentials');
const { normalizeProviderAccounts } = require('../services/importProvider');
const { replaceSyncedAccount } = require('../services/portfolioService');

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let chunkStr = '';
    request.on('data', chunk => { chunkStr += chunk; });
    request.on('end', () => {
      try {
        resolve(chunkStr ? JSON.parse(chunkStr) : {});
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', err => reject(err));
  });
}

function credentialStatus(sourceName) {
  const credential = getCredential(sourceName);
  const loggedIn = Boolean(credential && credential.status === 'connected' && credential.token);
  return {
    logged_in: loggedIn,
    status: credential ? credential.status : 'disconnected',
    last_sync_at: loggedIn ? credential.updated_at : null,
    source_name: sourceName
  };
}

async function handleProviderApi(request, response, url) {
  const match = url.pathname.match(/^\/api\/provider\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return false;

  const [, sourceName, action] = match;
  const provider = getProvider(sourceName);
  if (!provider) {
    sendJson(response, 404, { success: false, error: `未知数据源: ${sourceName}` });
    return true;
  }

  const method = request.method;

  try {
    if (action === 'qrcode' && method === 'POST') {
      const qr = await provider.getQRCode();
      return sendJson(response, 200, { success: true, ...qr });
    }

    if (action === 'status' && method === 'GET') {
      const qrId = url.searchParams.get('qr_id');
      if (qrId) {
        const state = await provider.checkQRCode(qrId);
        if (state.state === 'confirmed' && state.token) {
          saveCredential({ source_name: sourceName, token: state.token, status: 'connected' });
        }
        return sendJson(response, 200, { success: true, ...state });
      }
      return sendJson(response, 200, { success: true, ...credentialStatus(sourceName) });
    }

    if (action === 'sendSMS' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.phone) {
        return sendJson(response, 400, { success: false, error: '缺少 phone 参数' });
      }
      await provider.sendSMS(body.phone);
      return sendJson(response, 200, { success: true, message: '验证码已发送' });
    }

    if (action === 'login' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.phone || !body.code) {
        return sendJson(response, 400, { success: false, error: '缺少 phone 或 code 参数' });
      }
      const result = await provider.verifySMS(body.phone, body.code);
      saveCredential({
        source_name: sourceName,
        token: result.token,
        user_info: result.user_info,
        status: 'connected'
      });
      return sendJson(response, 200, { success: true, message: '登录成功' });
    }

    if (action === 'import' && method === 'POST') {
      const credential = getCredential(sourceName);
      if (!credential || credential.status !== 'connected' || !credential.token) {
        return sendJson(response, 401, { success: false, error: `未登录${provider.displayName}，请先登录` });
      }
      provider.setToken(credential.token);
      try {
        const payload = await normalizeProviderAccounts(provider);
        // 阶段1：同步账户持仓写入服务端权威库
        for (const account of payload.accounts || []) {
          replaceSyncedAccount(account.name, account.funds);
        }
        // 导入成功即刷新最后同步时间
        saveCredential({
          source_name: sourceName,
          token: credential.token,
          refresh_token: credential.refresh_token,
          cookie: credential.cookie,
          user_info: credential.user_info,
          status: 'connected'
        });
        return sendJson(response, 200, {
          success: true,
          provider: payload.provider,
          accounts: payload.accounts,
          persisted: true,
          imported_at: new Date().toISOString()
        });
      } catch (importErr) {
        if (importErr.statusCode === 401 || /未登录|登录已过期|401/i.test(importErr.message || '')) {
          disconnectCredential(sourceName);
          return sendJson(response, 401, {
            success: false,
            error: '登录已过期，请重新登录',
            token_expired: true
          });
        }
        throw importErr;
      }
    }

    if (action === 'logout' && method === 'POST') {
      disconnectCredential(sourceName);
      provider.logout();
      return sendJson(response, 200, { success: true });
    }

    return sendJson(response, 404, { success: false, error: '接口不存在' });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode === 401) {
      disconnectCredential(sourceName);
      return sendJson(response, 401, {
        success: false,
        error: '登录已过期，请重新登录',
        token_expired: true
      });
    }
    return sendJson(response, statusCode, { success: false, error: err.message || '服务异常' });
  }
}

module.exports = { handleProviderApi };
