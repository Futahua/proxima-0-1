// A browser is a client of BOP, not another offline replica or native device host.
(()=>{
 const P=globalThis.ProximaPortal;
 const button=document.createElement('button');button.type='button';button.textContent='Connection';button.hidden=true;document.body.append(button);
 const panel=document.createElement('dialog');panel.id='portal-connection';
 const header=document.createElement('header'),title=document.createElement('strong'),close=document.createElement('button');title.textContent='Devices & connection';close.type='button';close.textContent='×';close.setAttribute('aria-label','Close');close.onclick=()=>panel.close();header.append(title,close);
 const status=document.createElement('p'),storage=document.createElement('div'),links=document.createElement('nav'),conflicts=document.createElement('button'),help=document.createElement('p');status.setAttribute('role','status');conflicts.type='button';conflicts.textContent='Sync conflicts';conflicts.onclick=()=>{panel.close();dispatchEvent(new CustomEvent('proxima:open-conflicts'));};
 help.textContent='Touch: swipe to pan, pinch to zoom. Tap the arrow for mouse mode; use L to drag, R for colors and context menus, and Shift or Select for multiple blobs. Undo and redo are at the bottom right.';help.hidden=!ProximaWebPlatform.touch;
 P.controls.hidden=false;panel.append(header,status,storage,links,P.controls,conflicts,help);document.body.append(panel);
 let choices=[];
 async function read(){status.textContent=navigator.onLine?'Checking BOP…':'This device is offline. BOP may still be online.';if(!navigator.onLine)return;
  try{const report=await P.api('api/storage'),s=report.storage;status.textContent='BOP is online. Browser edits are saved directly on BOP.';storage.replaceChildren();const label=document.createElement('div'),bar=document.createElement('div'),used=document.createElement('span'),free=document.createElement('span'),size=n=>(n/1024**3).toLocaleString(undefined,{maximumFractionDigits:2})+' GB';label.textContent='BOP · '+size(s.freeBytes)+' free · '+size(s.syncBytes)+' synced';bar.className='portal-storage-bar';const capacity=Math.max(1,s.freeBytes+s.syncBytes);used.style.width=s.syncBytes/capacity*100+'%';free.style.flex='1';bar.append(used,free);bar.setAttribute('role','img');bar.setAttribute('aria-label',size(s.syncBytes)+' synced and '+size(s.freeBytes)+' free');storage.append(label,bar);}
  catch{status.textContent=navigator.onLine?'This device has a network connection, but BOP cannot be reached. Changes cannot be saved.':'This device is offline. BOP may still be online.';}
 }
 async function connections(){try{choices=(await P.api('api/connections')).connections;links.replaceChildren();for(const item of choices){const a=document.createElement('a');a.href=item.url+location.hash;a.textContent=item.label+(new URL(item.url).origin===location.origin?' · current':'');a.title=item.note;links.append(a);}}catch{}}
 button.onclick=()=>{panel.showModal();void read();void connections();};
 const clock=document.getElementById('lifeProgressClock');clock?.addEventListener('click',event=>{if(!event.target.closest('#overviewProjects'))return;event.preventDefault();event.stopImmediatePropagation();button.click();},true);
 addEventListener('offline',()=>{P.status.textContent='This device is offline · changes cannot be saved';P.status.dataset.state='error';if(panel.open)void read();});addEventListener('online',()=>{if(panel.open)void read();});
})();
