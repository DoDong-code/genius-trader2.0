(function () {
  const root = document.querySelector('#view-root');
  const getApiBase = () => window.FUND_API_BASE || '';

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
      const response = await fetch(`${getApiBase()}/api/funds`);
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
      let response = await fetch(`${getApiBase()}/api/fund/${code}`);
      if (response.status === 404) {
        const imported = await fetch(`${getApiBase()}/api/fund/import/${code}`);
        if (!imported.ok) throw new Error('import failed');
        response = await fetch(`${getApiBase()}/api/fund/${code}`);
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

  // --- Column Customization State & Functions ---
  let sortKey = null;
  let sortDirection = 'default';
  const defaultOrder = ['fund', 'todayProfit', 'holdingProfit', 'amount'];
  const columnLabels = {
    fund: { desktop: '基金', mobile: '基金' },
    holdingProfit: { desktop: '持有收益', mobile: '持有' },
    todayProfit: { desktop: '今日收益', mobile: '今日' },
    amount: { desktop: '持有金额', mobile: '金额' }
  };

  function getColumnOrder() {
    try {
      const saved = localStorage.getItem('genius-trader-column-order');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) {
          // 旧默认顺序（基金/持有收益/今日收益/持有金额）迁移到新默认顺序
          if (JSON.stringify(parsed) === JSON.stringify(['fund', 'holdingProfit', 'todayProfit', 'amount'])) {
            saveColumnOrder([...defaultOrder]);
            return [...defaultOrder];
          }
          return parsed;
        }
      }
    } catch (e) {}
    return [...defaultOrder];
  }

  function saveColumnOrder(order) {
    try {
      localStorage.setItem('genius-trader-column-order', JSON.stringify(order));
    } catch (e) {}
  }

  function applyColumnOrder(order) {
    const rootEl = document.documentElement;
    order.forEach((key, index) => {
      rootEl.style.setProperty(`--col-${index}`, `var(--col-width-${key})`);
      rootEl.style.setProperty(`--col-order-${key}`, index);
    });
  }

  // Initialize column order
  let currentColumnOrder = getColumnOrder();
  applyColumnOrder(currentColumnOrder);

  // setup drag & drop for actual headers
  function setupDragAndDrop(header) {
    if (!header || header.dataset.dragBound) return;
    header.dataset.dragBound = 'true';

    let draggedKey = null;

    header.addEventListener('dragstart', e => {
      const span = e.target.closest('[data-col-key]');
      if (!span || span.dataset.colKey === 'fund') return;
      draggedKey = span.dataset.colKey;
      span.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedKey);
    });

    header.addEventListener('dragover', e => {
      e.preventDefault();
      const span = e.target.closest('[data-col-key]');
      if (span && span.dataset.colKey !== draggedKey) {
        span.classList.add('drag-over');
      }
    });

    header.addEventListener('dragenter', e => {
      const span = e.target.closest('[data-col-key]');
      if (span && span.dataset.colKey !== draggedKey) {
        span.classList.add('drag-over');
      }
    });

    header.addEventListener('dragleave', e => {
      const span = e.target.closest('[data-col-key]');
      if (span) {
        span.classList.remove('drag-over');
      }
    });

    header.addEventListener('drop', e => {
      e.preventDefault();
      const span = e.target.closest('[data-col-key]');
      if (!span || span.dataset.colKey === 'fund') return;
      const targetKey = span.dataset.colKey;
      span.classList.remove('drag-over');

      if (draggedKey && targetKey && draggedKey !== targetKey) {
        const order = [...currentColumnOrder];
        const draggedIndex = order.indexOf(draggedKey);
        const targetIndex = order.indexOf(targetKey);
        
        if (draggedIndex !== -1 && targetIndex !== -1) {
          order.splice(draggedIndex, 1);
          order.splice(targetIndex, 0, draggedKey);
          
          currentColumnOrder = order;
          saveColumnOrder(order);
          applyColumnOrder(order);

          // Force update visual positions
          enhance();
        }
      }
    });

    header.addEventListener('dragend', e => {
      header.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
      header.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      draggedKey = null;
    });
  }

  // settings dialog for columns customizer
  function customizeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay fund-modal-overlay';
    overlay.innerHTML = `
      <form class="confirm-dialog fund-modal" style="max-width: 440px;">
        <h2>自定义表头顺序</h2>
        <p style="margin-bottom: 16px; color: #86868b; font-size: 13px; line-height: 1.5;">拖动选项，自定义持仓列表的左右顺序（基金列固定在最前）。</p>
        <div class="column-list">
          <!-- Dynamically populated -->
        </div>
        <div class="confirm-actions" style="margin-top: 20px;">
          <button type="button" class="primary column-done-btn" style="width: 100%; border-radius: 8px;">完成</button>
        </div>
      </form>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const columnListContainer = overlay.querySelector('.column-list');

    function renderList() {
      columnListContainer.innerHTML = currentColumnOrder.map((key) => {
        const lbl = columnLabels[key];
        if (key === 'fund') {
          return `
            <div class="column-item column-item-fixed" data-key="fund" title="基金列固定在最前">
              <span class="column-item-name">${lbl.desktop}</span>
              <span style="font-size: 11px; color: #86868b; font-weight: 500;">固定</span>
            </div>
          `;
        }
        return `
          <div class="column-item" data-key="${key}" draggable="true">
            <span class="column-item-name">${lbl.desktop}</span>
          </div>
        `;
      }).join('');
    }

    renderList();

    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
    };

    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('.column-done-btn')) {
        close();
      }
    });

    let modalDraggedKey = null;

    columnListContainer.addEventListener('dragstart', e => {
      const item = e.target.closest('.column-item');
      if (!item || item.dataset.key === 'fund') return;
      modalDraggedKey = item.dataset.key;
      item.style.opacity = '0.5';
    });

    columnListContainer.addEventListener('dragover', e => {
      e.preventDefault();
    });

    columnListContainer.addEventListener('drop', e => {
      e.preventDefault();
      const item = e.target.closest('.column-item');
      if (!item || item.dataset.key === 'fund') return;
      const targetKey = item.dataset.key;

      if (modalDraggedKey && targetKey && modalDraggedKey !== targetKey) {
        const order = [...currentColumnOrder];
        const draggedIndex = order.indexOf(modalDraggedKey);
        const targetIndex = order.indexOf(targetKey);

        if (draggedIndex !== -1 && targetIndex !== -1) {
          order.splice(draggedIndex, 1);
          order.splice(targetIndex, 0, modalDraggedKey);
          currentColumnOrder = order;
          saveColumnOrder(order);
          applyColumnOrder(order);
          renderList();
          enhance();
        }
      }
    });

    columnListContainer.addEventListener('dragend', e => {
      columnListContainer.querySelectorAll('.column-item').forEach(el => el.style.opacity = '');
      modalDraggedKey = null;
    });
  }

  function enhance() {
    const section = root.querySelector('.list-section');
    if (!section || !section.querySelector('.fund-list')) return;

    if (!section.querySelector('.holding-head')) {
      const head = document.createElement('div');
      head.className = 'holding-head';
      section.querySelector('.fund-list').before(head);
    }

    const header = section.querySelector('.holding-head');
    if (header) {
      let html = '';
      currentColumnOrder.forEach(key => {
        if (key === 'fund') {
          html += `<span data-col-key="fund">基金</span>`;
        } else {
          const lbl = columnLabels[key];
          const active = key === sortKey && sortDirection !== 'default';
          const arrow = active ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
          html += `<span data-col-key="${key}"><button type="button" class="holding-sort-button" data-sort-key="${key}" aria-sort="${active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}"><span class="desktop-label">${lbl.desktop}${arrow}</span><span class="mobile-label">${lbl.mobile}${arrow}</span></button></span>`;
        }
      });
      header.innerHTML = html;

      Array.from(header.children).forEach(span => {
        span.setAttribute('draggable', 'true');
      });

      setupDragAndDrop(header);
    }

    const account = window.portfolioState.accounts[window.portfolioState.getActive()];
    section.querySelectorAll('.fund-row').forEach(row => {
      const colFund = row.querySelector('.fund-info');
      const colEst = row.querySelector('.fund-est');
      const colToday = row.querySelector('.fund-today');
      const colAmount = row.querySelector('.fund-amount');

      if (colFund) colFund.dataset.colKey = 'fund';
      if (colEst) colEst.dataset.colKey = 'holdingProfit';
      if (colToday) colToday.dataset.colKey = 'todayProfit';
      if (colAmount) colAmount.dataset.colKey = 'amount';

      const fund = account.funds.find(item => item.code === row.dataset.code);
      if (fund && Number.isFinite(fund.holdingProfit)) {
        const strong = colEst?.querySelector('strong');
        const span = colEst?.querySelector('span');
        const profit = `${fund.holdingProfit < 0 ? '−' : ''}¥${Math.abs(fund.holdingProfit).toLocaleString('zh-CN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`;
        const rateText = `${fund.holdingRate > 0 ? '+' : ''}${(fund.holdingRate * 100).toFixed(2)}%`;
        if (strong && strong.textContent !== profit) strong.textContent = profit;
        if (span && span.textContent !== rateText) span.textContent = rateText;
      }

      [colEst, colToday].forEach(cell => {
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

    const customizeBtn = section.querySelector('[data-action="customize-columns"]');
    if (customizeBtn && !customizeBtn.dataset.bound) {
      customizeBtn.dataset.bound = '1';
      customizeBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        customizeModal();
      });
    }
  }

  // Keep the observer at the view boundary so row/cell updates do not make
  // this legacy enhancer run recursively.
  new MutationObserver(enhance).observe(root, { childList: true });

  if (!root.dataset.fundSortBound) {
    root.dataset.fundSortBound = 'true';

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
      const header = root.querySelector('.holding-head');
      if (header) {
        currentColumnOrder.forEach(key => {
          if (key !== 'fund') {
            const span = header.querySelector(`[data-col-key="${key}"]`);
            const button = span?.querySelector('[data-sort-key]');
            if (button) {
              const lbl = columnLabels[key];
              const active = key === sortKey && sortDirection !== 'default';
              const arrow = active ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
              button.innerHTML = `<span class="desktop-label">${lbl.desktop}${arrow}</span><span class="mobile-label">${lbl.mobile}${arrow}</span>`;
              button.setAttribute('aria-sort', active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
            }
          }
        });
      }
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
