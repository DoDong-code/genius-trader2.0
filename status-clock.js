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

  function isTradingDay(date) {
    var day = date.getDay();
    if (day === 0 || day === 6) return false;
    var yyyymmdd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    var holidays = [
      '2026-01-01', '2026-01-02',
      '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
      '2026-04-06',
      '2026-05-01', '2026-05-04', '2026-05-05',
      '2026-06-19',
      '2026-09-25',
      '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'
    ];
    return holidays.indexOf(yyyymmdd) === -1;
  }

  function getLatestTradingDayDate() {
    var d = new Date();
    while (true) {
      if (isTradingDay(d)) {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(d);
      }
      d.setDate(d.getDate() - 1);
    }
  }

  function render() {
    var now = new Date();
    var trading = isTradingDay(now);
    var dataDate = window.latestFundDataDate || getLatestTradingDayDate();

    document.querySelectorAll('.sync-status, .portfolio-data-status').forEach(function (status) {
      setupStatus(status);
      var time = status.querySelector('.status-time');
      var update = status.querySelector('.status-update');
      if (!time || !update) return;
      time.textContent = formatter.format(now);
      var minutes = Math.max(0, Math.floor((now.getTime() - updatedAt) / 60000));
      if (!trading) {
        update.innerHTML = '<span class="desktop-label">数据日期：' + dataDate + ' · 非交易日，展示最近交易日数据</span><span class="mobile-label">' + dataDate + ' · 展示最近交易日数据</span>';
      } else {
        update.innerHTML = '<span class="desktop-label">数据日期：' + dataDate + ' · 数据更新 · ' + (minutes < 1 ? '刚刚' : minutes + ' 分钟前') + '</span><span class="mobile-label">' + dataDate + ' · ' + (minutes < 1 ? '刚刚' : minutes + '分钟前') + '</span>';
      }
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
