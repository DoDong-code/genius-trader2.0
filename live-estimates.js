(function () {
  'use strict';

  var API_BASE = window.FUND_API_BASE || '';
  var active = 0;
  var MAX_CONCURRENT = 3;
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
    return sign + '¥' + Math.abs(amount).toLocaleString('zh-CN', {
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
    return account && Array.isArray(account.funds)
      ? account.funds.find(function (fund) { return fund.code === code; })
      : null;
  }

  function formatMMDD(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    var match = dateStr.match(/(\d{2})[-/](\d{2})$/);
    return match ? match[1] + '-' + match[2] : '';
  }

  function setFundMeta(row, fund) {
    var meta = row && row.querySelector('.fund-info small');
    if (!meta || !fund) return;
    var sector = FUND_SECTORS[fund.code] || fund.sector || fund.category || '\u57fa\u91d1';
    var text = fund.code + ' \u00b7 ' + sector;
    // This function is called by a DOM observer.  Do not rewrite an already
    // correct value, otherwise replaceChildren triggers the observer again.
    if (meta.dataset.fundMeta === text) return;
    var badge = meta.querySelector('.nav-updated-badge');
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

  function clearNavUpdated(row) {
    var badge = row.querySelector('.nav-updated-badge');
    if (badge) badge.remove();
  }

  function shanghaiDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function requestJson(url, options) {
    return fetch(url, options).then(function (response) {
      if (!response.ok) {
        var error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
    });
  }

  function refreshFund(code) {
    var endpoint = API_BASE + '/api/fund/' + encodeURIComponent(code) + '?refresh=1';
    return requestJson(endpoint).catch(function (error) {
      if (error.status !== 404) throw error;
      return requestJson(API_BASE + '/api/fund/import/' + encodeURIComponent(code))
        .then(function () { return requestJson(endpoint); });
    });
  }

  function estimateFund(code, amount) {
    return requestJson(
      API_BASE + '/api/fund/' + encodeURIComponent(code) + '/estimate?amount=' + encodeURIComponent(amount)
    );
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

  function hydrateRow(row) {
    if (!row || row.dataset.estimateState === 'loading' || row.dataset.estimateState === 'ready' || row.dataset.estimateState === 'unavailable') return;
    var code = row.dataset.code;
    var fund = currentFund(code);
    if (!code || !fund) return;
    setFundMeta(row, fund);
    row.dataset.estimateState = 'loading';

    enqueue(function () {
      return Promise.allSettled([refreshFund(code), estimateFund(code, fund.amount)]).then(function (results) {
        if (!row.isConnected) return;
        var snapshot = results[0].status === 'fulfilled' ? results[0].value || {} : {};
        var payload = results[1].status === 'fulfilled' ? results[1].value || {} : {};
        var estimate = payload.estimate || payload;

        var navDate = snapshot.latest_nav && snapshot.latest_nav.date;
        if (!navDate && snapshot.fund && snapshot.fund.latest_nav) navDate = snapshot.fund.latest_nav.date;
        if (!navDate && estimate && estimate.nav_date) navDate = estimate.nav_date;

        if (navDate) {
          window.latestFundDataDate = navDate;
          if (typeof window.refreshDataStatus === 'function') window.refreshDataStatus();
        }

        var officialChange = officialNavChange(snapshot, navDate);
        if (!Number.isFinite(officialChange) && estimate && Number.isFinite(Number(estimate.estimate_change))) {
          officialChange = Number(estimate.estimate_change);
        }

        var officialUpdated = Boolean(navDate && Number.isFinite(officialChange));
        if (officialUpdated) {
          fund.navUpdatedAt = navDate;
          markNavUpdated(row, navDate, fund);
        } else {
          delete fund.navUpdatedAt;
          clearNavUpdated(row);
        }

        var payload = results[1].status === 'fulfilled' ? results[1].value || {} : {};
        var estimate = payload.estimate || payload;
        if (estimate && estimate.nav_date && !window.latestFundDataDate) {
          window.latestFundDataDate = estimate.nav_date;
          if (typeof window.refreshDataStatus === 'function') window.refreshDataStatus();
        }
        var manualDate = fund.manualEstimateDate;
        var hasManualEstimate = manualDate === shanghaiDate() && Number.isFinite(Number(fund.manualToday));
        var manualUnavailable = manualDate === shanghaiDate() && fund.manualEstimateUnavailable === true;
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
        if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
        window.dispatchEvent(new CustomEvent('fund-estimate-updated', { detail: { code: code } }));
      }).catch(function () {
        if (row.isConnected) row.dataset.estimateState = 'error';
      });
    });
  }

  function scan() {
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(hydrateRow);
  }

  window.refreshFundEstimates = function () {
    document.querySelectorAll('#view-root .fund-row[data-code]').forEach(function (row) {
      delete row.dataset.estimateState;
    });
    scan();
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
