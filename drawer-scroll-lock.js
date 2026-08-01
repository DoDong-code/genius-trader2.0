(function(){
  function sync(){
    document.body.classList.toggle('drawer-open',!!document.querySelector('.drawer-backdrop'));
  }
  new MutationObserver(sync).observe(document.body,{childList:true});
  document.addEventListener('wheel',function(event){
    const backdrop=document.querySelector('.drawer-backdrop');
    if(!backdrop||event.target.closest('.detail-drawer'))return;
    const drawerScroll=backdrop.querySelector('.drawer-scroll');
    if(!drawerScroll)return;
    event.preventDefault();
    drawerScroll.scrollTop+=event.deltaY;
  },{passive:false});
  sync();
})();
