(function () {
  'use strict';

  var root = document.querySelector('#view-root');
  var state = window.portfolioState;
  if (!root || !state) return;

  // Keep sorting deliberately event-driven.  The old implementation watched every
  // DOM change under the page and then moved rows again, which could snowball when
  // live estimates refreshed a row at the same time.
  var direction = null;
  var retryFrame = 0;

  function labelForCurrentDirection() {
    if (direction === 'desc') return '持有金额 ↓';
    if (direction === 'asc') return '持有金额 ↑';
    return '持有金额';
  }

  function updateButton(button) {
    if (!button) return;
    button.textContent = labelForCurrentDirection();
    button.setAttribute('aria-label', direction === 'desc'
      ? '持有金额，当前从高到低，点击改为从低到高'
      : direction === 'asc'
        ? '持有金额，当前从低到高，点击改为从高到低'
        : '按持有金额排序');
    button.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none');
  }

  function sortRows(section) {
    if (!direction || !section) return;
    var list = section.querySelector('.fund-list');
    var account = state.accounts && state.accounts[state.getActive()];
    if (!list || !account) return;

    var amounts = new Map((account.funds || []).map(function (fund) {
      return [String(fund.code), Number(fund.amount) || 0];
    }));
    var rows = Array.from(list.querySelectorAll('.fund-row'));
    var sortedRows = rows.slice().sort(function (a, b) {
      var difference = (amounts.get(String(a.dataset.code)) || 0) - (amounts.get(String(b.dataset.code)) || 0);
      return direction === 'asc' ? difference : -difference;
    });

    if (!sortedRows.some(function (row, index) { return row !== rows[index]; })) return;
    // This is performed only in response to a user sort action or a complete view
    // render—not in response to arbitrary subtree mutations.
    sortedRows.forEach(function (row) { list.appendChild(row); });
  }

  function install(retries) {
    var section = root.querySelector('.list-section');
    var header = section && section.querySelector('.holding-head');
    if (!section || !header || !section.querySelector('.fund-list')) {
      if (retries > 0) {
        cancelAnimationFrame(retryFrame);
        retryFrame = requestAnimationFrame(function () { install(retries - 1); });
      }
      return;
    }

    var lastHeader = header.lastElementChild;
    if (!lastHeader) return;
    var button = lastHeader.querySelector('[data-sort-amount]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'holding-sort-button';
      button.dataset.sortAmount = 'true';
      lastHeader.replaceChildren(button);
    }
    updateButton(button);
    sortRows(section);
  }

  root.addEventListener('click', function (event) {
    var button = event.target.closest('[data-sort-amount]');
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      direction = direction === 'desc' ? 'asc' : 'desc';
      updateButton(button);
      sortRows(root.querySelector('.list-section'));
      return;
    }

    // The primary renderer replaces the portfolio markup after these actions.
    // Install once on the next frame; do not attach a permanent mutation observer.
    if (event.target.closest('[data-view="portfolio"], [data-portfolio-account], [data-action="add-fund"]')) {
      requestAnimationFrame(function () { install(2); });
    }
  }, true);

  install(2);
}());
