(function () {
  'use strict';

  // P3.4：诊断日志开关（仅在 ?diag=1 或 window.GT_DIAGNOSTIC===true 时打印）
  var DIAGNOSTIC = /[?&]diag=1\b/.test(String((window.location && window.location.search) || '')) || window.GT_DIAGNOSTIC === true;
  function diagLog() {
    if (!DIAGNOSTIC) return;
    try { console.log.apply(console, arguments); } catch (e) {}
  }

  // P3.4：数据源切换请求版本（防止旧 source 响应覆盖新 source 状态）
  var sourceRequestVersion = 0;
  window.__sourceRefreshVersion = 0;

  var getApiBase = function() { return window.FUND_API_BASE || ''; };
  var active = 0;
  var MAX_CONCURRENT = 6;
  var queue = [];
  var FUND_SECTORS = {
    '014002': '\u5168\u7403\u667a\u80fd\u79d1\u6280',
    '022184': '\u5168\u7403\u79d1\u6280',
    '002771': '\u7075\u6d3b\u914d\u7f6e',
    '002207': '\u9ec4\u91d1\u77ff\u4e1a',
    '019633': '\u534a\u5bfc\u4f53\u8bbe\u5907',
    '007339': '\u6caa\u6df1300',
    '004253': '\u9ec4\u91d1',
    '013309': '\u6052\u751f\u79d1\u6280',
    '010827': '\u4ea7\u4e1a\u8d8b\u52bf',
    '025422': '\u6570\u5b57\u7ecf\u6d4e',
    '014847': '\u503a\u5238',
    '008173': '\u503a\u5238',
    '020741': '\u503a\u5238',
    '015736': '\u7eaf\u503a',
    '380006': '\u7eaf\u503a',
    '004103': '\u503a\u5238',
    '009690': '\u7075\u6d3b\u914d\u7f6e',
    // 二次验收：与小程序 utils/fundSectors.js 的 FUND_SECTORS_BY_CODE 完全一致（双端同一板块表）
    '000001': '\u6df7\u5408',
    '008702': '\u57fa\u91d1'
  };

  function formatMoney(value) {
    var amount = Number(value) || 0;
    var sign = amount < 0 ? '−' : amount > 0 ? '+' : '';
    // P2 统一：金额最多 2 位小数、不强制补 0
    return sign + '' + Math.abs(amount).toLocaleString('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function formatPercent(value) {
    var rate = (Number(value) || 0) * 100;
    // P2 统一：百分比最多 2 位小数、不强制补 0
    return (rate > 0 ? '+' : '') + String(Number(rate.toFixed(2))) + '%';
  }

  function marketClass(value) {
    return value > 0 ? 'market-up' : value < 0 ? 'market-down' : 'market-flat';
  }

  function currentFund(code) {
    var state = window.portfolioState;
    if (!state || !state.accounts || typeof state.getActive !== 'function') return null;
    var account = state.accounts[state.getActive()];
    if (!account) return null;
    var funds = typeof state.effectiveFunds === 'function' ? state.effectiveFunds(account) : (account.funds || []);
    return Array.isArray(funds)
      ? funds.find(function (fund) { return fund.code === code; })
      : null;
  }

  function formatMMDD(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    var match = dateStr.match(/(\d{2})[-/](\d{2})$/);
    return match ? match[1] + '-' + match[2] : '';
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

  // P4.5 统一净值显示状态（唯一判定入口，Web 与 mp1 规则完全一致）：
  //   1. fund.nav.confirmed === true && fund.nav.date 存在 → { type: 'CONFIRMED_NAV', date }
  //   2. 无确认净值 && fund.estimate.status === 'READY'   → { type: 'TODAY_ESTIMATE' }
  //   3. 其他                                              → { type: 'NO_DATA' }
  // 禁止在 UI 层用 provider 名称 / estimate 日期 / 开盘与否 / 非交易日 / localStorage 日期再推导状态。
  // 蓝色唯一事实 = 后端确认的正式净值（fund_nav）；一切估值永远灰色，estimate 永远不得写 confirmed。
  function getNavDisplayState(fund) {
    // 三态唯一入口：蓝色 = 后端确认净值且含有效正值（confirmed===true && date && value>0）。
    // 增加 value>0 守卫，彻底封堵「res.date 存在但 nav=0/null」被误判为蓝色（旧 0825 假蓝根因）。
    if (fund && fund.nav && fund.nav.confirmed === true && fund.nav.date &&
        Number.isFinite(Number(fund.nav.value)) && Number(fund.nav.value) > 0) {
      return { type: 'CONFIRMED_NAV', date: String(fund.nav.date) };
    }
    if (fund && fund.estimate && fund.estimate.status === 'READY') {
      return { type: 'TODAY_ESTIMATE' };
    }
    return { type: 'NO_DATA' };
  }
  window.getNavDisplayState = getNavDisplayState;

  // P3.18-NET：显式刷新时批量同步当天净值（后端 today-nav 幂等：命中 fund_nav 缓存直接返回，不重复请求 provider）。
  // 只在「刷新数据」按钮调用；切 Tab/切数据源/页面加载不调用（读本地缓存，不发起净值请求）。
  function refreshTodayNav() {
    var state = window.portfolioState || {};
    var active = typeof state.getActive === 'function' ? state.getActive() : '';
    var funds = (state.accounts && state.accounts[active] && state.accounts[active].funds) || [];
    var codes = [];
    funds.forEach(function (f) { if (f && f.code && codes.indexOf(String(f.code)) === -1) codes.push(String(f.code)); });
    codes = codes.slice(0, 20); // 并发上限
    var currentSource = preferredEstimateSource();
    return Promise.all(codes.map(function (code) {
      return requestJson(getApiBase() + '/api/fund/' + encodeURIComponent(code) + '/today-nav?source=' + encodeURIComponent(currentSource))
        .then(function (res) {
          if (res && res.success) {
            var c = String(code);
            var cached = window.fundStore ? window.fundStore.get(c) : null;
            // P4.5 统一规则：只有后端返回「有效净值数值」（fund_nav 已确认）才写 confirmed NAV。
            // 后端契约：res.date 恒为 expected 日期；nav=null（before-close / provider-unavailable）
            // 表示净值未确认，绝不能只看 res.date 就写——否则盘中会把 value=0 的今日日期污染成蓝色。
            var navValue = Number(res.nav);
            if (res.date && Number.isFinite(navValue) && navValue > 0 && cached) {
              var changePercent = null;

              if (cached._history && Array.isArray(cached._history.data)) {
                var history = cached._history.data;
                var records = history
                  .filter(function (item) {
                    return item && item.date && Number.isFinite(Number(item.nav));
                  })
                  .sort(function (left, right) {
                    return String(left.date).localeCompare(String(right.date));
                  });

                var prevNav = null;

                if (records.length > 0) {
                  var sortedDesc = records.slice().reverse();
                  var prevRecord = sortedDesc.find(function (r) {
                    return String(r.date).localeCompare(String(res.date)) < 0;
                  });

                  if (prevRecord) {
                    prevNav = Number(prevRecord.nav);
                  }
                }

                if (prevNav && prevNav > 0) {
                  changePercent = navValue / prevNav - 1;
                }
              }

              window.fundStore.update(c, {
                nav: {
                  status: 'READY',
                  date: res.date,
                  value: navValue,
                  percent: changePercent !== null ? changePercent : cached.nav.percent,
                  confirmed: true
                }
              });

              if (typeof window.calculateTodayProfit === 'function') {
                var updatedProfit = window.calculateTodayProfit(cached);

                window.fundStore.update(c, {
                  todayProfit: updatedProfit
                });
              }
            }
          }
          return null;
        })
        .catch(function () { return null; }); // P4.5：单只失败不影响其他基金，整体 loading 必须结束
      }))
        .catch(function () { return null; }).then(function () {
      // 重新扫描行徽章（不 force，读缓存）
      if (typeof scan === 'function') scan(false, true);
      markEstimatesRefreshed();
    });
  }
  window.refreshTodayNav = refreshTodayNav;

  // 记录某账户最近一次成功刷新估值的时间（按账户），供 AI 诊断判断是否需要重新刷新
  function markEstimatesRefreshed() {
    var accountName = window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : '';
    window.lastEstimatesRefreshAtByAccount = window.lastEstimatesRefreshAtByAccount || {};
    window.lastEstimatesRefreshAtByAccount[accountName] = Date.now();
  }
  window.markEstimatesRefreshed = markEstimatesRefreshed;

  function setFundMeta(row, fund) {
    var meta = row && row.querySelector('.fund-info small');
    if (!meta || !fund) return;
    // 二次验收：兜底与小程序 fundSectors.sectorNameOf 统一为「其他」（双端板块显示一致）
    var sector = FUND_SECTORS[fund.code] || fund.sector || fund.category || '\u5176\u4ed6';
    var text = fund.code + ' \u00b7 ' + sector;
    // This function is called by a DOM observer.  Do not rewrite an already
    // correct value, otherwise replaceChildren triggers the observer again.
    if (meta.dataset.fundMeta === text) return;
    var badge = meta.querySelector('.nav-updated-badge, .nav-estimate-badge');
    meta.dataset.fundMeta = text;
    meta.replaceChildren();
    if (badge) meta.appendChild(badge);

    var codeSpan = document.createElement('span');
    codeSpan.className = 'fund-code-text';
    codeSpan.textContent = fund.code;

    var sepSpan = document.createElement('span');
    sepSpan.className = 'fund-meta-sep';
    sepSpan.textContent = ' \u00b7 ';

    var sectorSpan = document.createElement('span');
    sectorSpan.className = 'fund-sector-text';
    sectorSpan.textContent = sector;

    meta.appendChild(codeSpan);
    meta.appendChild(sepSpan);
    meta.appendChild(sectorSpan);
  }

  function updateTodayCell(row, change, profit) {
    var cell = row.querySelector('.fund-today') || row.children[2];
    if (!cell) return;
    delete cell.dataset.estimateUnavailable;
    cell.innerHTML = '<strong>' + formatMoney(profit) + '</strong><span>' + formatPercent(change) + '</span>';
    cell.classList.remove('market-up', 'market-down', 'market-flat');
    cell.classList.add(marketClass(change));
  }

  function showEstimateUnavailable(row) {
    var cell = row.querySelector('.fund-today') || row.children[2];
    if (!cell) return;
    cell.dataset.estimateUnavailable = 'true';
    cell.innerHTML = '<strong>—</strong><span>待估值</span>';
    cell.classList.remove('market-up', 'market-down');
    cell.classList.add('market-flat');
  }

  function markNavUpdated(row, date, fund) {
    var meta = row.querySelector('.fund-info small');
    if (!meta) return;
    setFundMeta(row, fund || currentFund(row.dataset.code));
    
    // Remove estimate badge if present
    var estBadge = meta.querySelector('.nav-estimate-badge');
    if (estBadge) estBadge.remove();

    var mmddHyphen = formatMMDD(date);
    var mmddNoHyphen = mmddHyphen.replace('-', '');
    // 二次验收：蓝徽章直接显示实际净值日期（0820），不带「已更新」前缀（双端一致）
    var desktopText = mmddNoHyphen || mmddHyphen || '';
    var mobileText = mmddHyphen || desktopText;
    var badge = meta.querySelector('.nav-updated-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-updated-badge';
    }
    badge.innerHTML = '<span class="desktop-tag-text">' + desktopText + '</span><span class="mobile-tag-text">' + mobileText + '</span>';
    badge.title = date ? '净值更新至 ' + date : '净值已更新';
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  // P4.5：灰色徽章（唯一灰章入口）。TODAY_ESTIMATE →「估值」；NO_DATA →「暂无数据」。
  function markEstimateBadge(row, fund, label) {
    var meta = row.querySelector('.fund-info small');
    if (!meta) return;
    setFundMeta(row, fund || currentFund(row.dataset.code));

    // Remove updated badge if present
    var upBadge = meta.querySelector('.nav-updated-badge');
    if (upBadge) upBadge.remove();

    var badge = meta.querySelector('.nav-estimate-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-estimate-badge';
    }
    var text = label || '估值';
    badge.innerHTML = '<span class="desktop-tag-text">' + text + '</span><span class="mobile-tag-text">' + text + '</span>';
    badge.title = '今日估算数据（非官方净值）';
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  // P4.5：单请求 20s 超时保护——成功/失败/超时都必须 settle，杜绝「永远刷新中」。
  // 超时后当前请求结束（abort）、保留已有缓存、UI 显示已有数据、不无限重试。
  var REQUEST_TIMEOUT_MS = 20000;
  function requestJson(url, options) {
    var headers = Object.assign({}, (options && options.headers) || {}, window.auth && window.auth.authHeaders ? window.auth.authHeaders() : {});
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(url, Object.assign({}, options, { headers: headers, signal: controller ? controller.signal : undefined }))
      .then(function (response) {
        if (!response.ok) {
          var error = new Error('HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })
      .finally(function () {
        if (timer !== null) window.clearTimeout(timer);
      });
  }

  function refreshFund(code, force) {
    // 详情快照（持仓/历史净值）始终走服务端缓存/快速模式：持仓季度更新、历史每日增量
    var endpoint = getApiBase() + '/api/fund/' + encodeURIComponent(code) + (force ? '?refresh=1&fast=1' : '');
    return requestJson(endpoint).catch(function (error) {
      if (error.status !== 404) throw error;
      var importUrl = getApiBase() + '/api/fund/import/' + encodeURIComponent(code) + (force ? '?force=1' : '');
      return requestJson(importUrl)
        .then(function () { return requestJson(endpoint); });
    });
  }

  function estimateFund(code, amount, force) {
    var endpoint = getApiBase() + '/api/fund/' + encodeURIComponent(code) + '/estimate?amount=' + encodeURIComponent(amount) + (force ? '&force=1' : '');
    var source = preferredEstimateSource();
    if (source === 'local') {
      endpoint += '&mode=local';
    } else if (typeof window.getProviderStatus === 'function') {
      var available = window.getProviderStatus();
      if (available[source] === true) {
        endpoint += '&mode=provider&source=' + encodeURIComponent(source);
      } else {
        endpoint += '&mode=local';
      }
    } else {
      endpoint += '&mode=provider&source=' + encodeURIComponent(source);
    }
    return requestJson(endpoint);
  }

  function preferredEstimateSource() {
    var accountName = window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : '';
    try {
      return localStorage.getItem('estimate_source_' + accountName) || 'local';
    } catch (err) {
      return 'local';
    }
  }

  function runTask(task) {
    active += 1;
    task().finally(function () {
      active -= 1;
      drain();
    });
  }

  function drain() {
    while (active < MAX_CONCURRENT && queue.length) runTask(queue.shift());
  }

  function enqueue(task) {
    queue.push(task);
    drain();
  }

  function renderRowFromStore(row, code, fund) {
    if (!row || !row.isConnected) return;

    var cached = window.fundStore.get(code);

    // Resolve change & profit（数值层不变：今日收益仍由 calculateTodayProfit 决定）
    var change = cached.todayProfit.percent;
    var profit = cached.todayProfit.value;

    // P4.5 统一三态徽章（唯一判定入口 getNavDisplayState，与 mp1 完全一致）：
    //   CONFIRMED_NAV → 蓝色「实际净值日期」；TODAY_ESTIMATE → 灰色「估值」；NO_DATA → 灰色「暂无数据」
    var displayState = getNavDisplayState(cached);
    if (displayState.type === 'CONFIRMED_NAV') {
      markNavUpdated(row, displayState.date, fund);
    } else if (displayState.type === 'TODAY_ESTIMATE') {
      markEstimateBadge(row, fund, '估值');
    } else {
      var meta = row.querySelector('.fund-info small');
      if (meta) {
        var estBadge = meta.querySelector('.nav-estimate-badge');
        if (estBadge) estBadge.remove();
        var upBadge = meta.querySelector('.nav-updated-badge');
        if (upBadge) upBadge.remove();
      }
    }

    diagLog('[BADGE_DECISION]', 'code=' + code,
      'state=' + displayState.type,
      'nav_date=' + cached.nav.date,
      'nav_confirmed=' + cached.nav.confirmed,
      'estimate_status=' + cached.estimate.status);

    if (change !== null && Number.isFinite(change)) {
      updateTodayCell(row, change, profit);
      row.dataset.estimateState = 'ready';
    } else {
      showEstimateUnavailable(row);
      row.dataset.estimateState = 'unavailable';
    }
  }

  function hydrateRow(row, force, estimateOnly) {
    if (!row) return;
    var code = row.dataset.code;
    var fund = currentFund(code);
    if (!code || !fund) return;
    setFundMeta(row, fund);

    // Sync fund object with latest fundStore data on load
    if (window.fundStore && typeof window.fundStore.propagate === 'function') {
      window.fundStore.propagate(code);
    }

    var cached = window.fundStore ? window.fundStore.get(code) : null;
    var hasValidCache = cached && Number.isFinite(cached.todayProfit.percent);

    // If we have valid cached data and we are not forcing a refresh,
    // we can immediately display it and set state to ready!
    if (hasValidCache && !force && row.dataset.estimateState !== 'loading' && !estimateOnly) {
      renderRowFromStore(row, code, fund);
      
      // Trigger a non-blocking silent refresh in the background
      window.fundDataService.refresh(code, false).then(function() {
        renderRowFromStore(row, code, fund);
      }).catch(function() {});
      return;
    }

    if (row.dataset.estimateState === 'loading' || (!force && (row.dataset.estimateState === 'ready' || row.dataset.estimateState === 'unavailable'))) return;

    row.dataset.estimateState = 'loading';
    enqueue(function () {
      return window.fundDataService.refresh(code, force, { estimateOnly: estimateOnly }).then(function() {
        renderRowFromStore(row, code, fund);
      }).catch(function() {
        if (row.isConnected) {
          renderRowFromStore(row, code, fund);
          if (row.dataset.estimateState === 'loading') {
            row.dataset.estimateState = 'error';
          }
        }
      });
    });
  }

  function scan(force, estimateOnly) {
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(function (row) {
      // 初次/切换 tab 进入：不强制重抓基金详情，走服务端缓存，避免多基金排队卡顿
      hydrateRow(row, force, estimateOnly);
    });
  }

  window.refreshFundEstimates = function (arg) {
    var estimateOnly = false;
    if (typeof arg === 'boolean') {
      estimateOnly = arg;
    } else if (arg && typeof arg === 'object') {
      estimateOnly = arg.estimateOnly === true;
    }
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(function (row) {
      delete row.dataset.estimateState;
    });
    scan(true, estimateOnly);
  };

  // 单行刷新：详情抽屉刷新出最新净值后，同步更新持仓列表对应行（走缓存，不重复抓取）
  window.refreshListRow = function (code) {
    var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
    if (!row) return;
    delete row.dataset.estimateState;
    hydrateRow(row, false);
  };

  // P3.4：当前视图可见的基金 code 列表（数据源切换只刷新可见行）
  function visibleFundCodes() {
    var codes = [];
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(function (row) {
      var c = row.dataset.code;
      if (c && codes.indexOf(String(c)) === -1) codes.push(String(c));
    });
    return codes;
  }

  // P3.4：切换数据源的统一刷新入口（每次切换仅触发一次；带请求版本保护 + 结果提示 + 诊断日志）
  // 调用链：用户选择 source → applySourceSelection 写 localStorage → triggerSourceRefresh
  //   → fundDataService.refresh(code, true, {version}) → mergeFundData → FundStore
  //   → renderRowFromStore（按冻结优先级重算 badge）→ todayProfit 重算 → showToast 结果提示
  function triggerSourceRefresh(opts) {
    opts = opts || {};
    var to = opts.to || preferredEstimateSource();
    var from = opts.from;
    var version = ++sourceRequestVersion;
    window.__sourceRefreshVersion = version;
    diagLog('[SOURCE_SWITCH]', 'account=' + (window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : ''),
      'from=' + (from || '-'), 'to=' + to, 'version=' + version);

    var codes = visibleFundCodes();
    if (codes.length === 0) {
      diagLog('[SOURCE_SWITCH]', 'no visible rows to refresh');
      return;
    }
    var results = [];
    codes.forEach(function (code) {
      var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
      if (row) row.dataset.estimateState = 'loading'; // 立即给出刷新状态反馈
      refreshSourceRow(code, to, version, results);
    });
    // 用独立计数器确保 summary 在所有行结束后触发
    pendingSourceSummary = { version: version, to: to, remaining: codes.length, results: results };
  }

  // 等待所有行 refresh 完成后再汇总（避免过早提示）
  var pendingSourceSummary = null;
  function maybeSummarizeSourceRefresh() {
    if (!pendingSourceSummary) return;
    pendingSourceSummary.remaining -= 1;
    if (pendingSourceSummary.remaining > 0) return;
    var summary = pendingSourceSummary;
    pendingSourceSummary = null;
    if (summary.version !== window.__sourceRefreshVersion) {
      diagLog('[SOURCE_REFRESH_SUMMARY]', 'skipped stale version=' + summary.version);
      return; // 已有更新的切换，交给新切换汇总
    }
    summarizeSourceRefresh(summary.to, summary.version, summary.results);
  }

  function refreshSourceRow(code, to, version, results) {
    var fund = currentFund(code);
    diagLog('[SOURCE_REFRESH_START]', 'source=' + to, 'version=' + version, 'code=' + code);
    window.fundDataService.refresh(code, true, { version: version, estimateOnly: true }).then(function () {
      if (version !== window.__sourceRefreshVersion) {
        diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=discarded(stale)');
        maybeSummarizeSourceRefresh();
        return;
      }
      var cached = window.fundStore.get(code);
      var est = cached.estimate;
      var hasEstimate = Boolean(est && est.status === 'READY' && est.value !== null && est.value !== undefined);
      diagLog('[SOURCE_REFRESH_RESULT]', 'source=' + to, 'version=' + version, 'code=' + code,
        'estimate_status=' + (est ? est.status : 'EMPTY'),
        'trade_date=' + (est ? (est.trade_date || est.date || null) : null));
      var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
      if (row && row.isConnected) renderRowFromStore(row, code, fund);
      results.push({ code: code, hasEstimate: hasEstimate });
      diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=ok');
      maybeSummarizeSourceRefresh();
    }).catch(function (err) {
      diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=error', err && err.message);
      // P4.5：失败也必须结束该行 loading——立即用现有缓存重渲染，禁止永久「刷新中」
      var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
      if (row && row.isConnected) renderRowFromStore(row, code, fund);
      results.push({ code: code, status: 'ERROR', error: err });
      maybeSummarizeSourceRefresh();
    });
  }

  function showSourceToast(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      diagLog('[SOURCE_TOAST]', message);
    }
  }

  function summarizeSourceRefresh(to, version, results) {
    if (version !== window.__sourceRefreshVersion) return;
    var label = sourceDisplayName(to);
    if (to === 'local') {
      showSourceToast('本地引擎：已基于持仓计算今日估值', 'success');
      return;
    }
    var errors = results.filter(function (r) { return r.status === 'ERROR'; });
    var hasData = results.some(function (r) { return r.hasEstimate; });
    if (results.length > 0 && errors.length === results.length) {
      showSourceToast(label + '：数据获取失败，已保留当前数据', 'error');
    } else if (!hasData) {
      showSourceToast(label + '：暂无今日估值数据，已保留最近确认净值', 'warning');
    } else {
      showSourceToast(label + '：已获取今日估值', 'success');
    }
  }

  window.triggerSourceRefresh = triggerSourceRefresh;

  var scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    window.requestAnimationFrame(function () {
      scanQueued = false;
      scan();
    });
  }

  var observer = new MutationObserver(scheduleScan);
  // Rows are recreated when the active view is mounted. Watching only that
  // boundary prevents normal estimate-cell writes from scheduling re-scans.
  observer.observe(document.getElementById('view-root') || document.body, { childList: true });
  // P3.18：暴露交易日判断供分析页复用（不新建第二套交易日算法）
  window.__isTradingDay = isTradingDay;
  scan();
}());
