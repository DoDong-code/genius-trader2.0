(function () {
  'use strict';

  const TOKEN_KEY = 'genius-trader-auth-token';
  const state = {
    user: null,
    token: localStorage.getItem(TOKEN_KEY) || '',
    ready: false
  };
  const listeners = [];

  function notify() {
    listeners.forEach(fn => { try { fn(state); } catch (e) { /* ignore */ } });
    window.dispatchEvent(new CustomEvent('auth-changed', { detail: state }));
  }

  function authHeaders() {
    return state.token ? { Authorization: 'Bearer ' + state.token } : {};
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {}, authHeaders());
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || ('HTTP ' + response.status));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function init() {
    state.ready = true;
    if (!state.token) { notify(); return; }
    try {
      const data = await api('/api/auth/me');
      state.user = data.user || null;
      if (!state.user) {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (error) {
      if (error.status === 401) {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
      }
    }
    notify();
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    notify();
  }

  async function login(email, password) {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setSession(data.token, data.user);
    return data.user;
  }

  async function register(email, password) {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setSession(data.token, data.user);
    return data.user;
  }

  async function logout() {
    const token = state.token;
    // 退出前把当前状态（含各账户投资策略等）同步到云端，避免丢失
    if (token && typeof window.backupToCloud === 'function') {
      try { await window.backupToCloud(); } catch (e) { /* 云端同步失败不阻塞退出 */ }
    }
    state.user = null;
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    if (typeof window.clearLocalData === 'function') window.clearLocalData();
    notify();
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      }).catch(() => {});
    }
  }

  // ---- UI（入口位于右上角「•••」菜单）----
  function overlay(html) {
    const layer = document.createElement('div');
    layer.className = 'confirm-overlay apple-dialog-overlay auth-overlay';
    layer.innerHTML = html;
    document.body.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('visible'));
    const close = () => {
      layer.classList.remove('visible');
      setTimeout(() => layer.remove(), 180);
    };
    layer.addEventListener('click', e => {
      if (e.target === layer || e.target.closest('[data-role="cancel"]')) close();
    });
    return { layer, close };
  }

  function openAuthModal() {
    const { layer, close } = overlay(`
      <div class="confirm-dialog apple-dialog auth-dialog" role="dialog" aria-modal="true">
        <h2 id="auth-title">登录</h2>
        <p class="apple-dialog-message">登录后，你的账户与持仓会自动同步到云端，换设备也不丢失。</p>
        <div class="auth-form">
          <label><span>邮箱</span><input id="auth-email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
          <label><span>密码</span><input id="auth-password" type="password" autocomplete="current-password" placeholder="至少 6 位" required></label>
          <div id="auth-error" class="auth-error" style="display:none;"></div>
        </div>
        <div class="confirm-actions apple-dialog-actions">
          <button type="button" class="apple-dialog-cancel" data-role="cancel">取消</button>
          <button type="button" class="primary" id="auth-submit">登录</button>
        </div>
        <button type="button" id="auth-switch" class="auth-switch">没有账号？注册</button>
      </div>
    `);
    let mode = 'login';
    const title = layer.querySelector('#auth-title');
    const submit = layer.querySelector('#auth-submit');
    const switchBtn = layer.querySelector('#auth-switch');
    const emailInput = layer.querySelector('#auth-email');
    const passwordInput = layer.querySelector('#auth-password');
    const errorBox = layer.querySelector('#auth-error');
    emailInput.focus();

    function showError(message) {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    }

    function setMode(next) {
      mode = next;
      title.textContent = mode === 'login' ? '登录' : '注册';
      submit.textContent = mode === 'login' ? '登录' : '注册';
      switchBtn.textContent = mode === 'login' ? '没有账号？注册' : '已有账号？登录';
      passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    }

    switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    async function submitForm() {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) { showError('请输入邮箱和密码'); return; }
      submit.disabled = true;
      submit.textContent = mode === 'login' ? '登录中…' : '注册中…';
      try {
        if (mode === 'login') await login(email, password);
        else await register(email, password);
        close();
        // 登录后立即把当前本地状态同步到云端（首次迁移）
        if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
        const activeTab = document.querySelector('.nav-tab.active');
        if (activeTab) activeTab.click();
      } catch (error) {
        showError(error.message || '操作失败，请重试');
        submit.disabled = false;
        submit.textContent = mode === 'login' ? '登录' : '注册';
      }
    }
    submit.addEventListener('click', submitForm);
    layer.querySelectorAll('input').forEach(input => {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); });
    });
  }

  function openAccountMenu() {
    const { layer, close } = overlay(`
      <div class="confirm-dialog apple-dialog auth-dialog" role="dialog" aria-modal="true" style="position: relative;">
        <button type="button" data-role="cancel" aria-label="关闭" style="position: absolute; right: 14px; top: 14px; width: 30px; height: 30px; border: 0; border-radius: 50%; background: #f0f0f2; color: #6e6e73; font-size: 17px; line-height: 1; cursor: pointer;">×</button>
        <h2>已登录</h2>
        <p class="apple-dialog-message">${escapeHtml(state.user ? state.user.email : '')}，数据已同步到云端。</p>
        <div style="display: flex; gap: 10px; margin: 4px 0 0;">
          <button type="button" class="secondary-button" id="auth-backup-btn" style="flex: 1;">立即备份</button>
          <button type="button" class="secondary-button" id="auth-restore-btn" style="flex: 1;">恢复本地</button>
        </div>
        <!-- P2：备份功能移入账号弹窗，两个按钮下方增加「备份列表」 -->
        <div style="margin-top: 8px;">
          <button type="button" class="secondary-button" id="auth-backups-btn" style="width: 100%;">备份列表</button>
        </div>
      </div>
    `);
    const backupBtn = layer.querySelector('#auth-backup-btn');
    const restoreBtn = layer.querySelector('#auth-restore-btn');
    const backupsBtn = layer.querySelector('#auth-backups-btn');
    backupsBtn.addEventListener('click', () => {
      if (typeof window.openBackupManager === 'function') {
        window.openBackupManager();
      } else {
        window.showToast('备份功能暂不可用', 'warning');
      }
    });
    backupBtn.addEventListener('click', async () => {
      backupBtn.disabled = true;
      backupBtn.textContent = '备份中…';
      try {
        const ok = await window.backupToCloud();
        if (ok) window.showToast('已备份到云端');
        else window.showToast('请先登录账号', 'warning');
      } catch (error) {
        window.showToast('备份失败：' + (error.message || '网络错误'), 'error');
      } finally {
        backupBtn.disabled = false;
        backupBtn.textContent = '立即备份';
      }
    });
    restoreBtn.addEventListener('click', async () => {
      const confirmRestore = await window.showAppleDialog({
        title: '恢复本地',
        message: '将用云端数据覆盖当前本地账户数据（同步账户不受影响）。是否继续？',
        okText: '恢复',
        cancelText: '取消',
        danger: true
      });
      if (!confirmRestore) return;
      restoreBtn.disabled = true;
      restoreBtn.textContent = '恢复中…';
      try {
        const ok = await window.restoreFromCloud();
        if (ok) window.showToast('已从云端恢复');
        else window.showToast('云端暂无数据，或请先登录账号', 'warning');
      } catch (error) {
        window.showToast('恢复失败：' + (error.message || '网络错误'), 'error');
      } finally {
        restoreBtn.disabled = false;
        restoreBtn.textContent = '恢复本地';
      }
    });
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  window.auth = {
    state,
    api,
    authHeaders,
    login,
    register,
    logout,
    init,
    openModal: openAuthModal,
    openAccountMenu,
    onChange(fn) { listeners.push(fn); }
  };

  init();
})();
