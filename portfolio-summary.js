(function () {
  var root = document.querySelector('#view-root');
  var state = window.portfolioState;
  if (!root || !state) return;

  function money(value) {
    var amount = Number(value) || 0;
    var sign = amount < 0 ? '−' : '';
    return sign + '¥' + Math.abs(amount).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setTone(node, value) {
    if (!node) return;
    node.classList.remove('market-up', 'market-down', 'market-flat');
    node.classList.add(value > 0 ? 'market-up' : value < 0 ? 'market-down' : 'market-flat');
  }

  function totals() {
    var account = state.accounts && state.accounts[state.getActive()];
    var funds = account && Array.isArray(account.funds) ? account.funds : [];
    var amount = funds.reduce(function (sum, fund) {
      return sum + Number(fund.amount || 0);
    }, 0);
    var today = funds.reduce(function (sum, fund) {
      var profit = Number.isFinite(fund.todayEstimate)
        ? fund.todayEstimate
        : Number(fund.amount || 0) * Number(fund.today || 0);
      return sum + Number(profit || 0);
    }, 0);
    return { amount: amount, today: today };
  }

  function enhance() {
    var section = root.querySelector('.list-section');
    var tabs = root.querySelector('.portfolio-account-tabs');
    if (!section || !root.querySelector('.fund-list')) return;

    var summary = root.querySelector('.portfolio-compact-summary');
    if (!summary) {
      summary = document.createElement('section');
      summary.className = 'portfolio-compact-summary';
      summary.setAttribute('aria-label', '当前账户汇总');
      summary.innerHTML =
        '<div class="portfolio-summary-item">' +
          '<span>账户资产</span>' +
          '<strong data-portfolio-total></strong>' +
        '</div>' +
        '<div class="portfolio-summary-item portfolio-summary-today">' +
          '<span>今日收益</span>' +
          '<strong data-portfolio-today></strong>' +
        '</div>';
      if (tabs) tabs.after(summary);
      else section.before(summary);
    }

    var value = totals();
    setText(summary.querySelector('[data-portfolio-total]'), money(value.amount));
    setText(summary.querySelector('[data-portfolio-today]'), money(value.today));
    setTone(summary.querySelector('[data-portfolio-today]'), value.today);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      enhance();
    });
  }

  // The summary updates its own values. Only react when the mounted view at
  // the root changes, not to those internal text updates.
  new MutationObserver(schedule).observe(root, { childList: true });
  window.addEventListener('fund-estimate-updated', schedule);
  schedule();
})();
