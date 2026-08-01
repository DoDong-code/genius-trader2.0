(function () {
  const apiBase = window.FUND_API_BASE || '';
  const root = document.querySelector('#view-root');
  if (!root || !window.portfolioState) return;

  function migrateFundCodes() {
    let changed = false;
    Object.values(window.portfolioState.accounts).forEach(account => {
      (account.funds || []).forEach(fund => {
        if (fund.name?.includes('富国全球科技互联网') && fund.code !== '022184') {
          fund.code = '022184';
          changed = true;
        }
        if (fund.name?.includes('易方达恒生科技') && fund.code !== '013309') {
          fund.code = '013309';
          fund.name = '易方达恒生科技ETF联接(QDII)C';
          changed = true;
        }
      });
    });
    if (changed) window.savePortfolioState?.();
  }

  migrateFundCodes();

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  const money = value => {
    const number = Number(value) || 0;
    const prefix = number < 0 ? '−' : '';
    return `${prefix}¥${Math.abs(number).toLocaleString('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })}`;
  };

  const percent = value => {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : ''}${(number * 100).toFixed(2)}%`;
  };

  const tone = value => Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : '';
  const historyRanges = [
    { key: '1m', label: '近1月', days: 31 },
    { key: '3m', label: '近3月', days: 93 },
    { key: '6m', label: '近6月', days: 186 },
    { key: '1y', label: '近1年', days: 366 },
    { key: '3y', label: '近3年', days: 1096 }
  ];

  function getFund(code) {
    const activeName = window.portfolioState.getActive();
    const activeAccount = window.portfolioState.accounts[activeName];
    let fund = activeAccount?.funds.find(fund => String(fund.code) === String(code));
    if (!fund) {
      Object.values(window.portfolioState.accounts || {}).some(account => {
        fund = account.funds?.find(item => String(item.code) === String(code));
        return Boolean(fund);
      });
    }
    return fund;
  }

  // Keep the drawer on exactly the same source-of-truth as the holdings list:
  // today's published NAV wins; only then may an intraday estimate be shown.
  function shanghaiDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function officialNavChange(history, navDate) {
    const records = (Array.isArray(history) ? history : [])
      .filter(item => item?.date && Number.isFinite(Number(item.nav)))
      .slice()
      .sort((left, right) => String(left.date).localeCompare(String(right.date)));
    const index = records.findIndex(item => item.date === navDate);
    if (index <= 0) return null;
    const current = Number(records[index].nav);
    const previous = Number(records[index - 1].nav);
    return Number.isFinite(current) && Number.isFinite(previous) && previous !== 0
      ? current / previous - 1
      : null;
  }

  function resolveTodayData(fund, payload = {}) {
    const history = payload.history || [];
    const navDate = payload.latest_nav?.date || payload.fund?.latest_nav?.date || payload.estimate?.nav_date || null;
    let officialChange = navDate ? officialNavChange(history, navDate) : null;
    if (!Number.isFinite(officialChange) && navDate && payload.latest_nav?.date === navDate && Number.isFinite(Number(payload.latest_nav?.changePercent))) {
      officialChange = Number(payload.latest_nav.changePercent);
    }
    if (!Number.isFinite(officialChange) && navDate && payload.estimate?.nav_date === navDate && Number.isFinite(Number(payload.estimate?.estimate_change))) {
      officialChange = Number(payload.estimate.estimate_change);
    }
    if (navDate && Number.isFinite(officialChange)) {
      return { official: true, navDate, change: officialChange, profit: fund.amount * officialChange };
    }

    // Portfolio-provided intraday estimates are the first fallback while the
    // official NAV is pending. Do not let a stale/empty API zero overwrite
    // these values in the detail drawer.
    const manualIsCurrent = fund.manualEstimateDate === shanghaiDate();
    const manualChange = Number(fund.manualToday);
    if (manualIsCurrent && fund.manualEstimateUnavailable !== true && Number.isFinite(manualChange)) {
      return { official: false, navDate: null, change: manualChange, profit: fund.amount * manualChange };
    }

    const apiChange = Number(payload.estimate?.estimate_change);
    if (Number.isFinite(apiChange)) {
      return { official: false, navDate: null, change: apiChange, profit: fund.amount * apiChange };
    }

    // The list may already have refreshed a same-day manual/official value.
    const localIsCurrent = manualIsCurrent || Boolean(fund.navUpdatedAt);
    const localChange = Number(fund.today);
    if (localIsCurrent && Number.isFinite(localChange)) {
      return { official: Boolean(fund.navUpdatedAt), navDate: fund.navUpdatedAt || null, change: localChange, profit: fund.amount * localChange };
    }
    return { official: false, navDate: null, change: null, profit: null };
  }

  function historyForRange(history, rangeKey) {
    if (!Array.isArray(history) || !history.length) return [];
    const range = historyRanges.find(item => item.key === rangeKey) || historyRanges[3];
    const latestTime = new Date(`${history[history.length - 1].date}T00:00:00`).getTime();
    const cutoff = latestTime - range.days * 86400000;
    const startIndex = history.findIndex(item =>
      new Date(`${item.date}T00:00:00`).getTime() >= cutoff
    );
    return history.slice(Math.max(0, startIndex));
  }

  function rangeReturn(history, rangeKey) {
    const range = historyRanges.find(item => item.key === rangeKey);
    if (!range || history.length < 2) return null;
    const latestTime = new Date(`${history[history.length - 1].date}T00:00:00`).getTime();
    const oldestTime = new Date(`${history[0].date}T00:00:00`).getTime();
    const cutoff = latestTime - range.days * 86400000;
    if (oldestTime > cutoff + 14 * 86400000) return null;
    const period = historyForRange(history, rangeKey);
    const start = Number(period[0]?.nav);
    const end = Number(period[period.length - 1]?.nav);
    return start && Number.isFinite(end) ? (end - start) / start : null;
  }

  function chartMarkup(history, rangeLabel = '近1年') {
    if (!Array.isArray(history) || history.length < 2) {
      return '<div class="detail-empty">暂无历史净值数据</div>';
    }

    const width = 520;
    const height = 180;
    const padding = 10;
    const values = history.map(item => Number(item.nav)).filter(Number.isFinite);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum || 1;
    const points = history.map((item, index) => {
      const x = padding + (index / (history.length - 1)) * (width - padding * 2);
      const y = padding + ((maximum - Number(item.nav)) / range) * (height - padding * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const first = history[0];
    const last = history[history.length - 1];
    const change = first.nav ? (last.nav - first.nav) / first.nav : 0;

    return `
      <div class="detail-chart" aria-label="${escapeHtml(rangeLabel)}历史净值曲线">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
          <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.5"
            vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"></polyline>
        </svg>
      </div>
      <div class="detail-chart-meta">
        <span>${escapeHtml(first.date)}</span>
        <b class="${tone(change)}">${percent(change)}</b>
        <span>${escapeHtml(last.date)}</span>
      </div>`;
  }

  function performanceMarkup(history) {
    const inception = history.length > 1
      ? (Number(history.at(-1).nav) - Number(history[0].nav)) / Number(history[0].nav)
      : null;
    return `<div class="history-performance">
      <div class="history-table-head"><span>时间区间</span><span>涨跌幅</span></div>
      ${historyRanges.map(range => {
        const value = rangeReturn(history, range.key);
        return `<div class="history-performance-row">
          <b>${range.label}</b>
          <strong class="${value == null ? '' : tone(value)}">
            ${value == null ? '—' : percent(value)}
          </strong>
        </div>`;
      }).join('')}
      <div class="history-performance-row">
        <b>成立以来</b>
        <strong class="${inception == null ? '' : tone(inception)}">
          ${inception == null ? '—' : percent(inception)}
        </strong>
      </div>
    </div>`;
  }

  function navHistoryMarkup(history) {
    const rows = history.slice(-30).reverse();
    return `<div class="history-nav">
      <div class="history-nav-row history-table-head">
        <span>日期</span><span>单位净值</span><span>累计净值</span><span>日涨跌幅</span>
      </div>
      ${rows.map((item, reverseIndex) => {
        const index = history.length - 1 - reverseIndex;
        const previous = Number(history[index - 1]?.nav);
        const current = Number(item.nav);
        const dailyChange = previous ? (current - previous) / previous : null;
        return `<div class="history-nav-row">
          <b>${escapeHtml(item.date)}</b>
          <span>${current.toFixed(4)}</span>
          <span>${Number(item.acc_nav ?? item.nav).toFixed(4)}</span>
          <strong class="${dailyChange == null ? '' : tone(dailyChange)}">
            ${dailyChange == null ? '—' : percent(dailyChange)}
          </strong>
        </div>`;
      }).join('')}
    </div>`;
  }

  function activateButton(buttons, activeButton) {
    buttons.forEach(button => {
      const active = button === activeButton;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  function setupHistoryExplorer(backdrop, history) {
    const chartContent = backdrop.querySelector('.detail-history-content');
    const chartTitle = backdrop.querySelector('.detail-history-title');
    const rangeButtons = [...backdrop.querySelectorAll('.detail-range-button')];
    const recordButtons = [...backdrop.querySelectorAll('.detail-record-tab')];
    const recordContent = backdrop.querySelector('.detail-record-content');

    const renderRange = button => {
      activateButton(rangeButtons, button);
      const range = historyRanges.find(item => item.key === button.dataset.range) || historyRanges[3];
      chartTitle.textContent = `${range.label}走势`;
      chartContent.classList.remove('content-enter');
      chartContent.innerHTML = chartMarkup(historyForRange(history, range.key), range.label);
      requestAnimationFrame(() => chartContent.classList.add('content-enter'));
    };

    const renderRecord = button => {
      activateButton(recordButtons, button);
      recordContent.classList.remove('content-enter');
      recordContent.innerHTML = button.dataset.record === 'nav'
        ? navHistoryMarkup(history)
        : performanceMarkup(history);
      requestAnimationFrame(() => recordContent.classList.add('content-enter'));
    };

    rangeButtons.forEach(button => button.addEventListener('click', () => renderRange(button)));
    recordButtons.forEach(button => button.addEventListener('click', () => renderRecord(button)));
    renderRange(rangeButtons.find(button => button.dataset.range === '1y') || rangeButtons[0]);
    renderRecord(recordButtons.find(button => button.dataset.record === 'performance') || recordButtons[0]);
  }

  function holdingsMarkup(fund) {
    const holdings = Array.isArray(fund.holdings) ? fund.holdings : [];
    if (!holdings.length) return '<div class="detail-empty">暂无公开持仓数据</div>';
    return `<div class="holding-list">${holdings.map(item => `
      <div>
        <span>${escapeHtml(item.stock_name ?? item[0])}</span>
        <b>${escapeHtml(
          item.weight == null
            ? item[1]
            : `${(Number(item.weight) * (Number(item.weight) <= 1 ? 100 : 1)).toFixed(2)}%`
        )}</b>
      </div>
    `).join('')}</div>`;
  }

  function transactionsMarkup(fund) {
    const transactions = Array.isArray(fund.transactions) ? fund.transactions : [];
    if (!transactions.length) return '<div class="detail-empty">暂无交易记录</div>';
    return `<div class="transaction-list">${transactions.map(item => {
      const legacy = Array.isArray(item);
      const isSell = legacy ? String(item[1] || '').includes('减') : item?.type === 'sell';
      const date = legacy ? item[0] : item?.date;
      const label = legacy ? item[1] : (isSell ? '卖出' : '买入');
      const amount = legacy
        ? item[2]
        : `${isSell ? '−' : '+'}${money(Math.abs(Number(item?.amount) || 0))}`;
      return `
      <div><span>${escapeHtml(date || '')}</span><b>${escapeHtml(label || '')}</b><em>${escapeHtml(amount || '')}</em></div>
    `;
    }).join('')}</div>`;
  }

  function normalizeHolding(fund, amount, profit) {
    const nextAmount = Math.max(0, Number(amount) || 0);
    const nextProfit = Number(profit) || 0;
    const cost = nextAmount - nextProfit;
    const nextRate = cost > 0 ? nextProfit / cost : 0;

    fund.amount = nextAmount;
    fund.holdingProfit = nextProfit;
    fund.holdingRate = nextRate;
    fund.hold = nextRate;
  }

  function refreshDrawerHoldingMetrics(backdrop, fund) {
    const cells = backdrop.querySelectorAll('.detail-values > div');
    const amount = Number(fund.amount) || 0;
    const profit = Number(fund.holdingProfit ?? fund.profit) || 0;
    const rate = Number(fund.holdingRate ?? fund.hold) || 0;
    const update = (index, value, className) => {
      const valueNode = cells[index]?.querySelector('b');
      if (!valueNode) return;
      valueNode.className = className || '';
      valueNode.textContent = value;
    };

    update(0, money(amount), '');
    update(2, money(profit), tone(profit));
    update(3, percent(rate), tone(rate));
  }

  function localDateTimeInputValue() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
  }

  function transactionDateLabel(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date).replace(/\//g, '-');
  }

  function openHoldingEditor(fund, drawerBackdrop) {
    const amount = Number(fund.amount) || 0;
    const profit = Number(fund.holdingProfit ?? fund.profit) || 0;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay holding-editor-overlay';
    overlay.innerHTML = [
      '<form class="confirm-dialog fund-modal holding-editor" novalidate>',
      '<h2>修改持仓</h2>',
      '<p>直接修正当前数据，或按交易金额同步加仓、减仓。</p>',
      '<div class="holding-summary">',
      '<div><span>当前持有金额</span><b>' + money(amount) + '</b></div>',
      '<div><span>当前持有收益</span><b class="' + tone(profit) + '">' + money(profit) + '</b></div>',
      '</div>',
      '<div class="holding-edit-grid">',
      '<label>持有金额<input name="holding-amount" type="number" min="0" step="0.01" value="' + amount.toFixed(2) + '"></label>',
      '<label>持有收益<input name="holding-profit" type="number" step="0.01" value="' + profit.toFixed(2) + '"></label>',
      '</div>',
      '<div class="holding-action-switch" role="group" aria-label="持仓操作">',
      '<button type="button" class="active" data-holding-mode="edit">直接修改</button>',
      '<button type="button" data-holding-mode="add">同步加仓</button>',
      '<button type="button" data-holding-mode="reduce">同步减仓</button>',
      '</div>',
      '<div class="holding-trade-fields" hidden>',
      '<div class="holding-edit-grid">',
      '<label><span data-trade-amount-label>买入金额</span><input name="trade-amount" type="number" min="0.01" step="0.01" value=""></label>',
      '<label><span data-trade-fee-label>买入费率</span><input name="trade-fee" type="number" min="0" step="0.0001" value="0"></label>',
      '<label><span data-trade-time-label>买入时间</span><input name="trade-time" type="datetime-local" value="' + localDateTimeInputValue() + '"></label>',
      '</div>',
      '</div>',
      '<p class="holding-editor-error" role="alert"></p>',
      '<div class="confirm-actions">',
      '<button type="button" class="secondary" data-holding-cancel>取消</button>',
      '<button type="submit" class="primary">保存</button>',
      '</div>',
      '</form>'
    ].join('');

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const form = overlay.querySelector('form');
    const tradeFields = form.querySelector('.holding-trade-fields');
    const error = form.querySelector('.holding-editor-error');
    let mode = 'edit';

    const close = () => {
      overlay.classList.remove('visible');
      document.removeEventListener('keydown', onKeydown);
      window.setTimeout(() => overlay.remove(), 180);
    };
    const onKeydown = event => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeydown);

    const setMode = nextMode => {
      mode = nextMode;
      error.textContent = '';
      tradeFields.hidden = mode === 'edit';
      form.querySelectorAll('[data-holding-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.holdingMode === mode);
      });
      const isReduce = mode === 'reduce';
      form.querySelector('[data-trade-amount-label]').textContent = isReduce ? '卖出金额' : '买入金额';
      form.querySelector('[data-trade-fee-label]').textContent = isReduce ? '卖出费率' : '买入费率';
      form.querySelector('[data-trade-time-label]').textContent = isReduce ? '卖出时间' : '买入时间';
    };

    form.querySelectorAll('[data-holding-mode]').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.holdingMode));
    });

    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-holding-cancel]')) close();
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const amountInput = form.querySelector('[name="holding-amount"]');
      const profitInput = form.querySelector('[name="holding-profit"]');
      const tradeAmountInput = form.querySelector('[name="trade-amount"]');
      const feeInput = form.querySelector('[name="trade-fee"]');
      const timeInput = form.querySelector('[name="trade-time"]');
      let nextAmount = Number(amountInput.value);
      let nextProfit = Number(profitInput.value);

      if (!Number.isFinite(nextAmount) || nextAmount < 0 || !Number.isFinite(nextProfit)) {
        error.textContent = '请填写有效的持有金额和持有收益。';
        return;
      }

      if (mode !== 'edit') {
        const tradeAmount = Number(tradeAmountInput.value);
        const feeRate = Number(feeInput.value);
        if (!Number.isFinite(tradeAmount) || tradeAmount <= 0 || !Number.isFinite(feeRate) || feeRate < 0) {
          error.textContent = '请填写有效的交易金额和费率。';
          return;
        }
        const fee = tradeAmount * feeRate / 100;
        if (mode === 'add') {
          nextAmount += tradeAmount;
          nextProfit -= fee;
        } else {
          if (tradeAmount + fee > nextAmount) {
            error.textContent = '卖出金额及费率不能超过当前持有金额。';
            return;
          }
          const remainingRatio = nextAmount === 0 ? 0 : (nextAmount - tradeAmount) / nextAmount;
          nextAmount -= tradeAmount;
          nextProfit = nextProfit * remainingRatio - fee;
        }
        fund.transactions = Array.isArray(fund.transactions) ? fund.transactions : [];
        fund.transactionVersion = 2;
        fund.transactions.unshift({
          type: mode === 'add' ? 'buy' : 'sell',
          amount: tradeAmount,
          fee,
          date: transactionDateLabel(timeInput.value)
        });
      }

      normalizeHolding(fund, nextAmount, nextProfit);
      window.savePortfolioState?.();
      refreshDrawerHoldingMetrics(drawerBackdrop, fund);
      const transactionContent = drawerBackdrop.querySelector('.detail-transaction-content');
      if (transactionContent) transactionContent.innerHTML = transactionsMarkup(fund);
      close();
    });
  }

  function renderDrawer(fund) {
    const holdingRate = Number.isFinite(fund.holdingRate) ? fund.holdingRate : Number(fund.hold) || 0;
    const holdingProfit = Number.isFinite(fund.holdingProfit)
      ? fund.holdingProfit
      : fund.amount * holdingRate;
    const initialToday = resolveTodayData(fund);
    const todayProfit = initialToday.profit;

    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop real-detail-drawer';
    backdrop.innerHTML = `
      <aside class="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="real-detail-title">
        <button class="drawer-close" aria-label="关闭详情">×</button>
        <div class="drawer-scroll">
          <p class="eyebrow detail-api-type">${escapeHtml(fund.category || '基金')} · 基金详情</p>
          <div class="detail-title-row">
            <h2 id="real-detail-title">${escapeHtml(fund.name)}</h2>
            <button type="button" class="detail-edit-holding" data-edit-holding>修改持仓</button>
          </div>
          <p class="detail-code">${escapeHtml(fund.code)}</p>

          <div class="detail-values">
            <div><span>当前金额</span><b>${money(fund.amount)}</b></div>
            <div><span>今日收益</span><b class="${Number.isFinite(todayProfit) ? tone(todayProfit) : ''}">${Number.isFinite(todayProfit) ? money(todayProfit) : '待估值'}</b></div>
            <div><span>持有收益</span><b class="${tone(holdingProfit)}">${money(holdingProfit)}</b></div>
            <div><span>持有收益率</span><b class="${tone(holdingRate)}">${percent(holdingRate)}</b></div>
          </div>

          <div class="detail-section">
            <div class="detail-section-head">
              <div><p class="eyebrow">历史净值</p><h3 class="detail-history-title">近1年走势</h3></div>
              <span class="detail-api-state">正在读取真实数据…</span>
            </div>
            <div class="detail-history-content"><div class="detail-loading" aria-label="加载历史净值"></div></div>
            <div class="detail-range-tabs" role="tablist" aria-label="净值周期">
              ${historyRanges.map(range => `
                <button class="detail-range-button${range.key === '1y' ? ' active' : ''}"
                  type="button" role="tab" aria-selected="${range.key === '1y'}"
                  data-range="${range.key}">${range.label}</button>
              `).join('')}
            </div>
          </div>

          <div class="detail-section detail-record-section">
            <div class="detail-record-tabs" role="tablist" aria-label="历史数据类型">
              <button class="detail-record-tab active" type="button" role="tab"
                aria-selected="true" data-record="performance">历史业绩</button>
              <button class="detail-record-tab" type="button" role="tab"
                aria-selected="false" data-record="nav">历史净值</button>
            </div>
            <div class="detail-record-content">
              <div class="detail-loading detail-loading-short" aria-label="加载历史业绩"></div>
            </div>
          </div>

          <div class="detail-section">
            <p class="eyebrow">前十大持仓</p>
            <h3>主要持仓</h3>
            <div class="detail-holdings-content">${holdingsMarkup(fund)}</div>
          </div>

          <div class="detail-section">
            <p class="eyebrow">交易记录</p>
            <h3>最近操作</h3>
            <div class="detail-transaction-content">${transactionsMarkup(fund)}</div>
          </div>
        </div>
      </aside>`;

    document.body.appendChild(backdrop);
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => backdrop.classList.add('visible'));

    const close = () => {
      backdrop.classList.remove('visible');
      document.body.classList.remove('drawer-open');
      setTimeout(() => backdrop.remove(), 180);
    };
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop || event.target.closest('.drawer-close')) close();
    });
    backdrop.querySelector('[data-edit-holding]')?.addEventListener('click', () => {
      openHoldingEditor(fund, backdrop);
    });
    document.addEventListener('keydown', function onEscape(event) {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onEscape);
        close();
      }
    });

    loadRealData(fund, backdrop);
  }

  async function requestFund(code) {
    let response = await fetch(`${apiBase}/api/fund/${code}?refresh=1`);
    if (response.status === 404) {
      const imported = await fetch(`${apiBase}/api/fund/import/${code}`);
      if (!imported.ok) throw new Error('基金导入失败');
      response = await fetch(`${apiBase}/api/fund/${code}?refresh=1`);
    }
    if (!response.ok) throw new Error('基金数据读取失败');
    return response.json();
  }

  async function loadRealData(fund, backdrop) {
    const state = backdrop.querySelector('.detail-api-state');
    const historyContent = backdrop.querySelector('.detail-history-content');
    try {
      const payload = await requestFund(fund.code);
      if (!backdrop.isConnected) return;
      const history = payload.history || [];
      setupHistoryExplorer(backdrop, history);
      state.textContent = payload.data_status?.history === 'normal'
        ? '✓ 数据正常'
        : '⚠ 等待数据源';

      if (payload.fund?.fund_name) {
        backdrop.querySelector('#real-detail-title').textContent = payload.fund.fund_name;
      }
      const typeParts = [payload.fund?.fund_type, payload.fund?.company].filter(Boolean);
      if (typeParts.length) {
        backdrop.querySelector('.detail-api-type').textContent = `${typeParts.join(' · ')} · 基金详情`;
      }
      backdrop.querySelector('.detail-holdings-content').innerHTML = holdingsMarkup({
        holdings: payload.holdings
      });

      const today = resolveTodayData(fund, payload);
      const metricCells = backdrop.querySelectorAll('.detail-values > div');
      const todayProfitCell = metricCells[1];
      if (Number.isFinite(today.change) && Number.isFinite(today.profit)) {
        fund.today = today.change;
        fund.todayEstimate = today.profit;
        if (today.official) fund.navUpdatedAt = today.navDate;
        todayProfitCell.querySelector('b').className = tone(today.profit);
        todayProfitCell.querySelector('b').textContent = money(today.profit);
      } else {
        todayProfitCell.querySelector('b').className = '';
        todayProfitCell.querySelector('b').textContent = '待估值';
      }
    } catch {
      if (!backdrop.isConnected) return;
      historyContent.innerHTML = `
        <div class="detail-empty detail-error">
          暂未同步到历史净值。东方财富数据源当前不可访问，恢复后再次打开即可自动补齐。
        </div>`;
      state.textContent = '等待数据源';
    }
  }

  document.addEventListener('click', event => {
    const row = event.target.closest('.fund-row[data-code]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const fund = getFund(row.dataset.code);
    if (fund) renderDrawer(fund);
  }, true);
})();
