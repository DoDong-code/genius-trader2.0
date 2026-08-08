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
    state.user = null;
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
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
      <div class="confirm-dialog apple-dialog auth-dialog" role="dialog" aria-modal="true">
        <h2>已登录</h2>
        <p class="apple-dialog-message">${escapeHtml(state.user ? state.user.email : '')}，数据已同步到云端。</p>
        <div class="confirm-actions apple-dialog-actions">
          <button type="button" class="apple-dialog-cancel" data-role="cancel">取消</button>
          <button type="button" class="apple-dialog-danger" id="auth-logout-btn">退出登录</button>
        </div>
      </div>
    `);
    layer.querySelector('#auth-logout-btn').addEventListener('click', async () => {
      close();
      await logout();
      const activeTab = document.querySelector('.nav-tab.active');
      if (activeTab) activeTab.click();
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
