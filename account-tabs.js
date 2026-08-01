(function () {
  'use strict';

  var root = document.querySelector('#view-root');
  var state = window.portfolioState;
  var selected = 'all';
  if (!root || !state) return;

  function money(value) {
    var amount = Number(value) || 0;
    var sign = amount < 0 ? '−' : '';
    return sign + '¥' + Math.abs(amount).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function percent(value) {
    var rate = (Number(value) || 0) * 100;
    return (rate > 0 ? '+' : '') + rate.toFixed(2) + '%';
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setHtml(node, value) {
    if (node && node.innerHTML !== value) node.innerHTML = value;
  }

  function selectedFunds() {
    var accounts = selected === 'all'
      ? Object.values(state.accounts)
      : [state.accounts[selected]].filter(Boolean);
    return accounts.flatMap(function (account) { return account.funds || []; });
  }

  function summary() {
    var funds = selectedFunds();
    var total = funds.reduce(function (sum, fund) { return sum + Number(fund.amount || 0); }, 0);
    var holdingProfit = funds.reduce(function (sum, fund) {
      var value = Number.isFinite(fund.holdingProfit)
        ? fund.holdingProfit
        : Number(fund.amount || 0) * Number(fund.hold || 0);
      return sum + Number(value || 0);
    }, 0);
    var todayProfit = funds.reduce(function (sum, fund) {
      var value = Number.isFinite(fund.todayEstimate)
        ? fund.todayEstimate
        : Number(fund.amount || 0) * Number(fund.today || 0);
      return sum + Number(value || 0);
    }, 0);
    var cost = total - holdingProfit;
    return {
      total: total,
      holdingProfit: holdingProfit,
      holdingRate: cost ? holdingProfit / cost : 0,
      todayProfit: todayProfit,
      todayRate: total ? todayProfit / total : 0,
      navUpdated: funds.length > 0 && funds.every(function (fund) { return Boolean(fund.navUpdatedAt); })
    };
  }

  function updateCard() {
    var box = root.querySelector('.kpis');
    if (!box) return;
    var items = box.querySelectorAll('.kpi');
    if (items.length < 5) return;
    var data = summary();
    setText(items[0].querySelector('.kpi-label'), selected === 'all' ? '全部账户总资产' : '当前账户总资产');
    setText(items[0].querySelector('.kpi-value'), money(data.total));

    setText(items[1].querySelector('.kpi-value'), '¥0.00');
    setText(items[1].querySelector('.kpi-sub'), '0.00%');

    setText(items[2].querySelector('.kpi-value'), money(data.todayProfit));
    setHtml(
      items[2].querySelector('.kpi-sub'),
      '<span class="estimate-state' + (data.navUpdated ? ' updated' : '') + '">' +
        (data.navUpdated ? '已更新' : '估算') +
      '</span><span>' + percent(data.todayRate) + '</span>'
    );

    setText(items[3].querySelector('.kpi-value'), money(data.holdingProfit));
    setText(items[3].querySelector('.kpi-sub'), percent(data.holdingRate));
    setText(items[4].querySelector('.kpi-value'), money(data.holdingProfit));
    setText(items[4].querySelector('.kpi-sub'), percent(data.holdingRate));
  }

  function updateTabs() {
    root.querySelectorAll('.account-segment').forEach(function (button) {
      button.classList.toggle('active', button.dataset.accountTab === selected);
    });
  }

  function ensure() {
    var box = root.querySelector('.kpis');
    if (!box) return;
    if (selected !== 'all' && !state.accounts[selected]) selected = state.getActive() || 'all';
    var tabs = root.querySelector('.account-segmented');
    if (!tabs) {
      tabs = document.createElement('div');
      tabs.className = 'account-segmented';
      tabs.setAttribute('role', 'tablist');
      tabs.innerHTML = '<button class="account-segment" data-account-tab="all">总览</button>' +
        Object.keys(state.accounts).map(function (name) {
          return '<button class="account-segment" data-account-tab="' + name.replace(/"/g, '&quot;') + '">' +
            name.replace(/（朋友账户）/, '') +
          '</button>';
        }).join('');
      box.before(tabs);
    }
    updateTabs();
    updateCard();
  }

  root.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-account-tab]');
    if (!tab) return;
    selected = tab.dataset.accountTab;
    if (selected !== 'all' && state.accounts[selected]) state.setActive(selected);
    updateTabs();
    updateCard();
  });

  root.addEventListener('click', function (event) {
    var kpis = event.target.closest('.kpis');
    if (!kpis || event.target.closest('button, input, a, [data-action]')) return;
    state.render('portfolio');
  });

  root.addEventListener('click', function (event) {
    var row = event.target.closest('.account-section .account-card[data-account]');
    if (!row || row.classList.contains('account-edit-row')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = row.dataset.account;
    state.setActive(selected);
    updateTabs();
    updateCard();
    state.render('portfolio');
  }, true);

  window.addEventListener('fund-estimate-updated', updateCard);
  // A view change replaces the root content. Observing direct children is
  // enough and avoids reacting to the KPI text this module writes itself.
  new MutationObserver(ensure).observe(root, { childList: true });
  ensure();
}());
