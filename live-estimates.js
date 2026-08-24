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

  // 是否已过收盘（A股 15:00，北京时间）
  function isShanghaiAfterClose() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const time = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return Number(time.hour) * 60 + Number(time.minute) >= 15 * 60;
  }

  // P3.18 时间模型：交易日 9:00（北京时间）开盘前判断——开盘前显示最近确认净值（蓝）
  function isBeforeOpen() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const time = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return Number(time.hour) * 60 + Number(time.minute) < 9 * 60;
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

  // P3.18-ESTIMATE-STATE 临时降级：后端未部署 data_status 时，前端用 estimate 响应自推（部署后后端接管）
  // 纯前端只读 estimate 字段，不改后端；与 mp1 inferDataStatusFromEstimate 同构
  var INFER_PROVIDER_SET = { xiaobeiyangji: true, yangjibao: true, xbyj: true, yjb: true };
  function inferDataStatusFromEstimate(fund, estimate) {
    if (!estimate) return 'NO_DATA';
    var actualSource = estimate.data_source_actual || estimate.source || estimate.estimate_source;
    if (actualSource === 'local') return 'NO_DATA'; // 本地估算不算 provider 当日
    if (!actualSource || !INFER_PROVIDER_SET[actualSource]) return null; // 非 provider（让决策块走降级）
    var tradeDate = estimate.trade_date || estimate.nav_date || null;
    if (!tradeDate) return 'PROVIDER_STALE';
    var today = shanghaiDate(new Date());
    var expected = isQdiiFund(fund) ? getPreviousTradingDay(today) : today;
    return tradeDate === expected ? 'PROVIDER_TODAY' : 'PROVIDER_STALE';
  }
  window.inferDataStatusFromEstimate = inferDataStatusFromEstimate;

  // P3.18-NET：显式刷新时批量同步当天净值（后端 today-nav 幂等：命中 fund_nav 缓存直接返回，不重复请求 provider）。
  // 只在「刷新数据」按钮调用；切 Tab/切数据源/页面加载不调用（读本地缓存，不发起净值请求）。
  function refreshTodayNav() {
    var state = window.portfolioState || {};
    var active = typeof state.getActive === 'function' ? state.getActive() : '';
    var funds = (state.accounts && state.accounts[active] && state.accounts[active].funds) || [];
    var codes = [];
    funds.forEach(function (f) { if (f && f.code && codes.indexOf(String(f.code)) === -1) codes.push(String(f.code)); });
    codes = codes.slice(0, 20); // 并发上限
    return Promise.all(codes.map(function (code) {
      return requestJson(getApiBase() + '/api/fund/' + encodeURIComponent(code) + '/today-nav')
        .then(function (res) {
          if (res && res.success && res.cached && res.nav && res.date) {
            // P3.4：updatedNavDates 仅作「正式净值辅助缓存」，绝不作为独立 badge 状态源。
            // 若当前基金已是 PROVIDER_TODAY（provider 当日估值），禁止写入，避免把估值覆盖成蓝色 0824。
            var c = String(code);
            var fund = currentFund(c);
            var cached = window.fundStore ? window.fundStore.get(c) : null;
            var providerToday = cached && cached.estimate && cached.estimate.status === 'READY'
              && inferDataStatusFromEstimate(fund, cached.estimate) === 'PROVIDER_TODAY';
            if (!providerToday) {
              updatedNavDates[c] = { day: shanghaiDate(), navDate: res.date };
            } else {
              diagLog('[TODAY_NAV]', 'skip cached nav write for PROVIDER_TODAY code=' + c);
            }
          }
          return null;
        })
        .catch(function () { return null; });
    })).then(function () {
      // 重新扫描行徽章（不 force，读缓存）
      if (typeof scan === 'function') scan(false, true);
      markEstimatesRefreshed();
    });
  }
  window.refreshTodayNav = refreshTodayNav;

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
    // 二次验收：蓝徽章 = 实际净值日期（0820）；label（小倍/养基宝）放入 title 兜底
    badge.innerHTML = '<span class="desktop-tag-text">' + mmddNoHyphen + '</span><span class="mobile-tag-text">' + mmddHyphen + '</span>';
    badge.title = (label ? label + ' ' : '') + '净值更新至 ' + date;
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  function markEstimateBadge(row, fund, label, stale) {
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
    if (stale) badge.classList.add('is-stale'); else badge.classList.remove('is-stale');
    var text = label || '估算';
    badge.innerHTML = '<span class="desktop-tag-text">' + text + '</span><span class="mobile-tag-text">' + text + '</span>';
    badge.title = (stale ? '估值（待确认）' : (label ? label + '实时估值' : '今日估算数据'));
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  function clearNavUpdated(row) {
    var badge = row.querySelector('.nav-updated-badge, .nav-estimate-badge');
    if (badge) badge.remove();
  }

  // P3.18-ESTIMATE-STATE：PROVIDER_TODAY 蓝色数据源徽章（provider 当日数据=可信，蓝色）
  // 与 CONFIRMED_NAV 的 .nav-updated-badge 同色系，文字为数据源名（小倍/养基宝）
  function markProviderTodayBadge(row, fund, label) {
    var meta = row.querySelector('.fund-info small');
    if (!meta) return;
    setFundMeta(row, fund || currentFund(row.dataset.code));

    var estBadge = meta.querySelector('.nav-estimate-badge');
    if (estBadge) estBadge.remove();

    var badge = meta.querySelector('.nav-updated-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-updated-badge';
    }
    badge.innerHTML = '<span class="desktop-tag-text">' + label + '</span><span class="mobile-tag-text">' + label + '</span>';
    badge.title = label + ' 已更新今日数据（当日估值）';
    if (meta.firstChild !== badge) {
      meta.insertBefore(badge, meta.firstChild);
    }
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

  function syncFundAcrossAccounts(code, today, todayEstimate, navUpdatedAt, estimateConfidence) {
    var state = window.portfolioState;
    if (!state || !state.accounts) return;
    Object.keys(state.accounts).forEach(function (accName) {
      var account = state.accounts[accName];
      if (!account || !Array.isArray(account.funds)) return;
      account.funds.forEach(function (f) {
        if (f.code === code) {
          if (today === undefined || today === null) {
            delete f.today;
            delete f.todayEstimate;
          } else {
            f.today = today;
            f.todayEstimate = (Number(f.amount) || 0) * today;
          }
          if (navUpdatedAt === undefined || navUpdatedAt === null) {
            delete f.navUpdatedAt;
          } else {
            f.navUpdatedAt = navUpdatedAt;
          }
          if (estimateConfidence === undefined || estimateConfidence === null) {
            delete f.estimateConfidence;
          } else {
            f.estimateConfidence = estimateConfidence;
          }
        }
      });
    });
  }

  function initUpdatedNavDates() {
    var state = window.portfolioState;
    if (!state || !state.accounts) return;
    var shanghaiToday = shanghaiDate();
    var isTrading = isTradingDay(new Date());
    Object.keys(state.accounts).forEach(function (accName) {
      var account = state.accounts[accName];
      if (!account || !Array.isArray(account.funds)) return;
      account.funds.forEach(function (fund) {
        var code = String(fund.code);
        var navDate = fund.latest_nav && fund.latest_nav.date;
        if (!navDate && fund.navUpdatedAt) navDate = fund.navUpdatedAt;
        
        var expectedNavDate = isQdiiFund(fund) ? getPreviousTradingDay(shanghaiToday) : shanghaiToday;
        if (navDate && (navDate === expectedNavDate || (!isTrading && navDate))) {
          updatedNavDates[code] = { day: shanghaiToday, navDate: navDate };
        }
      });
    });
  }

  function renderRowFromStore(row, code, fund) {
    if (!row || !row.isConnected) return;
    
    var cached = window.fundStore.get(code);
    var utils = window.fundStoreUtils;
    var sToday = utils.shanghaiDate();
    var isTr = utils.isTradingDay(new Date());
    
    // Resolve change & profit
    var change = cached.todayProfit.percent;
    var profit = cached.todayProfit.value;
    
    // P3.4-STATE：统一徽章决策（冻结优先级：PROVIDER_TODAY > PROVIDER_STALE > 确认净值蓝 > 估值兜底）
    // 关键修复：后端 resolveDataStatus 在「已确认净值」存在时会优先返回 CONFIRMED_NAV，
    // 从而把 provider 当日估值覆盖成蓝色 0824。此处用 inferDataStatusFromEstimate 独立判定
    // 「当前 source 是否返回 provider 当日/旧数据」，确保 PROVIDER_TODAY 优先于确认净值蓝。
    var decision = null;
    var providerStatus = (cached.estimate && cached.estimate.status === 'READY')
      ? inferDataStatusFromEstimate(fund, cached.estimate)
      : null;

    if (providerStatus === 'PROVIDER_TODAY') {
      // 第一优先级：provider 当日估值 → 灰「估值」（不蓝、不显示数据源名）
      markEstimateBadge(row, fund, '估值', false);
      decision = 'PROVIDER_TODAY';
    } else if (providerStatus === 'PROVIDER_STALE') {
      // 第二优先级：provider 旧数据 → 灰「估值」（待确认）
      markEstimateBadge(row, fund, '估值', true);
      decision = 'PROVIDER_STALE';
    } else {
      // 第三优先级：非 provider 当日数据 → 确认净值蓝（CONFIRMED）或估值兜底
      var navDate = cached.nav.date;
      var expNavDate = utils.isQdiiFund(fund) ? utils.getPreviousTradingDay(sToday) : sToday;
      var isOfficialUpdated = Boolean(navDate && (navDate === expNavDate || (!isTr && navDate)));
      if (isOfficialUpdated || (isBeforeOpen() && navDate)) {
        markNavUpdated(row, navDate, fund);
        decision = 'CONFIRMED_NAV';
      } else {
        markEstimateBadge(row, fund, '估值', false);
        decision = 'NO_DATA';
      }
    }

    diagLog('[BADGE_DECISION]', 'code=' + code,
      'source=' + (cached.meta && cached.meta.source),
      'data_status=' + (cached.estimate ? cached.estimate.data_status : null),
      'trade_date=' + (cached.estimate ? (cached.estimate.trade_date || cached.estimate.date) : null),
      'nav_date=' + cached.nav.date,
      'providerStatus=' + providerStatus,
      'decision=' + decision);
    
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
      return window.fundDataService.refresh(code, force).then(function() {
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
    initUpdatedNavDates();
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
    var results = [];
    codes.forEach(function (code) {
      var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
      if (row) row.dataset.estimateState = 'loading'; // 立即给出刷新状态反馈
      refreshSourceRow(code, to, version, results);
    });
    Promise.allSettled(codes.map(function () { return Promise.resolve(); })).then(function () {
      // 等待所有行 refresh 完成（refreshSourceRow 内部已 push，这里用计数兜底）
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
    window.fundDataService.refresh(code, true, { version: version }).then(function () {
      if (version !== window.__sourceRefreshVersion) {
        diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=discarded(stale)');
        maybeSummarizeSourceRefresh();
        return;
      }
      var cached = window.fundStore.get(code);
      var est = cached.estimate;
      var providerStatus = (est && est.status === 'READY') ? inferDataStatusFromEstimate(fund, est) : null;
      var tradeDate = est ? (est.trade_date || est.date || null) : null;
      var actualSource = est ? (est.data_source_actual || est.source || est.estimate_source || null) : null;
      var hasEstimate = Boolean(providerStatus && providerStatus !== 'NO_DATA');
      diagLog('[SOURCE_REFRESH_RESULT]', 'source=' + to, 'version=' + version, 'code=' + code,
        'status=' + (providerStatus || 'NO_ESTIMATE'),
        'trade_date=' + tradeDate, 'data_source_actual=' + actualSource, 'hasEstimate=' + hasEstimate);
      var row = document.querySelector('#view-root .fund-row[data-code="' + String(code) + '"]');
      if (row && row.isConnected) renderRowFromStore(row, code, fund);
      results.push({ code: code, status: providerStatus, hasEstimate: hasEstimate });
      diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=ok');
      maybeSummarizeSourceRefresh();
    }).catch(function (err) {
      diagLog('[SOURCE_REFRESH_END]', 'source=' + to, 'version=' + version, 'code=' + code, 'result=error', err && err.message);
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
