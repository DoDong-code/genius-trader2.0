(function () {
  'use strict';

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
    '009690': '\u7075\u6d3b\u914d\u7f6e'
  };

  function formatMoney(value) {
    var amount = Number(value) || 0;
    var sign = amount < 0 ? '−' : amount > 0 ? '+' : '';
    return sign + '' + Math.abs(amount).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatPercent(value) {
    var rate = (Number(value) || 0) * 100;
    return (rate > 0 ? '+' : '') + rate.toFixed(2) + '%';
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

  // 是否已过收盘（A股 15:00，北京时间）
  function isShanghaiAfterClose() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const time = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return Number(time.hour) * 60 + Number(time.minute) >= 15 * 60;
  }

  // QDII 类基金：今天结算上一交易日净值（如 8.7 交易，结算 8.6 净值）
  // 仅美股/全球类基金延迟；港股（恒生/港股/港美）基金按当日结算，交易日正常显示当日估算
  var QDII_CODES = { '022184': true, '014002': true };
  function isQdiiFund(fund) {
    if (!fund) return false;
    var fundName = String(fund.name || '');
    if (/恒生|港股|港美/.test(fundName)) return false;
    if (QDII_CODES[String(fund.code || '')]) return true;
    return /QDII|全球|海外|纳斯达克|纳指|标普|日经|德国|法国|印度|越南|美国|道琼斯|欧洲/i.test(fundName);
  }

  function providerDisplayName(source) {
    if (source === 'xiaobeiyangji') return '小倍';
    if (source === 'yangjibao') return '养基宝';
    return null;
  }

  // 已更新净值的缓存：code -> { day, navDate }，切换 tab 不重复请求，仅手动刷新时更新
  var updatedNavDates = {};

  // 记录某账户最近一次成功刷新估值的时间（按账户），供 AI 诊断判断是否需要重新刷新
  function markEstimatesRefreshed() {
    var accountName = window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : '';
    window.lastEstimatesRefreshAtByAccount = window.lastEstimatesRefreshAtByAccount || {};
    window.lastEstimatesRefreshAtByAccount[accountName] = Date.now();
  }
  window.markEstimatesRefreshed = markEstimatesRefreshed;

  function getPreviousTradingDay(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    while (true) {
      d.setDate(d.getDate() - 1);
      var yyyy = d.getFullYear();
      var mm = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      if (isTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
        return yyyy + '-' + mm + '-' + dd;
      }
    }
  }

  function setFundMeta(row, fund) {
    var meta = row && row.querySelector('.fund-info small');
    if (!meta || !fund) return;
    var sector = FUND_SECTORS[fund.code] || fund.sector || fund.category || '\u57fa\u91d1';
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
    var desktopText = '已更新' + (mmddNoHyphen || mmddHyphen || '');
    var mobileText = mmddHyphen || ('已更新' + (mmddNoHyphen || ''));
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

  function markProviderUpdated(row, date, fund, label) {
    var meta = row.querySelector('.fund-info small');
    if (!meta) return;
    setFundMeta(row, fund || currentFund(row.dataset.code));

    // Remove estimate badge if present
    var estBadge = meta.querySelector('.nav-estimate-badge');
    if (estBadge) estBadge.remove();

    var mmddHyphen = formatMMDD(date);
    var mmddNoHyphen = mmddHyphen.replace('-', '');
    var badge = meta.querySelector('.nav-updated-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-updated-badge';
    }
    badge.innerHTML = '<span class="desktop-tag-text">' + label + mmddNoHyphen + '</span><span class="mobile-tag-text">' + mmddHyphen + '</span>';
    badge.title = label + '净值更新至 ' + date;
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

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
    var text = label || '估算';
    badge.innerHTML = '<span class="desktop-tag-text">' + text + '</span><span class="mobile-tag-text">' + text + '</span>';
    badge.title = label ? label + '实时估值' : '今日估算数据';
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  function clearNavUpdated(row) {
    var badge = row.querySelector('.nav-updated-badge, .nav-estimate-badge');
    if (badge) badge.remove();
  }

  function shanghaiDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function requestJson(url, options) {
    var headers = Object.assign({}, (options && options.headers) || {}, window.auth && window.auth.authHeaders ? window.auth.authHeaders() : {});
    return fetch(url, Object.assign({}, options, { headers: headers })).then(function (response) {
      if (!response.ok) {
        var error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
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

  function officialNavChange(snapshot, navDate) {
    if (!snapshot || !navDate) return null;
    var history = Array.isArray(snapshot && snapshot.history) ? snapshot.history.slice() : [];
    var records = history
      .filter(function (item) { return item && item.date && Number.isFinite(Number(item.nav)); })
      .sort(function (left, right) { return String(left.date).localeCompare(String(right.date)); });
    var currentIndex = records.findIndex(function (item) { return item.date === navDate; });
    if (currentIndex > 0) {
      var current = Number(records[currentIndex].nav);
      var previous = Number(records[currentIndex - 1].nav);
      if (!Number.isNaN(current) && !Number.isNaN(previous) && previous > 0) {
        return current / previous - 1;
      }
    }
    if (snapshot.latest_nav && snapshot.latest_nav.date === navDate && Number.isFinite(Number(snapshot.latest_nav.changePercent))) {
      return Number(snapshot.latest_nav.changePercent);
    }
    return null;
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

  function hydrateRow(row, force, estimateOnly) {
    if (!row || row.dataset.estimateState === 'loading' || (!force && (row.dataset.estimateState === 'ready' || row.dataset.estimateState === 'unavailable'))) return;
    var code = row.dataset.code;
    var fund = currentFund(code);
    if (!code || !fund) return;
    setFundMeta(row, fund);
    if (estimateOnly) {
      row.dataset.estimateState = 'loading';
      enqueue(function () {
        return estimateFund(code, fund.amount, force).then(function (payload) {
          if (!row.isConnected) return;
          var estimate = payload && (payload.estimate || payload);
          var change = Number(estimate && estimate.estimate_change);
          if (!Number.isFinite(change)) {
            showEstimateUnavailable(row);
            row.dataset.estimateState = 'unavailable';
            return;
          }
          var profit = Number.isFinite(Number(estimate.estimate_profit))
            ? Number(estimate.estimate_profit)
            : (Number(fund.amount) || 0) * change;
          var pLabel = providerDisplayName(estimate && (estimate.source || estimate.estimate_source));
          fund.today = change;
          fund.todayEstimate = profit;
          fund.estimateConfidence = estimate.confidence || null;
          clearNavUpdated(row);
          markEstimateBadge(row, fund, pLabel);
          updateTodayCell(row, change, profit);
          row.dataset.estimateState = 'ready';
          markEstimatesRefreshed();
          if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
          window.dispatchEvent(new CustomEvent('fund-estimate-updated', { detail: { code: code } }));
        }).catch(function () {
          if (row.isConnected) row.dataset.estimateState = 'error';
        });
      });
      return;
    }
    // 已更新净值的基金：切换 tab 直接复用缓存，不重复请求（除非手动刷新数据）
    var cachedNav = updatedNavDates[String(code)];
    if (!force && cachedNav && cachedNav.day === shanghaiDate()) {
      if (Number.isFinite(Number(fund.today))) {
        updateTodayCell(row, Number(fund.today), Number(fund.todayEstimate) || (Number(fund.amount) || 0) * Number(fund.today));
      } else {
        showEstimateUnavailable(row);
      }
      markNavUpdated(row, cachedNav.navDate, fund);
      row.dataset.estimateState = 'ready';
      markEstimatesRefreshed();
      return;
    }
    row.dataset.estimateState = 'loading';

    enqueue(function () {
      return Promise.allSettled([refreshFund(code, force), estimateFund(code, fund.amount, force)]).then(function (results) {
        if (!row.isConnected) return;
        var snapshot = results[0].status === 'fulfilled' ? results[0].value || {} : {};
        var payload = results[1].status === 'fulfilled' ? results[1].value || {} : {};
        var estimate = payload.estimate || payload;

        var navDate = snapshot.latest_nav && snapshot.latest_nav.date;
        if (!navDate && snapshot.fund && snapshot.fund.latest_nav) navDate = snapshot.fund.latest_nav.date;
        if (!navDate && estimate && estimate.nav_date) navDate = estimate.nav_date;

        var officialChange = officialNavChange(snapshot, navDate);
        if (!Number.isFinite(officialChange) && estimate && Number.isFinite(Number(estimate.estimate_change))) {
          officialChange = Number(estimate.estimate_change);
        }

        var shanghaiToday = shanghaiDate();
        // QDII 基金今天结算上一交易日净值；普通基金结算当日净值
        var expectedNavDate = isQdiiFund(fund) ? getPreviousTradingDay(shanghaiToday) : shanghaiToday;
        var officialUpdated = Boolean(navDate && navDate === expectedNavDate && Number.isFinite(officialChange));
        var isTrading = isTradingDay(new Date());
        var estimateSource = estimate && (estimate.source || estimate.estimate_source);
        var providerLabel = providerDisplayName(estimateSource);
        var providerDataToday = providerLabel && estimate && String(estimate.estimate_time || '').slice(0, 10) === shanghaiToday;

        if (officialUpdated) {
          // 官方净值已更新到预期日期（如 0811）→ 蓝色“已更新0811”
          fund.navUpdatedAt = navDate;
          updatedNavDates[String(code)] = { day: shanghaiToday, navDate: navDate };
          markNavUpdated(row, navDate, fund);
        } else if (!isTrading && navDate) {
          // 非交易日：显示最新已公布净值（蓝色“已更新MMDD”）
          fund.navUpdatedAt = navDate;
          updatedNavDates[String(code)] = { day: shanghaiToday, navDate: navDate };
          markNavUpdated(row, navDate, fund);
        } else {
          // 净值尚未更新（含交易日盘中与盘后）：灰色估值标识（估值/小倍/养基宝）
          delete fund.navUpdatedAt;
          clearNavUpdated(row);
          markEstimateBadge(row, fund, providerLabel);
        }

        var estimateDate = estimate && (estimate.trade_date || estimate.nav_date);
        var dataDateToSet = navDate;
        if (estimateDate && estimateDate === shanghaiToday && !officialUpdated) {
          dataDateToSet = shanghaiToday;
        }
        if (dataDateToSet) {
          window.latestFundDataDate = dataDateToSet;
          if (typeof window.refreshDataStatus === 'function') window.refreshDataStatus();
        }

        var manualDate = fund.manualEstimateDate;
        var hasManualEstimate = manualDate === shanghaiToday && Number.isFinite(Number(fund.manualToday));
        var manualUnavailable = manualDate === shanghaiToday && fund.manualEstimateUnavailable === true;
        var change = officialUpdated ? officialChange : (hasManualEstimate ? Number(fund.manualToday) : Number(estimate.estimate_change));
        // When the official NAV has not yet arrived, use the public intraday
        // estimate returned with the refreshed fund snapshot as a safe fallback.
        if (!officialUpdated && !Number.isFinite(change)) {
          change = Number(snapshot.estimate && snapshot.estimate.estimate_change);
        }
        if (manualUnavailable && !officialUpdated) {
          delete fund.today;
          delete fund.todayEstimate;
          showEstimateUnavailable(row);
          row.dataset.estimateState = 'unavailable';
          if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
          return;
        }
        if (!Number.isFinite(change)) {
          delete fund.today;
          delete fund.todayEstimate;
          delete fund.estimateConfidence;
          showEstimateUnavailable(row);
          row.dataset.estimateState = 'unavailable';
          if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
          window.dispatchEvent(new CustomEvent('fund-estimate-updated', { detail: { code: code, unavailable: true } }));
          return;
        }
        var profit = officialUpdated ? NaN : (hasManualEstimate ? (Number(fund.amount) || 0) * change : Number(estimate.estimate_profit));
        if (!Number.isFinite(profit)) profit = (Number(fund.amount) || 0) * change;

        fund.today = change;
        fund.todayEstimate = profit;
        fund.estimateConfidence = estimate.confidence || null;
        updateTodayCell(row, change, profit);

        row.dataset.estimateState = 'ready';
        markEstimatesRefreshed();
        if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
        // 已登录第三方但本次估值是本地引擎：稍后拉取第三方估值并更正（谁快谁先出）
        if (!providerLabel && !officialUpdated) {
          window.setTimeout(function () {
            if (typeof window.getProviderConnected !== 'function' || !window.getProviderConnected()) return;
            requestJson(getApiBase() + '/api/fund/' + encodeURIComponent(code) + '/estimate?amount=' + (Number(fund.amount) || 0) + '&mode=provider&source=' + encodeURIComponent(preferredEstimateSource()))
              .then(function (payload) {
                if (!row.isConnected) return;
                var pv = payload && (payload.estimate || payload);
                var pChange = Number(pv && pv.estimate_change);
                var pLabel = providerDisplayName(pv && (pv.source || pv.estimate_source));
                if (!pLabel || !Number.isFinite(pChange)) return;
                fund.today = pChange;
                fund.todayEstimate = Number.isFinite(Number(pv.estimate_profit))
                  ? Number(pv.estimate_profit)
                  : (Number(fund.amount) || 0) * pChange;
                updateTodayCell(row, fund.today, fund.todayEstimate);
                clearNavUpdated(row);
                markEstimateBadge(row, fund, pLabel);
                if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
              }).catch(function () {});
          }, 2500);
        }
        window.dispatchEvent(new CustomEvent('fund-estimate-updated', { detail: { code: code } }));
      }).catch(function () {
        if (row.isConnected) row.dataset.estimateState = 'error';
      });
    });
  }

  function scan(force, estimateOnly) {
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(function (row) {
      // 初次/切换 tab 进入：不强制重抓基金详情，走服务端缓存，避免多基金排队卡顿
      hydrateRow(row, force, estimateOnly);
    });
  }

  window.refreshFundEstimates = function (estimateOnly) {
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
  scan();
}());
