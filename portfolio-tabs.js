(function(){
  const root=document.querySelector('#view-root'),state=window.portfolioState;
  function enhance(){
    const section=root.querySelector('.list-section'),isPortfolio=!!root.querySelector('.fund-list');
    document.body.classList.toggle('portfolio-mode',isPortfolio);
    if(!isPortfolio||!section)return;
    let toolbar=root.querySelector('.portfolio-toolbar');
    if(!toolbar){
      toolbar=document.createElement('div');
      toolbar.className='portfolio-toolbar';
      toolbar.innerHTML='<div class="account-segmented portfolio-account-tabs" role="tablist"></div><div class="portfolio-data-status" aria-live="polite"></div>';
      section.before(toolbar);
    }
    const tabs=toolbar.querySelector('.portfolio-account-tabs');
    const accounts=Object.keys(state.accounts);
    if(tabs.dataset.accounts!==accounts.join('|')){
      tabs.dataset.accounts=accounts.join('|');
      tabs.innerHTML=accounts.map(n=>'<button class="account-segment" data-portfolio-account="'+n.replace(/"/g,'&quot;')+'">'+n.replace(/（朋友账户）/,'')+'</button>').join('');
    }
    const active=state.getActive();
    tabs.querySelectorAll('.account-segment').forEach(b=>b.classList.toggle('active',b.dataset.portfolioAccount===active));
    window.refreshDataStatus?.();
  }
  root.addEventListener('click',e=>{const tab=e.target.closest('[data-portfolio-account]');if(!tab)return;e.preventDefault();e.stopImmediatePropagation();const name=tab.dataset.portfolioAccount;if(state.accounts[name]){state.setActive(name);document.querySelector('.nav-tab[data-view="portfolio"]')?.click()}},true);
  // The portfolio view is mounted as a direct child of the root. Watching
  // nested changes caused by this enhancer can otherwise create a feedback
  // loop in the in-app preview.
  new MutationObserver(enhance).observe(root,{childList:true});enhance();
}());
