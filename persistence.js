(function(){
  const state=window.portfolioState;
  if(!state)return;
  const storageKey='genius-trader-portfolio-v2';
  const originalSetActive=state.setActive.bind(state);
  // 同步账户的服务端数据只存持仓；策略等本地元数据随本地/云端 JSON 一并备份
  let syncMetaStore={};
  window.accountRestoreStatus = (window.auth && window.auth.state && window.auth.state.token) ? 'restoring' : 'ready';

  // Define fundStoreUtils on window first
  window.fundStoreUtils = {
    shanghaiDate: function() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    },
    
    isTradingDay: function(date) {
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
    },
    
    getPreviousTradingDay: function(dateStr) {
      var parts = dateStr.split('-');
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      while (true) {
        d.setDate(d.getDate() - 1);
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        if (this.isTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
          return yyyy + '-' + mm + '-' + dd;
        }
      }
    },

    getLatestTradingDay: function(dateStr) {
      var parts = dateStr.split('-');
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      while (true) {
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        if (this.isTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
          return yyyy + '-' + mm + '-' + dd;
        }
        d.setDate(d.getDate() - 1);
      }
    },
    
    isQdiiFund: function(fund) {
      if (!fund) return false;
      var fundName = String(fund.name || fund.fund_name || '');
      if (/恒生|港股|港美/.test(fundName)) return false;
      var QDII_CODES = { '022184': true, '014002': true };
      if (QDII_CODES[String(fund.code || '')]) return true;
      return /QDII|全球|海外|纳斯达克|纳指|标普|日经|德国|法国|印度|越南|美国|道琼斯|欧洲/i.test(fundName);
    },

    officialNavChange: function(fund, navDate) {
      if (!fund || !navDate) return null;
      var history = Array.isArray(fund.history) ? fund.history.slice() : [];
      if (history.length === 0 && fund._history && Array.isArray(fund._history.data)) {
        history = fund._history.data.slice();
      }
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
      if (fund.nav && fund.nav.date === navDate) {
        if (Number.isFinite(Number(fund.nav.percent))) return Number(fund.nav.percent);
        if (Number.isFinite(Number(fund.nav.changePercent))) return Number(fund.nav.changePercent);
      }
      
      var detailData = {};
      if (fund.detail) {
        if (fund.detail.data && typeof fund.detail.data === 'object') {
          detailData = fund.detail.data;
        } else {
          detailData = fund.detail;
        }
      } else if (fund._detail && fund._detail.data) {
        detailData = fund._detail.data;
      }
      
      if (detailData.latest_nav && detailData.latest_nav.date === navDate) {
        if (Number.isFinite(Number(detailData.latest_nav.changePercent))) return Number(detailData.latest_nav.changePercent);
        if (Number.isFinite(Number(detailData.latest_nav.percent))) return Number(detailData.latest_nav.percent);
      }
      return null;
    }
  };

  function calculateTodayProfit(fund) {
    var change = null;
    var utils = window.fundStoreUtils;
    if (!utils) return { value: null, percent: null, status: 'EMPTY' };
    
    var sToday = utils.shanghaiDate();
    
    var detailData = {};
    if (fund.detail) {
      if (fund.detail.data && typeof fund.detail.data === 'object') {
        detailData = fund.detail.data;
      } else {
        detailData = fund.detail;
      }
    } else if (fund._detail && fund._detail.data) {
      detailData = fund._detail.data;
    }
    
    // 1. Try manual estimate first
    var manualDate = detailData.manualEstimateDate;
    var hasManualEstimate = manualDate === sToday && Number.isFinite(Number(detailData.manualToday));
    if (hasManualEstimate && detailData.manualEstimateUnavailable !== true) {
      change = Number(detailData.manualToday);
    } else if (detailData.manualEstimateUnavailable === true) {
      return { value: null, percent: null, status: 'ERROR' };
    }
    
    // 2. Try official nav change
    if (change === null && fund.nav && fund.nav.status === 'READY') {
      var navDate = fund.nav.date;
      var expectedNavDate = utils.isQdiiFund(fund) ? utils.getPreviousTradingDay(sToday) : sToday;
      var isTr = utils.isTradingDay(new Date());
      var isOfficialUpdated = Boolean(navDate === expectedNavDate || (!isTr && navDate));
      if (isOfficialUpdated) {
        change = (fund.nav.percent !== undefined && fund.nav.percent !== null) ? fund.nav.percent : fund.nav.changePercent;
        if (change === null || change === undefined || !Number.isFinite(change)) {
          change = utils.officialNavChange(fund, navDate);
        }
      }
    }
    
    // 3. Try intraday estimate change
    if (change === null && fund.estimate && fund.estimate.status === 'READY') {
      var estDate = fund.estimate.date;
      var expectedEstDate = utils.isQdiiFund(fund) ? utils.getPreviousTradingDay(sToday) : sToday;
      if (estDate === expectedEstDate || estDate === sToday || !utils.isTradingDay(new Date())) {
        change = fund.estimate.value;
      }
    }
    
    // 4. Fallback: try latest NAV change percent
    if (change === null && fund.nav && fund.nav.status === 'READY') {
      change = (fund.nav.percent !== undefined && fund.nav.percent !== null) ? fund.nav.percent : fund.nav.changePercent;
      if (change === null || change === undefined || !Number.isFinite(change)) {
        change = utils.officialNavChange(fund, fund.nav.date);
      }
    }
    
    if (change !== null && Number.isFinite(change)) {
      var state = window.portfolioState;
      var account = state && state.accounts && state.accounts[state.getActive()];
      var currentFundObj = account && account.funds && account.funds.find(function(f) { return String(f.code) === String(fund.code); });
      var amount = currentFundObj ? (Number(currentFundObj.amount) || 0) : 0;
      
      return {
        percent: change,
        value: amount * change,
        status: 'READY'
      };
    }
    
    return {
      percent: null,
      value: null,
      status: 'LOADING'
    };
  }
  window.calculateTodayProfit = calculateTodayProfit;

  function mergeFundData(code, data) {
    const fund = window.fundStore.get(code);
    if (!data) return fund;
    
    const utils = window.fundStoreUtils;
    let anyMerged = false;

    // Field-level merging with non-regression rules
    if (data.snapshot) {
      const snap = data.snapshot;
      const l_nav = snap.latest_nav || (snap.fund && snap.fund.latest_nav);
      
      if (l_nav && l_nav.date) {
        const sToday = utils.shanghaiDate();
        const maxAllowedDate = utils.isQdiiFund(fund)
          ? utils.getPreviousTradingDay(utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday))
          : (utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday));
        const isCachedInvalid = fund.nav.date && String(fund.nav.date).localeCompare(maxAllowedDate) > 0;
        // Prevent date regression: don't overwrite with older date unless the cached date is invalid
        if (isCachedInvalid || !fund.nav.date || String(l_nav.date).localeCompare(String(fund.nav.date)) >= 0) {
          console.log('[DATA][MERGE] code=' + code + ' field=nav date=' + l_nav.date);
          fund.nav.date = l_nav.date;
          if (l_nav.nav !== undefined && l_nav.nav !== null) {
            fund.nav.value = Number(l_nav.nav);
          }
          if (l_nav.changePercent !== undefined && l_nav.changePercent !== null) {
            fund.nav.percent = Number(l_nav.changePercent);
          }
          fund.nav.status = 'READY';
          anyMerged = true;
        } else {
          console.log('[DATA][PRESERVE] code=' + code + ' field=nav existing newer date kept');
        }
      }
      
      if (Array.isArray(snap.history) && snap.history.length > 0) {
        console.log('[DATA][MERGE] code=' + code + ' field=history count=' + snap.history.length);
        fund._history.data = snap.history;
        fund._history.status = 'READY';
        anyMerged = true;
      }
      
      if (snap.fund) {
        console.log('[DATA][MERGE] code=' + code + ' field=detail');
        fund._detail.data = { ...fund._detail.data, ...snap.fund };
        fund._detail.status = 'READY';
        anyMerged = true;
      }
      
      if (Array.isArray(snap.holdings) && snap.holdings.length > 0) {
        fund.holdings = snap.holdings;
      }
      if (snap.calibration) {
        fund.calibration = snap.calibration;
      }
    }
    
    if (data.estimate) {
      const est = data.estimate;
      const estDate = est.trade_date || est.nav_date;
      
      if (estDate) {
        const sToday = utils.shanghaiDate();
        const maxAllowedDate = utils.isQdiiFund(fund)
          ? utils.getPreviousTradingDay(utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday))
          : (utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday));
        const isCachedInvalid = fund.estimate.date && String(fund.estimate.date).localeCompare(maxAllowedDate) > 0;
        if (isCachedInvalid || !fund.estimate.date || String(estDate).localeCompare(String(fund.estimate.date)) >= 0) {
          console.log('[DATA][MERGE] code=' + code + ' field=estimate date=' + estDate);
          fund.estimate.date = estDate;
          if (est.estimate_change !== undefined && est.estimate_change !== null) {
            fund.estimate.value = Number(est.estimate_change);
          }
          if (est.confidence !== undefined && est.confidence !== null) {
            fund.estimate.confidence = est.confidence;
          }
          if (est.source || est.estimate_source) {
            fund.meta.source = est.source || est.estimate_source;
          }
          if (est.data_status) {
            fund.estimate.data_status = est.data_status;
          }
          if (est.trade_date) {
            fund.estimate.trade_date = est.trade_date;
          }
          if (est.data_source_actual) {
            fund.estimate.data_source_actual = est.data_source_actual;
          }
          if (est.source || est.estimate_source) {
            fund.estimate.source = est.source || est.estimate_source;
          }
          fund.estimate.status = 'READY';
          anyMerged = true;
        } else {
          console.log('[DATA][PRESERVE] code=' + code + ' field=estimate existing newer date kept');
        }
      }
    }
    
    if (data.nav && data.nav.date) {
      const sToday = utils.shanghaiDate();
      const maxAllowedDate = utils.isQdiiFund(fund)
        ? utils.getPreviousTradingDay(utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday))
        : (utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday));
      const isCachedInvalid = fund.nav.date && String(fund.nav.date).localeCompare(maxAllowedDate) > 0;
      if (isCachedInvalid || !fund.nav.date || String(data.nav.date).localeCompare(String(fund.nav.date)) >= 0) {
        console.log('[DATA][MERGE] code=' + code + ' field=nav date=' + data.nav.date);
        fund.nav.date = data.nav.date;
        if (data.nav.value !== undefined && data.nav.value !== null) {
          fund.nav.value = Number(data.nav.value);
        }
        if (data.nav.percent !== undefined && data.nav.percent !== null) {
          fund.nav.percent = Number(data.nav.percent);
        }
        fund.nav.status = 'READY';
        anyMerged = true;
      }
    }

    // Restore REFRESHING statuses back to READY if they weren't updated
    if (fund.nav.status === 'REFRESHING') fund.nav.status = 'READY';
    if (fund.estimate.status === 'REFRESHING') fund.estimate.status = 'READY';
    if (fund.todayProfit.status === 'REFRESHING') fund.todayProfit.status = 'READY';
    
    // Re-evaluate today's profit
    const profitResult = calculateTodayProfit(fund);
    fund.todayProfit.percent = profitResult.percent;
    fund.todayProfit.value = profitResult.value;
    fund.todayProfit.status = profitResult.status;
    
    if (profitResult.status === 'READY') {
      fund.meta.lastValidAt = new Date().toISOString();
    }
    fund.meta.updatedAt = new Date().toISOString();
    
    // Sync backward compatible flatter fields
    fund.todayProfitPercent = fund.todayProfit.percent;
    fund.todayProfitValue = fund.todayProfit.value; // For backwards safety
    fund.navUpdatedAt = (fund.nav && fund.nav.status === 'READY') ? fund.nav.date : undefined;
    fund.estimateConfidence = fund.estimate.confidence || null;
    fund.estimateSource = fund.meta.source || null;
    fund.history = fund._history.data || [];
    fund.detail = fund._detail.data || {};
    
    // Propagate changes to accounts
    window.fundStore.propagate(code);
    
    if (typeof window.savePortfolioState === 'function') {
      window.savePortfolioState();
    }
    
    window.dispatchEvent(new CustomEvent('fund-store-updated', { detail: { code: code } }));
    return fund;
  }
  window.mergeFundData = mergeFundData;

  const storeMethods = {
    get: function(code) {
      if (!this[code]) {
        this[code] = {
          code: code,
          nav: { value: null, date: null, status: 'EMPTY' },
          estimate: { value: null, date: null, status: 'EMPTY', confidence: null },
          todayProfit: { value: null, percent: null, status: 'EMPTY' },
          _history: { data: [], status: 'EMPTY' },
          _detail: { data: {}, status: 'EMPTY' },
          history: [],
          detail: {},
          meta: { source: null, updatedAt: null, lastValidAt: null },
          
          // Flatter fields for backward compatibility
          todayProfitPercent: null,
          todayProfitValue: null,
          navUpdatedAt: null,
          estimateConfidence: null,
          estimateSource: null,
          history_compat: [],
          holdings: [],
          calibration: null,
          status: { refreshing: false }
        };
      }
      return this[code];
    },
    
    update: function(code, data) {
      const fund = this.get(code);
      if (!data) return fund;
      
      let changed = false;
      
      if (data.nav !== undefined && data.nav !== null) {
        fund.nav = { ...fund.nav, ...data.nav };
        changed = true;
      }
      if (data.estimate !== undefined && data.estimate !== null) {
        fund.estimate = { ...fund.estimate, ...data.estimate };
        changed = true;
      }
      if (data.todayProfitPercent !== undefined) {
        fund.todayProfit.percent = data.todayProfitPercent;
        fund.todayProfit.status = 'READY';
        changed = true;
      }
      if (data.todayProfit !== undefined && data.todayProfit !== null) {
        if (typeof data.todayProfit === 'object') {
          fund.todayProfit = { ...fund.todayProfit, ...data.todayProfit };
        } else {
          fund.todayProfit.value = Number(data.todayProfit) || null;
          fund.todayProfit.status = 'READY';
        }
        changed = true;
      }
      if (data.history !== undefined && data.history !== null) {
        if (Array.isArray(data.history)) {
          fund._history.data = data.history;
          fund._history.status = 'READY';
        } else {
          fund._history = { ...fund._history, ...data.history };
        }
        changed = true;
      }
      if (data.detail !== undefined && data.detail !== null) {
        if (data.detail.data) {
          fund._detail = { ...fund._detail, ...data.detail };
        } else {
          fund._detail.data = { ...fund._detail.data, ...data.detail };
          fund._detail.status = 'READY';
        }
        changed = true;
      }
      if (data.meta !== undefined && data.meta !== null) {
        fund.meta = { ...fund.meta, ...data.meta };
        changed = true;
      }
      if (data.holdings !== undefined) {
        fund.holdings = data.holdings;
        changed = true;
      }
      if (data.calibration !== undefined) {
        fund.calibration = data.calibration;
        changed = true;
      }
      
      // Update backwards compatible fields
      fund.todayProfitPercent = fund.todayProfit.percent;
      fund.todayProfitValue = fund.todayProfit.value;
      fund.navUpdatedAt = (fund.nav && fund.nav.status === 'READY') ? fund.nav.date : undefined;
      fund.estimateConfidence = fund.estimate.confidence || null;
      fund.estimateSource = fund.meta.source || null;
      fund.history = fund._history.data || [];
      fund.detail = fund._detail.data || {};
      
      this.propagate(code);
      
      if (changed) {
        if (typeof window.savePortfolioState === 'function') {
          window.savePortfolioState();
        }
        window.dispatchEvent(new CustomEvent('fund-store-updated', { detail: { code: code } }));
      }
      return fund;
    },
    
    propagate: function(code) {
      const src = this.get(code);
      const s = window.portfolioState;
      if (!s || !s.accounts) return;
      Object.keys(s.accounts).forEach(function(accName) {
        const account = s.accounts[accName];
        if (!account || !Array.isArray(account.funds)) return;
        account.funds.forEach(function(f) {
          if (String(f.code) === String(code)) {
            if (src.todayProfit.percent !== undefined && src.todayProfit.percent !== null) {
              f.today = src.todayProfit.percent;
              f.todayEstimate = (Number(f.amount) || 0) * src.todayProfit.percent;
            } else {
              f.today = null;
              f.todayEstimate = null;
            }
            if (src.nav.date) {
              f.navUpdatedAt = src.nav.date;
              f.latest_nav = f.latest_nav || {};
              f.latest_nav.date = src.nav.date;
              f.latest_nav.nav = src.nav.value;
              f.latest_nav.changePercent = src.nav.percent;
            } else {
              f.navUpdatedAt = null;
              f.latest_nav = null;
            }
            if (src.estimate.confidence !== undefined) {
              f.estimateConfidence = src.estimate.confidence;
            }
            if (src.meta.source !== undefined) {
              f.estimateSource = src.meta.source;
            }
            const historyArray = Array.isArray(src.history) ? src.history : (src._history && src._history.data) || [];
            if (historyArray && historyArray.length > 0) {
              f.history = historyArray;
            }
            if (src.holdings && src.holdings.length > 0) {
              f.holdings = src.holdings;
            }
            if (src.estimate && src.estimate.status === 'READY') {
              f.estimate = f.estimate || {};
              f.estimate.estimate_change = src.estimate.value;
              f.estimate.trade_date = src.estimate.date;
              f.estimate.confidence = src.estimate.confidence;
              f.estimate.source = src.meta.source;
            }
          }
        });
      });
    }
  };

  window.fundStore = window.fundStore || {};
  Object.defineProperty(window.fundStore, 'get', { value: storeMethods.get, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(window.fundStore, 'update', { value: storeMethods.update, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(window.fundStore, 'propagate', { value: storeMethods.propagate, enumerable: false, writable: true, configurable: true });

  // Account Store and Service
  window.accountStore = {
    get accounts() {
      return window.portfolioState ? window.portfolioState.accounts : {};
    },
    get activeAccountId() {
      return window.portfolioState ? window.portfolioState.getActive() : '';
    },
    set activeAccountId(id) {
      if (window.portfolioState && typeof window.portfolioState.setActive === 'function') {
        window.portfolioState.setActive(id);
      }
    }
  };

  window.accountDataService = {
    switchAccount: function(accountId) {
      console.log('[ACCOUNT] switch to ' + accountId);
      window.accountStore.activeAccountId = accountId;
      if (typeof window.savePortfolioState === 'function') window.savePortfolioState();
      window.dispatchEvent(new CustomEvent('account-changed', { detail: { activeAccountId: accountId } }));
    }
  };

  // Network Request Helpers at the Data Layer
  function getApiBase() { return window.FUND_API_BASE || ''; }

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
  window.requestJson = requestJson;

  function refreshFund(code, force) {
    var endpoint = getApiBase() + '/api/fund/' + encodeURIComponent(code) + (force ? '?refresh=1&fast=1' : '');
    return requestJson(endpoint).catch(function (error) {
      if (error.status !== 404) throw error;
      var importUrl = getApiBase() + '/api/fund/import/' + encodeURIComponent(code) + (force ? '?force=1' : '');
      return requestJson(importUrl)
        .then(function () { return requestJson(endpoint); });
    });
  }
  window.refreshFund = refreshFund;

  function preferredEstimateSource() {
    var accountName = window.portfolioState && window.portfolioState.getActive ? window.portfolioState.getActive() : '';
    try {
      return localStorage.getItem('estimate_source_' + accountName) || 'local';
    } catch (err) {
      return 'local';
    }
  }
  window.preferredEstimateSource = preferredEstimateSource;

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
  window.estimateFund = estimateFund;

  // Unified Fund Data Service
  window.fundDataService = {
    refresh: function(code, force) {
      console.log('[DATA][REQUEST] code=' + code + ' force=' + !!force);
      
      const fund = window.fundStore.get(code);
      
      // Update statuses to LOADING or REFRESHING
      const isNavReady = fund.nav && fund.nav.status === 'READY';
      const isEstReady = fund.estimate && fund.estimate.status === 'READY';
      const isProfitReady = fund.todayProfit && fund.todayProfit.status === 'READY';
      
      window.fundStore.update(code, {
        nav: { status: isNavReady ? 'REFRESHING' : 'LOADING' },
        estimate: { status: isEstReady ? 'REFRESHING' : 'LOADING' },
        todayProfit: { status: isProfitReady ? 'REFRESHING' : 'LOADING' }
      });
      
      var state = window.portfolioState;
      var account = state && state.accounts && state.accounts[state.getActive()];
      var currentFundObj = account && account.funds && account.funds.find(function(f) { return String(f.code) === String(code); });
      var amount = currentFundObj ? (Number(currentFundObj.amount) || 0) : 0;
      
      return Promise.allSettled([
        refreshFund(code, force),
        estimateFund(code, amount, force)
      ]).then(function(results) {
        const snapshotRes = results[0].status === 'fulfilled' ? results[0].value : null;
        const estimateRes = results[1].status === 'fulfilled' ? results[1].value : null;
        
        console.log('[DATA][SUCCESS] code=' + code + ' source=' + (estimateRes && (estimateRes.source || estimateRes.estimate_source) || 'local'));
        
        const mergedData = {
          snapshot: snapshotRes,
          estimate: estimateRes
        };
        
        window.mergeFundData(code, mergedData);
        return window.fundStore.get(code);
      }).catch(function(err) {
        console.error('[DATA][ERROR] code=' + code, err);
        
        // Revert statuses from REFRESHING back to READY, or if they failed from LOADING, set to ERROR
        const f = window.fundStore.get(code);
        window.fundStore.update(code, {
          nav: { status: f.nav.status === 'REFRESHING' ? 'READY' : 'ERROR' },
          estimate: { status: f.estimate.status === 'REFRESHING' ? 'READY' : 'ERROR' },
          todayProfit: { status: f.todayProfit.status === 'REFRESHING' ? 'READY' : 'ERROR' }
        });
        
        throw err;
      });
    },
    
    refreshMany: function(codes, force) {
      if (!Array.isArray(codes)) return Promise.resolve([]);
      return Promise.allSettled(codes.map(function(code) {
        return window.fundDataService.refresh(code, force);
      }));
    }
  };

  function buildPersisted(){
    // 同步账户的持仓由服务端权威存储，不写入本地/云端 JSON；本地账户（含由同步转换的）正常持久化
    const persisted={};
    Object.keys(state.accounts).forEach(name=>{
      const account=state.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source)))return;
      persisted[name]=account;
    });
    const syncMeta={};
    Object.keys(state.accounts).forEach(name=>{
      const account=state.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&Array.isArray(account.strategy)&&account.strategy.length){
        syncMeta[name]={ strategy: account.strategy.slice() };
      }
    });
    return { accounts:persisted, active:state.getActive(), syncMeta, fundStore: window.fundStore };
  }

  function normalizeAccount(account){
    if(!account||typeof account!=='object')return;
    if(account.accountType==='sync'||account.accountType==='local')return;
    if(account.__source){
      account.accountType='sync';
      account.syncSource=account.syncSource||account.__source;
    }else{
      account.accountType='local';
    }
    if(account.accountType==='local')account.syncSource=account.syncSource||null;
  }

  let cloudTimer=null;
  function scheduleCloudSave(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return;
    clearTimeout(cloudTimer);
    cloudTimer=setTimeout(()=>{
      fetch('/api/account/state',{
        method:'PUT',
        headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
        body:JSON.stringify({state:buildPersisted()})
      }).catch(()=>{});
    },400);
  }

  function save(){
    if (window.accountRestoreStatus === 'restoring') {
      console.log('[ACCOUNT] save ignored because status is restoring');
      return;
    }
    try{
      const payload=buildPersisted();
      localStorage.setItem(storageKey,JSON.stringify(payload));
      // 同步账户元数据合并：仅当该同步账户当前存在且策略为空时才清除，
      // 避免云端恢复/重新加载同步账户过程中被空元数据误清
      const newMeta=payload.syncMeta||{};
      const merged=Object.assign({},syncMetaStore,newMeta);
      Object.keys(merged).forEach(name=>{
        const account=state.accounts[name];
        if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&!(name in newMeta)){
          delete merged[name];
        }
      });
      syncMetaStore=merged;
      scheduleCloudSave();
    }catch(error){
      console.warn('Portfolio data could not be saved.',error);
    }
  }

  try{
    const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
    if(saved&&saved.syncMeta&&typeof saved.syncMeta==='object')syncMetaStore=saved.syncMeta;
    
    // Hydrate fundStore from saved state!
    if (saved && saved.fundStore && typeof saved.fundStore === 'object') {
      Object.keys(saved.fundStore).forEach(code => {
        if (saved.fundStore[code] && typeof saved.fundStore[code] === 'object') {
          console.log('[DATA][HYDRATE] code=' + code);
          const fund = window.fundStore.get(code);
          const savedFund = saved.fundStore[code];
          
          const utils = window.fundStoreUtils;
          const sToday = utils.shanghaiDate();
          const maxAllowedDate = utils.isQdiiFund(fund)
            ? utils.getPreviousTradingDay(utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday))
            : (utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday));
          
          if (savedFund.nav && savedFund.nav.date && String(savedFund.nav.date).localeCompare(maxAllowedDate) > 0) {
            console.log('[DATA][HEAL] Resetting hydrated nav date for ' + code + ' because ' + savedFund.nav.date + ' exceeds maximum allowed ' + maxAllowedDate);
            savedFund.nav.date = '';
            savedFund.nav.value = null;
            savedFund.nav.percent = null;
            savedFund.nav.status = 'EMPTY';
            if (savedFund.todayProfit) {
              if (typeof savedFund.todayProfit === 'object') {
                savedFund.todayProfit.percent = null;
                savedFund.todayProfit.value = null;
                savedFund.todayProfit.status = 'EMPTY';
              } else {
                savedFund.todayProfit = null;
              }
            }
          }
          if (savedFund.estimate && savedFund.estimate.date && String(savedFund.estimate.date).localeCompare(maxAllowedDate) > 0) {
            savedFund.estimate.date = '';
            savedFund.estimate.value = null;
            savedFund.estimate.status = 'EMPTY';
          }
          
          if (savedFund.nav) fund.nav = { ...fund.nav, ...savedFund.nav };
          if (savedFund.estimate) fund.estimate = { ...fund.estimate, ...savedFund.estimate };
          if (savedFund.todayProfit) {
            if (typeof savedFund.todayProfit === 'object') {
              fund.todayProfit = { ...fund.todayProfit, ...savedFund.todayProfit };
            } else {
              fund.todayProfit.value = Number(savedFund.todayProfit) || null;
              fund.todayProfit.status = 'READY';
            }
          }
          if (savedFund.history) {
            if (savedFund.history.data) {
              fund._history = { ...fund._history, ...savedFund.history };
            } else {
              fund._history.data = Array.isArray(savedFund.history) ? savedFund.history : [];
              fund._history.status = 'READY';
            }
          }
          if (savedFund.detail) {
            if (savedFund.detail.data) {
              fund._detail = { ...fund._detail, ...savedFund.detail };
            } else {
              fund._detail.data = typeof savedFund.detail === 'object' ? savedFund.detail : {};
              fund._detail.status = 'READY';
            }
          }
          if (savedFund.meta) fund.meta = { ...fund.meta, ...savedFund.meta };
          
          // Sync backward compatible flatter fields
          fund.history = fund._history.data || [];
          fund.detail = fund._detail.data || {};
          
          // Re-evaluate today's profit on load/hydration to heal any corrupted state
          const profitResult = calculateTodayProfit(fund);
          fund.todayProfit.percent = profitResult.percent;
          fund.todayProfit.value = profitResult.value;
          fund.todayProfit.status = profitResult.status;

          fund.todayProfitPercent = fund.todayProfit.percent;
          fund.todayProfitValue = fund.todayProfit.value;
          fund.navUpdatedAt = (fund.nav && fund.nav.status === 'READY') ? fund.nav.date : undefined;
          fund.estimateConfidence = fund.estimate.confidence || null;
          fund.estimateSource = fund.meta.source || null;
          if (savedFund.holdings) fund.holdings = savedFund.holdings;
          if (savedFund.calibration) fund.calibration = savedFund.calibration;
        }
      });
    }

    // 只要存在已保存的 accounts（即使为空），就以保存内容为准，
    // 避免删除默认账户后刷新又出现“主账户”
    if(saved&&saved.accounts&&typeof saved.accounts==='object'){
      const valid=Object.entries(saved.accounts).filter(([,account])=>
        account&&typeof account.name==='string'&&Array.isArray(account.funds)
      );
      Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
      valid.forEach(([name,account])=>{
        normalizeAccount(account);
        if (Array.isArray(account.funds)) {
          account.funds.forEach(f => {
            const utils = window.fundStoreUtils;
            const sToday = utils.shanghaiDate();
            const fundForQdiiCheck = window.fundStore ? window.fundStore.get(f.code) : f;
            const maxAllowedDate = utils.isQdiiFund(fundForQdiiCheck)
              ? utils.getPreviousTradingDay(utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday))
              : (utils.isTradingDay(new Date()) ? sToday : utils.getLatestTradingDay(sToday));
            
            if (f.navUpdatedAt && String(f.navUpdatedAt).localeCompare(maxAllowedDate) > 0) {
              f.navUpdatedAt = null;
            }
            if (f.latest_nav && f.latest_nav.date && String(f.latest_nav.date).localeCompare(maxAllowedDate) > 0) {
              f.latest_nav = null;
            }
            if (f.estimate && f.estimate.trade_date && String(f.estimate.trade_date).localeCompare(maxAllowedDate) > 0) {
              f.estimate = null;
            }
          });
        }
        state.accounts[name]=account;
      });
      const active=state.accounts[saved.active]?saved.active:Object.keys(state.accounts)[0];
      if(active)originalSetActive(active);
      else originalSetActive('');

      // Propagate loaded fundStore values to state.accounts
      Object.keys(window.fundStore).forEach(code => {
        if (typeof window.fundStore.propagate === 'function') {
          window.fundStore.propagate(code);
        }
      });
    }
  }catch(error){
    console.warn('Saved portfolio data could not be restored.',error);
  }

  function migrateTransactions(accounts){
    var changed=false;
    Object.keys(accounts||{}).forEach(function(accountName){
      var funds=accounts[accountName]&&accounts[accountName].funds;
      if(!Array.isArray(funds))return;
      funds.forEach(function(fund){
        if(!fund||typeof fund!=='object')return;
        var source=Array.isArray(fund.transactions)?fund.transactions:[];
        var normalized=source.map(function(item){
          if(Array.isArray(item)){
            return {
              type:String(item[1]||'').indexOf('\u51cf')!==-1?'sell':'buy',
              amount:Math.abs(Number(String(item[2]||'').replace(/[^\d.-]/g,''))||0),
              fee:0,
              date:String(item[0]||'')
            };
          }
          if(item&&typeof item==='object'){
            return {
              type:item.type==='sell'?'sell':'buy',
              amount:Math.max(0,Number(item.amount)||0),
              fee:Math.max(0,Number(item.fee)||0),
              date:String(item.date||'')
            };
          }
          changed=true;
          return null;
        }).filter(Boolean);
        var isCurrent=source.length===normalized.length&&source.every(function(item,index){
          var next=normalized[index];
          return item&&!Array.isArray(item)&&item.type===next.type&&Number(item.amount)===next.amount&&Number(item.fee)===next.fee&&String(item.date||'')===next.date;
        });
        if(!isCurrent||fund.transactionVersion!==2){
          fund.transactions=normalized;
          fund.transactionVersion=2;
          changed=true;
        }
      });
    });
    return changed;
  }

  var corrected=typeof window.applyAccount2PortfolioCorrection==='function'&&window.applyAccount2PortfolioCorrection(state.accounts);
  var migrated=migrateTransactions(state.accounts);
  if(corrected||migrated){
    save();
  }

  function ensureParentChildHierarchy() {
    const s = window.portfolioState || state;
    if (!s || !s.accounts) return;
    
    // Clear children arrays
    Object.keys(s.accounts).forEach(name => {
      const acc = s.accounts[name];
      if (acc) {
        acc.children = [];
      }
    });
    
    // Rebuild children arrays from parent field
    Object.keys(s.accounts).forEach(name => {
      const acc = s.accounts[name];
      if (acc && acc.parent && s.accounts[acc.parent]) {
        const parent = s.accounts[acc.parent];
        parent.children = parent.children || [];
        if (!parent.children.includes(name)) {
          parent.children.push(name);
        }
      }
    });
    
    // Clean up empty children arrays
    Object.keys(s.accounts).forEach(name => {
      const acc = s.accounts[name];
      if (acc && acc.children && acc.children.length === 0) {
        delete acc.children;
      }
    });
  }
  window.ensureParentChildHierarchy = ensureParentChildHierarchy;

  function applyAccounts(saved){
    if(!saved||!saved.accounts||typeof saved.accounts!=='object')return false;
    if(saved.syncMeta&&typeof saved.syncMeta==='object')syncMetaStore=saved.syncMeta;
    // 保留当前同步账户（服务端权威），仅用云端数据覆盖本地账户
    const syncAccounts=Object.entries(state.accounts).filter(([,a])=>a&&(a.accountType==='sync'||(!a.accountType&&a.__source)));
    const valid=Object.entries(saved.accounts).filter(([,account])=>
      account&&typeof account.name==='string'&&Array.isArray(account.funds)
    );
    Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
    valid.forEach(([name,account])=>{normalizeAccount(account);state.accounts[name]=account});
    syncAccounts.forEach(([name,account])=>{state.accounts[name]=account});
    // 把备份中的同步账户策略合并回保留的同步账户
    Object.keys(syncMetaStore).forEach(name=>{
      const account=state.accounts[name];
      const meta=syncMetaStore[name];
      if(account&&meta&&Array.isArray(meta.strategy))account.strategy=meta.strategy.slice();
    });
    const active=state.accounts[saved.active]?saved.active:Object.keys(state.accounts)[0];
    if(active)originalSetActive(active);
    else originalSetActive('');
    ensureParentChildHierarchy();
    return true;
  }

  // 云端恢复：已登录时优先使用云端数据（首次登录时若云端为空则上传本地数据）
  function restoreCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token) {
      window.accountRestoreStatus = 'ready';
      return;
    }
    console.log('[ACCOUNT] restore start');
    window.accountRestoreStatus = 'restoring';
    window.auth.api('/api/account/state').then(data=>{
      window.accountRestoreStatus = 'ready';
      if(data&&data.state&&data.state.accounts&&typeof data.state.accounts==='object'){
        console.log('[ACCOUNT] restored: count=' + Object.keys(data.state.accounts).length);
        applyAccounts(data.state);
        console.log('[ACCOUNT] activeAccountId=' + state.getActive());
        save();
        if(typeof window.refreshSyncedAccounts==='function'){
          window.refreshSyncedAccounts().then(rerender).catch(rerender);
        }else{
          rerender();
        }
      } else {
        // 云端为空：把本地数据作为首次迁移上传
        console.log('[ACCOUNT] restored: count=0 (cloud empty, uploading local as first migration)');
        if (Object.keys(state.accounts).length === 0) {
          console.log('[ACCOUNT] no local accounts found, creating default 主账户');
          state.accounts['主账户'] = {
            name: '主账户',
            funds: [
              {name:'国泰半导体设备ETF联接C',code:'019633',category:'基金',amount:10000,today:-.015,hold:.052,history:[.02,.06,.04,.12,.1,.15,.2,.18,.23,.31,.28,.34],holdings:[['兆易创新','8.31%'],['北方华创','7.86%'],['中微公司','6.42%']],transactions:[['2026-07-13','买入','10,000']]},
              {name:'华夏黄金ETF联接C',code:'008702',category:'基金',amount:15000,today:.008,hold:.124,history:[.04,.06,.03,.08,.12,.1,.15,.18,.22,.2,.24,.29],holdings:[['黄金现货','92.40%'],['现金及其他','7.60%']],transactions:[['2026-07-05','买入','15,000']]}
            ]
          };
          originalSetActive('主账户');
        }
        console.log('[ACCOUNT] activeAccountId=' + state.getActive());
        save();
        if(typeof window.refreshSyncedAccounts==='function'){
          window.refreshSyncedAccounts().then(rerender).catch(rerender);
        }else{
          rerender();
        }
      }
    }).catch(err=>{
      console.error('[ACCOUNT] restore failed', err);
      window.accountRestoreStatus = 'ready';
      rerender();
    });
  }

  // 退出登录：清空本地账户数据（云端数据已备份，登录后再恢复）
  function clearLocalData(){
    Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
    if(typeof state.setActive==='function')state.setActive('');
    save();
  }
  window.clearLocalData=clearLocalData;

  function rerender(){
    const tab=document.querySelector('.nav-tab.active');
    if(tab)tab.click();
  }

  window.addEventListener('auth-changed',()=>{
    if(window.auth&&window.auth.state&&window.auth.state.token){
      restoreCloud();
    }else{
      window.accountRestoreStatus = 'ready';
      save();
      rerender();
    }
  });
  restoreCloud();

  state.setActive=function(name){
    originalSetActive(name);
    save();
  };
  state.persist=save;
  window.savePortfolioState=save;
  // 供 app-refactor 在刷新同步账户时合并其本地策略元数据
  window.getSyncAccountMeta=function(name){return syncMetaStore[name]||null;};
  // 手动操作：备份云端 / 恢复本地
  async function backupToCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const response=await fetch('/api/account/state',{
      method:'PUT',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
      body:JSON.stringify({state:buildPersisted()})
    });
    if(!response.ok)throw new Error('HTTP '+response.status);
    return true;
  }
  async function restoreFromCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const data=await window.auth.api('/api/account/state');
    const applied=applyAccounts(data&&data.state);
    if(applied){
      save();
      rerender();
    }
    return applied;
  }
  window.backupToCloud=backupToCloud;
  window.restoreFromCloud=restoreFromCloud;
  // 创建服务器备份快照（account_backups，后端最多保留 5 个，超出自动删最旧）
  window.createCloudBackup=async function(reason){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const response=await fetch('/api/account/backups',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
      body:JSON.stringify({state:buildPersisted(),reason:reason||'manual'})
    });
    if(!response.ok)throw new Error('HTTP '+response.status);
    return true;
  };
  // 从服务器备份快照恢复账户（写回本地并持久化，保留当前同步账户）
  window.restoreCloudBackup=async function(id){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const response=await fetch('/api/account/backups/'+Number(id)+'/restore',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders())
    });
    if(!response.ok)throw new Error('HTTP '+response.status);
    const data=await response.json();
    const applied=applyAccounts(data&&data.state);
    if(applied){
      save();
      rerender();
    }
    return applied;
  };
  // Data Non-Regression Test Suite
  window.runDataNonRegressionTest = function() {
    console.log('[DATA][TEST] Starting Unified Data Layer Self-Test Suite...');
    try {
      const code = 'TEST_FUND_999';
      const store = window.fundStore;
      
      // Clear test fund first
      delete store[code];
      
      const fund = store.get(code);
      
      // Test 1: Initial EMPTY state
      if (fund.nav.status !== 'EMPTY' || fund.estimate.status !== 'EMPTY') {
        throw new Error('Test 1 failed: initial state is not EMPTY');
      }
      
      // Test 2: Update NAV
      window.mergeFundData(code, {
        nav: { value: 1.234, date: '2026-08-21', percent: 0.015 }
      });
      if (fund.nav.status !== 'READY' || fund.nav.value !== 1.234 || fund.nav.date !== '2026-08-21') {
        throw new Error('Test 2 failed: NAV update failed or status incorrect');
      }
      
      // Test 3: Failed refresh should preserve existing NAV
      // Simulating a failed refresh status
      store.update(code, {
        nav: { status: 'REFRESHING' }
      });
      // Simulate failure recovery
      store.update(code, {
        nav: { status: 'READY' }
      });
      if (fund.nav.status !== 'READY' || fund.nav.value !== 1.234 || fund.nav.date !== '2026-08-21') {
        throw new Error('Test 3 failed: failed refresh did not preserve existing NAV');
      }
      
      // Test 4: Update estimate, history should remain untouched
      window.mergeFundData(code, {
        snapshot: { history: [{ date: '2026-08-20', nav: 1.215 }] }
      });
      if (fund._history.data.length !== 1 || fund._history.data[0].nav !== 1.215) {
        throw new Error('Test 4.1 failed: history snapshot merge failed');
      }
      
      window.mergeFundData(code, {
        estimate: { estimate_change: 0.008, trade_date: '2026-08-22' }
      });
      if (fund.estimate.value !== 0.008 || fund.estimate.date !== '2026-08-22') {
        throw new Error('Test 4.2 failed: estimate merge failed');
      }
      if (fund._history.data.length !== 1 || fund._history.data[0].nav !== 1.215) {
        throw new Error('Test 4.3 failed: estimate update regression impacted history data');
      }
      
      // Clean up
      delete store[code];
      console.log('[DATA][TEST] All Unified Data Layer Non-Regression Tests Passed Successfully! [GREEN]');
      return true;
    } catch (e) {
      console.error('[DATA][TEST] Non-regression test failed: ', e);
      return false;
    }
  };
  // Automatically trigger self-test suite on script load to verify integrity
  setTimeout(window.runDataNonRegressionTest, 1000);

})();
