(function () {
  const getApiBase = () => window.FUND_API_BASE || '';
  const root = document.querySelector('#view-root');
  if (!root || !window.portfolioState) return;
  const detailApiFundCache = {};

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
    return `${prefix}${Math.abs(number).toLocaleString('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })}`;
  };

  const percent = value => {
    const number = Number(value) || 0;
    // P2 统一：百分比最多 2 位小数、不强制补 0
    return `${number > 0 ? '+' : ''}${String(Number((number * 100).toFixed(2)))}%`;
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
    // 与持仓列表保持同一数据源：列表已刷新的今日估值（fund.today）优先，
    // 抽屉与列表显示完全相同的“今日收益”，避免出现昨天的净值。
    const localChange = Number(fund.today);
    if (Number.isFinite(localChange)) {
      const localProfit = Number(fund.todayEstimate);
      return {
        official: Boolean(fund.navUpdatedAt && fund.navUpdatedAt === shanghaiDate()),
        navDate: fund.navUpdatedAt || null,
        change: localChange,
        profit: Number.isFinite(localProfit) ? localProfit : fund.amount * localChange
      };
    }

    const history = payload.history || [];
    const navDate = payload.latest_nav?.date || payload.fund?.latest_nav?.date || payload.estimate?.nav_date || null;
    let officialChange = navDate ? officialNavChange(history, navDate) : null;
    if (!Number.isFinite(officialChange) && navDate && payload.latest_nav?.date === navDate && Number.isFinite(Number(payload.latest_nav?.changePercent))) {
      officialChange = Number(payload.latest_nav.changePercent);
    }
    if (!Number.isFinite(officialChange) && navDate && payload.estimate?.nav_date === navDate && Number.isFinite(Number(payload.estimate?.estimate_change))) {
      officialChange = Number(payload.estimate.estimate_change);
    }
    if (navDate && navDate === shanghaiDate() && Number.isFinite(officialChange)) {
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

  function fundCostPrice(fund, latestNav) {
    // 优先使用数据源提供的单位成本（costNav），避免“市值-收益”反推在口径不一致时失真
    if (fund && Number.isFinite(Number(fund.costNav)) && Number(fund.costNav) > 0) {
      return Number(fund.costNav);
    }
    const amount = Number(fund?.amount) || 0;
    const profit = Number(fund?.holdingProfit ?? fund?.profit) || 0;
    if (amount <= 0 || !Number.isFinite(latestNav) || latestNav <= 0) return null;
    const price = latestNav * (1 - profit / amount);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function chartTransactions(fund, history) {
    if (!Array.isArray(fund?.transactions) || !Array.isArray(history) || history.length < 2) return [];
    return fund.transactions.map(t => {
      const legacy = Array.isArray(t);
      const type = legacy
        ? (String(t[1] || '').includes('减') ? 'sell' : 'buy')
        : (t && t.type === 'sell' ? 'sell' : 'buy');
      const date = legacy ? String(t[0] || '') : String(t?.date || '');
      const amount = legacy ? t[2] : t?.amount;
      const day = date.slice(0, 10);
      const index = history.findIndex(h => String(h.date).slice(0, 10) === day);
      if (index === -1) return null;
      return { type, date, amount, index };
    }).filter(Boolean);
  }

  function chartMarkup(history, rangeLabel = '近1年', fund) {
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

    // 成本虚线：按持有成本价在走势图上绘制水平虚线
    const costPrice = fundCostPrice(fund, Number(last.nav));
    let costLine = '';
    let costTopPct = 0;
    let costHint = '';
    if (costPrice != null) {
      const rawCostY = padding + ((maximum - costPrice) / range) * (height - padding * 2);
      // 成本价超出当前走势区间时，将虚线钳制在图表可视区内，避免“跑出曲线图”
      const costY = Math.max(padding, Math.min(height - padding, rawCostY));
      costTopPct = Math.min(92, Math.max(8, ((costY - padding) / (height - padding * 2)) * 100));
      if (costPrice > maximum) costHint = '（高于当前区间）';
      else if (costPrice < minimum) costHint = '（低于当前区间）';
      costLine = `
        <line x1="${padding}" y1="${costY.toFixed(2)}" x2="${width - padding}" y2="${costY.toFixed(2)}"
          stroke="#0071e3" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.8"
          vector-effect="non-scaling-stroke"></line>`;
    }

    // 买入/卖出交易点
    const txns = chartTransactions(fund, history);
    const txnMarkers = txns.map(t => {
      const nav = Number(history[t.index].nav);
      const x = padding + (t.index / (history.length - 1)) * (width - padding * 2);
      const y = padding + ((maximum - nav) / range) * (height - padding * 2);
      const color = t.type === 'buy' ? '#ff3b30' : '#ff9500';
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke"></circle>`;
    }).join('');

    const legendItems = [];
    if (costPrice != null) legendItems.push('<span><i class="legend-dash"></i>成本线</span>');
    if (txns.some(t => t.type === 'buy')) legendItems.push('<span><i class="legend-buy"></i>买入</span>');
    if (txns.some(t => t.type === 'sell')) legendItems.push('<span><i class="legend-sell"></i>卖出</span>');
    const legend = legendItems.length ? `<div class="detail-chart-legend">${legendItems.join('')}</div>` : '';

    return `
      <div class="detail-chart" style="position: relative;" aria-label="${escapeHtml(rangeLabel)}历史净值曲线">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
          <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.5"
            vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"></polyline>
          ${costLine}
          ${txnMarkers}
        </svg>
        ${costPrice != null ? `<div class="detail-chart-cost-label" style="top: ${costTopPct.toFixed(2)}%;">成本 ${costPrice.toFixed(4)}${costHint}</div>` : ''}
      </div>
      <div class="detail-chart-meta">
        <span>${escapeHtml(first.date)}</span>
        <b class="${tone(change)}">${percent(change)}</b>
        <span>${escapeHtml(last.date)}</span>
      </div>
      ${legend}`;
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

  function attachChartInteractiveEvents(container, history, pointsArray, width, height, padding, minimum, maximum, range) {
    const svg = container.querySelector('svg');
    if (!svg) return;

    // Create line, dot, and tooltip dynamically
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('y1', '0');
    line.setAttribute('y2', String(height));
    line.setAttribute('stroke', '#0071e3');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '3,3');
    line.style.display = 'none';
    svg.appendChild(line);

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '4.5');
    dot.setAttribute('fill', '#0071e3');
    dot.setAttribute('stroke', '#ffffff');
    dot.setAttribute('stroke-width', '1.5');
    dot.style.display = 'none';
    svg.appendChild(dot);

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-interactive-tooltip';
    tooltip.style.cssText = `
      display: none;
      position: absolute;
      pointer-events: none;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 11px;
      color: #1d1d1f;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      z-index: 10;
      white-space: nowrap;
      transform: translate(-50%, -100%);
      font-family: inherit;
      font-variant-numeric: tabular-nums;
      top: 0;
      left: 0;
    `;
    container.style.position = 'relative';
    container.appendChild(tooltip);

    const firstNav = Number(history[0]?.nav) || 1;

    const onMove = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const xInSvg = clientX - rect.left;
      const pct = Math.max(0, Math.min(1, xInSvg / rect.width));
      
      const index = Math.round(pct * (history.length - 1));
      const point = history[index];
      if (!point) return;

      const navVal = Number(point.nav);
      const accNavVal = Number(point.acc_nav ?? point.nav);
      const chgFromStart = ((navVal - firstNav) / firstNav) * 100;

      // Map back to SVG coordinates
      const svgX = padding + (index / (history.length - 1)) * (width - padding * 2);
      const svgY = padding + ((maximum - navVal) / range) * (height - padding * 2);

      line.setAttribute('x1', String(svgX));
      line.setAttribute('x2', String(svgX));
      line.style.display = '';

      dot.setAttribute('cx', String(svgX));
      dot.setAttribute('cy', String(svgY));
      dot.style.display = '';

      // Calculate container coordinate for tooltip
      const tooltipX = (svgX / width) * rect.width;
      const tooltipY = (svgY / height) * rect.height - 8;

      tooltip.style.left = `${tooltipX}px`;
      tooltip.style.top = `${tooltipY}px`;
      tooltip.style.display = '';
      tooltip.innerHTML = `
        <div style="font-weight: 600; color: #86868b; margin-bottom: 2px;">${point.date}</div>
        <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 2px;">
          <span style="color: #86868b;">单位净值:</span>
          <b style="font-weight: 600; color: #1d1d1f;">${navVal.toFixed(4)}</b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 2px;">
          <span style="color: #86868b;">累计净值:</span>
          <b style="color: #6e6e73; font-weight: 500;">${accNavVal.toFixed(4)}</b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px;">
          <span style="color: #86868b;">较期初:</span>
          <b style="font-weight: 650; ${chgFromStart >= 0 ? 'color: #ff3b30 !important;' : 'color: #34a853 !important;'}">${chgFromStart >= 0 ? '+' : ''}${chgFromStart.toFixed(2)}%</b>
        </div>
      `;
    };

    const onLeave = () => {
      line.style.display = 'none';
      dot.style.display = 'none';
      tooltip.style.display = 'none';
    };

    container.addEventListener('mousemove', (e) => onMove(e.clientX));
    container.addEventListener('mouseleave', onLeave);
    container.addEventListener('touchmove', (e) => {
      if (e.touches[0]) {
        onMove(e.touches[0].clientX);
      }
    }, { passive: true });
    container.addEventListener('touchend', onLeave);
  }

  function intradayChartMarkup(fundCode) {
    const timestamp = Date.now();
    const imageUrl = `https://j4.dfcfw.com/charts/pic6/${fundCode}.png?v=${timestamp}`;
    
    return `
      <div class="detail-intraday-container" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 12px 0;">
        <div style="position: relative; width: 100%; max-width: 520px; aspect-ratio: 520/180; border-radius: 12px; overflow: hidden; background: #fff; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.02);">
          <img src="${imageUrl}" alt="今日分时估值走势" style="width: 100%; height: 100%; object-fit: fill; display: block;" onerror="this.onerror=null; this.parentElement.innerHTML='<div style=\\'display:grid;place-items:center;height:100%;color:#86868b;font-size:12px;\\'>实时估值走势图暂不可用</div>';" />
        </div>
        <div class="detail-chart-meta" style="width: 100%; margin-top: 10px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; color: #86868b; font-size: 11px;">
          <span>交易日 09:30</span>
          <b style="color: #0071e3; font-weight: 500;">实时估值走势 (每分钟更新)</b>
          <span style="text-align: right;">15:00</span>
        </div>
      </div>
    `;
  }

  async function loadStockRealtimeDetails(holdings, backdrop) {
    if (!Array.isArray(holdings) || !holdings.length) return;
    const items = [...backdrop.querySelectorAll('.holding-list > div')];
    
    await Promise.allSettled(holdings.map(async (item, index) => {
      const stockCode = item.stock_code ?? item[0];
      if (!stockCode) return;
      try {
        const response = await fetch(`${getApiBase()}/api/stock/${stockCode}`);
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.success && data.quote) {
          const changePercent = Number(data.quote.change_percent);
          if (Number.isFinite(changePercent)) {
            const node = items[index];
            if (!node) return;
            const pctText = (changePercent * 100).toFixed(2);
            const isPos = changePercent > 0;
            const isNeg = changePercent < 0;
            const sign = isPos ? '+' : '';
            
            const badgeSpan = document.createElement('span');
            badgeSpan.className = `holding-stock-change ${isPos ? 'positive' : isNeg ? 'negative' : ''}`;
            badgeSpan.style.cssText = `
              display: inline-block;
              font-size: 11px;
              font-weight: 650;
              margin-left: 8px;
              padding: 1px 5px;
              border-radius: 4px;
              background: ${isPos ? 'rgba(255, 59, 48, 0.08)' : isNeg ? 'rgba(52, 168, 83, 0.08)' : 'rgba(0,0,0,0.05)'};
              color: ${isPos ? '#ff3b30 !important' : isNeg ? '#34a853 !important' : '#86868b'};
              font-variant-numeric: tabular-nums;
            `;
            badgeSpan.textContent = `${sign}${pctText}%`;
            
            const labelNode = node.querySelector('span');
            if (labelNode) {
              labelNode.appendChild(badgeSpan);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to load quote for stock', stockCode, err);
      }
    }));
  }

  function setupHistoryExplorer(backdrop, history, fund) {
    const chartContent = backdrop.querySelector('.detail-history-content');
    const chartTitle = backdrop.querySelector('.detail-history-title');
    const rangeButtons = [...backdrop.querySelectorAll('.detail-range-button')];
    const recordButtons = [...backdrop.querySelectorAll('.detail-record-tab')];
    const recordContent = backdrop.querySelector('.detail-record-content');

    const renderRange = button => {
      activateButton(rangeButtons, button);
      if (button.dataset.range === 'today') {
        chartTitle.textContent = `今日实时估值`;
        chartContent.classList.remove('content-enter');
        chartContent.innerHTML = intradayChartMarkup(fund.code);
        requestAnimationFrame(() => chartContent.classList.add('content-enter'));
        return;
      }
      const range = historyRanges.find(item => item.key === button.dataset.range) || historyRanges[3];
      chartTitle.textContent = `${range.label}走势`;
      chartContent.classList.remove('content-enter');
      
      const periodHistory = historyForRange(history, range.key);
      chartContent.innerHTML = chartMarkup(periodHistory, range.label, fund);
      if (periodHistory.length >= 2) {
        requestAnimationFrame(() => {
          chartContent.classList.add('content-enter');
          const values = periodHistory.map(item => Number(item.nav)).filter(Number.isFinite);
          const minimum = Math.min(...values);
          const maximum = Math.max(...values);
          const diff = maximum - minimum || 1;
          attachChartInteractiveEvents(chartContent, periodHistory, values, 520, 180, 10, minimum, maximum, diff);
        });
      } else {
        requestAnimationFrame(() => chartContent.classList.add('content-enter'));
      }
    };

    const renderRecord = button => {
      activateButton(recordButtons, button);
      recordContent.classList.remove('content-enter');
      // P2：四 Tab 统一渲染（历史净值｜历史业绩｜前十大持仓｜交易记录）
      const record = button.dataset.record;
      let markup;
      if (record === 'nav') markup = navHistoryMarkup(history);
      else if (record === 'performance') markup = performanceMarkup(history);
      else if (record === 'holdings') markup = holdingsMarkup(fund);
      else markup = transactionsMarkup(fund);
      recordContent.innerHTML = markup;
      requestAnimationFrame(() => recordContent.classList.add('content-enter'));
    };

    rangeButtons.forEach(button => button.addEventListener('click', () => renderRange(button)));
    recordButtons.forEach(button => button.addEventListener('click', () => renderRecord(button)));
    // 供外部（startLoad 更新 holdings/transactions 后）重渲染当前激活 Tab
    backdrop._renderActiveRecord = () => {
      const active = recordButtons.find(button => button.classList.contains('active'));
      if (active) renderRecord(active);
    };
    renderRange(rangeButtons.find(button => button.dataset.range === '1y') || rangeButtons[0]);
    renderRecord(recordButtons.find(button => button.dataset.record === 'nav') || recordButtons[0]);
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
      const investTag = (!legacy && item?.invest) ? '<span style="display:inline-block;background:#0071e3;color:#fff;border-radius:4px;font-size:10px;line-height:1;padding:2px 4px;margin-left:4px;vertical-align:middle;font-weight:600;">定</span>' : '';
      const amount = legacy
        ? item[2]
        : `${isSell ? '−' : '+'}${money(Math.abs(Number(item?.amount) || 0))}`;
      return `
      <div><span>${escapeHtml(date || '')}</span><b>${escapeHtml(label || '')}${investTag}</b><em>${escapeHtml(amount || '')}</em></div>
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

  function updateAutoInvestBanner(backdrop, fund) {
    // P2：定投计划 banner 位于 record tabs（历史净值）上方
    let banner = backdrop.querySelector('.auto-invest-banner');
    if (fund.autoInvest && fund.autoInvest.enabled) {
      if (!banner) {
        banner = document.createElement('div');
        banner.className = 'auto-invest-banner';
        const recordSection = backdrop.querySelector('.detail-record-section');
        if (recordSection) {
          recordSection.parentNode.insertBefore(banner, recordSection);
        } else {
          backdrop.querySelector('.drawer-scroll').appendChild(banner);
        }
      }
      banner.textContent = `定投计划：每${fund.autoInvest.frequency === 'daily' ? '日' : fund.autoInvest.frequency === 'weekly' ? '周' : '月'} ${money(fund.autoInvest.amount)}，下次 ${fund.autoInvest.nextDate || '—'}`;
    } else if (banner) {
      banner.remove();
    }
  }

  // P2：校准结果渲染（与小程序共用同一套校准数据/算法，字段同 estimateEngine 返回）
  function renderCalibration(backdrop, payload) {
    const box = backdrop.querySelector('.detail-calibration-result');
    if (!box) return;
    const cal = payload?.estimate?.calibration || null;
    if (!cal) {
      box.hidden = true;
      return;
    }
    const weights = payload?.estimate?.weights || null;
    const cash = payload?.estimate?.cash_adjustment;
    const metrics = [
      cal.sample_size != null ? `样本 ${Number(cal.sample_size)} 日` : '',
      cal.direction_accuracy != null ? `方向准确率 ${(Number(cal.direction_accuracy) * 100).toFixed(0)}%` : '',
      cal.mae != null ? `MAE ${(Number(cal.mae) * 100).toFixed(3)}%` : '',
      cal.rmse != null ? `RMSE ${(Number(cal.rmse) * 100).toFixed(3)}%` : '',
      weights ? `权重 ${Math.round(Number(weights.holdings) * 100)}/${Math.round(Number(weights.sector) * 100)}` : '',
      cash != null ? `现金 ${(Number(cash) * 100).toFixed(1)}%` : ''
    ].filter(Boolean);
    box.hidden = false;
    const statusNode = box.querySelector('.detail-calibration-status');
    if (statusNode) {
      statusNode.textContent = cal.calibrated ? '已校准' : '样本不足';
      statusNode.className = 'detail-calibration-status ' + (cal.calibrated ? 'ok' : 'warn');
    }
    const metricNodes = box.querySelectorAll('.detail-calibration-metric');
    metricNodes.forEach((node, index) => {
      node.textContent = metrics[index] || '';
      node.hidden = !metrics[index];
    });
  }

  // P2：手动触发校准（强制重算，与小程序 onCalibrate 同接口 recalibrate=1）
  async function triggerCalibration(fund, backdrop) {
    const btn = backdrop.querySelector('[data-calibrate]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '校准中';
    try {
      const response = await fetch(`${getApiBase()}/api/fund/${encodeURIComponent(fund.code)}/calibration?recalibrate=1`);
      if (!response.ok) throw new Error('calibration request failed');
      const payload = await response.json();
      if (payload && payload.calibration) {
        // calibration 接口返回 { success, calibration }：包装为 estimate 结构供 renderCalibration 消费
        const cal = payload.calibration;
        renderCalibration(backdrop, {
          estimate: {
            calibration: cal,
            weights: (cal.holdings_weight != null || cal.sector_weight != null)
              ? { holdings: cal.holdings_weight, sector: cal.sector_weight }
              : null,
            cash_adjustment: cal.cash_adjustment
          }
        });
        const calibrated = Boolean(cal.calibrated);
        if (typeof window.showToast === 'function') {
          window.showToast(calibrated ? '校准完成' : '样本不足，暂无法校准', calibrated ? 'success' : '');
        }
        // 校准后强制刷新估值，使今日估值使用新权重
        startLoad(fund, backdrop, { forceRefresh: true });
      }
    } catch (err) {
      if (typeof window.showToast === 'function') window.showToast('校准失败', '');
    } finally {
      btn.disabled = false;
      btn.textContent = '校准';
    }
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
      '<div class="holding-summary">',
      '<div><span>当前持有金额</span><b>' + money(amount) + '</b></div>',
      '<div><span>当前持有收益</span><b class="' + tone(profit) + '">' + money(profit) + '</b></div>',
      '</div>',
      '<div class="holding-edit-grid">',
      '<label>持有金额<input name="holding-amount" type="number" min="0" step="0.01" value="' + amount.toFixed(2) + '"></label>',
      '<label>持有收益<input name="holding-profit" type="number" step="0.01" value="' + profit.toFixed(2) + '"></label>',
      '</div>',
      '<div class="holding-action-switch" role="group" aria-label="持仓操作">',
      '<button type="button" class="active" data-holding-mode="edit">修改</button>',
      '<button type="button" data-holding-mode="add">加仓</button>',
      '<button type="button" data-holding-mode="reduce">减仓</button>',
      '<button type="button" data-holding-mode="invest">定投</button>',
      '<button type="button" data-holding-mode="liquidate">清仓</button>',
      '</div>',
      '<div class="holding-trade-fields" hidden>',
      '<div class="holding-quick-ratios" style="display:flex;align-items:center;gap:6px;margin:12px 0;flex-wrap:wrap;">',
      '<button type="button" data-quick-ratio="0.25" style="background:#f5f5f7;color:#0071e3;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">1/4</button>',
      '<button type="button" data-quick-ratio="0.3333333333333333" style="background:#f5f5f7;color:#0071e3;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">1/3</button>',
      '<button type="button" data-quick-ratio="0.5" style="background:#f5f5f7;color:#0071e3;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">1/2</button>',
      '<button type="button" data-quick-ratio="1" style="background:#f5f5f7;color:#0071e3;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">全部</button>',
      '</div>',
      '<div class="holding-edit-grid">',
      '<label><span data-trade-amount-label>买入金额</span><input name="trade-amount" type="number" min="0.01" step="0.01" value=""></label>',
      '<label><span data-trade-fee-label>买入费率</span><input name="trade-fee" type="number" min="0" step="0.0001" value="0"></label>',
      '<label><span data-trade-time-label>买入时间</span><input name="trade-time" type="datetime-local" value="' + localDateTimeInputValue() + '"></label>',
      '</div>',
      '</div>',
      '<div class="holding-invest-fields" hidden>',
      '<div class="holding-edit-grid">',
      '<label>每期定投金额<input name="invest-amount" type="number" min="0.01" step="0.01" value=""></label>',
      '<label>定投周期<select name="invest-frequency" style="width:100%;padding:10px 12px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;background:#f5f5f7;font:inherit;margin-top:8px;color:#1d1d1f;"><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly" selected>每月</option></select></label>',
      '</div>',
      '<label>定投开始时间<input name="invest-date" type="datetime-local" value="' + localDateTimeInputValue() + '"></label>',
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
    const investFields = form.querySelector('.holding-invest-fields');
    const quickRow = form.querySelector('.holding-quick-ratios');
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
      tradeFields.hidden = mode === 'edit' || mode === 'invest';
      investFields.hidden = mode !== 'invest';
      if (quickRow) quickRow.hidden = mode === 'edit' || mode === 'invest' || mode === 'liquidate';
      form.querySelectorAll('[data-holding-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.holdingMode === mode);
      });
      const isReduce = mode === 'reduce' || mode === 'liquidate';
      form.querySelector('[data-trade-amount-label]').textContent = isReduce ? '卖出金额' : '买入金额';
      form.querySelector('[data-trade-fee-label]').textContent = isReduce ? '卖出费率' : '买入费率';
      form.querySelector('[data-trade-time-label]').textContent = isReduce ? '卖出时间' : '买入时间';
      if (mode === 'liquidate') {
        form.querySelector('[name="trade-amount"]').value = amount.toFixed(2);
        form.querySelector('[name="trade-fee"]').value = '0';
      }
      if (mode === 'invest') {
        form.querySelector('[name="invest-amount"]').value = '';
        form.querySelector('[name="invest-date"]').value = localDateTimeInputValue();
      }
    };

    form.querySelectorAll('[data-holding-mode]').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.holdingMode));
    });

    // 快捷比例：基于当前实际可交易持仓金额，自动计算交易金额（保留手动修改）
    form.querySelectorAll('[data-quick-ratio]').forEach(button => {
      button.addEventListener('click', () => {
        const ratio = Number(button.dataset.quickRatio);
        const base = Number(fund.amount) || 0;
        const value = Math.round(base * ratio * 100) / 100;
        form.querySelector('[name="trade-amount"]').value = value.toFixed(2);
      });
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
        error.textContent = '请填写有效的持有金额 and 持有收益。';
        return;
      }

      if (mode === 'liquidate') {
        const feeRate = Number(feeInput.value);
        if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 100) {
          error.textContent = '请填写有效的卖出费率（0-100）。';
          return;
        }
        const fee = amount * feeRate / 100;
        const date = transactionDateLabel(timeInput.value);
        // 记录卖出流水
        fund.transactions = Array.isArray(fund.transactions) ? fund.transactions : [];
        fund.transactions.unshift({ type: 'sell', amount, fee, date });
        // 记录清仓日志（已清仓列表）
        const account = window.portfolioState.accounts[window.portfolioState.getActive()];
        if (account) {
          account.closedPositions = Array.isArray(account.closedPositions) ? account.closedPositions : [];
          account.closedPositions.unshift({
            name: fund.name,
            code: fund.code,
            closedBefore: date,
            reason: '手动清仓',
            amount,
            profit,
            fee
          });
          const index = account.funds.findIndex(f => f.code === fund.code);
          if (index !== -1) account.funds.splice(index, 1);
        }
        window.savePortfolioState?.();
        close();
        document.body.classList.remove('drawer-open');
        drawerBackdrop.remove();
        if (typeof window.portfolioState.render === 'function') window.portfolioState.render('portfolio');
        if (typeof window.showToast === 'function') window.showToast(`已清仓「${fund.name}」，并从列表移除`, 'success');
        return;
      }

      if (mode === 'invest') {
        const investAmount = Number(form.querySelector('[name="invest-amount"]').value);
        const frequency = form.querySelector('[name="invest-frequency"]').value;
        const investDate = form.querySelector('[name="invest-date"]').value;
        if (!Number.isFinite(investAmount) || investAmount <= 0) {
          error.textContent = '请填写有效的定投金额。';
          return;
        }
        const date = transactionDateLabel(investDate);
        fund.transactions = Array.isArray(fund.transactions) ? fund.transactions : [];
        fund.transactions.unshift({ type: 'buy', amount: investAmount, fee: 0, date, invest: true });
        nextAmount += investAmount;
        // 计算下一次定投日期
        const nextDateBase = investDate ? new Date(investDate) : new Date();
        if (frequency === 'daily') nextDateBase.setDate(nextDateBase.getDate() + 1);
        else if (frequency === 'weekly') nextDateBase.setDate(nextDateBase.getDate() + 7);
        else nextDateBase.setMonth(nextDateBase.getMonth() + 1);
        fund.autoInvest = {
          enabled: true,
          amount: investAmount,
          frequency,
          nextDate: nextDateBase.toISOString().slice(0, 10)
        };
        normalizeHolding(fund, nextAmount, nextProfit);
        window.savePortfolioState?.();
        refreshDrawerHoldingMetrics(drawerBackdrop, fund);
        updateAutoInvestBanner(drawerBackdrop, fund);
        // P2：交易记录并入 record Tab —— 重渲染当前激活 Tab
        if (typeof drawerBackdrop._renderActiveRecord === 'function') {
          drawerBackdrop._renderActiveRecord();
        } else {
          const transactionContent = drawerBackdrop.querySelector('.detail-transaction-content');
          if (transactionContent) transactionContent.innerHTML = transactionsMarkup(fund);
        }
        close();
        if (typeof window.portfolioState?.render === 'function') window.portfolioState.render('portfolio');
        if (typeof window.showToast === 'function') window.showToast('已设置定投并买入本期', 'success');
        return;
      }

      if (mode !== 'edit') {
        const tradeAmount = Number(tradeAmountInput.value);
        const feeRate = Number(feeInput.value);
        if (!Number.isFinite(tradeAmount) || tradeAmount <= 0 || !Number.isFinite(feeRate) || feeRate < 0) {
          error.textContent = '请填写有效的交易金额 and 费率。';
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
      // P2：交易记录并入 record Tab —— 重渲染当前激活 Tab
      if (typeof drawerBackdrop._renderActiveRecord === 'function') {
        drawerBackdrop._renderActiveRecord();
      } else {
        const transactionContent = drawerBackdrop.querySelector('.detail-transaction-content');
        if (transactionContent) transactionContent.innerHTML = transactionsMarkup(fund);
      }
      close();
      if (typeof window.portfolioState?.render === 'function') window.portfolioState.render('portfolio');
    });
  }

  function renderDrawer(fund) {
    document.querySelectorAll('.drawer-backdrop').forEach(el => { if (el._syncController) el._syncController.stop(); el.remove(); });

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
            <!-- P3.18 布局：两行——第1行「历史净值」左 +「✓ 数据源」右；第2行「近1年走势」左 +「校准」右；左左对齐、右右对齐 -->
            <div class="detail-section-head">
              <div class="detail-head-row">
                <p class="eyebrow">历史净值</p>
                <span class="detail-api-state">正在读取真实数据…</span>
              </div>
              <div class="detail-head-row">
                <h3 class="detail-history-title">近1年走势</h3>
                <button type="button" class="detail-calibrate-btn" data-calibrate>校准</button>
              </div>
            </div>
            <!-- P2：校准结果（与小程序共用同一套校准数据/算法；样本数、权重、准确率等关键数据） -->
            <div class="detail-calibration-result" hidden>
              <span class="detail-calibration-status ok">已校准</span>
              <span class="detail-calibration-metric"></span>
              <span class="detail-calibration-metric"></span>
              <span class="detail-calibration-metric"></span>
              <span class="detail-calibration-metric"></span>
              <span class="detail-calibration-metric"></span>
            </div>
            <div class="detail-history-content"><div class="detail-loading" aria-label="加载历史净值"></div></div>
            <div class="detail-range-tabs" role="tablist" aria-label="净值周期">
              <button class="detail-range-button" type="button" role="tab" aria-selected="false" data-range="today">今日估值</button>
              ${historyRanges.map(range => `
                <button class="detail-range-button${range.key === '1y' ? ' active' : ''}"
                  type="button" role="tab" aria-selected="${range.key === '1y'}"
                  data-range="${range.key}">${range.label}</button>
              `).join('')}
            </div>
          </div>

          <!-- P2：定投计划移到历史净值（record tabs）上方 -->
          ${fund.autoInvest && fund.autoInvest.enabled ? `
            <div class="auto-invest-banner">定投计划：每${fund.autoInvest.frequency === 'daily' ? '日' : fund.autoInvest.frequency === 'weekly' ? '周' : '月'} ${money(fund.autoInvest.amount)}，下次 ${fund.autoInvest.nextDate || '—'}</div>
          ` : ''}

          <!-- P2：四 Tab 统一（历史净值｜历史业绩｜前十大持仓｜交易记录）横排 -->
          <div class="detail-section detail-record-section">
            <div class="detail-record-tabs" role="tablist" aria-label="历史数据类型">
              <button class="detail-record-tab active" type="button" role="tab"
                aria-selected="true" data-record="nav">历史净值</button>
              <button class="detail-record-tab" type="button" role="tab"
                aria-selected="false" data-record="performance">历史业绩</button>
              <button class="detail-record-tab" type="button" role="tab"
                aria-selected="false" data-record="holdings">前十大持仓</button>
              <button class="detail-record-tab" type="button" role="tab"
                aria-selected="false" data-record="transactions">交易记录</button>
            </div>
            <div class="detail-record-content">
              <div class="detail-loading detail-loading-short" aria-label="加载历史数据"></div>
            </div>
          </div>
        </div>
      </aside>`;

    document.body.appendChild(backdrop);
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => backdrop.classList.add('visible'));

    const close = () => {
      if (backdrop._syncController) backdrop._syncController.stop();
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
    backdrop.querySelector('[data-calibrate]')?.addEventListener('click', () => {
      triggerCalibration(fund, backdrop);
    });
    document.addEventListener('keydown', function onEscape(event) {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onEscape);
        close();
      }
    });

    startLoad(fund, backdrop);
  }

  // 数据同步数据源（代码已确认，非编造）：server/services/fundService.js 的
  // EASTMONEY_FUND_URL = 'https://fund.eastmoney.com'（天天基金），且服务侧
  // 错误文案直接使用“天天基金”，故此处展示真实数据源名称。
  const FUND_DATA_SOURCE_LABEL = '天天基金';

  // 同步/重试轮询策略：首次打开用 refresh=1&fast=1 触发后台同步；后续轮询仅普通查询，
  // 不再触发数据源请求（避免请求风暴）。递增退避 + 次数/总等待上限，避免无限后台任务与请求风暴。
  const SYNC_POLL_DELAYS = [1500, 2000, 3000, 5000, 8000, 10000, 10000, 10000];
  const SYNC_MAX_ATTEMPTS = 40;
  const SYNC_MAX_WAIT_MS = 180000;

  async function fetchFundPayload(code, refresh) {
    let response = await fetch(`${getApiBase()}/api/fund/${code}${refresh ? '?refresh=1&fast=1' : ''}`);
    if (response.status === 404) {
      const imported = await fetch(`${getApiBase()}/api/fund/import/${code}`);
      if (!imported.ok) throw new Error('基金导入失败');
      response = await fetch(`${getApiBase()}/api/fund/${code}?refresh=1`);
    }
    if (!response.ok) throw new Error('基金数据读取失败');
    return response.json();
  }

  // 绑定/重建一个同步控制器到抽屉：先停掉旧的，避免切换基金或重开时残留轮询。
  function attachController(backdrop) {
    if (backdrop._syncController) backdrop._syncController.stop();
    const ctl = {
      stopped: false, pollTimer: null, waitTimer: null, attempt: 0,
      waitStart: 0, status: 'IDLE', waitNode: null
    };
    ctl.stop = function () {
      ctl.stopped = true;
      if (ctl.pollTimer) { clearTimeout(ctl.pollTimer); ctl.pollTimer = null; }
      if (ctl.waitTimer) { clearInterval(ctl.waitTimer); ctl.waitTimer = null; }
    };
    backdrop._syncController = ctl;
    return ctl;
  }

  // SYNCING：阶段进度（仅展示后端可确认的真实状态）+ 不确定进度条（不伪造百分比）+ 真实等待秒数。
  function renderSyncPanel(backdrop, waitSeconds, label) {
    const historyContent = backdrop.querySelector('.detail-history-content');
    if (!historyContent) return;
    historyContent.innerHTML = `
      <div class="detail-sync-panel" role="status" aria-live="polite">
        <div class="detail-sync-title">正在同步历史净值…</div>
        <div class="detail-sync-bar" aria-hidden="true"><span class="detail-sync-bar-fill"></span></div>
        <ul class="detail-sync-stages">
          <li class="done">✓ 已发起数据同步</li>
          <li class="active">● 正在获取历史净值</li>
          <li class="pending">○ 数据准备完成</li>
        </ul>
        <div class="detail-sync-meta">
          <span>数据源：${escapeHtml(FUND_DATA_SOURCE_LABEL)}</span>
          <span class="detail-sync-wait">已等待 ${waitSeconds} 秒</span>
        </div>
        <div class="detail-sync-status">${escapeHtml(label || '数据准备完成后自动显示')}</div>
        <div class="detail-sync-hint">数据准备完成后自动显示</div>
      </div>`;
  }

  // RETRYING：数据源本次访问失败，但尚不能证明基金永久无数据 → 自动重试，不显示“暂无”。
  function renderRetryPanel(backdrop, attempt, waitSeconds, message) {
    const historyContent = backdrop.querySelector('.detail-history-content');
    if (!historyContent) return;
    historyContent.innerHTML = `
      <div class="detail-sync-panel" role="status" aria-live="polite">
        <div class="detail-sync-title">数据源暂时不可用</div>
        <div class="detail-sync-bar" aria-hidden="true"><span class="detail-sync-bar-fill"></span></div>
        <ul class="detail-sync-stages">
          <li class="done">✓ 已发起数据同步</li>
          <li class="active">● 正在自动重试</li>
          <li class="pending">○ 数据准备完成</li>
        </ul>
        <div class="detail-sync-meta">
          <span>数据源：${escapeHtml(FUND_DATA_SOURCE_LABEL)}</span>
          <span class="detail-sync-wait">第 ${attempt} 次尝试 · 已等待 ${waitSeconds} 秒</span>
        </div>
        <div class="detail-sync-status">正在自动重试，数据恢复后自动显示</div>
        <div class="detail-sync-hint">数据源暂时不可用，正在自动重试…</div>
      </div>`;
  }

  // FAILED：连续重试/超时达到安全上限 —— 明确区别于 EMPTY（失败≠无数据）：
  // 显示“数据获取较慢”，绝不显示“暂无历史净值数据”，保留“继续获取”按钮重新启动 180s 周期。
  function renderFailedPanel(backdrop, fund, message) {
    const historyContent = backdrop.querySelector('.detail-history-content');
    if (!historyContent) return;
    historyContent.innerHTML = `
      <div class="detail-sync-panel" role="status" aria-live="polite">
        <div class="detail-sync-title">数据获取较慢</div>
        <div class="detail-sync-bar" aria-hidden="true"><span class="detail-sync-bar-fill"></span></div>
        <div class="detail-sync-meta">
          <span>数据源：${escapeHtml(FUND_DATA_SOURCE_LABEL)}</span>
        </div>
        <div class="detail-sync-status">已自动尝试获取 3 分钟，当前仍未获得历史净值。系统不会把它判断为“基金没有历史数据”。${escapeHtml(message ? '（' + message + '）' : '')}</div>
        <button type="button" class="detail-sync-retry" data-sync-refresh>继续获取</button>
      </div>`;
    historyContent.querySelector('[data-sync-refresh]')?.addEventListener('click', () => {
      startLoad(fund, backdrop, { forceRefresh: true });
    });
  }

  // 与历史净值无关的基础信息（名称/类型/持仓/今日估值）立即生效，
  // 保证“历史净值未就绪”不会拖垮整个详情页（模块独立加载）。
  function applyMetaSideEffects(fund, backdrop, payload) {
    if (payload.fund?.fund_name) {
      const titleNode = backdrop.querySelector('#real-detail-title');
      if (titleNode) titleNode.textContent = payload.fund.fund_name;
    }
    const typeParts = [payload.fund?.fund_type, payload.fund?.company].filter(Boolean);
    if (typeParts.length) {
      const typeNode = backdrop.querySelector('.detail-api-type');
      if (typeNode) typeNode.textContent = `${typeParts.join(' · ')} · 基金详情`;
    }
    // P2：前十大持仓并入 record Tab —— 数据写回 fund.holdings，激活「前十大持仓」Tab 时重渲染
    if (Array.isArray(payload.holdings)) fund.holdings = payload.holdings;
    if (typeof backdrop._renderActiveRecord === 'function') {
      backdrop._renderActiveRecord();
    } else {
      const holdingsContent = backdrop.querySelector('.detail-holdings-content');
      if (holdingsContent) holdingsContent.innerHTML = holdingsMarkup({ holdings: payload.holdings });
    }
    // P2：校准结果（样本数/方向准确率/MAE/RMSE/权重）
    renderCalibration(backdrop, payload);
    // 仅首次加载实时股价，避免每次轮询都打 /api/stock/ 造成请求风暴。
    if (!backdrop._stockLoaded) {
      loadStockRealtimeDetails(payload.holdings, backdrop);
      backdrop._stockLoaded = true;
    }

    const today = resolveTodayData(fund, payload);
    const metricCells = backdrop.querySelectorAll('.detail-values > div');
    const todayProfitCell = metricCells[1];
    if (todayProfitCell) {
      const b = todayProfitCell.querySelector('b');
      if (Number.isFinite(today.change) && Number.isFinite(today.profit)) {
        fund.today = today.change;
        fund.todayEstimate = today.profit;
        if (today.official) fund.navUpdatedAt = today.navDate;
        if (b) { b.className = tone(today.profit); b.textContent = money(today.profit); }
        if (typeof window.refreshListRow === 'function') window.refreshListRow(fund.code);
      } else if (b) {
        b.className = '';
        b.textContent = '待估值';
      }
    }
  }

  function finishSuccess(fund, backdrop, payload, history, ctl) {
    if (ctl) ctl.stop();
    const state = backdrop.querySelector('.detail-api-state');
    if (state) state.textContent = dataSourceStatusText(fund, payload);
    applyMetaSideEffects(fund, backdrop, payload);
    setupHistoryExplorer(backdrop, history, fund);
    backdrop.fundHistory = history;
  }

  // 二次验收：数据更新状态显示真实数据源（不写死）
  // 估值 source 为小倍/养基宝时显示对应数据源；否则默认后端数据源（天天基金）
  function dataSourceStatusText(fund, payload) {
    const estimate = payload && payload.estimate;
    let source = estimate && (estimate.source || estimate.estimate_source);
    // 抽屉以 fast=1 打开时快照 estimate 为 null，回退到前端 FundStore / fund 上已由
    // 数据源切换或估值刷新写入的真实 source（不会因快照缺 estimate 而误显示“天天基金”）。
    // 通用修复：不针对任何基金代码硬编码。
    if (!source) {
      const fs = (window.fundStore && typeof window.fundStore.get === 'function' && fund)
        ? window.fundStore.get(fund.code) : null;
      source = (fs && fs.estimate && (fs.estimate.source || fs.estimate.estimate_source))
        || (fs && fs.meta && fs.meta.source)
        || (fund && fund.estimateSource)
        || (fund && fund.meta && fund.meta.source)
        || null;
    }
    if (source === 'xiaobeiyangji' || source === 'xbyj') return '✓ 小倍数据';
    if (source === 'yangjibao' || source === 'yjb') return '✓ 养基宝数据';
    return '✓ ' + FUND_DATA_SOURCE_LABEL + '数据';
  }

  function finishFailed(fund, backdrop, ctl, message) {
    if (ctl) ctl.stop();
    const state = backdrop.querySelector('.detail-api-state');
    if (state) state.textContent = '暂时无法获取';
    renderFailedPanel(backdrop, fund, message);
  }

  function elapsedSecs(ctl) {
    return ctl.waitStart ? Math.floor((Date.now() - ctl.waitStart) / 1000) : 0;
  }

  // 统一的等待计时器：仅刷新“已等待 / 第 X 次尝试”文本与超时提示，不伪造百分比；单一实例。
  function startWaitTimer(ctl, backdrop) {
    if (ctl.waitTimer) return;
    ctl.waitTimer = setInterval(() => {
      if (ctl.stopped || !backdrop.isConnected) return;
      const secs = elapsedSecs(ctl);
      const waitNode = backdrop.querySelector('.detail-sync-wait');
      if (waitNode) {
        waitNode.textContent = ctl.status === 'RETRYING'
          ? `第 ${ctl.attempt + 1} 次尝试 · 已等待 ${secs} 秒`
          : `已等待 ${secs} 秒`;
      }
      if (secs > 10) {
        const hint = backdrop.querySelector('.detail-sync-hint');
        if (hint) hint.textContent = ctl.status === 'RETRYING'
          ? '数据源暂时不可用，正在自动重试…'
          : '数据仍在同步，请稍候…';
      }
    }, 1000);
  }

  function enterSyncing(fund, backdrop, ctl, payload) {
    ctl.status = 'SYNCING';
    if (!ctl.waitStart) ctl.waitStart = Date.now();
    applyMetaSideEffects(fund, backdrop, payload);
    renderSyncPanel(backdrop, elapsedSecs(ctl), payload?.data_status?.label);
    startWaitTimer(ctl, backdrop);
    schedulePoll(fund, backdrop, ctl);
  }

  function enterRetrying(fund, backdrop, ctl, message) {
    ctl.status = 'RETRYING';
    if (!ctl.waitStart) ctl.waitStart = Date.now();
    renderRetryPanel(backdrop, ctl.attempt + 1, elapsedSecs(ctl), message);
    startWaitTimer(ctl, backdrop);
    schedulePoll(fund, backdrop, ctl);
  }

  // 轮询策略：首次由 startLoad 触发 refresh；此处后续轮询一律不带 refresh（避免请求风暴）。
  // 递增退避 1.5→2→3→5→8→10s…，到达次数/总等待上限后判 FAILED（绝不判 EMPTY）。
  function schedulePoll(fund, backdrop, ctl) {
    if (ctl.stopped || !backdrop.isConnected) return;
    if (ctl.attempt >= SYNC_MAX_ATTEMPTS || (ctl.waitStart && Date.now() - ctl.waitStart > SYNC_MAX_WAIT_MS)) {
      ctl.status = 'FAILED';
      finishFailed(fund, backdrop, ctl, '数据同步超时，可重新获取');
      return;
    }
    const delay = SYNC_POLL_DELAYS[Math.min(ctl.attempt, SYNC_POLL_DELAYS.length - 1)];
    ctl.pollTimer = setTimeout(async () => {
      if (ctl.stopped || !backdrop.isConnected) return;
      ctl.attempt += 1;
      try {
        const payload = await fetchFundPayload(fund.code, false); // 后续轮询绝不带 refresh
        if (ctl.stopped || !backdrop.isConnected) return;
        detailApiFundCache[String(fund.code)] = Date.now();
        const history = Array.isArray(payload.history) ? payload.history : [];
        if (history.length > 0) {
          ctl.status = 'SUCCESS';
          
          if (window.mergeFundData) {
            window.mergeFundData(fund.code, payload);
          }
          
          finishSuccess(fund, backdrop, payload, history, ctl);
          return;
        }
        const historyStatus = payload.data_status?.history;
        // 后续轮询命中空历史：同样不判 EMPTY，继续等待（pending 显示正在同步，其它未知状态也继续等待）。
        enterSyncing(fund, backdrop, ctl, payload);
      } catch (err) {
        if (ctl.stopped || !backdrop.isConnected) return;
        retryOrFail(fund, backdrop, ctl, err && err.message);
      }
    }, delay);
  }

  // 抓取抛错时：尚有重试额度 → RETRYING 自动重试；耗尽 → FAILED（失败≠无数据，绝不判 EMPTY）。
  function retryOrFail(fund, backdrop, ctl, message) {
    if (ctl.attempt >= SYNC_MAX_ATTEMPTS || (ctl.waitStart && Date.now() - ctl.waitStart > SYNC_MAX_WAIT_MS)) {
      ctl.status = 'FAILED';
      finishFailed(fund, backdrop, ctl, message);
      return;
    }
    enterRetrying(fund, backdrop, ctl, message);
  }

  function handlePayload(fund, backdrop, ctl, payload) {
    // P3.18 整改：fetch 已成功 → 永远渲染详情（不再因 history.length===0 进入 SYNCING）。
    // 核心诉求：历史净值/十大持仓 = 不变缓存 → 必须秒开。
    // fund_nav 无历史/基金未导入 → 显示「暂无历史」+ 仍渲染持仓等其余字段，不进入重试循环。
    // 后端 fetch 异常才走 retry（见 retryOrFail），那时才是真正「数据源不可用」。
    ctl.status = 'SUCCESS';
    const history = Array.isArray(payload.history) ? payload.history : [];
    finishSuccess(fund, backdrop, payload, history, ctl);
  }

  // 统一入口：LOADING → SUCCESS / SYNCING / RETRYING / FAILED（空 history 不再判 EMPTY）。
  function startLoad(fund, backdrop, options) {
    options = options || {};
    const ctl = attachController(backdrop);
    ctl.status = 'LOADING';
    const state = backdrop.querySelector('.detail-api-state');
    if (state) state.textContent = '正在读取真实数据…';
    const historyContent = backdrop.querySelector('.detail-history-content');
    if (historyContent) historyContent.innerHTML = '<div class="detail-loading" aria-label="加载历史净值"></div>';

    const initialRefresh = options.forceRefresh === true
      ? true
      : (() => {
          const now = Date.now();
          const last = detailApiFundCache[String(fund.code)] || 0;
          return now - last > 5 * 60 * 1000;
        })();

    const cached = window.fundStore ? window.fundStore.get(fund.code) : null;
    const hasCache = cached && Array.isArray(cached.history) && cached.history.length > 0;

    if (hasCache) {
      ctl.status = 'SUCCESS';
      const cachedPayload = {
        fund: cached.detail || {},
        holdings: cached.holdings || [],
        history: cached.history,
        estimate: cached.estimate || {},
        calibration: cached.calibration || null,
        latest_nav: cached.nav || (cached.detail && cached.detail.latest_nav)
      };
      
      detailApiFundCache[String(fund.code)] = Date.now();
      
      if (state) state.textContent = dataSourceStatusText(fund, cachedPayload);
      applyMetaSideEffects(fund, backdrop, cachedPayload);
      setupHistoryExplorer(backdrop, cached.history, fund);
      backdrop.fundHistory = cached.history;
      
      if (!initialRefresh) {
        return;
      }
      
      (async () => {
        try {
          const payload = await fetchFundPayload(fund.code, true);
          if (ctl.stopped || !backdrop.isConnected) return;
          detailApiFundCache[String(fund.code)] = Date.now();
          
          if (window.mergeFundData) {
            window.mergeFundData(fund.code, payload);
          }
          
          if (state) state.textContent = dataSourceStatusText(fund, payload);
          applyMetaSideEffects(fund, backdrop, payload);
          setupHistoryExplorer(backdrop, payload.history || [], fund);
          backdrop.fundHistory = payload.history || [];
          if (typeof window.refreshListRow === 'function') window.refreshListRow(fund.code);
        } catch (err) {
          console.warn('Silent background refresh failed', err);
        }
      })();
      return;
    }

    (async () => {
      try {
        const payload = await fetchFundPayload(fund.code, initialRefresh);
        if (ctl.stopped || !backdrop.isConnected) return;
        detailApiFundCache[String(fund.code)] = Date.now();
        
        if (window.mergeFundData) {
          window.mergeFundData(fund.code, payload);
        }
        
        handlePayload(fund, backdrop, ctl, payload);
      } catch (err) {
        if (ctl.stopped || !backdrop.isConnected) return;
        retryOrFail(fund, backdrop, ctl, err && err.message);
      }
    })();
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
