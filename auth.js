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
          <button type="button" class="secondary-button" id="auth-backup-btn" style="flex: 1;">立即同步</button>
          <button type="button" class="secondary-button" id="auth-restore-btn" style="flex: 1;">恢复本地</button>
        </div>
        <!-- 二次验收：「立即同步」点击直接备份（无二级弹窗），下方直接展示最近 5 条备份 -->
        <div class="account-backup-list" style="margin-top: 12px; text-align: left;"></div>
      </div>
    `);
    const backupBtn = layer.querySelector('#auth-backup-btn');
    const restoreBtn = layer.querySelector('#auth-restore-btn');
    const backupList = layer.querySelector('.account-backup-list');

    backupBtn.addEventListener('click', async () => {
      backupBtn.disabled = true;
      backupBtn.textContent = '同步中…';
      try {
        const ok = await window.createCloudBackup('manual');
        if (ok) window.showToast('已同步到云端');
        else window.showToast('请先登录账号', 'warning');
        loadRecentBackups(layer);
      } catch (error) {
        window.showToast('同步失败：' + (error.message || '网络错误'), 'error');
      } finally {
        backupBtn.disabled = false;
        backupBtn.textContent = '立即同步';
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
    loadRecentBackups(layer);
  }

  // 二次验收：账号弹窗内联最近 5 条备份（无二级弹窗）；恢复/删除能力与原有一致
  function loadRecentBackups(layer) {
    const list = layer.querySelector('.account-backup-list');
    if (!list) return;
    fetch('/api/account/backups', { headers: window.auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) { renderRecentBackups(list, layer, data && data.backups); })
      .catch(function () { renderRecentBackups(list, layer, []); });
  }

  function renderRecentBackups(list, layer, backups) {
    const items = Array.isArray(backups) ? backups.slice(0, 5) : [];
    if (items.length === 0) {
      list.innerHTML = '<div style="font-size:12px;color:#86868b;padding:8px 0;border-top:1px solid #f2f2f7;">暂无备份，点击「立即同步」创建。</div>';
      return;
    }
    let html = '<div style="font-size:12px;color:#86868b;padding:2px 0 6px;">最近备份</div>' +
      '<div style="border-top:1px solid #f2f2f7;">';
    items.forEach(function (b) {
      const time = b.created_at ? new Date(b.created_at).toLocaleString() : '';
      const reasonLabel = b.reason === 'manual' ? '手动备份' : b.reason === 'logout' ? '退出前' : (b.reason || '备份');
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f2f2f7;">' +
        '<div style="font-size:12px;color:#86868b;">' + escapeHtml(time || '') +
        '<span style="margin-left:6px;color:#b0b0b6;">' + escapeHtml(reasonLabel) + '</span></div>' +
        '<div style="display:flex;gap:14px;flex-shrink:0;">' +
        '<button type="button" data-backup-restore="' + b.id + '" style="background:transparent;border:none;color:#0071e3;font-size:12px;cursor:pointer;padding:2px 4px;">恢复</button>' +
        '<button type="button" data-backup-delete="' + b.id + '" style="background:transparent;border:none;color:#ff3b30;font-size:12px;cursor:pointer;padding:2px 4px;">删除</button>' +
        '</div></div>';
    });
    html += '</div>';
    list.innerHTML = html;
    list.onclick = function (event) {
      const restoreBtn = event.target.closest('[data-backup-restore]');
      if (restoreBtn) confirmRestoreCloudBackup(Number(restoreBtn.dataset.backupRestore), layer);
      const deleteBtn = event.target.closest('[data-backup-delete]');
      if (deleteBtn) confirmDeleteCloudBackup(Number(deleteBtn.dataset.backupDelete), layer);
    };
  }

  async function confirmRestoreCloudBackup(id, layer) {
    const ok = await window.showAppleDialog({
      title: '恢复备份',
      message: '将用该备份替换当前本地账户数据（保留同步账户）。此操作不可撤销。',
      okText: '恢复',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    try {
      const result = await window.restoreCloudBackup(id);
      window.showToast(result ? '已恢复备份' : '恢复失败', result ? 'success' : 'error');
    } catch (error) {
      window.showToast('恢复失败：' + (error.message || '网络错误'), 'error');
    }
    loadRecentBackups(layer);
  }

  async function confirmDeleteCloudBackup(id, layer) {
    const ok = await window.showAppleDialog({
      title: '删除备份',
      message: '确定删除该备份快照吗？删除后不可恢复。',
      okText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    try {
      await fetch('/api/account/backups/' + id, { method: 'DELETE', headers: window.auth.authHeaders() });
      window.showToast('已删除备份', 'success');
    } catch (error) {
      window.showToast('删除失败', 'error');
    }
    loadRecentBackups(layer);
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
