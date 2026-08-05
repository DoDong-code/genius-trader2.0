// utils/request.js
const DEFAULT_API_BASE = 'https://ais-dev-epsmejybqglmqess2x7hc4-466561077391.us-east1.run.app';

// Get active API server URL
export function getApiBase() {
  return wx.getStorageSync('api_base_url') || DEFAULT_API_BASE;
}

// Request wrapper for calling server-side REST APIs
export function request(url, options = {}) {
  const apiBase = getApiBase();
  const fullUrl = url.startsWith('http') ? url : `${apiBase}${url}`;

  if (!options.silent) {
    wx.showLoading({ title: options.loadingText || '加载中...', mask: true });
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: fullUrl,
      method: options.method || 'GET',
      data: options.data || {},
      header: {
        'content-type': 'application/json',
        ...options.headers
      },
      success(res) {
        if (!options.silent) wx.hideLoading();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const errMsg = res.data && res.data.error ? res.data.error : `请求失败 (${res.statusCode})`;
          if (!options.silent) {
            wx.showToast({ title: errMsg, icon: 'none', duration: 3000 });
          }
          reject(new Error(errMsg));
        }
      },
      fail(err) {
        if (!options.silent) {
          wx.hideLoading();
          wx.showToast({ title: '网络连接错误', icon: 'error', duration: 3000 });
        }
        reject(err);
      }
    });
  });
}

// Helper methods
export const http = {
  get: (url, data, options = {}) => request(url, { ...options, method: 'GET', data }),
  post: (url, data, options = {}) => request(url, { ...options, method: 'POST', data })
};

// WeChat Cloud Development DB Helper (Graceful Fallback to LocalStorage)
let isCloudInitialized = false;
let cloudDb = null;

export function initCloud() {
  if (wx.cloud) {
    try {
      wx.cloud.init({
        env: wx.cloud.DYNAMIC_CURRENT_ENV
      });
      isCloudInitialized = true;
      cloudDb = wx.cloud.database();
      console.log('[Cloud] WeChat Cloud Development successfully initialized.');
      return true;
    } catch (e) {
      console.warn('[Cloud] Cloud development initialization skipped or failed:', e.message);
    }
  }
  return false;
}

// Query or write to Cloud DB or local storage
export async function dbCollection(name) {
  if (!isCloudInitialized && initCloud()) {
    console.log('[Cloud] Lazy-initialized cloud connection.');
  }

  const openId = wx.getStorageSync('user_openid') || 'mock_openid_guest';

  // If cloud development database is active, return a simplified query client
  if (isCloudInitialized && cloudDb) {
    const col = cloudDb.collection(name);
    return {
      type: 'cloud',
      query: col,
      async get(whereClause = {}) {
        try {
          const res = await col.where({ ...whereClause, _openid: openId }).get();
          return res.data;
        } catch (err) {
          console.error(`[Cloud] Query collection ${name} failed:`, err);
          return null;
        }
      },
      async add(data) {
        try {
          const res = await col.add({ data: { ...data, _openid: openId, created_at: cloudDb.serverDate() } });
          return res._id;
        } catch (err) {
          console.error(`[Cloud] Add to collection ${name} failed:`, err);
          throw err;
        }
      },
      async update(id, data) {
        try {
          await col.doc(id).update({ data: { ...data, updated_at: cloudDb.serverDate() } });
          return true;
        } catch (err) {
          console.error(`[Cloud] Update doc in collection ${name} failed:`, err);
          throw err;
        }
      },
      async remove(id) {
        try {
          await col.doc(id).remove();
          return true;
        } catch (err) {
          console.error(`[Cloud] Remove doc in collection ${name} failed:`, err);
          throw err;
        }
      }
    };
  }

  // Fallback to unified local storage mock collections
  const localKey = `genius_trader_db_${name}`;
  let store = wx.getStorageSync(localKey) || [];
  
  return {
    type: 'local',
    async get(whereClause = {}) {
      return store.filter(item => {
        // filter by userId/openid and fields
        if (item._openid !== openId) return false;
        for (const [key, val] of Object.entries(whereClause)) {
          if (item[key] !== val) return false;
        }
        return true;
      });
    },
    async add(data) {
      const _id = Math.random().toString(36).substring(2, 15);
      const record = { ...data, _id, _openid: openId, created_at: new Date().toISOString() };
      store.push(record);
      wx.setStorageSync(localKey, store);
      return _id;
    },
    async update(id, data) {
      const index = store.findIndex(item => item._id === id);
      if (index !== -1) {
        store[index] = { ...store[index], ...data, updated_at: new Date().toISOString() };
        wx.setStorageSync(localKey, store);
        return true;
      }
      throw new Error('Record not found');
    },
    async remove(id) {
      const index = store.findIndex(item => item._id === id);
      if (index !== -1) {
        store.splice(index, 1);
        wx.setStorageSync(localKey, store);
        return true;
      }
      throw new Error('Record not found');
    }
  };
}
