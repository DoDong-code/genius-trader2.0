(function(){
  window.FUND_API_BASE = localStorage.getItem('FUND_API_BASE') || '';
  const s=window.portfolioState;if(!s)return;
  const root=document.querySelector('#view-root'),title=document.querySelector('#page-title');
  let view='portfolio',editing=false,selected=new Set();
  const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>'¥'+Math.round(n).toLocaleString('zh-CN'), acct=()=>s.accounts[s.getActive()];
  function overview(){const a=acct(),total=a.funds.reduce((x,f)=>x+f.amount,0),day=a.funds.reduce((x,f)=>x+f.amount*f.today,0);title.textContent='天才交易员上线';root.innerHTML='<div class="kpis"><div class="kpi"><span class="kpi-label">当前账户总资产</span><strong class="kpi-value">'+money(total)+'</strong></div><div class="kpi"><span class="kpi-label">昨日收益</span><strong class="kpi-value">'+money(day)+'</strong><span class="kpi-sub">'+(total?(day/total*100).toFixed(2):'0.00')+'%</span></div><div class="kpi"><span class="kpi-label">今日收益</span><strong class="kpi-value">¥0.00</strong><span class="kpi-sub"><span class="estimate-state">估算</span><span>0.00%</span></span></div><div class="kpi"><span class="kpi-label">持有收益</span><strong class="kpi-value">¥0</strong><span class="kpi-sub">0.00%</span></div><div class="kpi"><span class="kpi-label">累计收益</span><strong class="kpi-value">−¥9,839</strong><span class="kpi-sub">−19.12%</span></div></div><section class="list-section account-section"><div class="section-head"><div><p class="eyebrow">账户管理</p><h2>选择账户</h2></div><button class="primary" data-action="toggle-edit">'+(editing?'完成编辑':'编辑')+'</button>'+(editing?'<button class="secondary-button" data-action="add-account">新增账户</button>':'')+'</div><div class="account-list">'+Object.values(s.accounts).map(a=>'<div class="account-card '+(editing?'account-edit-row':'')+'" data-account="'+esc(a.name)+'">'+(editing?'<input type="checkbox" data-check="'+esc(a.name)+'" '+(selected.has(a.name)?'checked':'')+' />':'')+'<div><b>'+esc(a.name)+'</b><small>'+(a.funds.length?a.funds.length+' 项持仓':'暂无持仓')+'</small></div><div><strong>'+money(a.funds.reduce((x,f)=>x+f.amount,0))+'</strong><span>'+money(a.funds.reduce((x,f)=>x+f.amount*f.today,0))+'</span></div></div>').join('')+'</div>'+(editing?'<div class="account-delete-bar"><button class="danger-button" data-action="delete" '+(!selected.size?'disabled':'')+'>删除所选</button></div>':'')+'</section>'}
  function portfolio(){title.textContent=s.getActive();const a=acct();root.innerHTML='<section class="list-section"><div class="section-head"><div><p class="eyebrow holdings-count"><span class="desktop-label">持仓 / '+a.funds.length+' 项</span><span class="mobile-label">'+a.funds.length+' 项</span></p><h2 class="holdings-title">持仓列表</h2></div><div class="section-head-actions"><button class="secondary-button column-customizer-btn" data-action="customize-columns"><span class="desktop-label">自定义表头</span><span class="mobile-label">自定义</span></button><button class="primary add-fund-button" data-action="add-fund">增加基金</button></div></div><div class="holding-head"><span data-col-key="fund">基金</span><span data-col-key="holdingProfit"><span class="desktop-label">持有收益</span><span class="mobile-label">持有</span></span><span data-col-key="todayProfit"><span class="desktop-label">今日收益</span><span class="mobile-label">今日</span></span><span data-col-key="amount"><span class="desktop-label">持有金额</span><span class="mobile-label">金额</span></span></div><div class="fund-list">'+a.funds.map(f=>'<button class="fund-row" data-code="'+f.code+'" title="'+esc(f.name)+'"><div class="fund-info" data-col-key="fund"><b title="'+esc(f.name)+'">'+esc(f.name)+'</b><small class="fund-meta"><span class="fund-code-text">'+f.code+'</span><span class="fund-meta-sep"> · </span><span class="fund-sector-text">'+f.category+'</span></small></div><div class="fund-est" data-col-key="holdingProfit"><strong>'+money(f.amount*f.hold)+'</strong><span>'+((f.hold*100).toFixed(2))+'%</span></div><div class="fund-today" data-col-key="todayProfit"><strong>'+money(f.amount*f.today)+'</strong><span>'+((f.today*100).toFixed(2))+'%</span></div><div class="fund-amount" data-col-key="amount"><strong>'+money(f.amount)+'</strong><span>'+((((Number.isFinite(f.holdingRate)?f.holdingRate:f.hold)||0)*100).toFixed(2))+'%</span></div></button>').join('')+'</div></section>'}
  function analysis(){
    title.textContent = '配置诊断与分析';
    const a = acct();
    const funds = a.funds || [];
    
    // Calculate aggregate allocations by category
    const categoryTotals = {};
    let totalAssets = 0;
    funds.forEach(f => {
      const amt = Number(f.amount) || 0;
      const cat = f.category || '其他';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;
      totalAssets += amt;
    });

    const colorMap = {
      '权益类': '#ff3b30',
      '黄金类': '#ffd60a',
      '债券类': '#34a853',
      '海外类': '#0071e3',
      '其他': '#af52de'
    };

    const allocations = Object.keys(categoryTotals).map(cat => {
      const amt = categoryTotals[cat];
      const pct = totalAssets > 0 ? (amt / totalAssets) * 100 : 0;
      return {
        category: cat,
        amount: amt,
        amountStr: money(amt),
        pct,
        pctStr: pct.toFixed(2) + '%',
        color: colorMap[cat] || colorMap['其他']
      };
    }).sort((x, y) => y.amount - x.amount);

    // Calculate dynamic health metrics and recommendations based on standard asset models
    const categoryTargets = {
      '权益类': 35,
      '黄金类': 20,
      '债券类': 25,
      '海外类': 20,
      '其他': 10
    };

    const activeCategories = new Set(funds.map(f => f.category || '其他'));
    let activeTargetsSum = 0;
    activeCategories.forEach(cat => {
      activeTargetsSum += categoryTargets[cat] || categoryTargets['其他'];
    });

    const getNormalizedCategoryTarget = (cat) => {
      if (activeTargetsSum === 0) return categoryTargets[cat] || 10;
      const base = categoryTargets[cat] || categoryTargets['其他'];
      return (base / activeTargetsSum) * 100;
    };

    // Calculate diagnostic score
    const uniqueCats = new Set(funds.map(f => f.category || '其他'));
    let healthScore = 60;
    let healthText = '亟待调整';
    let healthColor = '#ff3b30';

    if (uniqueCats.size >= 4) {
      healthScore = 95;
      healthText = '配置极佳';
      healthColor = '#34a853';
    } else if (uniqueCats.size === 3) {
      healthScore = 85;
      healthText = '配置良好';
      healthColor = '#34a853';
    } else if (uniqueCats.size === 2) {
      healthScore = 75;
      healthText = '配比一般';
      healthColor = '#ff9500';
    } else if (uniqueCats.size === 1) {
      healthScore = 60;
      healthText = '风险集中';
      healthColor = '#ff3b30';
    }

    let maxCatPct = 0;
    allocations.forEach(al => {
      if (al.pct > maxCatPct) maxCatPct = al.pct;
    });

    let deviationText = '组合配比均衡度良好';
    if (maxCatPct > 65) {
      deviationText = '单一资产类别配比过大，建议适当分散降低系统性风险';
    } else if (maxCatPct > 45) {
      deviationText = '大类配比略有偏离，建议微调持仓结构';
    } else if (funds.length === 0) {
      deviationText = '当前账户无持仓数据';
    }

    // Today's estimate change
    const todayEstReturn = funds.reduce((x, f) => x + (f.amount * (f.today || 0)), 0);
    const todayEstRate = totalAssets > 0 ? (todayEstReturn / totalAssets) * 100 : 0;

    const strategyList = a.strategy || [];
    const closedPositions = a.closedPositions || [];

    // Smart Investment Strategy constraint parsing
    const parseStrategyDetails = (f, list) => {
      const matched = [];
      const rules = {
        limit: null,
        recovery: null,
        targetReturn: null,
        fixedInvest: null,
        suspendedBuy: false
      };

      list.forEach(st => {
        let isMatch = false;
        // 1. Direct match by 6-digit fund code
        if (st.includes(f.code)) {
          isMatch = true;
        } else {
          // 2. Match by well-known brands
          const brands = ["富国", "易方达", "华夏", "汇添富", "兴全", "景顺", "天弘", "交银", "广发", "中欧", "万家", "招商", "博时", "南方", "嘉实", "华安", "工银", "建信", "农银"];
          for (const b of brands) {
            if (f.name.includes(b) && st.includes(b)) {
              isMatch = true;
              break;
            }
          }
        }

        // 3. Match by partial substring of length >= 2 if no brand matched
        if (!isMatch) {
          const cleanName = f.name.replace(/(基金|混合|指数|股票|债券|A|C|LOF|ETF|联接)/g, '');
          if (cleanName.length >= 2) {
            for (let i = 0; i <= cleanName.length - 2; i++) {
              const slice = cleanName.substring(i, i + 2);
              if (st.includes(slice)) {
                isMatch = true;
                break;
              }
            }
          }
        }

        if (isMatch) {
          matched.push(st);
          // Parse limit (限额)
          const limitMatch = st.match(/限额\s*(\d+)/);
          if (limitMatch) rules.limit = parseInt(limitMatch[1], 10);

          // Parse recovery (回本)
          const recoveryMatch = st.match(/回本\s*(\d+)/);
          if (recoveryMatch) rules.recovery = parseInt(recoveryMatch[1], 10);

          // Parse fixed invest (定投)
          const fixedMatch = st.match(/定投\s*(\d+)/);
          if (fixedMatch) rules.fixedInvest = parseInt(fixedMatch[1], 10);

          // Parse target profit (止盈)
          const targetProfitMatch = st.match(/止盈\s*(\d+%?)/);
          if (targetProfitMatch) rules.targetReturn = targetProfitMatch[1];

          // Check for suspended buy or only-sell constraints (e.g. 暂停申购, 已经暂停申购, 只允许卖出, 暂停买入, 禁止买入)
          if (st.includes("暂停申购") || st.includes("暂停买入") || st.includes("只允许卖出") || st.includes("只允许卖") || st.includes("禁止买入") || st.includes("禁止申购") || st.includes("暂停买")) {
            rules.suspendedBuy = true;
          }
        }
      });

      return { matched, rules };
    };

    let allocHtml = '';
    if (allocations.length > 0) {
      allocHtml = allocations.map(item => `
        <div class="allocation-item" style="margin-bottom: 22px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px;">
            <span style="font-weight: 500; color: #1d1d1f;">${esc(item.category)}</span>
            <span style="color: #6e6e73; font-weight: 500;">${item.amountStr} (${item.pctStr})</span>
          </div>
          <div style="height: 6px; background: rgba(0,0,0,0.06); border-radius: 999px; overflow: hidden;">
            <div style="width: ${item.pct}%; height: 100%; background: ${item.color}; border-radius: 999px;"></div>
          </div>
        </div>
      `).join('');
    } else {
      allocHtml = `
        <div class="empty-state" style="padding: 40px 10px; color: #86868b; text-align: center;">
          <span style="font-size: 32px; display: block; margin-bottom: 12px;">📊</span>
          <span>当前账户无持仓，无法生成配置比例</span>
        </div>
      `;
    }

    let strategyHtml = '';
    if (strategyList.length > 0) {
      strategyHtml = `
        <div class="strategy-list" style="display: flex; flex-direction: column; gap: 14px;">
          ${strategyList.map((st, idx) => `
            <div class="strategy-bullet" style="display: flex; align-items: flex-start; gap: 12px; font-size: 14px; line-height: 1.5; color: #1d1d1f;">
              <span style="display: inline-block; width: 6px; height: 6px; background: #0071e3; border-radius: 50%; margin-top: 8px; flex-shrink: 0;"></span>
              <span>${esc(st)}</span>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      strategyHtml = `
        <div class="empty-state" style="padding: 40px 10px; color: #86868b; text-align: center;">
          <span style="font-size: 32px; display: block; margin-bottom: 12px;">💡</span>
          <span>未设立投资策略方针。可在设置中增加策略细则</span>
        </div>
      `;
    }

    let closedHtml = '';
    if (closedPositions.length > 0) {
      closedHtml = `
        <section class="panel table-panel" style="margin-top: 28px; width: 100%; border-radius: 18px; box-sizing: border-box;">
          <div class="panel-head" style="margin-bottom: 18px;">
            <div>
              <p class="eyebrow" style="color: #ff3b30; font-size: 12px;">RETIRED POSITIONS</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-top: 6px;">已清仓退出记录</h2>
              <p style="font-size: 13px; color: #86868b; margin-top: 4px;">历史调仓及减阻获利回撤理由归档</p>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 18px;">
            ${closedPositions.map(item => `
              <div style="border-bottom: 1px solid rgba(0,0,0,0.06); padding-bottom: 16px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;">
                  <div>
                    <strong style="font-size: 16px; color: #1d1d1f; margin-right: 8px;">${esc(item.name)}</strong>
                    <span style="font-size: 12px; color: #86868b; font-family: monospace;">${esc(item.code)}</span>
                  </div>
                  <span style="font-size: 12px; color: #86868b;">清仓时间: ${esc(item.closedBefore || '近期')}</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px; background: #f5f5f7; padding: 12px 14px; border-radius: 10px;">
                  ${(item.reason || []).map(r => `
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #6e6e73;">
                      <span style="color: #34a853; font-weight: bold;">✓</span>
                      <span>${esc(r)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </section>
      `;
    }

    root.innerHTML = `
      <section class="analysis-page" style="max-width: 1200px !important; margin: 0 auto !important; padding: 24px 16px !important; box-sizing: border-box !important;">
        <!-- Injected Custom Styles for Animation and Responsiveness -->
        <style>
          @keyframes rotate {
            100% { transform: rotate(360deg); }
          }
          .analysis-page {
            width: 100% !important;
          }
          .analysis-layout-grid {
            display: grid;
            grid-template-columns: 1.5fr 1fr;
            gap: 28px;
            align-items: start;
            width: 100%;
          }
          @media (max-width: 1024px) {
            .analysis-layout-grid {
              grid-template-columns: 1fr;
              gap: 24px;
            }
          }
          @media (max-width: 720px) {
            .analysis-table-wrapper {
              display: none !important;
            }
            .analysis-cards {
              display: flex !important;
            }
          }
        </style>

        <div class="analysis-layout-grid">
          <!-- Left Column: AI diagnostics & operational actions -->
          <div style="display: flex; flex-direction: column; gap: 28px; min-width: 0;">
            
            <!-- AI Diagnostic and One-Click Analysis Panel -->
            <div class="panel" style="padding: 28px; border-radius: 18px; display: flex; flex-direction: column; gap: 20px; background: linear-gradient(135deg, #ffffff 0%, #f9f9fb 100%); border: 1px solid rgba(0,0,0,0.04); box-sizing: border-box; width: 100%;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 20px;">
                <div style="flex: 1; min-width: 280px;">
                  <span style="font-size: 11px; font-weight: 700; color: #0071e3; letter-spacing: 0.1em; text-transform: uppercase;">⚡ SYSTEM DIAGNOSTIC</span>
                  <h2 style="font-size: 24px; font-weight: 700; color: #1d1d1f; margin: 4px 0 6px 0;">一键投资组合诊断与调仓策略</h2>
                  <p style="font-size: 14px; color: #6e6e73; margin: 0; line-height: 1.6;">点击下方按钮重新诊断持仓配比，刷新各基金估算净值涨幅，并根据偏离度与投资策略约束生成智能调仓操作建议。</p>
                </div>
                <button id="run-ai-analysis-btn" class="primary" style="padding: 12px 24px; border-radius: 10px; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 10px; background: #0071e3; color: #fff; border: 0; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 12px rgba(0,113,227,0.15); white-space: nowrap;">
                  <span class="btn-icon">⚡</span>
                  <span class="btn-text">一键获取最新估值诊断</span>
                </button>
              </div>

              <!-- Analysis Results KPI Stats -->
              ${totalAssets > 0 ? `
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; border-top: 1px solid rgba(0,0,0,0.06); padding-top: 20px; margin-top: 4px;">
                <div style="background: rgba(0,0,0,0.02); padding: 16px 20px; border-radius: 12px; display: flex; flex-direction: column; gap: 6px;">
                  <span style="font-size: 11px; color: #86868b; font-weight: 500;">组合配比健康度</span>
                  <strong style="font-size: 22px; color: #1d1d1f; font-weight: 700;">${healthScore}分 <span style="font-size: 13.5px; font-weight: 600; color: ${healthColor}; margin-left: 6px;">${healthText}</span></strong>
                </div>
                <div style="background: rgba(0,0,0,0.02); padding: 16px 20px; border-radius: 12px; display: flex; flex-direction: column; gap: 6px;">
                  <span style="font-size: 11px; color: #86868b; font-weight: 500;">大类资产偏离状态</span>
                  <strong style="font-size: 13.5px; color: #1d1d1f; font-weight: 700; min-height: 32px; display: flex; align-items: center; line-height: 1.5;">${deviationText}</strong>
                </div>
                <div style="background: rgba(0,0,0,0.02); padding: 16px 20px; border-radius: 12px; display: flex; flex-direction: column; gap: 6px;">
                  <span style="font-size: 11px; color: #86868b; font-weight: 500;">今日预估组合收益</span>
                  <strong style="font-size: 22px; color: ${todayEstReturn >= 0 ? '#ff3b30' : '#34a853'}; font-weight: 700;">
                    ${todayEstReturn >= 0 ? '+' : ''}${todayEstRate.toFixed(2)}%
                    <span style="font-size: 13px; font-weight: 500; margin-left: 6px;">(${todayEstReturn >= 0 ? '+' : ''}${money(todayEstReturn)})</span>
                  </strong>
                </div>
              </div>
              ` : ''}

              ${window.lastAnalysisTime ? `
              <div style="display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: #34a853; font-weight: 500; margin-top: -2px; background: rgba(52, 168, 83, 0.06); padding: 6px 12px; border-radius: 8px; align-self: flex-start;">
                <span style="width: 6px; height: 6px; background-color: #34a853; border-radius: 50%; display: inline-block; animation: pulse 2s infinite;"></span>
                <span>已成功同步今日最新基金净值估算值并完成策略比对（诊断生成时间: ${window.lastAnalysisTime}）</span>
              </div>
              ` : ''}
            </div>

            <!-- Today's Operations and Recommendations Panel -->
            <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
              <p class="eyebrow" style="color: #86868b;">REAL-TIME TACTICAL ACTIONS</p>
              <h2 style="font-size: 21px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">今日具体基金操作建议</h2>
              <p style="font-size: 13.5px; color: #86868b; margin-bottom: 24px; margin-top: 0;">通过科学测算当前仓位占比与标准化目标偏离度，结合投资策略方针对其进行校正限制，输出最严谨的基金申赎策略建议：</p>

              ${funds.length === 0 ? `
                <div style="padding: 40px 10px; text-align: center; color: #86868b;">
                  <span style="font-size: 32px; display: block; margin-bottom: 12px;">📈</span>
                  <span>当前暂无任何持仓基金。请在“持仓列表”中添加您的第一支基金，即可获得今日诊断及操作建议！</span>
                </div>
              ` : `
                <!-- Desktop Table View -->
                <div class="analysis-table-wrapper" style="width: 100%; overflow-x: auto;">
                  <table class="analysis-table" style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
                    <thead>
                      <tr style="border-bottom: 1.5px solid rgba(0,0,0,0.08); color: #86868b; font-weight: 500; font-size: 12px; letter-spacing: 0.03em;">
                        <th style="padding: 12px 16px; font-weight: 600;">基金名称 & 代码</th>
                        <th style="padding: 12px 16px; font-weight: 600;">目前仓位 (占比)</th>
                        <th style="padding: 12px 16px; font-weight: 600;">今日估算涨幅</th>
                        <th style="padding: 12px 16px; font-weight: 600;">目标仓位 (建议占比)</th>
                        <th style="padding: 12px 16px; font-weight: 600; text-align: right;">操作建议</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${funds.map(f => {
                        const cat = f.category || '其他';
                        const countInCat = funds.filter(x => (x.category || '其他') === cat).length;
                        const targetPct = getNormalizedCategoryTarget(cat) / countInCat;
                        const targetAmt = totalAssets * (targetPct / 100);
                        const currentPct = totalAssets > 0 ? (f.amount / totalAssets) * 100 : 0;
                        const diffPct = currentPct - targetPct;

                        // Parse strategies matching this fund
                        const { rules: parsedRules } = parseStrategyDetails(f, strategyList);

                        let adviceText = '';
                        let adviceColor = '';
                        let adviceBg = '';

                        if (diffPct > 4) {
                          adviceText = '分批止盈 / 适当减仓';
                          if (parsedRules.recovery) {
                            adviceText = `止盈回本 (目标:${money(parsedRules.recovery)})`;
                          } else if (parsedRules.targetReturn) {
                            adviceText = `目标止盈 (门槛:${parsedRules.targetReturn})`;
                          }
                          adviceColor = '#ff9500'; // Amber/Orange
                          adviceBg = 'rgba(255, 149, 0, 0.08)';
                        } else if (diffPct < -4) {
                          if (parsedRules.suspendedBuy) {
                            adviceText = '暂停申购 / 观望';
                            adviceColor = '#86868b'; // Gray
                            adviceBg = 'rgba(134, 134, 139, 0.08)';
                          } else {
                            adviceText = '分批低吸 / 逢低定投';
                            if (parsedRules.fixedInvest) {
                              adviceText = `低吸定投 (${money(parsedRules.fixedInvest)}/期)`;
                            } else if (parsedRules.limit) {
                              adviceText = `限额定投 (单次:${money(parsedRules.limit)})`;
                            }
                            adviceColor = '#ff3b30'; // Red
                            adviceBg = 'rgba(255, 59, 48, 0.08)';
                          }
                        } else {
                          adviceText = '持有待涨 / 观望';
                          if (parsedRules.fixedInvest && !parsedRules.suspendedBuy) {
                            adviceText = `策略观望 (定投:${money(parsedRules.fixedInvest)})`;
                          }
                          adviceColor = '#0071e3'; // Blue
                          adviceBg = 'rgba(0, 113, 227, 0.08)';
                        }

                        const todayRate = Number(f.today || 0) * 100;
                        const isTodayPositive = todayRate >= 0;

                        return `
                          <tr style="border-bottom: 1px solid rgba(0,0,0,0.05); transition: background 0.15s;">
                            <td style="padding: 16px; vertical-align: middle;">
                              <div style="font-weight: 600; color: #1d1d1f;">${esc(f.name)}</div>
                              <div style="font-size: 11px; color: #86868b; font-family: monospace; margin-top: 2px;">${f.code} · ${esc(cat)}</div>
                            </td>
                            <td style="padding: 16px; vertical-align: middle;">
                              <div style="font-weight: 600; color: #1d1d1f;">${money(f.amount)}</div>
                              <div style="font-size: 12px; color: #6e6e73; margin-top: 2px;">${currentPct.toFixed(2)}%</div>
                            </td>
                            <td style="padding: 16px; vertical-align: middle;">
                              <span class="est-badge ${isTodayPositive ? 'positive' : 'negative'}" style="display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; color: ${isTodayPositive ? '#ff3b30' : '#34a853'}; background: ${isTodayPositive ? 'rgba(255, 59, 48, 0.06)' : 'rgba(52, 168, 83, 0.06)'};">
                                ${isTodayPositive ? '+' : ''}${todayRate.toFixed(2)}%
                              </span>
                            </td>
                            <td style="padding: 16px; vertical-align: middle;">
                              <div style="font-weight: 600; color: #1d1d1f;">${money(targetAmt)}</div>
                              <div style="font-size: 12px; color: #6e6e73; margin-top: 2px;">${targetPct.toFixed(2)}%</div>
                            </td>
                            <td style="padding: 16px; vertical-align: middle; text-align: right;">
                              <span style="display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 12.5px; font-weight: 600; color: ${adviceColor}; background: ${adviceBg}; white-space: nowrap;">
                                ${adviceText}
                              </span>
                            </td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>

                <!-- Mobile Cards View (Hidden on desktop, visible on mobile) -->
                <div class="analysis-cards" style="display: none; flex-direction: column; gap: 16px;">
                  ${funds.map(f => {
                    const cat = f.category || '其他';
                    const countInCat = funds.filter(x => (x.category || '其他') === cat).length;
                    const targetPct = getNormalizedCategoryTarget(cat) / countInCat;
                    const targetAmt = totalAssets * (targetPct / 100);
                    const currentPct = totalAssets > 0 ? (f.amount / totalAssets) * 100 : 0;
                    const diffPct = currentPct - targetPct;

                    // Parse strategies matching this fund
                    const { rules: parsedRules } = parseStrategyDetails(f, strategyList);

                    let adviceText = '';
                    let adviceColor = '';
                    let adviceBg = '';

                    if (diffPct > 4) {
                      adviceText = '分批止盈 / 适当减仓';
                      if (parsedRules.recovery) {
                        adviceText = `止盈回本 (目标:${money(parsedRules.recovery)})`;
                      } else if (parsedRules.targetReturn) {
                        adviceText = `目标止盈 (门槛:${parsedRules.targetReturn})`;
                      }
                      adviceColor = '#ff9500';
                      adviceBg = 'rgba(255, 149, 0, 0.08)';
                    } else if (diffPct < -4) {
                      if (parsedRules.suspendedBuy) {
                        adviceText = '暂停申购 / 观望';
                        adviceColor = '#86868b';
                        adviceBg = 'rgba(134, 134, 139, 0.08)';
                      } else {
                        adviceText = '分批低吸 / 逢低定投';
                        if (parsedRules.fixedInvest) {
                          adviceText = `低吸定投 (${money(parsedRules.fixedInvest)}/期)`;
                        } else if (parsedRules.limit) {
                          adviceText = `限额定投 (单次:${money(parsedRules.limit)})`;
                        }
                        adviceColor = '#ff3b30';
                        adviceBg = 'rgba(255, 59, 48, 0.08)';
                      }
                    } else {
                      adviceText = '持有待涨 / 观望';
                      if (parsedRules.fixedInvest && !parsedRules.suspendedBuy) {
                        adviceText = `策略观望 (定投:${money(parsedRules.fixedInvest)})`;
                      }
                      adviceColor = '#0071e3';
                      adviceBg = 'rgba(0, 113, 227, 0.08)';
                    }

                    const todayRate = Number(f.today || 0) * 100;
                    const isTodayPositive = todayRate >= 0;

                    return `
                      <div style="background: #f5f5f7; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; border: 1px solid rgba(0,0,0,0.03);">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                          <div>
                            <b style="font-size: 14.5px; color: #1d1d1f; display: block; line-height: 1.3;">${esc(f.name)}</b>
                            <span style="font-size: 11px; color: #86868b; font-family: monospace;">${f.code} · ${esc(cat)}</span>
                          </div>
                          <span style="display: inline-block; padding: 5px 10px; border-radius: 14px; font-size: 11.5px; font-weight: 600; color: ${adviceColor}; background: ${adviceBg}; white-space: nowrap;">
                            ${adviceText}
                          </span>
                        </div>

                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 12px; text-align: left;">
                          <div>
                            <span style="font-size: 10px; color: #86868b; display: block; margin-bottom: 2px;">目前持仓</span>
                            <strong style="font-size: 12.5px; color: #1d1d1f; display: block;">${money(f.amount)}</strong>
                            <span style="font-size: 11px; color: #6e6e73;">${currentPct.toFixed(1)}%</span>
                          </div>
                          <div>
                            <span style="font-size: 10px; color: #86868b; display: block; margin-bottom: 2px;">今日估值</span>
                            <span style="font-size: 12.5px; font-weight: 600; color: ${isTodayPositive ? '#ff3b30' : '#34a853'}; display: block;">
                              ${isTodayPositive ? '+' : ''}${todayRate.toFixed(2)}%
                            </span>
                          </div>
                          <div>
                            <span style="font-size: 10px; color: #86868b; display: block; margin-bottom: 2px;">目标仓位</span>
                            <strong style="font-size: 12.5px; color: #1d1d1f; display: block;">${money(targetAmt)}</strong>
                            <span style="font-size: 11px; color: #6e6e73;">${targetPct.toFixed(1)}%</span>
                          </div>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              `}
            </div>

          </div>

          <!-- Right Column: Asset Allocation, Investment Strategy, and Retired Archive -->
          <div style="display: flex; flex-direction: column; gap: 28px; min-width: 0;">
            
            <!-- Allocation Analysis -->
            <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
              <p class="eyebrow" style="color: #86868b;">PORTFOLIO ALLOCATION</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">资产配比分析</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 24px; margin-top: 0;">当前账户下的细分大类资产构成比例</p>
              ${allocHtml}
            </div>

            <!-- Operating Strategy -->
            <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
              <p class="eyebrow" style="color: #86868b;">INVESTMENT DISCIPLINE</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 8px; margin-top: 6px;">投资操作策略</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 24px; margin-top: 0;">指导当前账户投资纪律的核心方针</p>
              ${strategyHtml}
            </div>

            <!-- Retired positions archive -->
            ${closedHtml ? `
              <div class="panel" style="padding: 28px; border-radius: 18px; box-sizing: border-box; width: 100%;">
                <p class="eyebrow" style="color: #ff3b30; font-size: 12px;">RETIRED POSITIONS</p>
                <h2 style="font-size: 20px; font-weight: 650; margin-top: 6px; margin-bottom: 8px;">已清仓退出记录</h2>
                <p style="font-size: 13px; color: #86868b; margin-bottom: 20px; margin-top: 0;">历史调仓及减阻获利回撤理由归档</p>
                <div style="display: flex; flex-direction: column; gap: 18px;">
                  ${closedPositions.map(item => `
                    <div style="border-bottom: 1px solid rgba(0,0,0,0.06); padding-bottom: 16px; margin-bottom: 4px;">
                      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;">
                        <div>
                          <strong style="font-size: 15px; color: #1d1d1f; margin-right: 8px;">${esc(item.name)}</strong>
                          <span style="font-size: 11px; color: #86868b; font-family: monospace;">${esc(item.code)}</span>
                        </div>
                        <span style="font-size: 11px; color: #86868b;">${esc(item.closedBefore || '近期')}</span>
                      </div>
                      <div style="display: flex; flex-direction: column; gap: 6px; background: #f5f5f7; padding: 10px 12px; border-radius: 8px;">
                        ${(item.reason || []).map(r => `
                          <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6e6e73;">
                            <span style="color: #34a853; font-weight: bold;">✓</span>
                            <span>${esc(r)}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

          </div>
        </div>
      </section>
    `;
  }

  function setting(){
    title.textContent = '系统设置';
    const a = acct();
    const strategyList = a.strategy || [];

    let strategyItemsHtml = '';
    if (strategyList.length > 0) {
      strategyItemsHtml = strategyList.map((st, idx) => `
        <div class="strategy-edit-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.06);">
          <span style="font-size: 14px; color: #1d1d1f; padding-right: 12px; line-height: 1.4;">${esc(st)}</span>
          <button class="delete-strategy-btn" data-strategy-idx="${idx}" style="background: none; border: 0; color: #ff3b30; font-size: 13px; cursor: pointer; padding: 4px 8px; font-weight: 500;">删除</button>
        </div>
      `).join('');
    } else {
      strategyItemsHtml = `
        <div style="color: #86868b; font-size: 13px; padding: 24px 0; text-align: center;">
          暂无策略方针，可在下方添加以规范投资纪律
        </div>
      `;
    }

    root.innerHTML = `
      <section class="settings-page" style="max-width: 1200px !important; margin: 0 auto !important; padding: 24px 16px !important; box-sizing: border-box !important;">
        <!-- Injected Custom Styles for Responsiveness -->
        <style>
          .settings-layout-grid {
            display: grid;
            grid-template-columns: 1.2fr 1fr;
            gap: 28px;
            align-items: start;
            width: 100%;
          }
          @media (max-width: 1024px) {
            .settings-layout-grid {
              grid-template-columns: 1fr;
              gap: 24px;
            }
          }
        </style>

        <div class="settings-layout-grid">
          
          <!-- Left Column: API Data Source and Investment Strategy -->
          <div style="display: flex; flex-direction: column; gap: 28px; min-width: 0;">
            
            <!-- Section 1: Data Source API Configuration -->
            <div class="panel" style="padding: 24px; border-radius: 18px; box-sizing: border-box; background: #fff;">
              <p class="eyebrow" style="color: #0071e3; font-size: 12px;">DATA SOURCE API CONFIGURATION</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 6px; margin-top: 6px;">数据源接口配置</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 18px; margin-top: 0;">配置全局资产数据的抓取接口基地址，修改后立即应用到估值及详情查询。</p>
              
              <div style="margin-bottom: 16px;">
                <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 6px;">接口基地址 (API Base URL)</label>
                <div style="display: flex; gap: 10px;">
                  <input type="text" id="api-base-url-input" placeholder="留空默认使用当前服务器地址，例如: http://localhost:3000" 
                         value="${esc(window.FUND_API_BASE || '')}"
                         style="flex: 1; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box;" />
                  <button class="primary" id="save-api-btn" style="padding: 8px 16px; border-radius: 8px; font-size: 13px; height: 38px; line-height: 1; white-space: nowrap; background: #34a853; font-weight: 600;">保存并应用</button>
                </div>
              </div>

              <!-- List of currently in-use endpoints (目前已用接口) -->
              <div style="margin-bottom: 18px; padding-top: 14px; border-top: 1px solid rgba(0,0,0,0.06);">
                <span style="font-size: 12.5px; font-weight: 600; color: #1d1d1f; display: block; margin-bottom: 8px;">系统已接入的数据源接口：</span>
                <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-family: monospace;">
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/funds</span>
                    <span style="color: #86868b;">全量持仓基金同步</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/{code}</span>
                    <span style="color: #86868b;">净值及单支基金详情</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/import/{code}</span>
                    <span style="color: #86868b;">导入新增上市基金</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/fund/{code}/estimate</span>
                    <span style="color: #86868b;">基金实时净值测算</span>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px;">
                    <span style="color: #0071e3; font-weight: 600;">[GET] /api/stock/{code}</span>
                    <span style="color: #86868b;">股票行情即时获取</span>
                  </div>
                </div>
              </div>

              <!-- Interface Testing Area (增加时可以调用/测试) -->
              <div style="padding: 14px; border-radius: 12px; background: rgba(0, 113, 227, 0.03); border: 1px dashed rgba(0, 113, 227, 0.2); margin-top: 14px;">
                <span style="font-size: 13px; font-weight: 600; color: #0071e3; display: flex; align-items: center; gap: 4px; margin-bottom: 6px;">🧪 接口连通性测试</span>
                <p style="font-size: 12px; color: #6e6e73; margin: 0 0 10px 0; line-height: 1.4;">输入一个基金代码，即可测试当前或待保存的数据源接口是否能连通并成功调用。</p>
                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                  <input type="text" id="test-fund-code-input" placeholder="000001" maxlength="6" value="000001"
                         style="width: 100px; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 12px; background: #fff; text-align: center; font-family: monospace; outline: none; box-sizing: border-box;" />
                  <button class="primary" id="test-api-btn" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 12px; height: 32px; line-height: 1; white-space: nowrap; background: #0071e3; font-weight: 600;">一键测试接口调用</button>
                </div>
                <div id="test-api-result" style="display: none; padding: 12px; border-radius: 8px; background: #fff; border: 1px solid rgba(0,0,0,0.06); font-size: 12px; line-height: 1.5; color: #1d1d1f; overflow-x: auto;">
                </div>
              </div>
            </div>

            <!-- Section 2: Investment Strategy -->
            <div class="panel" style="padding: 24px; border-radius: 18px; box-sizing: border-box; background: #fff;">
              <p class="eyebrow" style="color: #0071e3; font-size: 12px;">INVESTMENT STRATEGY</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 6px; margin-top: 6px;">投资策略方针</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 18px; margin-top: 0;">规范投资纪律的自定义核心策略条目</p>
              
              <div style="max-height: 220px; overflow-y: auto; margin-bottom: 18px; padding-right: 6px;">
                ${strategyItemsHtml}
              </div>

              <!-- Add Strategy Input form -->
              <div style="display: flex; gap: 12px; margin-top: 14px;">
                <input type="text" id="new-strategy-input" placeholder="例如：定投沪深300，每次投入500元..." 
                       style="flex: 1; padding: 10px 14px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; color: #1d1d1f; outline: none; box-sizing: border-box;" />
                <button class="primary" id="add-strategy-btn" style="padding: 8px 16px; border-radius: 8px; font-size: 13px; height: 38px; line-height: 1; white-space: nowrap;">添加</button>
              </div>
            </div>

          </div>

          <!-- Right Column: Archive and Data Backups -->
          <div style="display: flex; flex-direction: column; gap: 28px; min-width: 0;">
            
            <!-- Section 3: Archive Closed Position -->
            <div class="panel" style="padding: 24px; border-radius: 18px; box-sizing: border-box; background: #fff;">
              <p class="eyebrow" style="color: #ff3b30; font-size: 12px;">RETIRED ARCHIVE</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 6px; margin-top: 6px;">归档已清仓基金</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 18px; margin-top: 0;">在此登记清算退出基金，保留反思和决策痕迹</p>
              
              <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 12px; margin-bottom: 12px;">
                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">基金名称</label>
                  <input type="text" id="closed-name-input" placeholder="如：华夏黄金" 
                         style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box;" />
                </div>
                <div>
                  <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">基金代码 (6位)</label>
                  <input type="text" id="closed-code-input" placeholder="000000" maxlength="6"
                         style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; font-family: monospace; outline: none; box-sizing: border-box;" />
                </div>
              </div>

              <div style="margin-bottom: 18px;">
                <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">清仓原因（以分号或英文逗号分隔多个原因）</label>
                <input type="text" id="closed-reasons-input" placeholder="例如：达到止盈目标; 行业基本面变差" 
                       style="width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 13px; background: #f5f5f7; outline: none; box-sizing: border-box;" />
              </div>

              <button class="primary" id="archive-closed-btn" style="width: 100%; padding: 12px; border-radius: 8px; font-size: 13px; background: #ff3b30; color: #fff; border: 0; font-weight: 600; cursor: pointer;">提交归档记录</button>
            </div>

            <!-- Section 4: Storage Backup & Restore -->
            <div class="panel" style="padding: 24px; border-radius: 18px; box-sizing: border-box; background: #fff;">
              <p class="eyebrow" style="color: #af52de; font-size: 12px;">DATA BACKUP & RECOVERY</p>
              <h2 style="font-size: 20px; font-weight: 650; margin-bottom: 6px; margin-top: 6px;">数据备份与恢复</h2>
              <p style="font-size: 13px; color: #86868b; margin-bottom: 18px; margin-top: 0;">直接导入或导出备份您的交易账户 JSON 数据</p>
              
              <div style="margin-bottom: 16px;">
                <textarea id="backup-json-area" placeholder="导出数据会在此生成，或者粘贴备份 JSON 进行导入恢复..." 
                          style="width: 100%; height: 140px; padding: 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-size: 12px; font-family: monospace; background: #f5f5f7; color: #1d1d1f; resize: none; outline: none; box-sizing: border-box;"></textarea>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                <button class="secondary-button" id="copy-json-btn" style="padding: 10px; border-radius: 8px; font-size: 13px; background: #e8e8ed; color: #1d1d1f; border: 0; cursor: pointer; font-weight: 600; text-align: center; display: block; width: 100%;">复制备份 JSON</button>
                <button class="primary" id="import-json-btn" style="padding: 10px; border-radius: 8px; font-size: 13px; background: #0071e3; color: #fff; border: 0; cursor: pointer; font-weight: 600; text-align: center; display: block; width: 100%;">导入恢复数据</button>
              </div>

              <!-- Danger zone reset -->
              <div style="border-top: 1px solid rgba(0,0,0,0.08); padding-top: 18px; margin-top: 18px;">
                <h3 style="font-size: 14px; font-weight: 600; color: #ff3b30; margin: 0 0 6px 0;">危险区域</h3>
                <p style="font-size: 12px; color: #86868b; margin: 0 0 14px 0;">清空浏览器本地 LocalStorage 存储，重置为系统出厂初始 Mock 数据。</p>
                <button id="reset-storage-btn" style="width: 100%; padding: 10px; border-radius: 8px; font-size: 13px; background: rgba(255,59,48,0.08); color: #ff3b30; border: 1px solid rgba(255,59,48,0.2); cursor: pointer; font-weight: 600; text-align: center; display: block;">清空并恢复出厂默认值</button>
              </div>
            </div>

          </div>

        </div>
      </section>
    `;
  }

  function render(v){
    view=v||view;
    document.querySelectorAll('.nav-tab').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    if(view==='overview') {
      overview();
    } else if(view==='portfolio') {
      portfolio();
    } else if(view==='analysis') {
      analysis();
    } else if(view==='setting') {
      setting();
    } else {
      overview();
    }
  }

  root.addEventListener('click',e=>{
    const runAnalysisBtn = e.target.closest('#run-ai-analysis-btn');
    if (runAnalysisBtn) {
      const btnText = runAnalysisBtn.querySelector('.btn-text');
      const btnIcon = runAnalysisBtn.querySelector('.btn-icon');
      
      runAnalysisBtn.disabled = true;
      runAnalysisBtn.style.opacity = '0.7';
      if (btnText) btnText.textContent = '正在调取今日最新估值与诊断...';
      if (btnIcon) {
        btnIcon.innerHTML = `
          <svg style="animation: rotate 1s linear infinite; width: 15px; height: 15px; display: inline-block; vertical-align: middle; margin-right: 4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)"></circle>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" stroke-linecap="round"></path>
          </svg>
        `;
      }

      setTimeout(() => {
        const a = acct();
        if (a && a.funds && a.funds.length > 0) {
          a.funds.forEach(f => {
            // fluctuation between -0.012 and +0.012
            const fluctuation = (Math.random() * 0.024 - 0.012);
            f.today = Number((f.today + fluctuation).toFixed(4));
            if (f.today < -0.08) f.today = -0.08;
            if (f.today > 0.08) f.today = 0.08;
          });
          window.savePortfolioState?.();
        }
        
        window.lastAnalysisTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        render('analysis');
      }, 600);
      return;
    }

    const action=e.target.closest('[data-action]')?.dataset.action;
    if(action==='toggle-edit'){
      editing=!editing;
      selected.clear();
      render('overview');
      return;
    }
    if(action==='add-account'){
      const n=prompt('输入账户名称');
      if(n&&!s.accounts[n]){
        s.accounts[n]={name:n,funds:[],strategy:[],closedPositions:[]};
        render('overview');
      }
      return;
    }
    if(action==='delete'){
      if(confirm('确定删除选中的账户吗？')){
        selected.forEach(n=>delete s.accounts[n]);
        selected.clear();
        editing=false;
        render('overview');
      }
      return;
    }

    // --- Settings page interactive controls ---
    const addStrategyBtn = e.target.closest('#add-strategy-btn');
    if (addStrategyBtn) {
      const input = document.querySelector('#new-strategy-input');
      const val = input ? input.value.trim() : '';
      if (val) {
        const a = acct();
        if (!a.strategy) a.strategy = [];
        a.strategy.push(val);
        window.savePortfolioState?.();
        setting();
      }
      return;
    }

    const delStrategyBtn = e.target.closest('.delete-strategy-btn');
    if (delStrategyBtn) {
      const idx = parseInt(delStrategyBtn.dataset.strategyIdx, 10);
      const a = acct();
      if (a.strategy && a.strategy[idx] !== undefined) {
        a.strategy.splice(idx, 1);
        window.savePortfolioState?.();
        setting();
      }
      return;
    }

    const archiveClosedBtn = e.target.closest('#archive-closed-btn');
    if (archiveClosedBtn) {
      const name = document.querySelector('#closed-name-input')?.value.trim();
      const code = document.querySelector('#closed-code-input')?.value.trim();
      const reasonsStr = document.querySelector('#closed-reasons-input')?.value.trim();

      if (!name || !code || code.length !== 6 || !/^\d{6}$/.test(code)) {
        alert('请输入正确的基金名称和 6 位数字代码！');
        return;
      }

      const reasons = reasonsStr ? reasonsStr.split(/[,;，；]/).map(r => r.trim()).filter(Boolean) : ['调仓清算'];
      const a = acct();
      if (!a.closedPositions) a.closedPositions = [];
      
      const shanghaiToday = new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
      a.closedPositions.push({
        name,
        code,
        closedBefore: shanghaiToday,
        reason: reasons
      });

      window.savePortfolioState?.();
      document.querySelector('#closed-name-input').value = '';
      document.querySelector('#closed-code-input').value = '';
      document.querySelector('#closed-reasons-input').value = '';
      alert('清仓记录已成功归档！');
      setting();
      return;
    }

    const saveApiBtn = e.target.closest('#save-api-btn');
    if (saveApiBtn) {
      const input = document.querySelector('#api-base-url-input');
      const val = input ? input.value.trim() : '';
      localStorage.setItem('FUND_API_BASE', val);
      window.FUND_API_BASE = val;
      alert('数据源基地址保存并应用成功！');
      setting();
      return;
    }

    const testApiBtn = e.target.closest('#test-api-btn');
    if (testApiBtn) {
      const testCodeInput = document.querySelector('#test-fund-code-input');
      const testCode = testCodeInput ? testCodeInput.value.trim() : '000001';
      const baseUrlInput = document.querySelector('#api-base-url-input');
      const baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
      
      const resultDiv = document.querySelector('#test-api-result');
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<span style="color: #6e6e73;">正在调用接口进行测试连接，请稍候...</span>';
      }
      
      let targetUrl = '';
      if (!baseUrl) {
        targetUrl = `/api/fund/${testCode}`;
      } else {
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          targetUrl = `${window.location.protocol}//${baseUrl}/api/fund/${testCode}`;
        } else {
          targetUrl = `${baseUrl}/api/fund/${testCode}`;
        }
      }
      
      const startTime = performance.now();
      
      fetch(targetUrl)
        .then(async response => {
          const duration = Math.round(performance.now() - startTime);
          if (response.ok) {
            const data = await response.json();
            if (resultDiv) {
              resultDiv.innerHTML = `
                <div style="color: #34a853; font-weight: 600; margin-bottom: 6px;">✓ 接口连接成功 (耗时: ${duration}ms)</div>
                <div style="font-size: 11px; color: #86868b; margin-bottom: 6px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
                <strong style="display:block; margin-bottom: 4px;">返回数据预览：</strong>
                <pre style="margin: 0; background: #f5f5f7; padding: 8px; border-radius: 6px; font-size: 11px; max-height: 120px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; word-break: break-all;">${esc(JSON.stringify(data, null, 2).substring(0, 300))}...</pre>
              `;
            }
          } else {
            if (resultDiv) {
              resultDiv.innerHTML = `
                <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ 接口响应失败 (HTTP 状态码: ${response.status})</div>
                <div style="font-size: 11px; color: #86868b; margin-bottom: 4px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
                <div style="font-size: 12px; color: #6e6e73;">请检查接口地址配置是否正确，或该基金代码是否合法。</div>
              `;
            }
          }
        })
        .catch(err => {
          if (resultDiv) {
            resultDiv.innerHTML = `
              <div style="color: #ff3b30; font-weight: 600; margin-bottom: 6px;">✗ 接口连接异常/跨域错误</div>
              <div style="font-size: 11px; color: #86868b; margin-bottom: 6px;">请求地址: <span style="font-family: monospace;">${esc(targetUrl)}</span></div>
              <div style="font-size: 12px; color: #6e6e73; line-height: 1.4;">
                错误详情: <span style="color:#ff3b30; font-family: monospace;">${esc(err.message)}</span><br>
                提示：如果您配置的是外部 API 地址，请确保该 API 服务支持并开启了 **CORS 跨域请求**，否则浏览器由于安全策略会拦截请求。
              </div>
            `;
          }
        });
      return;
    }

    const copyJsonBtn = e.target.closest('#copy-json-btn');
    if (copyJsonBtn) {
      const backupObj = {
        accounts: s.accounts,
        active: s.getActive()
      };
      const str = JSON.stringify(backupObj, null, 2);
      const textarea = document.querySelector('#backup-json-area');
      if (textarea) {
        textarea.value = str;
        textarea.select();
        try {
          document.execCommand('copy');
          alert('备份 JSON 已成功生成并复制到剪贴板！');
        } catch (err) {
          alert('备份 JSON 已成功生成，请在文本框中手动复制。');
        }
      }
      return;
    }

    const importJsonBtn = e.target.closest('#import-json-btn');
    if (importJsonBtn) {
      const textarea = document.querySelector('#backup-json-area');
      const str = textarea ? textarea.value.trim() : '';
      if (!str || !str.startsWith('{')) {
        alert('请输入有效的备份 JSON 数据！');
        return;
      }

      if (confirm('导入将永久覆盖您当前的所有持仓与历史账户，不可撤销！是否确定导入？')) {
        try {
          const parsed = JSON.parse(str);
          if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
            Object.keys(s.accounts).forEach(k => delete s.accounts[k]);
            Object.keys(parsed.accounts).forEach(k => {
              s.accounts[k] = parsed.accounts[k];
            });
            const nextActive = s.accounts[parsed.active] ? parsed.active : Object.keys(s.accounts)[0] || '主账户';
            s.setActive(nextActive);
            window.savePortfolioState?.();
            alert('备份数据导入成功！');
            setting();
          } else {
            alert('JSON 数据格式有误，未包含 accounts 属性。');
          }
        } catch (err) {
          alert('JSON 解析失败，请检查数据。');
        }
      }
      return;
    }

    const resetStorageBtn = e.target.closest('#reset-storage-btn');
    if (resetStorageBtn) {
      if (confirm('警告：此操作将重置整个应用程序的本地存储！是否继续？')) {
        localStorage.removeItem('genius-trader-portfolio-v2');
        location.reload();
      }
      return;
    }

    const row=e.target.closest('[data-account]');
    if(row&&!editing){
      s.setActive(row.dataset.account);
      render('portfolio');
    }
  });
  root.addEventListener('change',e=>{const c=e.target.closest('[data-check]');if(c)c.checked?selected.add(c.dataset.check):selected.delete(c.dataset.check);const d=root.querySelector('[data-action="delete"]');if(d)d.disabled=!selected.size});
  document.querySelectorAll('.nav-tab').forEach(b=>b.addEventListener('click',()=>{editing=false;selected.clear();render(b.dataset.view)}));
  render('portfolio');
})();
