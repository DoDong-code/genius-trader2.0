(function(){
  var state=window.portfolioState;if(!state)return;
  var editing=false,selected=new Set(),root=document.querySelector('#view-root');
  var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var money=function(n){return '¥'+Math.round(n).toLocaleString('zh-CN')};
  function refresh(){if(typeof state.persist==='function')state.persist();state.render('overview')}
  function decorate(){
    if(!document.querySelector('.account-section'))return;
    var head=document.querySelector('.account-section .section-head'),list=document.querySelector('.account-list');if(!head||!list)return;
    var add=head.querySelector('[data-action="add-account"]');if(add)add.remove();
    var old=head.querySelector('[data-action="account-edit-toggle"]');if(old)old.remove();
    old=head.querySelector('[data-action="delete-selected-accounts"]');if(old)old.remove();
    var edit=document.createElement('button');edit.className='secondary-button';edit.dataset.action='account-edit-toggle';edit.textContent=editing?'完成编辑':'编辑';head.appendChild(edit);
    if(editing){var addBtn=document.createElement('button');addBtn.className='primary';addBtn.dataset.action='add-account';addBtn.textContent='新增账户';addBtn.type='button';addBtn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();state.addAccount()});head.appendChild(addBtn)}
    var oldBar=document.querySelector('.account-delete-bar');if(oldBar)oldBar.remove();
    if(editing){var bar=document.createElement('div');bar.className='account-delete-bar';var del=document.createElement('button');del.className='danger-button';del.dataset.action='delete-selected-accounts';del.disabled=!selected.size;del.textContent=selected.size?'删除所选（'+selected.size+'）':'选择账户后删除';bar.appendChild(del);document.querySelector('.account-section').appendChild(bar)}
    list.innerHTML=Object.values(state.accounts).map(function(a){
      var total=a.funds.reduce(function(s,f){return s+(Number(f.amount)||0)},0),daily=a.funds.reduce(function(s,f){return s+(Number(f.amount)||0)*(Number(f.today)||0)},0);
      if(!editing)return '<button class="account-card" data-account="'+esc(a.name)+'"><div><b>'+esc(a.name)+'</b><small>'+(a.funds.length?a.funds.length+' 项持仓':'暂无持仓')+'</small></div><div><strong>'+money(total)+'</strong><span class="'+(daily<0?'negative':'positive')+'">'+money(daily)+'</span></div><span class="row-chevron">›</span></button>';
      return '<div class="account-card account-edit-row"><label class="account-check"><input type="checkbox" data-account-check="'+esc(a.name)+'" '+(selected.has(a.name)?'checked':'')+' aria-label="选择'+esc(a.name)+'"></label><div class="account-edit-main"><input class="account-name-input" data-account-name="'+esc(a.name)+'" value="'+esc(a.name)+'" aria-label="账户名称"><small>'+(a.funds.length?a.funds.length+' 项持仓':'暂无持仓')+'</small></div><div><strong>'+money(total)+'</strong><span class="'+(daily<0?'negative':'positive')+'">'+money(daily)+'</span></div></div>';
    }).join('');
  }
  root.addEventListener('click',function(e){
    if(e.target.closest('[data-action="account-edit-toggle"]')){editing=!editing;selected.clear();refresh();return}
    if(e.target.closest('[data-action="delete-selected-accounts"]')){if(!selected.size)return;if(!window.confirm('确定删除选中的 '+selected.size+' 个账户吗？'))return;selected.forEach(function(name){delete state.accounts[name]});if(!state.accounts[state.getActive()])state.setActive(Object.keys(state.accounts)[0]||'');editing=false;selected.clear();refresh()}
  });
  root.addEventListener('click',function(e){var add=e.target.closest('[data-action="add-account"]');if(add){e.stopImmediatePropagation();state.addAccount()}},true);
  root.addEventListener('change',function(e){
    var check=e.target.closest('[data-account-check]');
    if(check){var name=check.dataset.accountCheck;check.checked?selected.add(name):selected.delete(name);var del=root.querySelector('[data-action="delete-selected-accounts"]');if(del){del.disabled=!selected.size;del.textContent=selected.size?'删除所选（'+selected.size+'）':'选择账户后删除'}return}
    var input=e.target.closest('[data-account-name]');
    if(input){var old=input.dataset.accountName,next=input.value.trim();if(!next||(next!==old&&state.accounts[next])){input.value=old;return}if(next!==old){state.accounts[next]=state.accounts[old];state.accounts[next].name=next;delete state.accounts[old];if(state.getActive()===old)state.setActive(next)}refresh()}
  });
  var originalRender=state.render;state.render=function(v){originalRender(v);if(v==='overview')setTimeout(decorate,0)};if(document.querySelector('.account-section'))decorate();
})();
