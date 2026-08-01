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
  function settings() {
    var overlay = dialog('数据设置', '数据仅保存在此浏览器中。建议在修改账户前先导出一份备份。', '<button type="button" data-cancel>关闭</button><button type="button" class="settings-export" data-export>导出数据</button>');
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('[data-cancel]')) closeDialog(overlay);
      if (event.target.closest('[data-export]')) downloadData();
    });
  }
  function openMenu() {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'data-menu';
    menu.innerHTML = '<button type="button" data-data-menu="export"><span>⇩</span>导出数据</button><button type="button" data-data-menu="import"><span>⇧</span>导入数据</button><span class="data-menu-separator"></span><button type="button" data-data-menu="settings"><span>⚙</span>数据设置</button>';
    document.body.appendChild(menu);
    var rect = moreButton.getBoundingClientRect();
    menu.style.top = (rect.bottom + 10) + 'px'; menu.style.right = Math.max(16, window.innerWidth - rect.right) + 'px';
  }
  moreButton?.addEventListener('click', function (event) { event.stopPropagation(); document.querySelector('.data-menu') ? closeMenu() : openMenu(); });
  document.addEventListener('click', function (event) {
    var action = event.target.closest('[data-data-menu]');
    if (action) {
      var type = action.dataset.dataMenu; closeMenu();
      if (type === 'export') downloadData();
      if (type === 'import') fileInput.click();
      if (type === 'settings') settings();
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
