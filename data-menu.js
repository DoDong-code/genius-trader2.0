(function () {
  'use strict';
  var moreButton = document.querySelector('.more-button');
  var fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'application/json,.json'; fileInput.hidden = true;
  document.body.appendChild(fileInput);

  function snapshot() {
    var state = window.portfolioState;
    return { version: 1, exportedAt: new Date().toISOString(), accounts: state.accounts, active: state.getActive() };
  }
  function closeMenu() { document.querySelector('.data-menu')?.remove(); }
  function downloadData() {
    var blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'genius-trader-data-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }
  function validData(data) {
    if (!data || typeof data !== 'object' || !data.accounts || typeof data.accounts !== 'object') return null;
    var entries = Object.entries(data.accounts).filter(function (entry) {
      return entry[1] && typeof entry[1].name === 'string' && Array.isArray(entry[1].funds);
    });
    return entries.length ? { accounts: Object.fromEntries(entries), active: data.active } : null;
  }
  function dialog(title, copy, actions) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay data-dialog-overlay';
    overlay.innerHTML = '<section class="confirm-dialog data-dialog" role="dialog" aria-modal="true"><h2>' + title + '</h2><p>' + copy + '</p><div class="confirm-actions">' + actions + '</div></section>';
    document.body.appendChild(overlay); requestAnimationFrame(function () { overlay.classList.add('visible'); });
    return overlay;
  }
  function closeDialog(overlay) { overlay.classList.remove('visible'); window.setTimeout(function () { overlay.remove(); }, 180); }
  function restore(payload) {
    var state = window.portfolioState;
    Object.keys(state.accounts).forEach(function (name) { delete state.accounts[name]; });
    Object.entries(payload.accounts).forEach(function (entry) { state.accounts[entry[0]] = entry[1]; });
    var active = state.accounts[payload.active] ? payload.active : Object.keys(state.accounts)[0];
    if (active) state.setActive(active);
    window.savePortfolioState?.();
    document.querySelector('.nav-tab.active')?.click();
  }
  function confirmImport(payload) {
    var overlay = dialog('导入数据', '将用备份中的 ' + Object.keys(payload.accounts).length + ' 个账户替换当前本地数据。此操作不可撤销。', '<button type="button" data-cancel>取消</button><button type="button" class="confirm-delete" data-confirm>确认导入</button>');
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('[data-cancel]')) closeDialog(overlay);
      if (event.target.closest('[data-confirm]')) { restore(payload); closeDialog(overlay); }
    });
  }
  function restoreDefaults() {
    var defaultPayload = {
      accounts: {
        '主账户': {
          name: '主账户',
          funds: [
            {
              name: '国泰半导体设备ETF联接C',
              code: '019633',
              category: '基金',
              amount: 10000,
              today: -0.015,
              hold: 0.052,
              history: [0.02, 0.06, 0.04, 0.12, 0.1, 0.15, 0.2, 0.18, 0.23, 0.31, 0.28, 0.34],
              holdings: [['兆易创新', '8.31%'], ['北方华创', '7.86%'], ['中微公司', '6.42%']],
              transactions: [['2026-07-13', '买入', '¥10,000']]
            },
            {
              name: '华夏黄金ETF联接C',
              code: '008702',
              category: '基金',
              amount: 15000,
              today: 0.008,
              hold: 0.124,
              history: [0.04, 0.06, 0.03, 0.08, 0.12, 0.1, 0.15, 0.18, 0.22, 0.2, 0.24, 0.29],
              holdings: [['黄金现货', '92.40%'], ['现金及其他', '7.60%']],
              transactions: [['2026-07-05', '买入', '¥15,000']]
            }
          ]
        }
      },
      active: '主账户'
    };

    var overlay = dialog('恢复默认状态', '确定要清空所有数据并恢复到默认状态吗？此操作将清除您所有的自定义账户和持仓数据，且无法恢复。', '<button type="button" data-cancel>取消</button><button type="button" class="confirm-delete" data-confirm>确认恢复</button>');
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('[data-cancel]')) closeDialog(overlay);
      if (event.target.closest('[data-confirm]')) {
        restore(defaultPayload);
        closeDialog(overlay);
      }
    });
  }
  function openMenu() {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'data-menu';
    var isLoggedIn = !!(window.auth && window.auth.state && window.auth.state.user);
    var authLabel = isLoggedIn ? escapeHtml(window.auth.state.user.email) : '登录 / 注册';
    menu.innerHTML = '<button type="button" data-data-menu="auth"><span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="transform: translateY(1px);" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-3.9 3.6-6 8-6s8 2.1 8 6"/></svg></span>' + authLabel + '</button><span class="data-menu-separator"></span><button type="button" data-data-menu="export"><span>⇧</span>导出数据</button><button type="button" data-data-menu="import"><span style="display: inline-block; transform: rotate(180deg);">⇧</span>导入数据</button><span class="data-menu-separator"></span><button type="button" data-data-menu="restore"><span>↺</span>恢复默认</button>';
    document.body.appendChild(menu);
    var rect = moreButton.getBoundingClientRect();
    menu.style.top = (rect.bottom + 10) + 'px'; menu.style.right = Math.max(16, window.innerWidth - rect.right) + 'px';
  }
  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  moreButton?.addEventListener('click', function (event) { event.stopPropagation(); document.querySelector('.data-menu') ? closeMenu() : openMenu(); });
  document.addEventListener('click', function (event) {
    var action = event.target.closest('[data-data-menu]');
    if (action) {
      var type = action.dataset.dataMenu; closeMenu();
      if (type === 'auth') {
        if (window.auth && window.auth.state && window.auth.state.user) window.auth.openAccountMenu();
        else if (window.auth) window.auth.openModal();
        return;
      }
      if (type === 'export') downloadData();
      if (type === 'import') fileInput.click();
      if (type === 'restore') restoreDefaults();
      return;
    }
    if (!event.target.closest('.data-menu') && !event.target.closest('.more-button')) closeMenu();
  });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0]; fileInput.value = '';
    if (!file) return;
    file.text().then(JSON.parse).then(validData).then(function (payload) {
      if (!payload) throw new Error('invalid'); confirmImport(payload);
    }).catch(function () { dialog('无法导入', '请选择由 Genius trader 导出的有效 JSON 备份文件。', '<button type="button" data-cancel>知道了</button>').addEventListener('click', function (event) { if (event.target.closest('[data-cancel]')) closeDialog(event.currentTarget); }); });
  });
}());
