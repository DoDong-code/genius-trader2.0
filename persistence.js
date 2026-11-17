(function(){
  const state=window.portfolioState;
  if(!state)return;
  const storageKey='genius-trader-portfolio-v2';
  const originalSetActive=state.setActive.bind(state);
  // 同步账户的服务端数据只存持仓；策略等本地元数据随本地/云端 JSON 一并备份
  let syncMetaStore={};
  window.accountRestoreStatus = (window.auth && window.auth.state && window.auth.state.token) ? 'restoring' : 'ready';
  // 同步闸门（2026-08-26）：cloudSyncReady 仅在「云端数据恢复成功并完成 hydration」后置 true。
  // 登录中 / 恢复中 / 恢复失败：任何 save / backup / PUT /api/account/state 都必须被拦截，
  // 严禁本地空 state 先写回云端。状态机：restoring → ready / blocked。
  window.cloudSyncReady = false;

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

    // 港股 / 恒生科技类基金：按「当日」规则处理（与美股 QDII 的 T+1 披露规则严格区分）。
    isHkFund: function(fund) {
      if (!fund) return false;
      var fundName = String(fund.name || fund.fund_name || '');
      return /恒生|港股|港美|香港/.test(fundName);
    },

    // 2026 年香港公众假期（香港政府宪报）：周末 + 以下日期为非交易日
    isHkTradingDay: function(date) {
      var weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', weekday: 'short'
      }).format(date);
      if (weekday === 'Sat' || weekday === 'Sun') return false;
      var yyyymmdd = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(date);
      var hkHolidays = [
        '2026-01-01',
        '2026-02-17', '2026-02-18', '2026-02-19',
        '2026-04-03', '2026-04-04', '2026-04-06',
        '2026-05-01', '2026-05-25',
        '2026-06-19', '2026-07-01', '2026-09-26',
        '2026-10-01', '2026-10-19',
        '2026-12-25', '2026-12-26'
      ];
      return hkHolidays.indexOf(yyyymmdd) === -1;
    },

    getLatestHkTradingDay: function(dateStr) {
      var parts = dateStr.split('-');
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      while (true) {
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        if (this.isHkTradingDay(new Date(yyyy, Number(mm) - 1, Number(dd)))) {
          return yyyy + '-' + mm + '-' + dd;
        }
        d.setDate(d.getDate() - 1);
      }
    },

    // 基金「今日正式净值」业务日期：
    //   A股            → 中国市场交易日（当日）
    //   港股/恒生科技   → 香港市场交易日（当日）
    //   QDII/美股/全球  → 实际 NAV 披露日期（前一交易日），绝不强制等于中国本地日期
    expectedNavDateFor: function(fund, dateStr) {
      var base = dateStr || this.shanghaiDate();
      if (this.isHkFund(fund)) {
        return this.isHkTradingDay(new Date(base + 'T00:00:00')) ? base : this.getLatestHkTradingDay(base);
      }
      if (this.isQdiiFund(fund)) {
        return this.getPreviousTradingDay(this.isTradingDay(new Date(base + 'T00:00:00')) ? base : this.getLatestTradingDay(base));
      }
      return this.isTradingDay(new Date(base + 'T00:00:00')) ? base : this.getLatestTradingDay(base);
    },
    
    isQdiiFund: function(fund) {
      if (!fund) return false;
      var fundName = String(fund.name || fund.fund_name || '');
      if (/恒生|港股|港美|香港/.test(fundName)) return false;
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
    
    // 2. Try official nav change（只要存在有效确认净值日期就走净值口径，不依赖 status 字段）
    if (change === null && fund.nav && fund.nav.date &&
        Number.isFinite(Number(fund.nav.value)) && Number(fund.nav.value) > 0) {
      var navDate = fund.nav.date;
      var expectedNavDate = utils.expectedNavDateFor(fund, sToday);
      var isTr = utils.isTradingDay(new Date());
      var isOfficialUpdated = Boolean(navDate === expectedNavDate || (!isTr && navDate));
      if (isOfficialUpdated) {
        change = (fund.nav.percent !== undefined && fund.nav.percent !== null) ? fund.nav.percent : fund.nav.changePercent;
        if (change === null || change === undefined || !Number.isFinite(change)) {
          change = utils.officialNavChange(fund, navDate);
        }
        // 通用规则：正式净值已就位时，今日收益必须用净值涨跌幅；
        // 若暂时无法计算，宁可显示等待，绝不用盘中估值顶替净值。
        if (change === null || change === undefined || !Number.isFinite(change)) {
          return { value: null, percent: null, status: 'LOADING' };
        }
      }
    }
    
    // 3. Try intraday estimate change
    if (change === null && fund.estimate && fund.estimate.status === 'READY') {
      var estDate = fund.estimate.date;
      var expectedEstDate = utils.expectedNavDateFor(fund, sToday);
      if (estDate === expectedEstDate || estDate === sToday || !utils.isTradingDay(new Date())) {
        change = fund.estimate.value;
      }
    }
    
    // 4. Fallback: try latest NAV change percent（仅限「今日 NAV 已发布」或非交易日；
    //    交易日今日 NAV 未发布时禁止把昨日涨跌幅当成今日收益）
    if (change === null && fund.nav && fund.nav.status === 'READY' &&
        (fund.nav.date === sToday || !utils.isTradingDay(new Date()))) {
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
        const maxAllowedDate = utils.expectedNavDateFor(fund, sToday);
        const isCachedInvalid = fund.nav.date && (String(fund.nav.date).localeCompare(maxAllowedDate) > 0 || !fund.nav.confirmed);
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
          fund.nav.confirmed = true;
          anyMerged = true;
        } else {
          console.log('[DATA][PRESERVE] code=' + code + ' field=nav existing newer date kept');
        }
      }
      
      if (Array.isArray(snap.history) && snap.history.length > 0) {
        console.log('[DATA][MERGE] code=' + code + ' field=history count=' + snap.history.length);
        // 按日期合并、新日期优先：禁止一次较旧响应把较新历史（如 0824）覆盖成旧日期（0821）。
        const byDate = new Map();
        (Array.isArray(fund._history.data) ? fund._history.data : []).forEach(h => {
          if (h && h.date) byDate.set(String(h.date), h);
        });
        snap.history.forEach(h => {
          if (h && h.date) byDate.set(String(h.date), h);
        });
        fund._history.data = [...byDate.values()]
          .sort((left, right) => String(left.date).localeCompare(String(right.date)));
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
        anyMerged = true;
      }
      if (snap.calibration) {
        fund.calibration = snap.calibration;
        anyMerged = true;
      }
    }
    
    if (data.estimate) {
      const est = data.estimate;
      const estDate = est.trade_date || est.nav_date;
      
      if (estDate) {
        const sToday = utils.shanghaiDate();
        const maxAllowedDate = utils.expectedNavDateFor(fund, sToday);
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
      const maxAllowedDate = utils.expectedNavDateFor(fund, sToday);
      const isCachedInvalid = fund.nav.date && (String(fund.nav.date).localeCompare(maxAllowedDate) > 0 || !fund.nav.confirmed);
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
        fund.nav.confirmed = true;
        anyMerged = true;
      }
    }

    // Restore LOADING or REFRESHING statuses back to READY/EMPTY if they weren't successfully resolved
    if (fund.nav.status === 'REFRESHING' || fund.nav.status === 'LOADING') {
      fund.nav.status = (fund.nav.value !== null && fund.nav.value !== undefined) ? 'READY' : 'EMPTY';
    }
    if (fund.estimate.status === 'REFRESHING' || fund.estimate.status === 'LOADING') {
      fund.estimate.status = (fund.estimate.value !== null && fund.estimate.value !== undefined) ? 'READY' : 'EMPTY';
    }
    if (fund.todayProfit.status === 'REFRESHING' || fund.todayProfit.status === 'LOADING') {
      fund.todayProfit.status = (fund.todayProfit.percent !== null && fund.todayProfit.percent !== undefined) ? 'READY' : 'EMPTY';
    }
    
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
    
    // 2026-11-17：无实际合并（纯 PRESERVE/状态复位）时跳过保存与事件广播，
    // 消除无效响应触发的整包落盘与下游 DOM 重算（点持仓卡顿放大因素）。
    if (anyMerged && typeof window.savePortfolioState === 'function') {
      window.savePortfolioState({ system: true });
    }

    if (anyMerged) {
      window.dispatchEvent(new CustomEvent('fund-store-updated', { detail: { code: code } }));
    }
    return fund;
  }
  window.mergeFundData = mergeFundData;

  const storeMethods = {
    get: function(code) {
      if (!this[code]) {
        // 缓存条目带上基金名称：三态/板块等按市场判定依赖名称（QDII/港股识别），
        // 仅凭 code 会把海外基金误判为 A 股。
        let displayName = String(code || '');
        try {
          const s = window.portfolioState;
          if (s && s.accounts) {
            Object.keys(s.accounts).some(accName => {
              const acc = s.accounts[accName];
              if (!acc || !Array.isArray(acc.funds)) return false;
              const hit = acc.funds.find(f => f && String(f.code) === String(code));
              if (hit) {
                displayName = String(hit.name || hit.fund_name || code);
                return true;
              }
              return false;
            });
          }
        } catch (e) { /* 名称缺失不影响缓存创建 */ }
        this[code] = {
          code: code,
          name: displayName,
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
        window.savePortfolioState({ system: true });
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
      var stored = localStorage.getItem('estimate_source_' + accountName);
      // 历史 'local' 迁移为 'auto'（不覆盖有效手动选择 xiaobeiyangji / yangjibao）
      if (stored === 'local') return 'auto';
      // 无偏好 / 无效 / 首次创建 → 默认 'auto'（后端并行「小倍养基 / 养基宝 → 本地引擎」先到先得）
      return stored || 'auto';
    } catch (err) {
      return 'auto';
    }
  }
  window.preferredEstimateSource = preferredEstimateSource;

  function estimateFund(code, amount, force) {
    var endpoint = getApiBase() + '/api/fund/' + encodeURIComponent(code) + '/estimate?amount=' + encodeURIComponent(amount) + (force ? '&force=1' : '');
    var source = preferredEstimateSource();
    if (source === 'auto') {
      // 自动模式：不拼 mode，后端并行「小倍养基 / 养基宝 → 本地引擎」先到先得，最快返回有效估值
    } else if (source === 'local') {
      // 历史遗留 'local'（未迁移）兜底走本地引擎
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

  // 合并多次刷新触发的重渲染：每个动画帧最多渲染一次，避免 N 只基金并发刷新时 O(N^2) 重绘抖动
  let _renderScheduled = false;
  function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : setTimeout;
    raf(function() {
      _renderScheduled = false;
      if (typeof window.renderRowsFromStore === 'function') window.renderRowsFromStore();
    });
  }

  // Unified Fund Data Service
  window.fundDataService = {
    refresh: function(code, force, options) {
      options = options || {};
      const estimateOnly = options.estimateOnly === true;
      console.log('[DATA][REQUEST] code=' + code + ' force=' + !!force + ' estimateOnly=' + estimateOnly);

      const fund = window.fundStore.get(code);

      // Update statuses to LOADING or REFRESHING
      const isNavReady = fund.nav && fund.nav.status === 'READY';
      const isEstReady = fund.estimate && fund.estimate.status === 'READY';
      const isProfitReady = fund.todayProfit && fund.todayProfit.status === 'READY';

      const updateData = {
        estimate: { status: isEstReady ? 'REFRESHING' : 'LOADING' },
        todayProfit: { status: isProfitReady ? 'REFRESHING' : 'LOADING' }
      };
      if (!estimateOnly) {
        updateData.nav = { status: isNavReady ? 'REFRESHING' : 'LOADING' };
      }
      window.fundStore.update(code, updateData);

      var state = window.portfolioState;
      var account = state && state.accounts && state.accounts[state.getActive()];
      var currentFundObj = account && account.funds && account.funds.find(function(f) { return String(f.code) === String(code); });
      var amount = currentFundObj ? (Number(currentFundObj.amount) || 0) : 0;

      // 版本守卫：同一基金并发多次刷新时，慢响应不得覆盖更快更新的有效响应
      if (!window.__fundRefreshVersion) window.__fundRefreshVersion = {};
      const version = (window.__fundRefreshVersion[code] = (window.__fundRefreshVersion[code] || 0) + 1);
      const startedAt = Date.now();

      // 估值与快照彻底解耦：估值一旦有效立即合并并渲染，不等待慢速快照/历史导入完成
      const estimateP = estimateFund(code, amount, force).then(function(estimateRes) {
        if (window.__fundRefreshVersion[code] !== version) return; // 已被更新请求取代
        console.log('[DATA][ESTIMATE] code=' + code + ' source=' + (estimateRes && (estimateRes.source || estimateRes.estimate_source) || 'local') + ' latency=' + (Date.now() - startedAt) + 'ms');
        window.mergeFundData(code, { estimate: estimateRes });
        scheduleRender();
      }).catch(function(err) {
        if (window.__fundRefreshVersion[code] !== version) return;
        console.error('[DATA][ESTIMATE-ERR] code=' + code, err && err.message);
        const f = window.fundStore.get(code);
        window.fundStore.update(code, {
          estimate: { status: f.estimate.status === 'REFRESHING' ? 'READY' : 'ERROR' },
          todayProfit: { status: f.todayProfit.status === 'REFRESHING' ? 'READY' : 'ERROR' }
        });
        scheduleRender();
      });

      let snapshotP = Promise.resolve(null);
      if (!estimateOnly) {
        snapshotP = refreshFund(code, force).then(function(snapshotRes) {
          if (window.__fundRefreshVersion[code] !== version) return;
          console.log('[DATA][SNAPSHOT] code=' + code + ' latency=' + (Date.now() - startedAt) + 'ms');
          window.mergeFundData(code, { snapshot: snapshotRes });
          scheduleRender();
        }).catch(function(err) {
          if (window.__fundRefreshVersion[code] !== version) return;
          console.error('[DATA][SNAPSHOT-ERR] code=' + code, err && err.message);
          const f = window.fundStore.get(code);
          window.fundStore.update(code, {
            nav: { status: f.nav.status === 'REFRESHING' ? 'READY' : 'ERROR' }
          });
          scheduleRender();
        });
      }

      // 返回的 Promise 在「估值完成」时即 resolve（快照仍在后台补齐），调用方可立即拿到 store
      return estimateP.then(function() { return window.fundStore.get(code); });
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
  // syncMeta 合并（策略仓库唯一出口）：内存同步账户策略优先覆盖，
  // syncMetaStore 兜底补缺（登录恢复过程中内存同步账户尚未重建时，避免空 syncMeta 上云抹掉云端策略）；
  // 仅当内存中该同步账户存在但没有策略时才删除条目（用户真的清空了策略）。
  function mergeSyncMeta(builtMeta){
    const merged=Object.assign({},syncMetaStore,builtMeta||{});
    Object.keys(merged).forEach(name=>{
      const account=state.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&!(name in (builtMeta||{}))){
        delete merged[name];
      }
    });
    return merged;
  }
  // 云端快照/PUT 用精简 state：剔除 fundStore 行情缓存（本地可重新拉取），
  // 避免 3MB 级 payload 拖垮上传（删除账户后无法及时 PUT → 刷新复现）。
  // syncMeta 必须经 mergeSyncMeta 合入 syncMetaStore 兜底（2026-11-17 修复：
  // 此前云端 PUT 只带内存同步账户的 syncMeta，登录恢复的 400ms 窗口内内存还是空的，
  // 会把云端 syncMeta 抹成 {} —— 策略登录即丢、换设备必丢，而手动恢复备份正常）。
  function buildCloudState(){
    const p=buildPersisted();
    delete p.fundStore;
    p.syncMeta=mergeSyncMeta(p.syncMeta);
    return p;
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
  let cloudSaveInFlight=false; // 单飞守卫：同一时刻只允许一个在途云端 PUT，避免大 JSON 并发叠加撑爆内存
  let syncGeneration=0; // 退出/登录时自增，作废在途/待发的旧账号 PUT（防旧账号数据覆盖新账号）
  window.__syncGeneration=syncGeneration;
  let cloudDirty=false; // 本地已修改、云端尚未一致（用于关闭/刷新/切后台兜底与失败重试）
  let cloudFailCount=0; // 连续失败次数，用于指数退避重试
  const CLOUD_DEBOUNCE_MS=400; // 防抖：连续修改只保存最终 state
  const CLOUD_RETRY_BASE_MS=2000;
  const CLOUD_RETRY_MAX_MS=30000;
  let __lastPersistLog=0;
  function logPersistSize(tag,bytes){
    const now=Date.now();
    if(bytes>1024*1024 || now-__lastPersistLog>60000){
      console.log('[SYNC][DIAG] '+tag+' buildPersistedBytes='+bytes+' (~'+Math.round(bytes/1024)+'KB)');
      __lastPersistLog=now;
    }
  }
  function cloudReady(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    if(window.accountRestoreStatus==='blocked')return true; // 恢复失败：云端不可信，本地修改（含删除/编辑）优先写回云端
    return window.accountRestoreStatus==='ready' && window.cloudSyncReady===true;
  }
  // 标记需要同步并安排防抖上传；闸门未就绪时仅标记 dirty，待恢复完成后由 save() 触发
  function scheduleCloudSave(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return;
    if(window.accountRestoreStatus!=='ready'||window.cloudSyncReady!==true){
      cloudDirty=true; // 恢复完成前标记，恢复后 save() 会真正上传
      return;
    }
    cloudDirty=true;
    if(cloudSaveInFlight)return; // 在途 PUT 期间不再叠加；结束后由 finally 重新排期
    clearTimeout(cloudTimer);
    cloudTimer=setTimeout(doCloudSave,CLOUD_DEBOUNCE_MS);
  }
  function doCloudSave(){
    if(cloudSaveInFlight)return; // 双检：单飞
    if(!cloudReady())return; // 跨越登录/恢复边界则放弃本次（保留 dirty）
    const myGen=syncGeneration; // 捕获代际：PUT 期间若发生退出/登录则作废本次写入
    cloudSaveInFlight=true;
    const controller=(typeof AbortController==='function')?new AbortController():null;
    const timer=controller?setTimeout(function(){controller.abort();},20000):null;
    const body=JSON.stringify({state:buildCloudState()});
    logPersistSize('doCloudSave',body.length);
    fetch('/api/account/state',{
      method:'PUT',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
      body:body,
      signal:controller?controller.signal:undefined
    }).then(function(res){
      if(myGen!==syncGeneration){console.log('[SYNC] SAVE_STALE_DROPPED gen changed');return;}
      if(res.ok){
        cloudDirty=false; cloudFailCount=0;
        console.log('[SYNC] CLOUD_SAVE_OK');
      } else if(res.status===409){
        // 服务端拒绝空覆盖：云端有数据而本地为空 → 以云端为准，停止重试（本地数据仍安全）
        console.warn('[SYNC] CLOUD_SAVE_REJECTED_409 keep-local');
        cloudDirty=false; cloudFailCount=0;
      } else {
        throw new Error('HTTP '+res.status);
      }
    }).catch(function(err){
      if(myGen!==syncGeneration)return;
      cloudFailCount+=1;
      console.warn('[SYNC] CLOUD_SAVE_FAILED will-retry attempt='+cloudFailCount,(err&&err.message)||err);
    }).finally(function(){
      if(timer!==null)clearTimeout(timer);
      cloudSaveInFlight=false;
      if(myGen!==syncGeneration)return;
      // 仍有未同步修改（成功但已过时 / 失败重试）→ 重新排期；失败按指数退避
      if(cloudDirty){
        const delay=cloudFailCount>0?Math.min(CLOUD_RETRY_MAX_MS,CLOUD_RETRY_BASE_MS*Math.pow(2,cloudFailCount-1)):CLOUD_DEBOUNCE_MS;
        clearTimeout(cloudTimer);
        cloudTimer=setTimeout(doCloudSave,delay);
      }
    });
  }
  // 页面隐藏（切后台/最小化）：页面仍存活，立即把待同步修改推送到云端
  function flushCloudSaveNow(){
    if(cloudSaveInFlight||!cloudDirty)return;
    if(!cloudReady())return;
    doCloudSave();
  }
  // 页面关闭/卸载：用 keepalive 兜底（请求可跨卸载存活），本地数据本身已同步落盘不会丢
  function flushCloudSaveUnload(){
    if(cloudSaveInFlight||!cloudDirty)return;
    if(!cloudReady())return;
    const myGen=syncGeneration;
    const body=JSON.stringify({state:buildCloudState()});
    try{
      fetch('/api/account/state',{
        method:'PUT',
        headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
        body:body,
        keepalive:true
      });
      if(myGen===syncGeneration)cloudDirty=false;
    }catch(e){/* best-effort */}
  }
  if(typeof document!=='undefined'){
    document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='hidden'){ flushLocalSaveNow(); flushCloudSaveNow(); } });
  }
  if(typeof window!=='undefined'){
    window.addEventListener('pagehide',function(){ flushLocalSaveNow(); flushCloudSaveUnload(); });
    window.addEventListener('beforeunload',function(){ flushLocalSaveNow(); flushCloudSaveUnload(); });
  }

  // 2026-11-17：本地落盘防抖（仅 system 级保存）。
  // 一次进入持仓页/页面加载会触发几十次 mergeFundData / fundStore.update，各自 save() 时
  // 都同步 JSON.stringify 整个 payload（fundStore + accounts 均含 history/holdings，MB 级）
  // 并 localStorage.setItem —— 主线程被连续长任务阻塞，表现为「点持仓卡一下」。
  // 防抖合并为尾随 600ms 一次写入；页面隐藏/关闭时强制 flush，不丢数据。
  // 用户编辑类保存（非 system）仍立即落盘，语义不变。
  let localSaveTimer = null;
  let localSavePending = false;
  function writeLocalStorageNow(){
    const payload=buildPersisted();
    // 2026-11-17：localStorage 也必须存合并后的 syncMeta（syncMetaStore 兜底）。
    // 此前云端 PUT（buildCloudState）有兜底而本地落盘没有 —— 退出登录后（内存
    // syncMetaStore 不随刷新存活）刷新页面，syncMetaStore 从 localStorage 重 hydrated
    // 为 built 空 meta，投资策略在本地也丢失。
    const mergedSyncMeta=mergeSyncMeta(payload.syncMeta);
    payload.syncMeta=mergedSyncMeta;
    localStorage.setItem(storageKey,JSON.stringify(payload));
    // 同步账户元数据合并：走 mergeSyncMeta 唯一出口（与云端 PUT buildCloudState 同一语义）
    syncMetaStore=mergedSyncMeta;
  }
  function flushLocalSaveNow(){
    if(!localSavePending)return;
    localSavePending=false;
    if(localSaveTimer!==null){clearTimeout(localSaveTimer);localSaveTimer=null;}
    try{ writeLocalStorageNow(); }catch(error){ console.warn('Portfolio data could not be saved.',error); }
  }
  function save(opts){
    try{
      if (opts && opts.system) {
        // 系统/行情刷新/水合更新：防抖合并落本地，且不触发云端 PUT（防被当成用户修改）
        localSavePending=true;
        if(localSaveTimer!==null)clearTimeout(localSaveTimer);
        localSaveTimer=setTimeout(function(){
          localSaveTimer=null;
          if(!localSavePending)return;
          localSavePending=false;
          try{ writeLocalStorageNow(); }catch(error){ console.warn('Portfolio data could not be saved.',error); }
        },600);
        return;
      }
      // 用户编辑：取消挂起的 system 写入，立即合并落盘（最新状态一次写全）
      localSavePending=false;
      if(localSaveTimer!==null){clearTimeout(localSaveTimer);localSaveTimer=null;}
      writeLocalStorageNow();
      if (window.auth && window.auth.state && window.auth.state.token) {
        if (window.cloudSyncReady === true) {
          console.log('[SYNC] SAVE_ALLOWED');
          scheduleCloudSave();
        } else if (window.accountRestoreStatus === 'blocked') {
          // 恢复已失败、云端不可信：本地修改（含删除/编辑）优先写回云端，避免刷新后账户复现
          console.log('[SYNC] SAVE_ALLOWED reason=restore-blocked local-wins');
          cloudDirty = true;
          flushCloudSaveNow();
        } else {
          console.log('[SYNC] SAVE_LOCAL_ONLY reason=restoring (cloud PUT deferred, local saved)');
        }
      }
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
          const maxAllowedDate = utils.expectedNavDateFor(fund, sToday);
          
          if (savedFund.nav && savedFund.nav.date) {
            const dateStr = String(savedFund.nav.date);
            const isFuture = dateStr.localeCompare(maxAllowedDate) > 0;
            // 只拒绝真正无效的缓存：① 未来日期；② 声称 confirmed 但无有效正值（旧 bug / 脏数据残留）。
            // 不再按「今天 / 特定日期(如 2026-08-24)」强制降级——正式 NAV 是否确认由后端 refresh 事实决定，
            // 缓存仅作为即时显示，后台刷新会按需保留/替换/补充，绝不因日期而清空已确认净值。
            const hasValidValue = Number.isFinite(Number(savedFund.nav.value)) && Number(savedFund.nav.value) > 0;
            if (isFuture || (savedFund.nav.confirmed === true && !hasValidValue)) {
              console.log('[DATA][HEAL] Downgrading invalid cached nav for ' + code + ': ' + dateStr + ' (future or confirmed-without-value)');
              savedFund.nav.date = '';
              savedFund.nav.value = null;
              savedFund.nav.percent = null;
              savedFund.nav.status = 'EMPTY';
              savedFund.nav.confirmed = false;
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
            const maxAllowedDate = utils.expectedNavDateFor(fundForQdiiCheck, sToday);
            
            if (f.navUpdatedAt) {
              const dateStr = String(f.navUpdatedAt);
              const isFuture = dateStr.localeCompare(maxAllowedDate) > 0;
              // 只拒绝未来日期；不再按「今天 / 特定日期(2026-08-24)」强制降级——
              // 正式 NAV 是否确认由后端事实决定，缓存仅作即时显示，刷新按需保留/替换/补充。
              if (isFuture) {
                f.navUpdatedAt = null;
              }
            }
            if (f.latest_nav && f.latest_nav.date) {
              const dateStr = String(f.latest_nav.date);
              const isFuture = dateStr.localeCompare(maxAllowedDate) > 0;
              const hasValidValue = Number.isFinite(Number(f.latest_nav.nav)) && Number(f.latest_nav.nav) > 0;
              // 只拒绝未来日期 / 声称 confirmed 但无有效正值（旧 bug / 脏数据）。
              // 保留最近已确认净值（如 0821），避免每次刷新清空已确认数据造成 NO_DATA 闪退。
              if (isFuture || (f.latest_nav.confirmed === true && !hasValidValue)) {
                f.latest_nav = null;
                f.navUpdatedAt = null;
              }
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

  // 2026-11-17：已登录但本地无有效账户（localStorage 缺失/损坏/退出后清空）时，
  // app.js 的演示「主账户」会残留在内存并被下方 correction/migration 的 save() 固化进
  // localStorage，用户刷新后「多出一个主账户」。在 correction 之前按指纹清除。
  if (window.auth && window.auth.state && window.auth.state.token) {
    stripStarterDemoAccounts();
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

  // 云端 syncMeta 合并（策略权威判定唯一出口）：云端非空条目权威，
  // 缺失/空策略条目用本地 syncMetaStore 兜底（对齐 mp1 loadStateFromCloud 本地兜底语义）。
  // 2026-11-17 追修：restoreCloud 的 cloud-empty 分支（user_data.accounts 为空，Web 主用户
  // 常态）此前从不走 applyAccounts —— 云端 syncMeta 在登录时被整段跳过，登录后同步账户
  // 策略恒为空（「投资策略方针没有随登录同步」根因）。
  function mergeCloudSyncMeta(saved){
    if(saved&&saved.syncMeta&&typeof saved.syncMeta==='object'){
      const fallback=Object.assign({},syncMetaStore);
      Object.keys(saved.syncMeta).forEach(name=>{
        const meta=saved.syncMeta[name];
        if(meta&&Array.isArray(meta.strategy)&&meta.strategy.length)fallback[name]=meta;
      });
      syncMetaStore=fallback;
    }
    // 云端权威同步进内存同步账户：登录恢复语义 = 云端为准。若不同步，紧随其后的
    // save() 会用陈旧的内存策略经 mergeSyncMeta(builtMeta) 反向覆盖刚合并的云端策略
    // （Object.assign 后写胜出）—— 「云端策略更新后 Web 重新登录仍显示旧策略」根因。
    Object.keys(syncMetaStore).forEach(name=>{
      const account=state.accounts[name];
      const meta=syncMetaStore[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&meta&&Array.isArray(meta.strategy)&&meta.strategy.length){
        account.strategy=meta.strategy.slice();
      }
    });
  }

  function applyAccounts(saved){
    if(!saved||!saved.accounts||typeof saved.accounts!=='object')return false;
    // 2026-11-17：云端 syncMeta 权威，但缺条目/空策略时用本地 syncMetaStore 兜底合并
    // （对齐 mp1 loadStateFromCloud 本地兜底语义）。此前整体替换 —— 云端 syncMeta 一旦被
    // 历史空写抹掉，登录恢复即把本地策略也清掉，且随后的 PUT 继续把空值写回云端形成循环。
    mergeCloudSyncMeta(saved);
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

  // 云端恢复（同步闸门核心）：以云端 user_id 数据为准。
  // 状态机：restoring →（成功）ready + cloudSyncReady=true → 允许 save/PUT；
  //        →（失败/异常）blocked + cloudSyncReady=false → 禁止一切云端写入，
  //          绝不把本地空 state 上传覆盖云端；也不自动创建「空主账户」。
  function restoreCloud() {
    if (!window.auth || !window.auth.state || !window.auth.state.token) {
      window.accountRestoreStatus = 'ready';
      window.cloudSyncReady = false;
      return Promise.resolve();
    }
    console.log('[SYNC] LOGIN');
    console.log('[SYNC] RESTORE_START');
    window.accountRestoreStatus = 'restoring';
    window.cloudSyncReady = false;

    return window.auth.api('/api/account/state')
      .then(data => {
        const rawAccounts = data && data.state && data.state.accounts;
        const isObjectAccounts = rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts);
        if (isObjectAccounts && Object.keys(rawAccounts).length > 0) {
          const applied = applyAccounts(data.state);
          const hydratedCount = Object.keys(state.accounts).length;
          if (!applied || hydratedCount === 0) {
            // 云端有数据但 hydration 后本地仍为空 → 视为恢复失败，禁止写回
            console.error('[SYNC] RESTORE_FAILED reason=hydration-empty applied=' + applied + ' hydrated=' + hydratedCount);
            if(window.accountRestoreStatus!=='ready'){window.accountRestoreStatus='blocked';window.cloudSyncReady=false;}
            rerender();
            return;
          }
          console.log('[SYNC] RESTORE_SUCCESS count=' + Object.keys(rawAccounts).length + ' hydrated=' + hydratedCount);
          window.accountRestoreStatus = 'ready';
          window.cloudSyncReady = true;
          console.log('[SYNC] SYNC_READY');
          save(); // 此刻才允许写（SAVE_ALLOWED）
          // 同步账户重建纳入 restorePromise：waitForAccountRestore 等「完整恢复」而非只等主 state
          const rebuildP = (typeof window.refreshSyncedAccounts === 'function')
            ? window.refreshSyncedAccounts().then(rerender).catch(rerender)
            : Promise.resolve(rerender());
          // P3.19：登录恢复后立即强制刷新持仓估值，消除原本需等待约 1 分钟的扫描延迟
          if (typeof window.refreshFundEstimates === 'function') {
            try { window.refreshFundEstimates(); } catch (e) {}
          }
          return rebuildP;
        }
        if (rawAccounts && Array.isArray(rawAccounts)) {
          // 非法格式（数组等）：不能识别为有效账户，禁止上传
          console.error('[SYNC] RESTORE_FAILED reason=accounts-invalid-shape');
          if(window.accountRestoreStatus!=='ready'){window.accountRestoreStatus='blocked';window.cloudSyncReady=false;}
          rerender();
          return;
        }
        // 云端确实为空（GET 成功且无有效账户对象）：以云端为准保持现状。
        // 不自动创建「空主账户」，更不创建后再覆盖云端。
        console.log('[SYNC] RESTORE_SUCCESS cloud-empty local=' + Object.keys(state.accounts).length);
        // 2026-11-17 追修：accounts 为空 ≠ 无策略 —— 云端 syncMeta（同步账户投资策略）
        // 必须在此合并，否则登录后 refreshSyncedAccounts 重建的同步账户策略恒为空。
        mergeCloudSyncMeta(data && data.state);
        window.accountRestoreStatus = 'ready';
        window.cloudSyncReady = true;
        console.log('[SYNC] SYNC_READY');
        // 2026-11-17：user_data.accounts 为空 ≠ 用户没数据 —— 同步账户（持仓服务端权威，
        // buildPersisted 不入 user_data）必须在此重建，否则登录后持仓 0、策略无处挂靠、
        // 估值不刷新（旧代码只在此分支跳过一切刷新，网页为主用户登录必空）。
        stripStarterDemoAccounts();
        if (Object.keys(state.accounts).length > 0) {
          save(); // 恢复完成即落盘/上传（本地已有账户：本地账户或此前会话状态）
        } else {
          console.log('[SYNC] SAVE_SKIPPED local-empty cloud-empty');
        }
        if (typeof window.refreshSyncedAccounts === 'function') {
          return window.refreshSyncedAccounts()
            .then(() => {
              if (Object.keys(state.accounts).length > 0) save(); // 同步账户重建后（active 等就位）再落盘
              console.log('[SYNC] cloud-empty synced-accounts rebuilt count=' + Object.keys(state.accounts).length);
              return Object.keys(state.accounts).length > 0 && typeof window.refreshFundEstimates === 'function'
                ? Promise.resolve(window.refreshFundEstimates())
                : null;
            })
            .catch(() => {})
            .finally(rerender);
        }
        rerender();
        return;
      })
      .catch(err => {
        // 拉取云端失败：绝不当作「云端为空」上传本地，禁止云端写入
        console.error('[SYNC] RESTORE_FAILED', err && err.message ? err.message : err);
        if(window.accountRestoreStatus!=='ready'){window.accountRestoreStatus='blocked';window.cloudSyncReady=false;}
        console.log('[SYNC] SYNC_BLOCKED reason=restore-failed (cloud writes disabled)');
        rerender();
      });
  }

  // 2026-11-17：清除 app.js 注入的演示「主账户」（国泰半导体 019633 + 华夏黄金 008702 指纹）。
  // 已登录用户空状态下演示账户会残留在内存/账户列表（刷新后「多出一个主账户」），
  // 仅按指纹精确清除，绝不误删用户自己创建的同名主账户。
  function stripStarterDemoAccounts(){
    const acc=state.accounts['主账户'];
    if(!acc||!Array.isArray(acc.funds))return;
    const codes=acc.funds.map(f=>String(f&&f.code)||'').sort();
    if(codes.join(',')==='008702,019633'){
      delete state.accounts['主账户'];
      if(state.getActive()==='主账户'){
        const first=Object.keys(state.accounts)[0];
        if(typeof state.setActive==='function')state.setActive(first||'');
      }
      console.log('[SYNC] starter demo account stripped');
    }
  }
  window.stripStarterDemoAccounts=stripStarterDemoAccounts;

  // 退出登录：清空本地账户数据（云端数据已备份，登录后再恢复）。
  // 清空期间禁止云端 PUT（cloudSyncReady=false），防止空 state 写回云端。
  function clearLocalData(){
    clearTimeout(cloudTimer); // 取消待发的延迟云端保存（防止退出后仍 PUT 空/旧 state）
    cloudSaveInFlight=false;
    cloudDirty=false; cloudFailCount=0; // 切换/退出账号：清理旧账号的待同步标记，严禁串数据
    syncGeneration+=1; window.__syncGeneration=syncGeneration; // 作废所有在途/待发的旧账号 PUT
    Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
    window.accountRestoreStatus = 'ready';
    window.cloudSyncReady = false;
    if(typeof state.setActive==='function')state.setActive('');
    // P3.19：退出登录同步清空 AI 问答残留（LAST_AI_CHAT / 内存态 / 回答窗口），
    // 避免退出后「AI 提问的回答还在」，并消除其覆盖层导致设置页不可点击
    try { localStorage.removeItem('LAST_AI_CHAT'); } catch (e) {}
    window.__aiChatState = null;
    try {
      var aiBox = document.querySelector('#ai-answer-window');
      if (aiBox) { aiBox.style.display = 'none'; aiBox.textContent = ''; }
    } catch (e) {}
    save();
  }
  window.clearLocalData=clearLocalData;

  function rerender(){
    const tab=document.querySelector('.nav-tab.active');
    if(tab)tab.click();
  }

  // 捕获恢复 Promise，供手动「立即同步」等待恢复完成，消除刷新瞬间 restoring 窗口竞态
  let restorePromise = Promise.resolve();
  // 2026-11-17 二轮审查（项1）：统一恢复等待出口。
  // auth.js 登录成功后必须 await 此函数再进入正常页面；恢复期间用户的编辑会被
  // applyAccounts 用云端数据覆盖（先建账户 → 恢复覆盖 → 「多出主账户/持仓为空」竞态根因）。
  // 返回终态：'ready' / 'blocked' / 'timeout'（超时兜底，不阻塞登录 UX）。
  function waitForAccountRestore(timeoutMs){
    const timeout=Number(timeoutMs)>0?Number(timeoutMs):10000;
    if(window.accountRestoreStatus!=='restoring')return Promise.resolve(window.accountRestoreStatus||'ready');
    return new Promise(resolve=>{
      const timer=setTimeout(function(){resolve('timeout');},timeout);
      const settle=function(){clearTimeout(timer);resolve(window.accountRestoreStatus||'ready');};
      Promise.resolve(restorePromise).then(settle,settle);
    });
  }
  window.waitForAccountRestore=waitForAccountRestore;
  window.addEventListener('auth-changed',()=>{
    if(window.auth&&window.auth.state&&window.auth.state.token){
      restorePromise = restoreCloud();
    }else{
      window.accountRestoreStatus = 'ready';
      window.cloudSyncReady = false;
      save();
      rerender();
    }
  });
  restorePromise = restoreCloud();

  state.setActive=function(name){
    originalSetActive(name);
    save();
  };
  state.persist=function(opts){ save(opts); };
  window.savePortfolioState=function(opts){ save(opts); };
  window.flushCloudSaveNow=flushCloudSaveNow; // 供删除账户等即时云端同步调用（绕过 400ms 防抖）
  // 供 app-refactor 在刷新同步账户时合并其本地策略元数据
  window.getSyncAccountMeta=function(name){return syncMetaStore[name]||null;};
  // 手动操作：备份云端 / 恢复本地
  // 2026-11-17 二轮审查（项2）：备份快照此前只有 buildCloudState（本地账户 + syncMeta 策略），
  // 同步账户持仓不入快照 —— 「恢复备份」实为「历史策略 + 当前 portfolio 持仓重建」。
  // captureSyncAccounts 把同步账户的用户持仓事实（金额/交易/策略/已平仓等）随快照备份；
  // 行情缓存类字段（history/estimate/latest_nav/holdings 等）可重新拉取，剔除以控制体积。
  const FUND_TRANSIENT_FIELDS=['history','_history','detail','_detail','holdings','calibration',
    'latest_nav','estimate','navUpdatedAt','today','todayEstimate','todayProfitPercent',
    'todayProfitValue','estimateConfidence','estimateSource'];
  function captureSyncAccounts(){
    const out={};
    Object.keys(state.accounts).forEach(name=>{
      const acc=state.accounts[name];
      if(!acc||!(acc.accountType==='sync'||(!acc.accountType&&acc.__source)))return;
      const funds=(Array.isArray(acc.funds)?acc.funds:[]).map(f=>{
        if(!f||typeof f!=='object')return f;
        const copy=Object.assign({},f);
        FUND_TRANSIENT_FIELDS.forEach(k=>{delete copy[k];});
        return copy;
      });
      out[name]={
        name:acc.name,
        funds:funds,
        strategy:Array.isArray(acc.strategy)?acc.strategy.slice():[],
        closedPositions:acc.closedPositions!==undefined?acc.closedPositions:[],
        targetRecovery:acc.targetRecovery!==undefined?acc.targetRecovery:null,
        maxFunds:acc.maxFunds!==undefined?acc.maxFunds:null,
        parent:acc.parent||null,
        children:Array.isArray(acc.children)?acc.children.slice():[]
      };
    });
    return out;
  }
  // 回填历史快照中的同步账户持仓。只作用于「服务端仍存在的同步账户」
  // （refreshSyncedAccounts 已按服务端权威重建/删除账户壳），
  // 服务端已删除的同步账户不复活 —— 服务端权威边界不破坏。
  function applySyncAccountsSnapshot(snapSync){
    if(!snapSync||typeof snapSync!=='object')return 0;
    let applied=0;
    Object.keys(snapSync).forEach(name=>{
      const snapAcc=snapSync[name];
      const acc=state.accounts[name];
      if(!acc||!snapAcc||typeof snapAcc!=='object')return;
      if(!(acc.accountType==='sync'||(!acc.accountType&&acc.__source)))return;
      if(Array.isArray(snapAcc.funds))acc.funds=snapAcc.funds.map(f=>Object.assign({},f));
      if(Array.isArray(snapAcc.strategy)&&snapAcc.strategy.length)acc.strategy=snapAcc.strategy.slice();
      if(snapAcc.closedPositions!==undefined)acc.closedPositions=snapAcc.closedPositions;
      if(snapAcc.targetRecovery!==undefined)acc.targetRecovery=snapAcc.targetRecovery;
      if(snapAcc.maxFunds!==undefined)acc.maxFunds=snapAcc.maxFunds;
      applied++;
    });
    return applied;
  }

  async function backupToCloud(){
    if(cloudSaveInFlight)return false; // 已有在途保存，避免叠加大 JSON
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    if(window.accountRestoreStatus!=='ready'||window.cloudSyncReady!==true){
      console.log('[SYNC] BACKUP_BLOCKED reason=not-ready status='+window.accountRestoreStatus);
      return false;
    }
    const myGen=syncGeneration; // 捕获代际：若退出/登录发生在 PUT 期间，作废本次写入
    cloudSaveInFlight=true;
    const controller=(typeof AbortController==='function')?new AbortController():null;
    const timer=controller?setTimeout(function(){controller.abort();},20000):null;
    try{
      // user_data PUT 保持原形态（不夹带 syncAccounts —— 双端兼容边界不动，
      // 完整历史快照只在 createCloudBackup 的 account_backups 里）。
      const body=JSON.stringify({state:buildCloudState()});
      logPersistSize('backupToCloud',body.length);
      const response=await fetch('/api/account/state',{
        method:'PUT',
        headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
        body:body,
        signal:controller?controller.signal:undefined
      });
      if(myGen!==syncGeneration){console.log('[SYNC] BACKUP_STALE_DROPPED gen changed'); return false;}
      if(!response.ok)throw new Error('HTTP '+response.status);
      return true;
    }catch(e){
      if(myGen!==syncGeneration)return false; // 代际已变，静默丢弃
      if(e&&e.name==='AbortError'){console.log('[SYNC] BACKUP_ABORTED timeout');}
      else{console.warn('[SYNC] BACKUP_FAILED',e&&e.message);}
      return false;
    }finally{
      if(timer!==null)clearTimeout(timer);
      cloudSaveInFlight=false;
    }
  }
  async function restoreFromCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const data=await window.auth.api('/api/account/state');
    const applied=applyAccounts(data&&data.state);
    if(applied){
      window.accountRestoreStatus='ready';
      window.cloudSyncReady=true;
      // 2026-11-17：备份快照不含同步账户持仓（服务端权威），恢复后必须重建，
      // 否则「恢复本地」后持仓/策略依旧为空（快照里只有 syncMeta 策略）。
      if (typeof window.refreshSyncedAccounts === 'function') {
        try { await window.refreshSyncedAccounts(); } catch (e) { /* 重建失败不阻塞恢复 */ }
      }
      save();
      rerender();
      if (typeof window.refreshFundEstimates === 'function') { try { window.refreshFundEstimates(); } catch (e) {} }
    }
    return applied;
  }
  window.backupToCloud=backupToCloud;
  window.restoreFromCloud=restoreFromCloud;
  // 创建服务器备份快照（account_backups，后端最多保留 5 个，超出自动删最旧）
  window.createCloudBackup=async function(reason){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    // 恢复仍在进行：等待恢复 Promise 完成再判就绪（手动同步撞 restoring 窗口属竞态，应等待而非直接失败）
    if(window.accountRestoreStatus==='restoring'){
      try{ await restorePromise; }catch(_){ /* 恢复失败 → 进入下方 blocked 判定 */ }
    }
    // 与 cloudReady() 对齐：'ready'（恢复成功）或 'blocked'（恢复失败/本地优先）均允许推送；
    // 仅真正的中间态才禁止。'blocked' 下本地数据优先写回云端（local-wins）。
    if(window.accountRestoreStatus!=='ready' && window.accountRestoreStatus!=='blocked'){
      console.log('[SYNC] BACKUP_BLOCKED reason='+window.accountRestoreStatus);
      return false;
    }
    const response=await fetch('/api/account/backups',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
      // backupVersion=2：快照带 syncAccounts（同步账户持仓事实），支持真正的历史恢复；
      // 旧快照（无 syncAccounts）恢复时自动回退「历史策略 + 当前持仓重建」，完全兼容。
      body:JSON.stringify({state:(function(){const s=buildCloudState();s.syncAccounts=captureSyncAccounts();s.backupVersion=2;return s;})(),reason:reason||'manual'})
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
      // 2026-11-17：备份快照（buildPersisted 形态）不含同步账户持仓，恢复后重建，
      // 并把 syncMeta 策略挂到重建出的同步账户上（否则恢复 16:31:09 备份后持仓/策略仍为空）。
      if (typeof window.refreshSyncedAccounts === 'function') {
        try { await window.refreshSyncedAccounts(); } catch (e) { /* 重建失败不阻塞恢复 */ }
      }
      // 2026-11-17 二轮审查（项2）：backupVersion=2 快照带 syncAccounts 历史持仓事实 ——
      // 在服务端权威重建之后回填，实现「真正的历史恢复」；旧快照无该字段 → 保持原语义
      // （历史策略 + 当前持仓重建）。服务端已删除的同步账户不复活。
      applySyncAccountsSnapshot(data && data.state && data.state.syncAccounts);
      save();
      rerender();
      if (typeof window.refreshFundEstimates === 'function') { try { window.refreshFundEstimates(); } catch (e) {} }
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
