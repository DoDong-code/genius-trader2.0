(function () {
  const root = document.querySelector('#view-root');
  const apiBase = window.FUND_API_BASE || '';

  function getLocalCatalog() {
    const catalog = new Map();
    Object.values(window.portfolioState?.accounts || {}).forEach(account => {
      (account.funds || []).forEach(fund => {
        if (/^\d{6}$/.test(String(fund.code || ''))) {
          catalog.set(String(fund.code), {
            code: String(fund.code),
            name: String(fund.name || '')
          });
        }
      });
    });
    return catalog;
  }

  async function loadRemoteCatalog(catalog) {
    try {
      const response = await fetch(`${apiBase}/api/funds`);
      if (!response.ok) return;
      const payload = await response.json();
      (payload.funds || []).forEach(fund => {
        catalog.set(String(fund.fund_code), {
          code: String(fund.fund_code),
          name: String(fund.fund_name)
        });
      });
    } catch {
      // The form remains fully usable when the optional data service is offline.
    }
  }

  function findByName(catalog, value) {
    const query = value.trim().toLocaleLowerCase('zh-CN');
    if (!query) return null;
    const funds = [...catalog.values()];
    const exact = funds.find(fund => fund.name.toLocaleLowerCase('zh-CN') === query);
    if (exact) return exact;
    const partial = funds.filter(fund => fund.name.toLocaleLowerCase('zh-CN').includes(query));
    return partial.length === 1 ? partial[0] : null;
  }

  async function resolveCode(code, catalog, status) {
    if (catalog.has(code)) {
      status.textContent = '已自动补全基金信息';
      return catalog.get(code);
    }
    status.textContent = '正在查询基金信息…';
    try {
      let response = await fetch(`${apiBase}/api/fund/${code}`);
      if (response.status === 404) {
        const imported = await fetch(`${apiBase}/api/fund/import/${code}`);
        if (!imported.ok) throw new Error('import failed');
        response = await fetch(`${apiBase}/api/fund/${code}`);
      }
      if (!response.ok) throw new Error('lookup failed');
      const payload = await response.json();
      const fund = {
        code: String(payload.fund.fund_code),
        name: String(payload.fund.fund_name)
      };
      catalog.set(fund.code, fund);
      status.textContent = '已自动补全基金信息';
      return fund;
    } catch {
      status.textContent = '暂未查到，可继续手动填写';
      return null;
    }
  }

  function modal() {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay fund-modal-overlay';
    overlay.innerHTML = `
      <form class="confirm-dialog fund-modal">
        <h2>增加基金</h2>
        <p>输入基金名称或代码可自动补齐。</p>
        <label>基金名称
          <input name="name" list="fund-name-options" autocomplete="off" required>
        </label>
        <datalist id="fund-name-options"></datalist>
        <label>基金代码
          <input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="off" required>
        </label>
        <small class="fund-lookup-status" aria-live="polite"></small>
        <label>持有金额
          <input name="amount" type="number" min="0.01" step="0.01" required>
        </label>
        <label>持有收益
          <input name="holdingProfit" type="number" step="0.01" value="0" required>
        </label>
        <div class="confirm-actions">
          <button type="button" data-close>取消</button>
          <button type="submit" class="fund-submit">添加</button>
        </div>
      </form>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const form = overlay.querySelector('form');
    const nameInput = form.elements.name;
    const codeInput = form.elements.code;
    const status = overlay.querySelector('.fund-lookup-status');
    const datalist = overlay.querySelector('#fund-name-options');
    const catalog = getLocalCatalog();
    let lookupSequence = 0;

    function refreshOptions() {
      const options = [...catalog.values()].map(fund => {
        const option = document.createElement('option');
        option.value = fund.name;
        option.textContent = fund.code;
        return option;
      });
      datalist.replaceChildren(...options);
    }

    refreshOptions();
    loadRemoteCatalog(catalog).then(refreshOptions);
    nameInput.focus();

    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
    };

    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-close]')) close();
    });

    nameInput.addEventListener('input', () => {
      const fund = findByName(catalog, nameInput.value);
      if (fund) {
        codeInput.value = fund.code;
        status.textContent = '已自动补全基金代码';
      }
    });

    codeInput.addEventListener('input', async () => {
      const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
      codeInput.value = code;
      if (code.length !== 6) {
        status.textContent = '';
        return;
      }
      const sequence = ++lookupSequence;
      const fund = await resolveCode(code, catalog, status);
      if (sequence !== lookupSequence || !fund) return;
      nameInput.value = fund.name;
      refreshOptions();
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(form);
      const name = String(data.get('name')).trim();
      const code = String(data.get('code')).trim();
      const amount = Number(data.get('amount'));
      const holdingProfit = Number(data.get('holdingProfit'));
      if (!name || !/^\d{6}$/.test(code) || amount <= 0 || !Number.isFinite(holdingProfit)) return;

      const costBasis = amount - holdingProfit;
      const holdingRate = costBasis > 0 ? holdingProfit / costBasis : 0;
      window.portfolioState.accounts[window.portfolioState.getActive()].funds.push({
        name,
        code,
        category: '基金',
        amount,
        holdingProfit,
        holdingRate,
        today: 0,
        hold: holdingRate,
        holdings: [],
        transactions: []
      });
      window.savePortfolioState?.();
      close();
      document.querySelector('.nav-tab[data-view="portfolio"]')?.click();
    });
  }

  function enhance() {
    const section = root.querySelector('.list-section');
    if (!section || !section.querySelector('.fund-list')) return;

    if (!section.querySelector('.holding-head')) {
      const head = document.createElement('div');
      head.className = 'holding-head';
      head.innerHTML = '<span>基金</span><span><button type="button" class="holding-sort-button" data-sort-key="holdingProfit" aria-sort="none"><span class="desktop-label">持有收益</span><span class="mobile-label">持有</span></button></span><span><button type="button" class="holding-sort-button" data-sort-key="todayProfit" aria-sort="none"><span class="desktop-label">今日收益</span><span class="mobile-label">今日</span></button></span><span><button type="button" class="holding-sort-button" data-sort-key="amount" aria-sort="none"><span class="desktop-label">持有金额</span><span class="mobile-label">金额</span></button></span>';
      section.querySelector('.fund-list').before(head);
    }

    const header = section.querySelector('.holding-head');
    const labels = [
      { desktop: '持有收益', mobile: '持有' },
      { desktop: '今日收益', mobile: '今日' },
      { desktop: '持有金额', mobile: '金额' }
    ];
    Array.from(header?.children || []).filter(c => c.tagName === 'SPAN').slice(1).forEach((cell, index) => {
      if (cell.querySelector('[data-sort-key]')) return;
      if (!labels[index]) return;
      const key = index === 0 ? 'holdingProfit' : index === 1 ? 'todayProfit' : 'amount';
      cell.innerHTML = `<button type="button" class="holding-sort-button" data-sort-key="${key}" aria-sort="none"><span class="desktop-label">${labels[index].desktop}</span><span class="mobile-label">${labels[index].mobile}</span></button>`;
    });

    const account = window.portfolioState.accounts[window.portfolioState.getActive()];
    section.querySelectorAll('.fund-row').forEach(row => {
      const fund = account.funds.find(item => item.code === row.dataset.code);
      if (fund && Number.isFinite(fund.holdingProfit)) {
        const strong = row.children[1]?.querySelector('strong');
        const span = row.children[1]?.querySelector('span');
        const profit = `${fund.holdingProfit < 0 ? '−' : ''}¥${Math.abs(fund.holdingProfit).toLocaleString('zh-CN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`;
        const rateText = `${fund.holdingRate > 0 ? '+' : ''}${(fund.holdingRate * 100).toFixed(2)}%`;
        if (strong && strong.textContent !== profit) strong.textContent = profit;
        if (span && span.textContent !== rateText) span.textContent = rateText;
      }

      [row.children[1], row.children[2]].forEach(cell => {
        if (!cell || cell.dataset.estimateUnavailable === 'true') return;
        const strong = cell.querySelector('strong');
        const span = cell.querySelector('span');
        if (!strong || !span) return;
        const match = span.textContent.match(/[+-]?\d+(?:\.\d+)?(?=%)/);
        const rate = match ? Number(match[0]) : 0;
        const className = rate > 0 ? 'market-up' : rate < 0 ? 'market-down' : 'market-flat';
        strong.classList.remove('market-up', 'market-down', 'market-flat');
        span.classList.remove('market-up', 'market-down', 'market-flat');
        strong.classList.add(className);
        span.classList.add(className);
        const text = `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`;
        if (span.textContent !== text) span.textContent = text;
      });
    });

    const addButton = section.querySelector('[data-action="add-fund"]');
    if (addButton && !addButton.dataset.bound) {
      addButton.dataset.bound = '1';
      addButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        modal();
      });
    }
  }

  // Keep the observer at the view boundary so row/cell updates do not make
  // this legacy enhancer run recursively.
  new MutationObserver(enhance).observe(root, { childList: true });

  if (!root.dataset.fundSortBound) {
    root.dataset.fundSortBound = 'true';
    let sortKey = null;
    let sortDirection = 'default';

    const sortValue = (fund, key) => {
      if (key === 'amount') return Number(fund.amount) || 0;
      if (key === 'holdingProfit') return Number.isFinite(fund.holdingProfit)
        ? Number(fund.holdingProfit)
        : (Number(fund.amount) || 0) * (Number(fund.hold) || 0);
      return Number.isFinite(fund.todayEstimate)
        ? Number(fund.todayEstimate)
        : (Number(fund.amount) || 0) * (Number(fund.today) || 0);
    };

    const refreshSortLabels = () => {
      root.querySelectorAll('[data-sort-key]').forEach(button => {
        const active = button.dataset.sortKey === sortKey && sortDirection !== 'default';
        const arrow = active ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
        const key = button.dataset.sortKey;
        const dText = key === 'holdingProfit' ? '持有收益' : key === 'todayProfit' ? '今日收益' : '持有金额';
        const mText = key === 'holdingProfit' ? '持有' : key === 'todayProfit' ? '今日' : '金额';
        button.innerHTML = `<span class="desktop-label">${dText}${arrow}</span><span class="mobile-label">${mText}${arrow}</span>`;
        button.setAttribute('aria-sort', active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      });
    };

    root.addEventListener('click', event => {
      const button = event.target.closest('[data-sort-key]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      const section = root.querySelector('.list-section');
      const list = section?.querySelector('.fund-list');
      const account = window.portfolioState?.accounts?.[window.portfolioState?.getActive?.()];
      if (!list || !account) return;

      const nextKey = button.dataset.sortKey;
      if (sortKey !== nextKey) {
        sortKey = nextKey;
        sortDirection = 'asc';
      } else if (sortDirection === 'asc') {
        sortDirection = 'desc';
      } else {
        sortKey = null;
        sortDirection = 'default';
      }

      const orderByCode = new Map((account.funds || []).map((fund, index) => [String(fund.code), index]));
      const fundsByCode = new Map((account.funds || []).map(fund => [String(fund.code), fund]));
      const rows = [...list.querySelectorAll('.fund-row')];
      const orderedRows = rows.slice().sort((left, right) => {
        if (sortDirection === 'default') {
          return (orderByCode.get(String(left.dataset.code)) || 0) - (orderByCode.get(String(right.dataset.code)) || 0);
        }
        const difference = sortValue(fundsByCode.get(String(left.dataset.code)) || {}, sortKey)
          - sortValue(fundsByCode.get(String(right.dataset.code)) || {}, sortKey);
        return sortDirection === 'asc' ? difference : -difference;
      });

      if (orderedRows.some((row, index) => row !== rows[index])) {
        orderedRows.forEach(row => list.appendChild(row));
      }

      refreshSortLabels();
    }, true);
  }
  enhance();
})();
