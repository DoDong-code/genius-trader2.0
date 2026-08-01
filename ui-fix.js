(function(){
  const root=document.querySelector('#view-root');
  function showNameModal(title,initial,onSave){
    const overlay=document.createElement('div');overlay.className='confirm-overlay name-modal-overlay';overlay.innerHTML='<form class="confirm-dialog name-modal"><h2>'+title+'</h2><p>请输入账户名称。</p><input name="accountName" maxlength="24" autocomplete="off" required><div class="confirm-actions"><button type="button" data-close>取消</button><button type="submit" class="name-submit">保存</button></div></form>';document.body.appendChild(overlay);const input=overlay.querySelector('input');input.value=initial||'';requestAnimationFrame(()=>overlay.classList.add('visible'));input.focus();input.select();const close=()=>{overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),180)};overlay.addEventListener('click',e=>{if(e.target===overlay||e.target.closest('[data-close]'))close()});overlay.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const value=input.value.trim();if(!value)return;onSave(value);close()})
  }
  let lastNameClick={node:null,time:0};
  function renameRow(row,nameNode){const oldName=row.dataset.accountId;showNameModal('重命名账户',oldName,newName=>{if(newName===oldName||window.portfolioState.accounts[newName])return;const account=window.portfolioState.accounts[oldName];window.portfolioState.accounts[newName]=account;account.name=newName;delete window.portfolioState.accounts[oldName];if(window.portfolioState.getActive()===oldName)window.portfolioState.setActive(newName);window.savePortfolioState?.();row.dataset.accountId=newName;const check=row.querySelector('[data-check]');if(check)check.dataset.check=newName;nameNode.textContent=newName;root.querySelector('.account-segmented')?.remove()})}
  function showDeleteConfirm(names){
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML='<div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><div class="confirm-icon">!</div><h2 id="confirm-title">删除账户？</h2><p>将永久删除选中的 '+names.length+' 个账户，此操作无法撤销。</p><div class="confirm-actions"><button type="button" data-confirm="cancel">取消</button><button type="button" class="confirm-delete" data-confirm="delete">删除</button></div></div>';
    document.body.appendChild(overlay);requestAnimationFrame(()=>overlay.classList.add('visible'));
    overlay.querySelector('[data-confirm="cancel"]').focus();
    const close=()=>{overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),180)};
    overlay.addEventListener('click',e=>{if(e.target===overlay||e.target.closest('[data-confirm="cancel"]')){close();return}if(e.target.closest('[data-confirm="delete"]')){names.forEach(name=>delete window.portfolioState.accounts[name]);const active=window.portfolioState.getActive();if(!window.portfolioState.accounts[active])window.portfolioState.setActive(Object.keys(window.portfolioState.accounts)[0]||'');window.savePortfolioState?.();close();root.querySelector('[data-action="toggle-edit"]')?.click()}});
    overlay.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  }
  function syncDelete(){
    const checks=[...root.querySelectorAll('[data-check]')],chosen=checks.filter(x=>x.checked).length;
    const del=root.querySelector('[data-action="delete"]');
    if(!del)return;
    del.disabled=!chosen;
    const label=chosen?'🗑 删除 '+chosen+' 个账户':'🗑 删除';if(del.textContent!==label)del.textContent=label;
    del.setAttribute('aria-label',chosen?'删除 '+chosen+' 个账户':'未选择账户，删除不可用');
  }
  function arrange(){
    const section=root.querySelector('.account-section');if(!section)return;
    const head=section.querySelector('.section-head'),bar=section.querySelector('.account-delete-bar');
    if(!head)return;
    if(bar){const del=bar.querySelector('[data-action="delete"]');if(del){del.className='danger-button account-delete-top';head.appendChild(del)}bar.remove()}
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
  root.addEventListener('click',e=>{const add=e.target.closest('[data-action="add-account"]');if(!add)return;e.preventDefault();e.stopImmediatePropagation();showNameModal('新增账户','',name=>{if(window.portfolioState.accounts[name])return;window.portfolioState.accounts[name]={name,funds:[]};window.savePortfolioState?.();root.querySelector('.account-segmented')?.remove();document.querySelector('.nav-tab[data-view="overview"]')?.click()})},true);
  // Account controls only need arranging after a top-level view change.
  // Watching all descendants also observes the controls moved by arrange().
  new MutationObserver(arrange).observe(root,{childList:true});arrange();
})();
