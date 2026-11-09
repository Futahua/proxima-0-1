/* Blob templates. Every As you Go blob owns one folder in the single synced As you Go root
 * ('ayg-root'), named after the blob. Opening the blob opens As you Go inside that folder; the
 * root and other blobs' folders stay reachable. The folder outlives the blob. Deleting the folder
 * leaves the blob without a template until As you Go is chosen again. */
(function(root){
 'use strict';
 const ROOT='ayg-root',pageQuery=new URL(location.href).searchParams,projectTab=pageQuery.get('blob-project');
 const bindings=item=>item?.templates??(item?.template?[item.template]:[]);
 let activeKind=pageQuery.get('blob-template')||null;
 addEventListener('proxima:blob-template-selected',event=>{if(pane?.hidden)return;activeKind=event.detail.kind;if(event.detail.coordinated)void selectSharedTemplate(activeKind);});
 let pane,frame,frameFolder=null,selected,origin,chain=Promise.resolve();const flushes=new Map();
 const folders=new Map(); // folderId -> {exists,binned,name,icon}, from the synced root
 const isV2=item=>item?.template?.kind==='as-you-go'&&item.template.version===2&&typeof item.template.folderId==='string';
 // A blob is propagated while its folder is not deleted. A folder not synced here yet still counts.
 function propagated(item){return bindings(item).some(binding=>binding.kind==='appflowy'||binding.kind==='as-you-go'&&binding.version===2&&!folders.get(binding.folderId)?.binned);}
 function imageOf(icon){
  if(typeof icon==='string')return /^(data:image\/|https?:\/\/)/i.test(icon)?icon:null;
  if(icon&&typeof icon==='object')for(const value of Object.values(icon)){const found=imageOf(value);if(found)return found;}
  return null;
 }
 /** For the timeline's blob button: whether the blob has a folder, and the folder's picture. */
 function button(item){return propagated(item)?{propagated:true,icon:imageOf(folders.get(item.template?.folderId)?.icon)}:{propagated:false,icon:null};}
 function refreshTimelines(){document.querySelectorAll('.exact-timeline').forEach(node=>root.ExactTimeline?.mount(node,Store)?.refresh());}
 let reading=null;
 function readFolders(){return reading??=(async()=>{try{
  const next=await root.ProximaWorkspaces.folders(ROOT),before=JSON.stringify([...folders]);
  folders.clear();for(const [id,value] of Object.entries(next))folders.set(id,value);
  if(JSON.stringify([...folders])!==before)refreshTimelines();
 }catch{}finally{reading=null;}})();}
 addEventListener('proxima:workspace-changed',()=>void readFolders());
 void readFolders();

 function build(){if(pane)return;
  pane=document.createElement('section');pane.className='blob-workspace-pane';pane.hidden=true;pane.setAttribute('aria-label','Blob contents');
  const head=document.createElement('header'),title=document.createElement('strong'),select=document.createElement('select'),close=document.createElement('button'),status=document.createElement('p'),body=document.createElement('div'),conflicts=document.createElement('aside');
  for(const [value,label] of [['','Add template…'],['as-you-go','Go'],['appflowy','Flow'],['remove','Remove current template']]){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}select.setAttribute('aria-label','Blob template');close.textContent='×';close.setAttribute('aria-label','Close blob contents');status.setAttribute('role','status');
  const loading=document.createElement('div');loading.className='blob-workspace-loading';loading.textContent='Opening folder…';loading.hidden=true;body.append(loading);
  const tabs=document.createElement('nav');tabs.className='blob-template-tabs';tabs.setAttribute('aria-label','Blob templates');head.append(tabs,select,close);conflicts.hidden=true;conflicts.className='blob-workspace-conflicts';pane.append(head,status,conflicts,body);pane.parts={title,select,status,body,conflicts,loading,tabs};document.body.append(pane);close.onclick=()=>closePane();
  // Pane geometry is an input to timeline exposure, not a timeline clock tick.
  let geometryFrame=0;const notifyGeometry=()=>{if(geometryFrame)return;geometryFrame=requestAnimationFrame(()=>{geometryFrame=0;dispatchEvent(new CustomEvent('proxima:blob-pane-geometry'));});};
  const geometryObserver=new MutationObserver(notifyGeometry);geometryObserver.observe(pane,{attributes:true,attributeFilter:['hidden','style','class']});
  const geometryResize=new ResizeObserver(notifyGeometry);geometryResize.observe(pane);
  addEventListener('pagehide',()=>{geometryObserver.disconnect();geometryResize.disconnect();cancelAnimationFrame(geometryFrame);},{once:true});
  select.onchange=async()=>{select.disabled=true;try{
   if(!select.value)return;await flush();const item=Store.timelineIntervals().find(x=>x.id===selected);
   // A deleted folder (or a first-generation template) is replaced by a fresh folder.
   const renew=select.value==='as-you-go'&&!!item.template&&(!isV2(item)||folders.get(item.template.folderId)?.binned);
   const r=await Store.command({type:'timeline-interval.template',ifRev:item.rev,payload:{intervalId:item.id,template:select.value==='remove'?null:select.value,removeKind:activeKind,...(renew?{renew:true}:{})}});
   if(!r.ok)throw Error('The blob changed before its template could be saved.');
   activeKind=select.value;await mount(selected);refreshTimelines();
  }catch(e){status.hidden=false;status.textContent=e.message;}finally{select.disabled=false;}};
  setInterval(()=>{if(!pane.hidden&&frame&&activeKind==='as-you-go'&&!reporting)void report();},3000);
 }
 async function flush(){if(!frame||activeKind!=='as-you-go')return;const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{flushes.delete(requestId);reject(Error('The file pane has not confirmed saving yet.'));},15000);flushes.set(requestId,{resolve,reject,timer});frame.contentWindow.postMessage({type:'proxima:workspace:flush',workspaceId:ROOT,requestId},origin);});}
 // One status check at a time: on the phone a check can take longer than the interval.
 let reporting=null;
 function report(){return reporting||(reporting=reportNow().finally(()=>{reporting=null;}));}
 async function reportNow(){try{const peers=(await root.__proximaDeviceCopy?.devices())?.others||[],state=await root.ProximaWorkspaces.status(ROOT,peers),errors=[...root.ProximaWorkspaces.errors.values()];pane.parts.status.textContent=state.label+(errors.length?' · '+errors[0].message:'');pane.parts.status.dataset.state=errors.length?'error':state.kind;
  const waitingDevices=peers.filter(peer=>(state.waiting||[]).includes(peer.name));
  root.ProximaBlobLayout?.setPendingSyncDevices(waitingDevices);
  const goTab=[...pane.parts.tabs.querySelectorAll('button')].find(tab=>tab.textContent.startsWith('Go'));if(goTab&&goTab.textContent.startsWith('Go')){goTab.textContent='Go'+waitingDevices.map(d=>' '+(d.kind==='phone'?'📱':'💻')+'*').join('');goTab.title=waitingDevices.length?'Waiting for '+waitingDevices.map(d=>d.name).join(', '):'Go';}
  // Waiting is shown on Go only; errors and conflicts retain their messages.
  pane.parts.status.hidden=!errors.length&&['synced','local','waiting'].includes(state.kind);
  const conflicts=await root.ProximaWorkspaces.conflicts(ROOT);const area=pane.parts.conflicts;area.replaceChildren();area.hidden=!conflicts.length;
  for(const conflict of conflicts){const row=document.createElement('div'),title=document.createElement('strong');title.textContent=conflict.name+' — both versions kept';row.append(title);for(const version of conflict.versions||[]){if(version.kind!=='content')continue;const choose=document.createElement('button');choose.type='button';choose.textContent='Keep '+version.device+' · '+version.hash.slice(0,7);choose.onclick=async()=>{choose.disabled=true;try{await root.ProximaWorkspaces.restore(ROOT,conflict.entryId,version.id);await report();}catch(error){pane.parts.status.textContent=error.message;choose.disabled=false;}};row.append(choose);}area.append(row);}
 }catch(e){pane.parts.status.textContent=e.message;}}
 // One As you Go page stays alive for every blob: opening another blob moves it to that folder
 // instead of loading As you Go again, and a new page stays invisible until its first themed render.
 let readyTimer=0,frameReady=false,wantedFolder=null,creatingFrame=null,templateEntry=null,navigation=null,openSequence=0,frameNavigationProtocol=0;
 function note(text){let el=pane.parts.body.querySelector('.blob-workspace-note');if(!el){el=document.createElement('p');el.className='blob-workspace-note';pane.parts.body.prepend(el);}el.textContent=text;el.hidden=!text;if(frame)frame.hidden=!!text||activeKind==='task';}
 function revealFrame(){clearTimeout(readyTimer);pane.parts.loading.hidden=true;pane.parts.loading.textContent='Opening folder…';if(pane.parts.status.textContent==='Opening folder…')pane.parts.status.textContent='';if(frame){frame.style.pointerEvents='';frame.style.visibility='visible';}}
 function confirmedFolder(folderId,requestId){frameFolder=folderId;if(!navigation||folderId!==navigation.folderId||frameNavigationProtocol>=1&&requestId!==navigation.requestId)return;const done=navigation;navigation=null;clearTimeout(done.timer);revealFrame();done.resolve(true);}
 function cancelNavigation(){if(!navigation)return;const old=navigation;navigation=null;clearTimeout(old.timer);old.resolve(false);}
 function waitForFolder(folderId){cancelNavigation();wantedFolder=folderId;pane.parts.loading.hidden=false;if(frame)frame.style.pointerEvents='none';return new Promise((resolve,reject)=>{const pending={folderId,requestId:crypto.randomUUID(),resolve,reject,timer:0};pending.timer=setTimeout(()=>slowFolder(pending,1),20000);navigation=pending;});}
 // BOP can take a while to answer (its file syncs share one queue). Giving up here used to leave the cover
 // up for good, even after the folder arrived. Keep waiting, start the page again once, then say so.
 function slowFolder(pending,stage){if(navigation!==pending)return;const cover=pane.parts.loading;
  if(stage===1){cover.textContent='BOP is slow to answer; still opening this folder…';pending.timer=setTimeout(()=>slowFolder(pending,2),25000);return;}
  if(stage===2){cover.textContent='Starting the folder view again…';if(frame&&!creatingFrame){frame.remove();frame=null;frameReady=false;void createFrame(pending.folderId,pane.parts.title.textContent).catch(()=>{});}pending.timer=setTimeout(()=>slowFolder(pending,3),45000);return;}
  cover.textContent='This folder has not opened: BOP is not answering. Open the blob again to retry.';}
 // The page hears folder requests only once it is ready; a request made earlier (opening a blob
 // while the page is still preloading another folder) waits here and is sent on 'ready'.
 function goToWanted(){if(!frame||!wantedFolder)return;
  // Sent before 'ready' too: a page still starting keeps it and opens that folder first.
  if(!frameReady||!navigation)return;frame.contentWindow.postMessage({type:'proxima:workspace:open-folder',workspaceId:ROOT,folderId:wantedFolder,requestId:navigation.requestId},origin);}
 function prepareTemplate(){return templateEntry??=(async()=>{const phone=new URL(location.href).searchParams.has('papers-phone');const entry=phone?{url:new URL('../ayg/workspace-20260730b.html',location.href).href}:(await root.ProximaWorkspaces.request('papers:project:workspace-template')).template;if(!entry?.url)throw Error('As you Go is unavailable on this device.');return entry;})().catch(error=>{templateEntry=null;throw error;});}
 function createFrame(folderId,title){if(frame)return Promise.resolve(frame);if(creatingFrame)return creatingFrame;creatingFrame=(async()=>{
  const phone=new URL(location.href).searchParams.has('papers-phone'),entry=await prepareTemplate();
  const url=new URL(entry.url);url.searchParams.set('papers-blob-workspace',ROOT);url.searchParams.set('as-you-go-folder',folderId);url.searchParams.set('papers-blob-parent-origin',location.origin==='null'?location.protocol+'//'+location.host:location.origin);url.searchParams.set('papers-embedded-surface','proxima-blob');url.searchParams.set('papers-inline-device','1');if(phone)url.searchParams.set('papers-phone','1');origin=url.origin==='null'?url.protocol+'//'+url.host:url.origin;
  frameReady=false;frame=document.createElement('iframe');frame.title=title+' · Go';frame.style.pointerEvents='none';frame.style.visibility='hidden';frame.style.background='#302d24';frame.src=url.href;frameFolder=folderId;(root.ProximaBlobLayout?.active()?root.ProximaBlobLayout.panel():pane.parts.body).append(frame);
  // A slow start must never reveal a different preloaded folder.
  readyTimer=setTimeout(()=>{if(!frameReady&&navigation){pane.parts.status.hidden=false;pane.parts.status.textContent='Opening folder…';}},8000);
  return frame;
 })().finally(()=>{creatingFrame=null;});return creatingFrame;}
 async function mount(id,request=openSequence){build();const item=Store.timelineIntervals().find(x=>x.id===id);if(!item)throw Error('This blob no longer exists.');pane.hidden=false;selected=id;pane.parts.title.textContent=item.name;
  if(activeKind==='task'){await showTask(item);return;}
  root.ProximaBlobTasks?.hide();
  const shared=location.protocol==='papers-backpack:'&&bindings(item).some(b=>b.kind==='appflowy')&&isV2(item)&&!folders.get(item.template.folderId)?.binned;
  if(shared){const requestedKind=activeKind;await root.ProximaFullAppFlowy?.suspend();root.ProximaBlobLayout.setTaskName(item.name);await root.ProximaBlobLayout.ensure(pane,await prepareTemplate());activeKind=requestedKind;if(frame&&frame.parentElement!==root.ProximaBlobLayout.panel()){frame.style.visibility='hidden';frameReady=false;root.ProximaBlobLayout.panel().append(frame);}}
  else {root.ProximaBlobLayout?.disable();if(frame&&frame.parentElement!==pane.parts.body){frame.style.visibility='hidden';frameReady=false;pane.parts.body.append(frame);}}
  renderTemplateTabs(item);
  if(activeKind==='appflowy'&&bindings(item).some(b=>b.kind==='appflowy'))startEditor(item,request);
  if(!shared&&activeKind==='appflowy'&&bindings(item).some(b=>b.kind==='appflowy')){cancelNavigation();note('');if(frame)frame.hidden=true;pane.classList.add('has-folder');pane.parts.loading.hidden=true;pane.parts.status.hidden=true;pane.parts.conflicts.hidden=true;return;}
  if(!shared)void root.ProximaFullAppFlowy?.hide();
  if(isV2(item)&&!folders.has(item.template.folderId))await readFolders();
  if(request!==openSequence)return;
  if(!isV2(item)||folders.get(item.template.folderId)?.binned){
   pane.classList.remove('has-folder');pane.parts.status.hidden=false;pane.parts.select.value='';
   note(isV2(item)?'This blob’s folder was deleted. Choose As you Go to give it a new one.':'Choose As you Go to give this blob its own folder.');pane.parts.status.textContent='';pane.parts.conflicts.hidden=true;return;
  }
  // With a folder open the pane has no header: As you Go's own strip carries the close button.
  pane.parts.select.value='';pane.classList.add('has-folder');note('');
  const folderId=item.template.folderId;
  // Opening (or choosing) creates the folder if it is not here yet, and keeps its name the blob's.
  // An existing folder opens at once; checking its name waits for no one (on the phone the shared
  // record queue can be busy with file work for a long time).
  const known=folders.get(folderId);
  if(known?.exists){void root.ProximaWorkspaces.ensureFolder(ROOT,folderId,item.name).then(folder=>{folders.set(folderId,folder);if(folder.binned&&selected===id)void open(id);}).catch(()=>{});}
  else{const folder=await root.ProximaWorkspaces.ensureFolder(ROOT,folderId,item.name);folders.set(folderId,folder);if(request!==openSequence)return;if(folder.binned)return mount(id,request);}
  // Every opening enters the blob's own folder, wherever the pane was left before.
  const opening=waitForFolder(folderId);opening.catch(()=>{});try{await createFrame(folderId,item.name);}catch(error){cancelNavigation();throw error;}if(request!==openSequence)return;frame.style.pointerEvents='none';frame.title=item.name+' · As you Go';goToWanted();
  if(!await opening||request!==openSequence)return;
  if(shared&&activeKind==='as-you-go')await root.ProximaBlobLayout.selectFiles();
  void report();refreshTimelines();
 }
 // Native preview windows (Windows preview handlers, Office) are placed in this page's coordinates; tell the
 // page inside the frame where its frame sits, and when the pane is closed, whenever that changes.
 let lastOffset='';
 setInterval(()=>{if(!frame||!frameReady||!frame.contentWindow)return;const r=frame.getBoundingClientRect(),hidden=!!pane?.hidden||frame.hidden||!!frame.parentElement?.hidden||!r.width,x=Math.round(r.left+frame.clientLeft),y=Math.round(r.top+frame.clientTop),key=x+','+y+','+hidden;if(key===lastOffset)return;lastOffset=key;try{frame.contentWindow.postMessage({type:'proxima:workspace:frame-offset',workspaceId:ROOT,x,y,hidden},origin);}catch{}},300);
 // Prepare the template, but create the live iframe only in the visible pane.
 // A frame born under display:none can remain on about:blank in Chromium.
 function prewarm(){if(frame||creatingFrame)return;const item=Store.timelineIntervals().find(propagated);if(!item)return;void prepareTemplate().catch(()=>{});}
 setTimeout(()=>{if('requestIdleCallback' in root)requestIdleCallback(prewarm,{timeout:4000});else prewarm();},2500);
 function announcePaneToggle(visible){dispatchEvent(new CustomEvent('proxima:blob-pane-toggle',{detail:{visible}}));}
 function closePane(){
  if(!pane||pane.hidden)return;
  announcePaneToggle(false);
  ++openSequence;cancelNavigation();
  void root.ProximaFullAppFlowy?.suspend();
  pane.hidden=true;
  document.querySelector('#exactTimeline')?.focus({preventScroll:true});
 }
 function toggle(id=selected||localStorage.getItem('proxima.blobPane.last')){
  const item=Store.timelineIntervals().find(x=>x.id===id);
  if(!item)return false;
  if(pane&&!pane.hidden&&selected===id){closePane();return true;}
  if(!pane||pane.hidden)announcePaneToggle(true);
  const flow=activeKind==='appflowy'&&bindings(item).find(binding=>binding.kind==='appflowy');
  if(pane?.hidden&&selected===id&&flow){
   pane.hidden=false;
   root.ProximaBlobLayout?.syncOverlay();
   startEditor(item,++openSequence);
  }else void open(id,selected===id?activeKind||'task':'task');
  return true;
 }
 function startEditor(item,request){void openEditor(bindings(item).find(b=>b.kind==='appflowy')).catch(error=>{if(request!==openSequence||selected!==item.id||pane.hidden)return;pane.parts.status.hidden=false;pane.parts.status.textContent=error.message;});}
 function open(id,kind='task'){if(kind)activeKind=kind;localStorage.setItem('proxima.blobPane.last',id);const request=++openSequence;cancelNavigation();chain=chain.catch(()=>{}).then(()=>request===openSequence?mount(id,request):undefined).catch(e=>{if(request!==openSequence)return;build();pane.hidden=false;pane.parts.status.hidden=false;pane.parts.status.textContent=e.message;});return chain;}
 // A file pane that is unloading (a blob switch reloads it) closes its hosted previews on the way out;
 // that message arrives with no source any more. Forward just those closes, or the preview stays on screen.
 addEventListener('message',event=>{const v=event.data;if(frame&&event.source===null&&event.origin===origin&&v?.workspaceId===ROOT&&v.type==='proxima:workspace:request'&&v.method==='file'&&/^preview-[a-z]+-close$/.test(v.args?.[0])&&typeof v.args[1]?.sessionId==='string'){void Promise.resolve(root.ProximaWorkspaces.frameCall(ROOT,'file',[v.args[0],{sessionId:v.args[1].sessionId}])).catch(()=>{});}});
 addEventListener('message',event=>{if(!frame||event.source!==frame.contentWindow||event.origin!==origin||event.data?.workspaceId!==ROOT)return;const v=event.data;
  if(v.type==='proxima:workspace:close'){closePane();return;}
  if(v.type==='proxima:workspace:pane-key'){if(v.shift)root.ProximaBlobPaneControls?.toggleFullscreen();else closePane();return;}
  // Show the page only once it shows the folder asked for, so the preloaded folder never flashes first.
  if(v.type==='proxima:workspace:ready'){frameReady=true;lastOffset='';frameNavigationProtocol=v.navigationProtocol||0;clearTimeout(readyTimer);frameFolder=v.folderId;if(navigation)goToWanted();return;}
  if(v.type==='proxima:workspace:folder-opened'){confirmedFolder(v.folderId,v.requestId);return;}
  if(v.type==='proxima:workspace:flushed'){const t=flushes.get(v.requestId);if(t){flushes.delete(v.requestId);clearTimeout(t.timer);v.ok?t.resolve():t.reject(Error(v.error));}return;}
  if(v.type!=='proxima:workspace:request'||typeof v.requestId!=='string'||!Array.isArray(v.args))return;
  const source=event.source,target=origin;Promise.resolve(root.ProximaWorkspaces.frameCall(ROOT,v.method,v.args)).then(result=>source.postMessage({type:'proxima:workspace:result',requestId:v.requestId,workspaceId:ROOT,ok:true,result},target),error=>source.postMessage({type:'proxima:workspace:result',requestId:v.requestId,workspaceId:ROOT,ok:false,error:error.message},target));
 });
 // The folder keeps the blob's name: renaming the blob here renames its folder.
 if(typeof Store!=='undefined'&&typeof Store.command==='function'){
  const command=Store.command;
  Store.command=async(...args)=>{
   const result=await command.apply(Store,args),c=args[0];
   if(result?.ok&&c?.type==='timeline-interval.patch'&&typeof c.payload?.patch?.name==='string'){
    const item=Store.timelineIntervals().find(x=>x.id===c.payload.intervalId);
    if(isV2(item)&&folders.get(item.template.folderId)?.exists)void root.ProximaWorkspaces.ensureFolder(ROOT,item.template.folderId,item.name).then(()=>readFolders()).catch(()=>{});
   }
   return result;
  };
 }
 addEventListener('proxima:blob-open',event=>{void (event.detail.newTab?openProjectTab(event.detail.id):toggle(event.detail.id));});
 document.addEventListener('dblclick',event=>{if(event.target.closest('input,button,.exact-resize-edge,.exact-queue-boundary'))return;const node=event.target.closest('.exact-selectable,.exact-outside-name');if(!propagated(node?.interval))return;event.preventDefault();event.stopImmediatePropagation();void open(node.interval.id);},true);
 // The Task tab: Proxima's own surface in the pane body. Go and Flow stay loaded behind it, only hidden.
 let selectingSharedFiles=false;
 async function selectSharedTemplate(kind){
  const item=Store.timelineIntervals().find(x=>x.id===selected);if(!item)return;
  if(kind==='task'){cancelNavigation();void root.ProximaFullAppFlowy?.suspend();root.ProximaBlobTasks?.mount(root.ProximaBlobLayout.taskPanel(),item.id);}
  else{root.ProximaBlobTasks?.hide();if(kind==='as-you-go'){if(frame)frame.hidden=false;if(!frameReady||frameFolder!==item.template?.folderId){if(selectingSharedFiles)return;selectingSharedFiles=true;try{await mount(item.id,openSequence);}finally{selectingSharedFiles=false;}}}if(kind==='appflowy'){const binding=bindings(item).find(b=>b.kind==='appflowy');if(binding)await openEditor(binding);}}
 }
 async function showTask(item){
  const shared=location.protocol==='papers-backpack:'&&bindings(item).some(b=>b.kind==='appflowy')&&isV2(item)&&!folders.get(item.template.folderId)?.binned;
  if(shared){cancelNavigation();await root.ProximaBlobLayout.ensure(pane,await prepareTemplate());root.ProximaBlobLayout.setTaskName(item.name);root.ProximaBlobTasks.mount(root.ProximaBlobLayout.taskPanel(),item.id);void root.ProximaFullAppFlowy?.suspend();pane.classList.add('has-folder');pane.parts.loading.hidden=true;await root.ProximaBlobLayout.selectTask();return;}

  cancelNavigation();root.ProximaBlobLayout?.disable();void root.ProximaFullAppFlowy?.suspend();
  if(frame&&frame.parentElement!==pane.parts.body){frame.style.visibility='hidden';frameReady=false;pane.parts.body.append(frame);}
  if(frame)frame.hidden=true;note('');pane.parts.loading.hidden=true;pane.parts.status.hidden=true;pane.parts.conflicts.hidden=true;pane.classList.add('has-folder');
  renderTemplateTabs(item);
  if(!root.ProximaBlobTasks){pane.parts.status.hidden=false;pane.parts.status.textContent='The task screen did not load. Reload this page.';return;}
  root.ProximaBlobTasks.mount(pane.parts.body,item.id);
 }
 function renderTemplateTabs(item){
  const list=bindings(item).filter(b=>b.kind!=='as-you-go'||!folders.get(b.folderId)?.binned);
  if(activeKind!=='task'&&!list.some(b=>b.kind===activeKind))activeKind='task';
  pane.parts.tabs.replaceChildren();{const tab=document.createElement('button');tab.type='button';tab.textContent=item.name||'Task';tab.title=item.name||'Task';tab.setAttribute('aria-pressed',String(activeKind==='task'));tab.onclick=()=>{void flush().then(()=>{activeKind='task';return mount(item.id);}).catch(error=>{pane.parts.status.hidden=false;pane.parts.status.textContent=error.message;});};pane.parts.tabs.append(tab);}for(const binding of list){const tab=document.createElement('button');tab.type='button';tab.textContent=binding.kind==='appflowy'?'Flow':'Go';tab.setAttribute('aria-pressed',String(binding.kind===activeKind));tab.onclick=()=>{void flush().then(()=>{activeKind=binding.kind;return mount(item.id);}).catch(error=>{pane.parts.status.hidden=false;pane.parts.status.textContent=error.message;});};pane.parts.tabs.append(tab);}
  for(const option of pane.parts.select.options)option.disabled=!!list.find(b=>b.kind===option.value);pane.parts.select.value='';
 }
 async function openProjectTab(id){
  const item=Store.timelineIntervals().find(x=>x.id===id);if(!item)return;
  const url=new URL(location.href);for(const key of ['papers-surface-key','papers-inline-device','papers-files-parent','papers-files-group'])url.searchParams.delete(key);
  url.searchParams.set('blob-project',id);url.searchParams.set('blob-title',item.name);url.searchParams.delete('blob-template');
  try{if(location.protocol==='papers-backpack:')await root.ProximaWorkspaces.request('papers:project:open-new-surface',{url:url.href,inlineGroupId:'sibling'});else window.open(url.href,'_blank','noopener');}
  catch(error){build();pane.hidden=false;pane.parts.status.hidden=false;pane.parts.status.textContent=error.message;}
 }
 async function openEditor(binding){
  if(!root.ProximaFullAppFlowy)throw Error('The full AppFlowy app is unavailable. Reload this page.');
  return root.ProximaFullAppFlowy.open(binding,pane.parts.body,pane.parts.title.textContent,selected);
 }
 async function chooseTemplate(kind){const item=Store.timelineIntervals().find(x=>x.id===selected);if(!item)return;if(bindings(item).some(b=>b.kind===kind)){await flush();activeKind=kind;return mount(selected);}pane.parts.select.value=kind;return pane.parts.select.onchange();}
 root.ProximaBlobWorkspaces=Object.freeze({showTask:()=>{if(selected)void open(selected,'task');},open,toggle,lastOpened:()=>selected||localStorage.getItem('proxima.blobPane.last'),close:closePane,openProjectTab,flush,button,prewarm,chooseTemplate});
 if(projectTab){document.documentElement.classList.add('blob-project-page');const start=()=>{const item=Store.timelineIntervals().find(x=>x.id===projectTab);if(item){document.title=item.name;void open(projectTab);}else setTimeout(start,100);};setTimeout(start,0);}
 // Papers asks every page to save before a reload. A page whose surface Papers already counts as closed cannot
 // reach Papers to save ("This surface is no longer open"); that must not cancel the reload. Other failures still do.
 const surfaceGone=error=>/surface is no longer open/i.test(String(error?.message||error));
 const step=async work=>{try{await work();}catch(error){if(!surfaceGone(error))throw error;}};
 const previousFlush=root.__papersFlushBeforeClose;root.__papersFlushBeforeClose=async()=>{await step(()=>root.ProximaBlobTasks?.flush());await step(()=>flush());await step(()=>previousFlush?.());await step(()=>root.ProximaWorkspaces.flush());return {ok:true};};
})(globalThis);
