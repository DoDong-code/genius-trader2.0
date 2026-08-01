(function () {
  'use strict';

  var storageKey = 'genius-trader-data-updated-at';
  var updatedAt = Number(sessionStorage.getItem(storageKey));
  var formatter = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai'
  });

  if (!Number.isFinite(updatedAt) || updatedAt > Date.now() || Date.now() - updatedAt > 30 * 60 * 1000) {
    updatedAt = Date.now();
    sessionStorage.setItem(storageKey, String(updatedAt));
  }

  function markup(withRefresh) {
    return '<span class="status-copy"><strong class="status-time"></strong><span class="status-update-row"><i aria-hidden="true"></i><small class="status-update"></small></span></span>' +
      (withRefresh ? '<button class="data-refresh-button" type="button" data-action="refresh-fund-data" aria-label="手动刷新数据">↻ <span>刷新数据</span></button>' : '');
  }

  function setupStatus(status) {
    if (!status || status.dataset.statusReady === 'true') return;
    status.dataset.statusReady = 'true';
    status.innerHTML = markup(status.classList.contains('portfolio-data-status'));
  }

  function render() {
    document.querySelectorAll('.sync-status, .portfolio-data-status').forEach(function (status) {
      setupStatus(status);
      var time = status.querySelector('.status-time');
      var update = status.querySelector('.status-update');
      if (!time || !update) return;
      time.textContent = formatter.format(new Date());
      var minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60000));
      update.textContent = '数据更新 · ' + (minutes < 1 ? '刚刚' : minutes + ' 分钟前');
    });
  }

  function refresh() {
    updatedAt = Date.now();
    sessionStorage.setItem(storageKey, String(updatedAt));
    render();
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action="refresh-fund-data"]');
    if (!button) return;
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.querySelector('span').textContent = '刷新中…';

    Promise.resolve(typeof window.refreshFundEstimates === 'function' ? window.refreshFundEstimates() : null)
      .finally(function () {
        refresh();
        window.setTimeout(function () {
          button.disabled = false;
          button.classList.remove('is-refreshing');
          button.querySelector('span').textContent = '刷新数据';
        }, 600);
      });
  }, true);

  // Do not observe the entire document here. `render()` updates the status
  // text itself once per second, which would make a subtree observer trigger
  // another render indefinitely in some embedded browsers.
  window.refreshDataStatus = refresh;
  render();
  window.setInterval(render, 1000);
}());
