/* The original AppFlowy app in a blob pane. On a Papers desktop the native AppFlowy app is docked
 * over the pane (a Papers program-window template); otherwise, or if docking fails, the web app
 * renders in Papers' persistent browser view or a frame.
 * Personal sessions come only through the paired BOP exchange, never the public portal. */
(function(root){
 'use strict';
 const ORIGIN='https://bop.taild88607.ts.net:8443',desktop=location.protocol==='papers-backpack:',TEMPLATE='appflowy';
 // docked: the native window is placed over this pane and stays running while hidden, so switching back is instant.
 let surface=null,last=null,openingDocumentId=null,session=null,docked=false,sharedDock=false,nativeUnavailable=false,dockFailure='',generation=0,openGeneration=0,queue=Promise.resolve();
 // Each blob's page as BOP last confirmed it (documentId -> {workspaceId, viewId, url, launchUrl}).
 const CACHE_KEY='proxima.flow.confirmed-pages.v1';
 const pages=new Map();
 try{for(const [id,value] of Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY)||'{}'))){if(value.documentId===id&&/^[0-9a-f-]{36}$/i.test(value.workspaceId)&&/^[0-9a-f-]{36}$/i.test(value.viewId))pages.set(id,{...value,url:ORIGIN+'/app/'+value.workspaceId+'/'+value.viewId});}}catch{}
 function rememberPage(id,value){pages.set(id,value);try{localStorage.setItem(CACHE_KEY,JSON.stringify(Object.fromEntries([...pages].map(([key,v])=>[key,{workspaceId:v.workspaceId,viewId:v.viewId,url:v.url,documentId:key}]))));}catch{}}
 let nativeTabId=null,recovering=false,recoveryTimer=null,recoveryAttempts=0,recoverySlot=null,latestNativeSnapshot=null;
 const flowTab=tab=>tab.id===nativeTabId||/^(?:AppFlowy|Flow)(?:$| ·)/i.test(tab.title||'');
 function recoverNative(snapshot){
  latestNativeSnapshot=snapshot;
  if(!desktop||!sharedDock||!last||!visible()||!root.ProximaBlobLayout?.active())return;
  const tabs=(snapshot?.groups||[]).flatMap(group=>group.tabs||[]);
  if(tabs.some(tab=>tab.kind==='native'&&flowTab(tab))){clearTimeout(recoveryTimer);recoveryTimer=null;return;}
  const dead=tabs.find(tab=>tab.kind==='dormant'&&flowTab(tab));
  if(!dead||recovering||recoveryTimer)return;
  if(recoverySlot!==dead.id){recoverySlot=dead.id;recoveryAttempts=0;}
  if(recoveryAttempts>=3)return;
  const value=last,ticket=generation;
  recoveryTimer=setTimeout(()=>{
   recoveryTimer=null;if(ticket!==generation||last!==value||!visible())return;
   recovering=true;recoveryAttempts++;
   void enqueue(async()=>{
    if(ticket!==generation||last!==value||!visible())return;
    if(!await dock(value))throw Error('Flow could not restart. Its tab is retained.');
    setTimeout(()=>{if(ticket===generation&&(latestNativeSnapshot?.groups||[]).some(g=>(g.tabs||[]).some(t=>t.kind==='native'&&flowTab(t))))recoveryAttempts=0;},60000);
   }).catch(showError).finally(()=>{recovering=false;if(ticket===generation)recoverNative(latestNativeSnapshot);});
  },[750,3000,10000][recoveryAttempts]);
 }
 addEventListener('message',event=>{if(event.source===window&&event.data?.type==='papers:project:pane-layout'){recoverNative(event.data.snapshot);nativeReturned(event.data.snapshot);}});
 const withDeadline=(promise,message,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(message)),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
 const enqueue=work=>{const result=queue.catch(()=>{}).then(work);queue=result;return result;};
 const call=(operation,detail)=>root.ProximaWorkspaces.call(operation,detail);
 async function release(){
  const id=session;session=null;if(id)await call('browser-close',{sessionId:id}).catch(()=>{});
  if(docked&&!sharedDock)await call('program-window-visible',{template:TEMPLATE,visible:false}).catch(()=>{});
  if(surface)surface.hidden=true;
 }
 // The web app stands in only while native Flow is away (closed, restarting, being
 // updated). Papers reports the pane layout whenever a native window appears; the
 // moment native Flow is back, dock it and close the web app, or the web page stays
 // behind the native window and shows around its edges.
 function nativeReturned(snapshot){
  if(!session||!last||nativeUnavailable)return;
  const tabs=(snapshot?.groups||[]).flatMap(group=>group.tabs||[]);
  if(!tabs.some(tab=>tab.kind==='native'&&flowTab(tab)))return;
  const value=last,ticket=generation;
  void enqueue(async()=>{
   if(ticket!==generation||last!==value||!session||!await dock(value))return;
   const id=session;session=null;await call('browser-close',{sessionId:id}).catch(()=>{});
   if(ticket!==generation||!visible())await release();
  }).catch(()=>{});
 }
 function hide(clear=true){clearTimeout(recoveryTimer);recoveryTimer=null;++generation;if(clear){++openGeneration;last=null;openingDocumentId=null;}return enqueue(release);}
 function rect(){const r=surface.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))};}
 function visible(){return root.ProximaModalGuard?.blocked()!==true&&last&&surface?.isConnected&&!surface.closest('.blob-workspace-pane')?.hidden&&!document.hidden;}
 async function dock(value){
  if(nativeUnavailable||!value.workspaceId)return false;
  // The blob's own page in the home workspace: <workspace>/<page> (or the workspace alone).
  const target=value.viewId?value.workspaceId+'/'+value.viewId:value.workspaceId;
  const attempt=()=>call('program-window-open',{template:TEMPLATE,target,rect:rect(),layout:root.ProximaBlobLayout?.active()===true}).catch(error=>({ok:false,message:error.message}));
  let result=await attempt();
  // Switching blobs, the previous blob's scope releases Flow by restoring the window's
  // earlier (minimized) placement while this scope places it, and placement sees
  // the minimized window (-32000). The release is over by the time that answer arrives,
  // so one immediate retry docks it instead of falling back to the web app.
  if(!result?.ok&&/observed=\{X=-32000,Y=-32000/.test(result?.message||''))result=await attempt();
  // Papers takes Flow over from whichever tab held it, but a launch or release still in
  // flight can make the first placement miss; give it a moment and place it again.
  for(let i=0;i<2&&!result?.ok&&result?.code!=='PROGRAM_WINDOWS_UNAVAILABLE';i++){await new Promise(r=>setTimeout(r,600));if(!visible())break;result=await attempt();}
  if(result?.ok){dockFailure='';if(result.snapshot)latestNativeSnapshot=result.snapshot;if(result.tabId)nativeTabId=result.tabId;docked=true;sharedDock=root.ProximaBlobLayout?.active()===true;if(sharedDock)root.ProximaBlobLayout.accept(result);return true;}
  // Older Papers builds, or no native AppFlowy on this computer: use the web app from now on.
  if(result?.code==='PROGRAM_WINDOWS_UNAVAILABLE'||/unknown|unsupported|not installed/i.test(result?.message||''))nativeUnavailable=true;
  // Desktop Flow exists but could not be placed: say why rather than show the signed-out web app.
  dockFailure=nativeUnavailable?'':(result?.message||result?.error||'Flow could not be placed here.');
  console.warn('AppFlowy native window unavailable here.',result?.message||result);
  return false;
 }
 // Desktop Flow could not be placed here: say why and offer to place it again.
 function showDockFailure(){
  const note=document.createElement('div');note.className='full-appflowy-elsewhere';
  note.style.cssText='display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--muted,#9aa3b2);font:13px/1.4 system-ui,sans-serif;text-align:center;padding:16px';
  const text=document.createElement('div');text.textContent='Flow could not be placed here. '+dockFailure;
  const bring=document.createElement('button');bring.type='button';bring.textContent='Try again';
  bring.style.cssText='padding:6px 12px;border-radius:6px;border:1px solid var(--line,#3a4150);background:transparent;color:inherit;cursor:pointer';
  bring.addEventListener('click',()=>{if(last)void present(last).catch(showError);});
  note.append(text,bring);surface.replaceChildren(note);
 }
 async function present(value,launchUrl=value.launchUrl||value.url){
  const ticket=++generation;return enqueue(async()=>{
   await release();if(ticket!==generation||!visible())return;
   surface.hidden=false;
   if(desktop){
    surface.replaceChildren();
    if(await dock(value)){if(ticket!==generation||!visible())await release();return;}
    if(dockFailure){showDockFailure();return;}
    const result=await call('browser-open',{url:launchUrl,rect:rect()});if(!result?.ok||!result.sessionId)throw Error(result?.message||'AppFlowy could not open.');session=result.sessionId;if(ticket!==generation||!visible())await release();
   }
   else{const frame=document.createElement('iframe');frame.title='AppFlowy';frame.src=launchUrl;surface.replaceChildren(frame);}
  });
 }
 // One move in flight at a time, always to the newest rectangle: a resize sends dozens of
 // positions a second and queuing them all left the native window crawling behind.
 let moving=false,movePending=false;
 function place(){
  if(!visible()||sharedDock)return;
  if(moving){movePending=true;return;}
  moving=true;movePending=false;
  const task=session?call('browser-move',{sessionId:session,rect:rect()}):docked?call('program-window-move',{template:TEMPLATE,rect:rect()}):null;
  void Promise.resolve(task).catch(()=>{}).finally(()=>{moving=false;if(movePending)place();});
 }
 async function open(binding,body,name,intervalId){
  if(last?.documentId===binding.documentId&&(session||docked)&&visible()&&!surface.hidden){place();return;}
  await hide();
  const opening=++openGeneration;
  if(!surface){surface=document.createElement('div');surface.className='full-appflowy-surface';surface.hidden=true;
   let scheduled=false;const move=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;place();});};new ResizeObserver(move).observe(surface);addEventListener('resize',move);
   document.addEventListener('visibilitychange',()=>{if(!visible())return;if(desktop? !session&&(surface.hidden||!docked): !surface.querySelector('iframe'))void present(last).catch(showError);});
  }
  body.append(surface);
  const pane=body.closest('.blob-workspace-pane');
  openingDocumentId=binding.documentId;
  if(!pane.__fullAppFlowyObserver){pane.__fullAppFlowyObserver=new MutationObserver(()=>{if(pane.hidden)void hide();});pane.__fullAppFlowyObserver.observe(pane,{attributes:true,attributeFilter:['hidden']});}
  // "Connecting…" only when it actually takes a moment, never on an ordinary tab switch.
  const status=pane.querySelector('[role=status]'),CONNECTING='Connecting to AppFlowy…';
  if(status){status.textContent='';status.hidden=true;}
  const slow=status?setTimeout(()=>{if(opening===openGeneration&&status.hidden){status.hidden=false;status.textContent=CONNECTING;}},900):null;
  const settled=()=>{clearTimeout(slow);if(status&&status.textContent===CONNECTING){status.textContent='';status.hidden=true;}};
  const remember=value=>({url:value.url,launchUrl:value.launchUrl,workspaceId:value.workspaceId,viewId:value.viewId,documentId:binding.documentId});
  try{
  // The native app needs only the page, so a page already known shows at once; BOP is
  // asked afterwards and only a changed answer (say the page was deleted) re-docks.
  const known=pages.get(binding.documentId);
  if(known&&desktop&&!nativeUnavailable){
   last={...known};
   await present(last);
   if(opening!==openGeneration)return;
   if(docked||!visible()){
    settled();
    void ask(binding,name,intervalId).then(value=>{
     if(opening!==openGeneration)return;
     const next=remember(value);rememberPage(binding.documentId,next);
     if(next.workspaceId!==last.workspaceId||next.viewId!==last.viewId){last=next;void present(last).catch(showError);}else last=next;
    }).catch(()=>{});
    return;
   }
  }
  const value=await ask(binding,name,intervalId);
  if(opening!==openGeneration)return;
  last=remember(value);rememberPage(binding.documentId,last);
  await present(last,value.launchUrl||value.url);
  settled();
  }catch(error){clearTimeout(slow);showError(error);throw error;}
 }
 // BOP's answer for a blob: its page in the home workspace, plus a fresh sign-in link for the web app.
 async function ask(binding,name,intervalId){
  let value=binding.appflowyWorkspaceId?{workspaceId:binding.appflowyWorkspaceId,viewId:binding.appflowyPageId,url:ORIGIN+'/app/'+binding.appflowyWorkspaceId+(binding.appflowyPageId?'/'+binding.appflowyPageId:'')}:null;
  const api=root.__proximaDeviceCopy;
  if(api){
   const devices=await withDeadline(api.devices(),'Device lookup is unavailable. Your Flow page is retained.',8000),bop=devices.others.find(device=>device.id==='44091a08-55e1-46b8-8fa7-df60366779c2'||/^bop$/i.test(device.name));
   if(!bop)throw Error('Connect this device to BOP to open AppFlowy.');
   const response=await withDeadline(api.exchange(bop,{workspaceProtocol:1,appflowy:{operation:'open',documentId:binding.documentId,name}}),'BOP is unavailable. Open a previously confirmed Flow page or retry when BOP reconnects.',12000);value=response.appflowy;
   if(value?.error)throw Error(value.error);
   if(!value||!value.url.startsWith(ORIGIN+'/app/')||!value.launchUrl?.startsWith(ORIGIN+'/papers-launch#'))throw Error('BOP did not confirm the AppFlowy workspace.');
   const item=Store.timelineIntervals().find(item=>item.id===intervalId),current=(item?.templates||[]).find(b=>b.kind==='appflowy');
   if(!current||current.documentId!==binding.documentId)throw Error('This blob template changed while AppFlowy was opening.');
   if(current.appflowyWorkspaceId!==value.workspaceId||current.appflowyPageId!==value.viewId){const saved=await Store.command({type:'timeline-interval.template',ifRev:item.rev,payload:{intervalId,template:'appflowy',appflowyWorkspaceId:value.workspaceId,appflowyPageId:value.viewId,expectedDocumentId:binding.documentId}});if(!saved.ok)throw Error('This blob changed before its AppFlowy link was saved.');}
  }
  if(!value)throw Error('Open this AppFlowy template in Papers on one of your connected devices first.');
  return value;
 }
 function showError(error){const pane=surface?.closest('.blob-workspace-pane'),status=pane?.querySelector('[role=status]');if(status){status.hidden=false;status.textContent='AppFlowy is unavailable. '+error.message;}}
 root.ProximaFullAppFlowy=Object.freeze({open,hide,setModalBlocked(blocked){if(sharedDock)return;if(docked)void call('program-window-visible',{template:TEMPLATE,visible:!blocked&&!!last&&!surface?.closest('.blob-workspace-pane')?.hidden}).catch(showError);else if(blocked&&session)void release();else if(!blocked&&last&&visible())void present(last).catch(showError);}});
 // Leaving the page hands the native window back to the desktop instead of keeping it hidden.
 addEventListener('pagehide',()=>{void hide();if(docked&&!sharedDock){docked=false;void call('program-window-close',{template:TEMPLATE}).catch(()=>{});}});
})(globalThis);
