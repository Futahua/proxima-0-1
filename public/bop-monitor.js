// Reachability belongs to the existing authenticated device transport. A probe
// checks the live replica without sending local edits or claiming sync completion.
(()=>{
  const anchor=document.getElementById('lifeProgressClock');if(!anchor)return;
  anchor.style.cursor='pointer';
  const panel=document.createElement('dialog');panel.id='deviceMonitor';panel.innerHTML='<header><nav role="tablist" aria-label="Device monitor"><button type="button" id="monitorStorageTab" role="tab" aria-selected="true" aria-controls="monitorStorage">Storage</button><button type="button" id="monitorConflictsTab" role="tab" aria-selected="false" aria-controls="monitorConflicts">Sync conflicts</button></nav><button type="button" data-close aria-label="Close device monitor">×</button></header><div id="monitorStorage" role="tabpanel" aria-labelledby="monitorStorageTab"><div id="monitorDevices"></div><footer><button type="button" id="bopMonitor">BOP · Checking</button><div class="monitor-local"></div></footer></div><div id="monitorConflicts" role="tabpanel" aria-labelledby="monitorConflictsTab" hidden></div>';
  document.body.append(panel);panel.querySelector('[data-close]').onclick=()=>panel.close();
  const open=()=>{if(!panel.open)panel.showModal();void check();};anchor.addEventListener('click',event=>{if(!event.target.closest('#overviewProjects'))return;event.preventDefault();event.stopImmediatePropagation();open();},true);
  const tabs=[panel.querySelector('#monitorStorageTab'),panel.querySelector('#monitorConflictsTab')];
  function selectTab(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});panel.querySelector('#monitorStorage').hidden=index!==0;panel.querySelector('#monitorConflicts').hidden=index!==1;if(index===1)dispatchEvent(new CustomEvent('proxima:open-conflicts',{detail:{host:panel.querySelector('#monitorConflicts')}}));else void check();}
  tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectTab(index));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;selectTab(next);tabs[next].focus();}});});tabs[1].tabIndex=-1;
  const button=panel.querySelector('#bopMonitor');
  const style=document.createElement('style');style.textContent=`
    #deviceMonitor{box-sizing:border-box;width:min(400px,calc(100vw - 28px));max-height:85vh;overflow:auto;color:var(--ink,#e6e9ef);background:var(--panel,#222a30);border:1px solid var(--line,#46525d);border-radius:16px;padding:20px;font:12px/1.45 system-ui}
    #deviceMonitor::backdrop{background:#0008}#deviceMonitor button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
    #deviceMonitor>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}#deviceMonitor [data-close]{font-size:20px;color:var(--dim,#aab5bf);width:28px;height:28px}#deviceMonitor [role=tablist]{display:flex;gap:18px}#deviceMonitor [role=tab]{padding:8px 0;color:var(--dim,#aab5bf);border-bottom:2px solid transparent}#deviceMonitor [role=tab][aria-selected=true]{color:var(--ink,#e6e9ef);border-bottom-color:#a4bf8f}#deviceMonitor [hidden]{display:none!important}
    #monitorConflicts .proxima-conflicts{position:static;inset:auto;display:block;padding:0;background:none;z-index:auto}#monitorConflicts .proxima-conflicts>section{width:auto;max-width:none;max-height:none;border:0;box-shadow:none;background:none;padding:0}#monitorConflicts .proxima-conflicts header button{display:none}#monitorConflicts .proxima-conflicts h2{font-size:13px}#monitorConflicts .proxima-conflict-options{grid-template-columns:1fr}#monitorConflicts .proxima-conflict-option{border:1px solid var(--line,#46525d);padding:10px}
    #monitorDevices .monitor-bar{position:relative}#monitorDevices .monitor-bar[data-has-sync=true]::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#a4bf8f;pointer-events:none}#monitorDevices .monitor-meta>span:first-child{display:flex;align-items:center;gap:5px}#monitorDevices .monitor-meta>span:first-child::before{content:'';width:5px;height:5px;border-radius:1px;background:#a4bf8f;flex-shrink:0}
    #deviceMonitor .monitor-legend{display:flex;gap:14px;color:var(--dim,#aab5bf);font-size:10px;margin-bottom:4px}#deviceMonitor .monitor-legend span{display:flex;align-items:center;gap:5px}#deviceMonitor i{display:inline-block;width:6px;height:6px;border-radius:2px}#deviceMonitor .used{background:#758995}#deviceMonitor .synced{background:#a4bf8f}#deviceMonitor .free{background:transparent;box-shadow:inset 0 0 0 1px #758995;border-radius:0 4px 4px 0}
    #monitorDevices section[data-growth-paused=true] .monitor-bar .free{background:#b95050;box-shadow:inset 0 0 0 1px #d27676}#monitorDevices section{padding:14px 0}#monitorDevices .monitor-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}#monitorDevices strong{font-weight:550}#monitorDevices .monitor-self{color:var(--dim,#aab5bf);font-size:10px;font-weight:400;margin-left:6px}#monitorDevices .monitor-free{font-variant-numeric:tabular-nums;white-space:nowrap}
    #monitorDevices .monitor-bar{height:7px;margin:8px 0 6px;border-radius:4px;background:transparent;overflow:hidden;display:flex}#monitorDevices .monitor-bar span{height:100%;flex-shrink:0}#monitorDevices .monitor-meta{display:flex;justify-content:space-between;gap:10px;color:var(--dim,#aab5bf);font-size:10px;font-variant-numeric:tabular-nums}#monitorDevices .monitor-stale{color:#c5a688}
    #deviceMonitor footer{border:0;margin-top:9px;padding-top:0;display:grid;gap:7px;color:var(--dim,#aab5bf);font-size:11px}#deviceMonitor .monitor-conflicts{text-align:left;color:var(--dim,#aab5bf);font-size:10px;margin-top:5px}
    #bopMonitor{font:500 11px/1.4 system-ui!important;text-align:left;color:var(--dim,#aab5bf);white-space:normal}
    #bopMonitor[data-state="online"]{color:#a9c99b}
    #bopMonitor[data-state="offline"]{color:#d6a58c}
    #bopMonitor:focus-visible{outline:2px solid currentColor;outline-offset:2px}
  `;document.head.append(style);
  const local=panel.querySelector('.monitor-local');
  const statusFooter=panel.querySelector('footer');
  let busy=false,lastSuccess=0,timer,peerId='44091a08-55e1-46b8-8fa7-df60366779c2';
  let saved=[];try{saved=JSON.parse(localStorage.getItem('proxima.device-storage-readings')||'[]');}catch{}
  const readings=new Map(Array.isArray(saved)?saved:[]);
  const size=n=>Number.isFinite(n)?(n/1024**3).toLocaleString(undefined,{maximumFractionDigits:2})+' GB':'Unknown';
  async function storageRows(){
    if(!panel.open)return;
    const container=panel.querySelector('#monitorDevices');
    try{
      const api=globalThis.__proximaDeviceCopy,list=await api.devices();
      const devices=[{...list.self,id:'local',local:true},...list.others];
      for(const name of ['SlopTop','LapDog','BOP'])if(!devices.some(d=>d.name?.toLowerCase()===name.toLowerCase()))devices.push({id:name,name,unlisted:true});
      if(!devices.some(d=>d.kind==='phone'))devices.push({id:'phone',name:'Phone',unlisted:true});
      devices.sort((a,b)=>Number(/^bop$/i.test(a.name))-Number(/^bop$/i.test(b.name)));
      statusFooter.remove();container.replaceChildren();
      const scaleBars=()=>{
        const bars=[...container.querySelectorAll('.monitor-bar[data-capacity]')];
        const maximum=Math.max(1,...bars.map(bar=>Number(bar.dataset.capacity)));
        for(const bar of bars){bar.style.width=(Number(bar.dataset.capacity)/maximum*100)+'%';bar.title='Shared scale: full row = '+size(maximum);}
      };
      await Promise.all(devices.map(async device=>{
        const row=document.createElement('section'),head=document.createElement('div'),name=document.createElement('strong'),free=document.createElement('span'),bar=document.createElement('div'),detail=document.createElement('div');head.className='monitor-row-head';name.textContent=device.name;if(device.local){const self=document.createElement('span');self.className='monitor-self';self.textContent='you';name.append(self);}free.className='monitor-free';const label=document.createElement('div');label.style.cssText='display:flex;align-items:center;gap:6px';label.append(name);head.append(label,free);bar.className='monitor-bar';detail.className='monitor-meta';detail.textContent='Reading…';row.append(head,bar,detail);container.append(row);
        let policy=null;const control=/^bop$/i.test(device.name)?null:document.createElement('button');
        const paint=()=>{if(!control)return;row.dataset.growthPaused=String(!!policy?.enabled);control.innerHTML=policy?.enabled?'<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 2.5v11L13 8z"/></svg>':'<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><rect fill="currentColor" x="3" y="2" width="3" height="12" rx=".5"/><rect fill="currentColor" x="10" y="2" width="3" height="12" rx=".5"/></svg>';control.disabled=!policy;control.setAttribute('aria-pressed',String(!!policy?.enabled));control.setAttribute('aria-label',(policy?.enabled?'Resume adding files on ':'Pause storage growth on ')+device.name);control.title=policy?(policy.enabled?'Resume adding files. Removed files stay dimmed until you open them; resuming does not download them again.':'Pause storage growth: new downloads replace the oldest local files by size, rounded up to whole files. Folder entries stay dimmed; only files verified on BOP can leave this device.')+(policy.deferredBytes?' Some files are protected or waiting for BOP.':''):'Connect to this device to change its cache setting.';};
        if(control){control.type='button';control.style.cssText='font-size:12px;color:var(--dim,#aab5bf);width:18px;padding:0;line-height:1';label.append(control);paint();control.onclick=async()=>{control.disabled=true;try{const desired=!policy.enabled;policy=device.local?await globalThis.ProximaWorkspaces.cachePolicy(desired,policy.enabled):(await api.exchange(device,{workspaceProtocol:1,cacheControl:{enabled:desired,expected:policy.enabled}})).cachePolicy;paint();}catch(error){paint();control.title=error.message||'The device did not confirm the setting.';}};}
        if(/^bop$/i.test(device.name))row.append(statusFooter);
        let state='Live reading';
        try{
          if(device.unlisted)throw Error('Not connected to this device.');
          if(!device.local&&!navigator.onLine)throw Error('This viewing device is offline.');
          const report=device.local?{storage:await globalThis.ProximaWorkspaces.call('workspace-files',{operation:'storage-status'}),cachePolicy:await globalThis.ProximaWorkspaces.cachePolicy()}:(await api.exchange(device,{workspaceProtocol:1,storageProbe:true,vv:{},changes:[]}));
          const reading=report?.storage;policy=report?.cachePolicy||null;paint();
          if(!reading||!Number.isFinite(reading.freeBytes))throw Error('Storage reporting unavailable on this version.');readings.set(device.id,reading);try{localStorage.setItem('proxima.device-storage-readings',JSON.stringify([...readings]));}catch{}
        }catch(error){state=error.message||'Unavailable';}
        const reading=readings.get(device.id);
        if(reading){
          const total=Math.max(1,reading.totalBytes),available=Math.max(0,Math.min(total,reading.freeBytes)),used=total-available,sync=Math.max(0,Math.min(used,reading.syncBytes));
          const shown=available+sync;bar.dataset.hasSync=String(sync>0);
          free.textContent=size(available)+' free';bar.dataset.capacity=String(shown);
          for(const [kind,bytes] of [['synced',sync],['free',available]]){const part=document.createElement('span');part.className=kind;part.style.width=(shown?bytes/shown*100:0)+'%';part.title=size(bytes)+(kind==='synced'?' sync content':' free');bar.append(part);}
          bar.setAttribute('role','img');bar.setAttribute('aria-label',`${size(sync)} sync content and ${size(available)} free; shared scale across devices; other used space omitted`);
          const content=document.createElement('span'),capacity=document.createElement('span');content.textContent=size(reading.syncBytes)+' sync · '+reading.syncFiles+' files';capacity.textContent='';detail.replaceChildren(content,capacity);
          const fresh=state==='Live reading';row.title=`${reading.volume} · ${fresh?'Read':'Last reading'} ${new Date(reading.at).toLocaleString()}${fresh?'':' · '+state}`;
          if(!fresh){free.classList.add('monitor-stale');capacity.textContent='Cached '+new Date(reading.at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
          scaleBars();
        }else{free.textContent='Unavailable';free.classList.add('monitor-stale');detail.textContent=state;bar.style.visibility='hidden';}
      }));
    }catch(error){container.textContent=error.message||'Device list unavailable.';container.after(statusFooter);}
  }
  async function localStatus(){
    try{
      const state=await globalThis.ProximaSync?.status(peerId);
      local.textContent=!state?'Can’t check whether BOP has your latest changes.':state.pendingRecords?navigator.onLine?'Your changes are saved here, waiting for BOP.':'Your changes are saved here. They can sync when you reconnect.':'Your Proxima changes are saved on BOP. Attached files may still be copying.';
      local.title='This checks saved Proxima information. Attached files and other devices are checked separately.';
    }catch{local.textContent='Can’t check whether BOP has your latest changes.';}
  }
  function show(state,text,detail){button.dataset.state=state;button.textContent=text;button.title=detail;button.setAttribute('aria-label',text+'. '+detail);}
  async function check(){
    if(busy||document.hidden||!panel.open)return;busy=true;clearTimeout(timer);void localStatus();void storageRows();
    if(!navigator.onLine){show('unknown','This device is offline. BOP can’t be checked.','BOP may still be online. Your saved work stays on this device.');busy=false;timer=setTimeout(check,60000);return;}
    show('checking','Checking BOP…','Checking whether the server answers.');
    try{
      const api=globalThis.__proximaDeviceCopy;if(!api)throw Error('Device connection unavailable.');
      const list=await api.devices();const peer=list.others.find(p=>p.id==='44091a08-55e1-46b8-8fa7-df60366779c2'||/^bop$/i.test(p.name));
      if(!peer){show('unknown','BOP isn’t connected to this device yet.','Connect BOP to this device to check it.');return;}peerId=peer.id;
      const start=performance.now();const reply=await api.exchange(peer,{protocol:2,probe:true,vv:{},changes:[]});
      if(reply?.protocol!==2||!reply.node)throw Error('Server returned an unexpected response.');
      if(!navigator.onLine){show('unknown','This device is offline. BOP can’t be checked.','BOP may still be online.');return;}
      lastSuccess=Date.now();show('online','BOP server is ready',`Answered in ${Math.round(performance.now()-start)} ms. Checked ${new Date(lastSuccess).toLocaleTimeString()}. Tap to check again.`);
    }catch(error){show('unknown',navigator.onLine?'Can’t reach BOP. It may be asleep, disconnected, or its server stopped.':'This device is offline. BOP can’t be checked.',(error?.message||'No answer.')+(lastSuccess?' Last reached '+new Date(lastSuccess).toLocaleTimeString()+'.':'')+' Tap to retry.');}
    finally{busy=false;void localStatus();timer=setTimeout(check,60000);}
  }
  button.addEventListener('click',check);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);if(button.dataset.state==='online')show('stale','BOP hasn’t been checked recently.','Return to Proxima to check BOP.');}else void check();});
  window.addEventListener('pagehide',()=>clearTimeout(timer));
  panel.addEventListener('close',()=>clearTimeout(timer));
  window.addEventListener('online',()=>{void localStatus();void check();});
  window.addEventListener('offline',()=>{void localStatus();show('unknown','This device is offline. BOP can’t be checked.','BOP may still be online.');});
  window.addEventListener('proxima-sync:local-change',()=>void localStatus());
  void check();
})();
