/* Blob templates. Every As you Go blob owns one folder in the single synced As you Go root
 * ('ayg-root'), named after the blob. Opening the blob opens As you Go inside that folder; the
 * root and other blobs' folders stay reachable. The folder outlives the blob. Deleting the folder
 * leaves the blob without a template until As you Go is chosen again. */
(function(root){
 'use strict';
 const ROOT='ayg-root';
 let pane,frame,frameFolder=null,selected,origin,chain=Promise.resolve();const flushes=new Map();
 const folders=new Map(); // folderId -> {exists,binned,name,icon}, from the synced root
 const isV2=item=>item?.template?.kind==='as-you-go'&&item.template.version===2&&typeof item.template.folderId==='string';
 // A blob is propagated while its folder is not deleted. A folder not synced here yet still counts.
 function propagated(item){if(!isV2(item))return false;const f=folders.get(item.template.folderId);return !f?.binned;}
 function imageOf(icon){
  if(typeof icon==='string')return /^(data:image\/|https?:\/\/)/i.test(icon)?icon:null;
  if(icon&&typeof icon==='object')for(const value of Object.values(icon)){const found=imageOf(value);if(found)return found;}
  return null;
 }
 /** For the timeline's blob button: whether the blob has a folder, and the folder's picture. */
 function button(item){return propagated(item)?{propagated:true,icon:imageOf(folders.get(item.template.folderId)?.icon)}:{propagated:false,icon:null};}
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
  for(const [value,label] of [['','No template'],['as-you-go','As you Go']]){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}select.setAttribute('aria-label','Blob template');close.textContent='×';close.setAttribute('aria-label','Close blob contents');status.setAttribute('role','status');
  head.append(title,select,close);conflicts.hidden=true;conflicts.className='blob-workspace-conflicts';pane.append(head,status,conflicts,body);pane.parts={title,select,status,body,conflicts};document.body.append(pane);close.onclick=()=>{pane.hidden=true;};
  select.onchange=async()=>{select.disabled=true;try{
   await flush();const item=Store.timelineIntervals().find(x=>x.id===selected);
   // A deleted folder (or a first-generation template) is replaced by a fresh folder.
   const renew=select.value==='as-you-go'&&!!item.template&&!propagated(item);
   const r=await Store.command({type:'timeline-interval.template',ifRev:item.rev,payload:{intervalId:item.id,template:select.value||null,...(renew?{renew:true}:{})}});
   if(!r.ok)throw Error('The blob changed before its template could be saved.');
   await mount(selected,{force:true});refreshTimelines();
  }catch(e){status.textContent=e.message;}finally{select.disabled=false;}};
  setInterval(()=>{if(!pane.hidden&&frame)void report();},3000);
 }
 async function flush(){if(!frame)return;const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{flushes.delete(requestId);reject(Error('The file pane has not confirmed saving yet.'));},15000);flushes.set(requestId,{resolve,reject,timer});frame.contentWindow.postMessage({type:'proxima:workspace:flush',workspaceId:ROOT,requestId},origin);});}
 async function report(){try{const peers=(await root.__proximaDeviceCopy?.devices())?.others||[],state=await root.ProximaWorkspaces.status(ROOT,peers),errors=[...root.ProximaWorkspaces.errors.values()];pane.parts.status.textContent=state.label+(errors.length?' · '+errors[0].message:'');pane.parts.status.dataset.state=errors.length?'error':state.kind;
  // Nothing shows while everything is synced; waiting, conflicts and errors always do.
  pane.parts.status.hidden=!errors.length&&['synced','local'].includes(state.kind);
  const conflicts=await root.ProximaWorkspaces.conflicts(ROOT);const area=pane.parts.conflicts;area.replaceChildren();area.hidden=!conflicts.length;
  for(const conflict of conflicts){const row=document.createElement('div'),title=document.createElement('strong');title.textContent=conflict.name+' — both versions kept';row.append(title);for(const version of conflict.versions||[]){if(version.kind!=='content')continue;const choose=document.createElement('button');choose.type='button';choose.textContent='Keep '+version.device+' · '+version.hash.slice(0,7);choose.onclick=async()=>{choose.disabled=true;try{await root.ProximaWorkspaces.restore(ROOT,conflict.entryId,version.id);await report();}catch(error){pane.parts.status.textContent=error.message;choose.disabled=false;}};row.append(choose);}area.append(row);}
 }catch(e){pane.parts.status.textContent=e.message;}}
 function closeFrame(){frame?.remove();frame=null;frameFolder=null;}
 async function mount(id,{force=false}={}){build();const item=Store.timelineIntervals().find(x=>x.id===id);if(!item)throw Error('This blob no longer exists.');pane.hidden=false;selected=id;pane.parts.title.textContent=item.name;
  if(isV2(item)&&!folders.has(item.template.folderId))await readFolders();
  if(!propagated(item)){
   pane.classList.remove('has-folder');pane.parts.status.hidden=false;
   pane.parts.select.value='';await flush().catch(()=>{});closeFrame();
   pane.parts.body.textContent=isV2(item)?'This blob’s folder was deleted. Choose As you Go to give it a new one.':'Choose As you Go to give this blob its own folder.';pane.parts.status.textContent='';pane.parts.conflicts.hidden=true;return;
  }
  // With a folder open the pane has no header: As you Go's own strip carries the close button.
  pane.parts.select.value='as-you-go';pane.classList.add('has-folder');
  const folderId=item.template.folderId;
  // Opening (or choosing) creates the folder if it is not here yet, and keeps its name the blob's.
  const folder=await root.ProximaWorkspaces.ensureFolder(ROOT,folderId,item.name);folders.set(folderId,folder);
  if(folder.binned)return mount(id);
  // Every opening enters the blob's own folder, wherever the pane was left before.
  if(!force&&frame&&frameFolder===folderId)return;
  await flush().catch(()=>{});closeFrame();
  const phone=new URL(location.href).searchParams.has('papers-phone'),entry=phone?{url:new URL('../ayg/workspace-20260730b.html',location.href).href}:(await root.ProximaWorkspaces.request('papers:project:workspace-template')).template;if(!entry?.url)throw Error('As you Go is unavailable on this device.');
  const url=new URL(entry.url);url.searchParams.set('papers-blob-workspace',ROOT);url.searchParams.set('as-you-go-folder',folderId);url.searchParams.set('papers-blob-parent-origin',location.origin==='null'?location.protocol+'//'+location.host:location.origin);url.searchParams.set('papers-embedded-surface','proxima-blob');url.searchParams.set('papers-inline-device','1');if(phone)url.searchParams.set('papers-phone','1');origin=url.origin==='null'?url.protocol+'//'+url.host:url.origin;
  frame=document.createElement('iframe');frame.title=item.name+' · As you Go';frame.src=url.href;frameFolder=folderId;pane.parts.body.replaceChildren(frame);await report();refreshTimelines();
 }
 function open(id){chain=chain.catch(()=>{}).then(()=>mount(id)).catch(e=>{build();pane.hidden=false;pane.parts.status.textContent=e.message;});return chain;}
 addEventListener('message',event=>{if(!frame||event.source!==frame.contentWindow||event.origin!==origin||event.data?.workspaceId!==ROOT)return;const v=event.data;
  if(v.type==='proxima:workspace:close'){pane.hidden=true;return;}
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
    if(propagated(item)&&folders.get(item.template.folderId)?.exists)void root.ProximaWorkspaces.ensureFolder(ROOT,item.template.folderId,item.name).then(()=>readFolders()).catch(()=>{});
   }
   return result;
  };
 }
 addEventListener('proxima:blob-open',event=>void open(event.detail.id));
 document.addEventListener('dblclick',event=>{if(event.target.closest('input,button,.exact-resize-edge,.exact-queue-boundary'))return;const node=event.target.closest('.exact-selectable,.exact-outside-name');if(!propagated(node?.interval))return;event.preventDefault();event.stopImmediatePropagation();void open(node.interval.id);},true);
 root.ProximaBlobWorkspaces=Object.freeze({open,flush,button});
 const previousFlush=root.__papersFlushBeforeClose;root.__papersFlushBeforeClose=async()=>{await flush();await previousFlush?.();await root.ProximaWorkspaces.flush();return {ok:true};};
})(globalThis);
