(function(){
  const root=document.querySelector('#view-root');
  function showNameModal(title,initial,onSave){
    const overlay=document.createElement('div');overlay.className='confirm-overlay name-modal-overlay';overlay.innerHTML='<form class="confirm-dialog name-modal"><h2>'+title+'</h2><p>请输入账户名称。</p><input name="accountName" maxlength="24" autocomplete="off" required><div class="confirm-actions"><button type="button" data-close>取消</button><button type="submit" class="name-submit">保存</button></div></form>';document.body.appendChild(overlay);const input=overlay.querySelector('input');input.value=initial||'';requestAnimationFrame(()=>overlay.classList.add('visible'));input.focus();input.select();const close=()=>{overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),180)};overlay.addEventListener('click',e=>{if(e.target===overlay||e.target.closest('[data-close]'))close()});overlay.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const value=input.value.trim();if(!value)return;onSave(value);close()})
  }
  let lastNameClick={node:null,time:0};
  function renameRow(row,nameNode){
    const oldName=row.dataset.accountId;
    showNameModal('重命名账户',oldName,newName=>{
      if(newName===oldName||window.portfolioState.accounts[newName])return;
      const account=window.portfolioState.accounts[oldName];
      if(!account)return;
      const wasSync=account.accountType==='sync'||(!account.accountType&&account.__source);
      const doRename=()=>{
        window.portfolioState.accounts[newName]=account;
        account.name=newName;
        delete window.portfolioState.accounts[oldName];
        if(window.portfolioState.getActive()===oldName)window.portfolioState.setActive(newName);
        if(wasSync){
          // 同步账户改名 = 转为本地账户，原同步账户服务端记录转为休眠
          account.originalSource=account.syncSource||account.__source||'sync';
          account.accountType='local';
          account.syncSource=null;
          account.convertedFromSync=true;
          account.convertedTime=new Date().toISOString();
          delete account.__source;
          fetch('/api/portfolio/rename',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},window.auth&&window.auth.authHeaders?window.auth.authHeaders():{}),body:JSON.stringify({from:oldName,to:newName})}).catch(function(){});
        }
        window.savePortfolioState?.();
        row.dataset.accountId=newName;
        const check=row.querySelector('[data-check]');
        if(check)check.dataset.check=newName;
        nameNode.textContent=newName;
        root.querySelector('.account-segmented')?.remove();
      };
      if(wasSync){
        const ask=()=>{
          if(window.showAppleDialog){
            window.showAppleDialog({title:'重命名账户',message:'修改同步账户名称后，该账户将转为本地账户，不再自动同步。是否继续？',okText:'继续',cancelText:'取消'}).then(ok=>{if(ok)doRename()});
          }else{
            if(window.confirm('修改同步账户名称后，该账户将转为本地账户，不再自动同步。是否继续？'))doRename();
          }
        };
        ask();
      }else{
        doRename();
      }
    })
  }
  function getStrategyArr(name){ const acc=window.portfolioState&&window.portfolioState.accounts?window.portfolioState.accounts[name]:null; return (acc&&Array.isArray(acc.strategy))?acc.strategy:[]; }
  function hasStrategy(name){ return getStrategyArr(name).length>0; }
  function deleteAccounts(names){
    names.forEach(function(name){
      const account=window.portfolioState.accounts[name];
      if(account&&(account.accountType==='sync'||(!account.accountType&&account.__source))){
        fetch('/api/portfolio/delete',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},window.auth&&window.auth.authHeaders?window.auth.authHeaders():{}),body:JSON.stringify({account_id:name})}).catch(function(){})
      }
      Object.values(window.portfolioState.accounts).forEach(function(a){if(Array.isArray(a.children)){const i=a.children.indexOf(name);if(i!==-1)a.children.splice(i,1)}});
      const target=window.portfolioState.accounts[name];
      if(target&&Array.isArray(target.children)){target.children.forEach(function(cn){if(window.portfolioState.accounts[cn])window.portfolioState.accounts[cn].parent=undefined})}
      delete window.portfolioState.accounts[name];
    });
    const active=window.portfolioState.getActive();
    if(!window.portfolioState.accounts[active])window.portfolioState.setActive(Object.keys(window.portfolioState.accounts)[0]||'');
    window.savePortfolioState?.();
    if (typeof window.flushCloudSaveNow === 'function') window.flushCloudSaveNow(); // 删除后立即同步云端，消除刷新竞态导致的账户复现
  }
  function showInfoDialog(title,msg){
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML='<div class="confirm-dialog" role="alertdialog" aria-modal="true"><div class="confirm-icon">!</div><h2 id="confirm-title">'+title+'</h2><p>'+msg+'</p><div class="confirm-actions" style="display:flex;justify-content:center;"><button type="button" data-info="ok" style="min-width:159px;">知道了</button></div></div>';
    document.body.appendChild(overlay);requestAnimationFrame(function(){overlay.classList.add('visible')});
    const close=function(){overlay.classList.remove('visible');setTimeout(function(){overlay.remove()},180)};
    overlay.addEventListener('click',function(e){if(e.target===overlay||e.target.closest('[data-info="ok"]'))close()});
    overlay.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  }
  function showTargetPicker(names,withStrategy){
    const others=Object.keys(window.portfolioState.accounts).filter(function(n){return names.indexOf(n)===-1});
    if(others.length===0){ showInfoDialog('无法保留','当前没有其他账户，无法保留策略。请选择“不保留”直接删除。'); return; }
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    let opts='';
    others.forEach(function(n){ opts+='<label style="display:flex;align-items:center;gap:8px;padding:10px 4px;cursor:pointer;"><input type="radio" name="retain-target" value="'+n.replace(/"/g,'&quot;')+'">'+n+'</label>'; });
    overlay.innerHTML='<div class="confirm-dialog" role="alertdialog" aria-modal="true"><h2 id="confirm-title">保留投资策略</h2><p>请选择将投资策略移动到哪个账户</p><div style="max-height:240px;overflow:auto;margin:8px 0 4px 0;">'+opts+'</div><div class="confirm-actions"><button type="button" data-target="cancel">取消</button><button type="button" class="confirm-delete" data-target="ok" disabled>确认保留</button></div></div>';
    document.body.appendChild(overlay);requestAnimationFrame(function(){overlay.classList.add('visible')});
    const close=function(){overlay.classList.remove('visible');setTimeout(function(){overlay.remove()},180)};
    const okBtn=overlay.querySelector('[data-target="ok"]');
    overlay.addEventListener('change',function(e){ if(e.target&&e.target.name==='retain-target'){ okBtn.disabled=false; } });
    overlay.addEventListener('click',function(e){
      if(e.target===overlay||e.target.closest('[data-target="cancel"]')){ close(); return; }
      if(e.target.closest('[data-target="ok"]')){
        const sel=overlay.querySelector('input[name="retain-target"]:checked');
        if(!sel) return;
        const targetName=sel.value;
        const target=window.portfolioState.accounts[targetName];
        if(!target){ close(); return; }
        const collected=[];
        withStrategy.forEach(function(n){ getStrategyArr(n).forEach(function(s){collected.push(s)}) });
        try {
          target.strategy=dedupeStrategies((target.strategy||[]).concat(collected));
          window.savePortfolioState?.();
        } catch(err){
          showInfoDialog('保存失败','策略合并保存失败，已取消删除，原账户与策略均已保留。'); close(); return;
        }
        deleteAccounts(names);
        close();
        root.querySelector('[data-action="toggle-edit"]')?.click();
        showInfoDialog('已保留','已将策略合并到“'+targetName+'”并删除原账户。');
      }
    });
    overlay.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  }
  function showStrategyConfirm(names,withStrategy){
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML='<div class="confirm-dialog" role="alertdialog" aria-modal="true"><div class="confirm-icon">!</div><h2 id="confirm-title">账户有投资策略</h2><p>该账户包含投资策略，删除后策略也会被删除，是否保留？</p><div class="confirm-actions"><button type="button" data-strategy="keep">保留</button><button type="button" class="confirm-delete" data-strategy="drop">不保留</button></div></div>';
    document.body.appendChild(overlay);requestAnimationFrame(function(){overlay.classList.add('visible')});
    const close=function(){overlay.classList.remove('visible');setTimeout(function(){overlay.remove()},180)};
    overlay.querySelector('[data-strategy="drop"]').focus();
    overlay.addEventListener('click',function(e){
      if(e.target===overlay){ close(); return; }
      if(e.target.closest('[data-strategy="drop"]')){ deleteAccounts(names); close(); root.querySelector('[data-action="toggle-edit"]')?.click(); return; }
      if(e.target.closest('[data-strategy="keep"]')){ close(); showTargetPicker(names,withStrategy); return; }
    });
    overlay.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  }
  function showGenericDeleteConfirm(names){
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML='<div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><div class="confirm-icon">!</div><h2 id="confirm-title">删除账户？</h2><p>将永久删除选中的 '+names.length+' 个账户，此操作无法撤销。</p><div class="confirm-actions"><button type="button" data-confirm="cancel">取消</button><button type="button" class="confirm-delete" data-confirm="delete">删除</button></div></div>';
    document.body.appendChild(overlay);requestAnimationFrame(function(){overlay.classList.add('visible')});
    overlay.querySelector('[data-confirm="cancel"]').focus();
    const close=function(){overlay.classList.remove('visible');setTimeout(function(){overlay.remove()},180)};
    overlay.addEventListener('click',function(e){if(e.target===overlay||e.target.closest('[data-confirm="cancel"]')){close();return}if(e.target.closest('[data-confirm="delete"]')){deleteAccounts(names);close();root.querySelector('[data-action="toggle-edit"]')?.click()}});
    overlay.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  }
  function showDeleteConfirm(names){
    const withStrategy=names.filter(hasStrategy);
    if(withStrategy.length===0){ showGenericDeleteConfirm(names); return; }
    showStrategyConfirm(names,withStrategy);
  }
  function syncDelete(){
    const checks=[...root.querySelectorAll('[data-check]')],chosen=checks.filter(x=>x.checked).length;
    const del=root.querySelector('[data-action="delete"]');
    if(!del)return;
    del.disabled=!chosen;
    const label=chosen?'删除'+chosen:'删除';if(del.textContent!==label)del.textContent=label;
    del.setAttribute('aria-label',chosen?'删除 '+chosen+' 个账户':'未选择账户，删除不可用');
  }
  function arrange(){
    const section=root.querySelector('.account-section');if(!section)return;
    const head=section.querySelector('.section-head'),bar=section.querySelector('.account-delete-bar');
    if(!head)return;
    if(bar){const del=bar.querySelector('[data-action="delete"]');if(del){del.className='danger-button account-delete-top';del.style.order='1';head.appendChild(del)}const move=bar.querySelector('[data-action="move-accounts"]');if(move){move.className='secondary-button account-move-top';move.style.order='2';head.appendChild(move)}bar.remove()}
    const editing=!!section.querySelector('.account-edit-row');
    section.querySelectorAll('.account-add-external').forEach(button=>button.remove());
    const add=section.querySelector('[data-action="add-account"]'),done=head.querySelector('[data-action="toggle-edit"]'),del=head.querySelector('[data-action="delete"]');
    if(add&&!editing){add.remove()}
    if(add&&editing){
      add.className='icon-button account-add-bottom-button';
      if(add.textContent!=='＋')add.textContent='＋';
      add.title='新增账户';
      add.setAttribute('aria-label','新增账户');
      let addBar=section.querySelector('.account-add-bottom');
      if(!addBar){addBar=document.createElement('div');addBar.className='account-add-bottom';section.appendChild(addBar)}
      if(add.parentElement!==addBar)addBar.appendChild(add);
    }
    if(done){done.className='primary account-done';done.style.order='3'}
    if(del){del.style.order='1'}
    section.querySelectorAll('.account-edit-row[data-account]').forEach(row=>{row.dataset.accountId=row.dataset.account;row.removeAttribute('data-account')});
    section.querySelectorAll('[data-check]').forEach(input=>{
      input.style.pointerEvents='auto';
      input.onpointerdown=e=>{e.preventDefault();e.stopPropagation();input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}))};
      input.onclick=e=>{e.preventDefault();e.stopPropagation()};
    });
    syncDelete();
  }
  root.addEventListener('change',e=>{if(e.target.matches('[data-check]'))syncDelete()});
  root.addEventListener('pointerdown',e=>{const row=e.target.closest('.account-edit-row');if(!row)return;if(e.target.closest('[data-check]'))return;const nameNode=e.target.closest('.account-edit-row>div:first-of-type b'),now=Date.now();if(nameNode&&lastNameClick.node===nameNode&&now-lastNameClick.time<420){lastNameClick={node:null,time:0};e.preventDefault();e.stopImmediatePropagation();renameRow(row,nameNode);return}if(nameNode)lastNameClick={node:nameNode,time:now};e.preventDefault();e.stopImmediatePropagation()},true);
  root.addEventListener('click',e=>{const row=e.target.closest('.account-edit-row');if(!row)return;e.preventDefault();e.stopImmediatePropagation()},true);
  root.addEventListener('click',e=>{const del=e.target.closest('[data-action="delete"]');if(!del||del.disabled)return;e.preventDefault();e.stopImmediatePropagation();const names=[...root.querySelectorAll('[data-check]:checked')].map(x=>x.dataset.check);showDeleteConfirm(names)},true);
  root.addEventListener('click',e=>{const add=e.target.closest('[data-action="add-account"]');if(!add)return;e.preventDefault();e.stopImmediatePropagation();showNameModal('新增账户','',name=>{if(window.portfolioState.accounts[name])return;window.portfolioState.accounts[name]={name,accountType:'local',syncSource:null,funds:[]};window.savePortfolioState?.();root.querySelector('.account-segmented')?.remove();document.querySelector('.nav-tab[data-view="overview"]')?.click()})},true);
  // Account controls only need arranging after a top-level view change.
  // Watching all descendants also observes the controls moved by arrange().
  new MutationObserver(arrange).observe(root,{childList:true});arrange();
})();
