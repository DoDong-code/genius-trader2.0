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

  var SOURCE_OPTIONS = [
    { key: 'local', label: '本地' },
    { key: 'xiaobeiyangji', label: '小倍' },
    { key: 'yangjibao', label: '养基宝' }
  ];

  // 时间/数据日期区域即点击入口：外层 wrapper 内放可点击的 status-copy + 气泡菜单
  function markup(withRefresh) {
    return withRefresh
      ? '<span class="estimate-source-picker"><span class="status-copy estimate-source-toggle" role="button" tabindex="0" aria-label="选择估值数据源"><strong class="status-time"></strong><span class="status-update-row"><i aria-hidden="true"></i><small class="status-update"></small></span></span><span class="estimate-source-menu" role="menu"></span></span>' +
        '<button class="data-refresh-button" type="button" data-action="refresh-fund-data" aria-label="手动刷新数据">↻ <span>刷新数据</span></button>'
      : '<span class="status-copy"><strong class="status-time"></strong><span class="status-update-row"><i aria-hidden="true"></i><small class="status-update"></small></span></span>';
  }

  function sourceDisplayName(key) {
    var found = SOURCE_OPTIONS.filter(function (o) { return o.key === key; })[0];
    return found ? found.label : '本地';
  }

  function currentAccountName() {
    return window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : '';
  }

  function preferredSource() {
    try {
      return localStorage.getItem('estimate_source_' + currentAccountName()) || 'local';
    } catch (err) {
      return 'local';
    }
  }

  function providerAvailability() {
    if (typeof window.getProviderStatus === 'function') {
      return window.getProviderStatus();
    }
    return { xiaobeiyangji: false, yangjibao: false };
  }

  // 数据源标签：仅桌面端在日期文字后追加“数据源：X”；移动端保留原日期
  function sourceTagText() {
    return ' · 数据源：' + sourceDisplayName(preferredSource());
  }

  function renderSourcePicker() {
    document.querySelectorAll('.estimate-source-picker').forEach(function (picker) {
      var menu = picker.querySelector('.estimate-source-menu');
      var available = providerAvailability();
      var sig = currentAccountName() + '|' + (available.xiaobeiyangji ? 1 : 0) + (available.yangjibao ? 1 : 0);
      if (menu && menu.dataset.sourceSig !== sig) {
        menu.dataset.sourceSig = sig;
        menu.innerHTML = SOURCE_OPTIONS.map(function (opt) {
          var disabled = opt.key !== 'local' && available[opt.key] !== true;
          return '<button type="button" class="estimate-source-option' + (disabled ? ' disabled' : '') + '" data-source-option="' + opt.key + '"' + (disabled ? ' title="未登录"' : '') + '>' + opt.label + '</button>';
        }).join('');
      }
      if (menu) {
        var preferred = preferredSource();
        menu.querySelectorAll('.estimate-source-option').forEach(function (btn) {
          btn.classList.toggle('active', btn.dataset.sourceOption === preferred);
        });
      }
    });
  }

  function applySourceSelection(key) {
    var from = preferredSource();
    // Case D：同一数据源不重复请求（养基宝→养基宝 等）
    if (from === key) {
      return;
    }
    try {
      localStorage.setItem('estimate_source_' + currentAccountName(), key);
    } catch (err) {}
    renderSourcePicker();
    // P3.4：切换数据源 → 仅触发一次当前账户当前数据源刷新（带请求版本保护 + 结果提示 + 诊断日志）。
    // 不调用 refreshFundEstimates（通用刷新，无版本保护/无提示），避免“切了但没反应”。
    if (typeof window.triggerSourceRefresh === 'function') {
      window.triggerSourceRefresh({ from: from, to: key });
    } else if (typeof window.refreshFundEstimates === 'function') {
      window.refreshFundEstimates(true);
    }
  }

  function setupStatus(status) {
    if (!status || status.dataset.statusReady === 'true') return;
    status.dataset.statusReady = 'true';
    status.innerHTML = markup(status.classList.contains('portfolio-data-status'));
    renderSourcePicker();
  }

  function isTradingDay(date) {
    var weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', weekday: 'short'
    }).format(date);
    if (weekday === 'Sat' || weekday === 'Sun') return false;
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
      var freshness = minutes < 1 ? '刚刚' : minutes + ' 分钟前';
      var isPicker = Boolean(status.querySelector('.estimate-source-picker'));
      if (!trading) {
        update.innerHTML = '<span class="desktop-label">数据日期：' + dataDate + ' · 非交易日，展示最近交易日数据' + (isPicker ? sourceTagText() : '') + '</span><span class="mobile-label">' + dataDate + '</span>';
      } else {
        update.innerHTML = '<span class="desktop-label">数据日期：' + dataDate + ' · 数据更新 · ' + freshness + (isPicker ? sourceTagText() : '') + '</span><span class="mobile-label">' + dataDate + '</span>';
      }
    });
  }

  function refresh() {
    updatedAt = Date.now();
    sessionStorage.setItem(storageKey, String(updatedAt));
    render();
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('.estimate-source-toggle');
    if (toggle) {
      event.preventDefault();
      var picker = toggle.closest('.estimate-source-picker');
      if (picker) {
        var menu = picker.querySelector('.estimate-source-menu');
        var open = menu && menu.classList.contains('open');
        document.querySelectorAll('.estimate-source-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (menu && !open) menu.classList.add('open');
      }
      return;
    }

    var option = event.target.closest('[data-source-option]');
    if (option) {
      event.preventDefault();
      if (option.classList.contains('disabled')) return;
      applySourceSelection(option.dataset.sourceOption);
      document.querySelectorAll('.estimate-source-menu.open').forEach(function (m) { m.classList.remove('open'); });
      return;
    }

    if (!event.target.closest('.estimate-source-picker')) {
      document.querySelectorAll('.estimate-source-menu.open').forEach(function (m) { m.classList.remove('open'); });
    }

    var button = event.target.closest('[data-action="refresh-fund-data"]');
    if (!button) return;
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.querySelector('span').textContent = '刷新中…';

    var refreshTasks = [];
    if (typeof window.refreshFundEstimates === 'function') {
      refreshTasks.push(Promise.resolve(window.refreshFundEstimates()));
    }
    if (typeof window.refreshMarketIndices === 'function') {
      refreshTasks.push(Promise.resolve(window.refreshMarketIndices()));
    }
    // P3.18-NET：刷新数据按钮同步当天净值（后端缓存优先，命中不请求 provider；不清空已有当天净值）
    if (typeof window.refreshTodayNav === 'function') {
      refreshTasks.push(Promise.resolve(window.refreshTodayNav()));
    }
    Promise.all(refreshTasks)
      .finally(function () {
        refresh();
        window.setTimeout(function () {
          button.disabled = false;
          button.classList.remove('is-refreshing');
          button.querySelector('span').textContent = '刷新数据';
        }, 600);
      });
  }, true);

  window.refreshDataStatus = refresh;
  render();
  renderSourcePicker();
  window.setInterval(render, 1000);
}());
