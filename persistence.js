(function(){
  const state=window.portfolioState;
  if(!state)return;
  const storageKey='genius-trader-portfolio-v2';
  const originalSetActive=state.setActive.bind(state);
  // 同步账户的服务端数据只存持仓；策略等本地元数据随本地/云端 JSON 一并备份
  let syncMetaStore={};

  function buildPersisted(){
    // 同步账户的持仓由服务端权威存储，不写入本地/云端 JSON；本地账户（含由同步转换的）正常持久化
    const persisted={};
    Object.keys(state.accounts).forEach(name=>{
      const account=state.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source)))return;
      persisted[name]=account;
    });
    const syncMeta={};
    Object.keys(state.accounts).forEach(name=>{
      const account=state.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&Array.isArray(account.strategy)&&account.strategy.length){
        syncMeta[name]={ strategy: account.strategy.slice() };
      }
    });
    return { accounts:persisted, active:state.getActive(), syncMeta };
  }

  function normalizeAccount(account){
    if(!account||typeof account!=='object')return;
    if(account.accountType==='sync'||account.accountType==='local')return;
    if(account.__source){
      account.accountType='sync';
      account.syncSource=account.syncSource||account.__source;
    }else{
      account.accountType='local';
    }
    if(account.accountType==='local')account.syncSource=account.syncSource||null;
  }

  let cloudTimer=null;
  function scheduleCloudSave(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return;
    clearTimeout(cloudTimer);
    cloudTimer=setTimeout(()=>{
      fetch('/api/account/state',{
        method:'PUT',
        headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
        body:JSON.stringify({state:buildPersisted()})
      }).catch(()=>{});
    },400);
  }

  function save(){
    try{
      const payload=buildPersisted();
      localStorage.setItem(storageKey,JSON.stringify(payload));
      // 同步账户元数据合并：仅当该同步账户当前存在且策略为空时才清除，
      // 避免云端恢复/重新加载同步账户过程中被空元数据误清
      const newMeta=payload.syncMeta||{};
      const merged=Object.assign({},syncMetaStore,newMeta);
      Object.keys(merged).forEach(name=>{
        const account=state.accounts[name];
        if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))&&!(name in newMeta)){
          delete merged[name];
        }
      });
      syncMetaStore=merged;
      scheduleCloudSave();
    }catch(error){
      console.warn('Portfolio data could not be saved.',error);
    }
  }

  try{
    const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
    if(saved&&saved.syncMeta&&typeof saved.syncMeta==='object')syncMetaStore=saved.syncMeta;
    // 只要存在已保存的 accounts（即使为空），就以保存内容为准，
    // 避免删除默认账户后刷新又出现“主账户”
    if(saved&&saved.accounts&&typeof saved.accounts==='object'){
      const valid=Object.entries(saved.accounts).filter(([,account])=>
        account&&typeof account.name==='string'&&Array.isArray(account.funds)
      );
      Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
      valid.forEach(([name,account])=>{normalizeAccount(account);state.accounts[name]=account});
      const active=state.accounts[saved.active]?saved.active:Object.keys(state.accounts)[0];
      if(active)originalSetActive(active);
      else originalSetActive('');
    }
  }catch(error){
    console.warn('Saved portfolio data could not be restored.',error);
  }

  function migrateTransactions(accounts){
    var changed=false;
    Object.keys(accounts||{}).forEach(function(accountName){
      var funds=accounts[accountName]&&accounts[accountName].funds;
      if(!Array.isArray(funds))return;
      funds.forEach(function(fund){
        if(!fund||typeof fund!=='object')return;
        var source=Array.isArray(fund.transactions)?fund.transactions:[];
        var normalized=source.map(function(item){
          if(Array.isArray(item)){
            return {
              type:String(item[1]||'').indexOf('\u51cf')!==-1?'sell':'buy',
              amount:Math.abs(Number(String(item[2]||'').replace(/[^\d.-]/g,''))||0),
              fee:0,
              date:String(item[0]||'')
            };
          }
          if(item&&typeof item==='object'){
            return {
              type:item.type==='sell'?'sell':'buy',
              amount:Math.max(0,Number(item.amount)||0),
              fee:Math.max(0,Number(item.fee)||0),
              date:String(item.date||'')
            };
          }
          changed=true;
          return null;
        }).filter(Boolean);
        var isCurrent=source.length===normalized.length&&source.every(function(item,index){
          var next=normalized[index];
          return item&&!Array.isArray(item)&&item.type===next.type&&Number(item.amount)===next.amount&&Number(item.fee)===next.fee&&String(item.date||'')===next.date;
        });
        if(!isCurrent||fund.transactionVersion!==2){
          fund.transactions=normalized;
          fund.transactionVersion=2;
          changed=true;
        }
      });
    });
    return changed;
  }

  var corrected=typeof window.applyAccount2PortfolioCorrection==='function'&&window.applyAccount2PortfolioCorrection(state.accounts);
  var migrated=migrateTransactions(state.accounts);
  if(corrected||migrated){
    save();
  }

  function applyAccounts(saved){
    if(!saved||!saved.accounts||typeof saved.accounts!=='object')return false;
    if(saved.syncMeta&&typeof saved.syncMeta==='object')syncMetaStore=saved.syncMeta;
    // 保留当前同步账户（服务端权威），仅用云端数据覆盖本地账户
    const syncAccounts=Object.entries(state.accounts).filter(([,a])=>a&&(a.accountType==='sync'||(!a.accountType&&a.__source)));
    const valid=Object.entries(saved.accounts).filter(([,account])=>
      account&&typeof account.name==='string'&&Array.isArray(account.funds)
    );
    Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
    valid.forEach(([name,account])=>{normalizeAccount(account);state.accounts[name]=account});
    syncAccounts.forEach(([name,account])=>{state.accounts[name]=account});
    // 把备份中的同步账户策略合并回保留的同步账户
    Object.keys(syncMetaStore).forEach(name=>{
      const account=state.accounts[name];
      const meta=syncMetaStore[name];
      if(account&&meta&&Array.isArray(meta.strategy))account.strategy=meta.strategy.slice();
    });
    const active=state.accounts[saved.active]?saved.active:Object.keys(state.accounts)[0];
    if(active)originalSetActive(active);
    else originalSetActive('');
    return true;
  }

  // 云端恢复：已登录时优先使用云端数据（首次登录时若云端为空则上传本地数据）
  function restoreCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return;
    window.auth.api('/api/account/state').then(data=>{
      if(data&&data.state&&data.state.accounts&&Object.keys(data.state.accounts).length>0){
        applyAccounts(data.state);
        save();
        if(typeof window.refreshSyncedAccounts==='function'){
          window.refreshSyncedAccounts().then(rerender).catch(rerender);
        }else{
          rerender();
        }
      } else if(data&&data.state&&data.state.accounts){
        // 云端为空：把本地数据作为首次迁移上传
        scheduleCloudSave();
      }
    }).catch(()=>{});
  }

  // 退出登录：清空本地账户数据（云端数据已备份，登录后再恢复）
  function clearLocalData(){
    Object.keys(state.accounts).forEach(name=>delete state.accounts[name]);
    if(typeof state.setActive==='function')state.setActive('');
    save();
  }
  window.clearLocalData=clearLocalData;

  function rerender(){
    const tab=document.querySelector('.nav-tab.active');
    if(tab)tab.click();
  }

  window.addEventListener('auth-changed',()=>{
    if(window.auth&&window.auth.state&&window.auth.state.token){
      restoreCloud();
    }else{
      save();
      rerender();
    }
  });
  restoreCloud();

  state.setActive=function(name){
    originalSetActive(name);
    save();
  };
  state.persist=save;
  window.savePortfolioState=save;
  // 供 app-refactor 在刷新同步账户时合并其本地策略元数据
  window.getSyncAccountMeta=function(name){return syncMetaStore[name]||null;};
  // 手动操作：备份云端 / 恢复本地
  async function backupToCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const response=await fetch('/api/account/state',{
      method:'PUT',
      headers:Object.assign({'Content-Type':'application/json'},window.auth.authHeaders()),
      body:JSON.stringify({state:buildPersisted()})
    });
    if(!response.ok)throw new Error('HTTP '+response.status);
    return true;
  }
  async function restoreFromCloud(){
    if(!window.auth||!window.auth.state||!window.auth.state.token)return false;
    const data=await window.auth.api('/api/account/state');
    const applied=applyAccounts(data&&data.state);
    if(applied){
      save();
      rerender();
    }
    return applied;
  }
  window.backupToCloud=backupToCloud;
  window.restoreFromCloud=restoreFromCloud;
})();
