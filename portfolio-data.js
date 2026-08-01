(function () {
  'use strict';

  var CORRECTION_VERSION = '20260731-account2-corrected-v2';
  var TARGET_DATE = '2026-07-31';
  var LEGACY_CODES = ['015442', '013308', '012910', '010826', '014846', '004919', '007540', '003103', '163819', '009730', '009689'];

  function fund(name, code, category, amount, holdingProfit, holdingRate, today, notes) {
    var hasEstimate = Number.isFinite(today);
    return {
      name: name,
      code: code,
      category: category,
      amount: amount,
      holdingProfit: holdingProfit,
      holdingRate: holdingRate,
      hold: holdingRate,
      today: hasEstimate ? today : null,
      todayEstimate: hasEstimate ? amount * today : null,
      manualToday: hasEstimate ? today : null,
      manualEstimateDate: TARGET_DATE,
      manualEstimateUnavailable: today === null,
      notes: notes || [],
      holdings: [],
      transactionVersion: 2,
      transactions: []
    };
  }

  function correctedFunds() {
    return [
      fund('国泰半导体设备ETF联接C', '019633', '权益类', 10000, 520, 0.052, -0.015, ['芯片板块示例']),
      fund('华夏黄金ETF联接C', '008702', '黄金类', 15000, 1860, 0.124, 0.008, ['避险资产示例'])
    ];
  }

  function isTargetAccount(account) {
    return false;
  }

  function applyCorrection(accounts) {
    if (!accounts || typeof accounts !== 'object') return false;
    var changed = false;
    Object.keys(accounts).forEach(function (name) {
      var account = accounts[name];
      if (!isTargetAccount(account) || account.portfolioDataVersion === CORRECTION_VERSION) return;
      account.funds = correctedFunds();
      account.snapshotDate = '2026-07-30';
      account.portfolioDataVersion = CORRECTION_VERSION;
      account.closedPositions = [{ name: '天弘中证银行ETF联接C', code: '001595', closedBefore: '2026-07-30', reason: ['连涨一个月', '持仓收益约+5%', '与沪深300存在重叠', '精简组合'] }];
      account.strategy = ['降低重复持仓', '银行已退出，沪深300作为核心宽基', '科技成长长期看好但控制仓位', '半导体观察并维持低仓位', '黄金作为防守资产', '债券作为组合稳定器'];
      changed = true;
    });
    return changed;
  }

  window.applyAccount2PortfolioCorrection = applyCorrection;
  var state = window.portfolioState;
  if (state && state.accounts) applyCorrection(state.accounts);
}());
