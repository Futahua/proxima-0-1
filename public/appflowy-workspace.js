/* The original AppFlowy app in a blob pane. On a Papers desktop the native AppFlowy app is docked
 * over the pane (a Papers program-window template); otherwise, or if docking fails, the web app
 * renders in Papers' persistent browser view or a frame.
 * Personal sessions come only through the paired BOP exchange, never the public portal. */
(function(root){
 'use strict';
 const ORIGIN='https://bop.taild88607.ts.net:8443',desktop=location.protocol==='papers-backpack:',TEMPLATE='appflowy';
 // docked: the native window is placed over this pane and stays running while hidden, so switching back is instant.
 let surface=null,last=null,openingDocumentId=null,session=null,docked=false,nativeUnavailable=false,generation=0,queue=Promise.resolve();
 // Each blob's page as BOP last confirmed it (documentId -> {workspaceId, viewId, url, launchUrl}).
 const pages=new Map();
 const enqueue=work=>{const result=queue.catch(()=>{}).then(work);queue=result;return result;};
 const call=(operation,detail)=>root.ProximaWorkspaces.call(operation,detail);
 async function release(){
  const id=session;session=null;if(id)await call('browser-close',{sessionId:id}).catch(()=>{});
  if(docked)await call('program-window-visible',{template:TEMPLATE,visible:false}).catch(()=>{});
  if(surface)surface.hidden=true;
 }
 function hide(clear=true){++generation;if(clear){last=null;openingDocumentId=null;}return enqueue(release);}
 function rect(){const r=surface.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))};}
 function visible(){return last&&surface?.isConnected&&!surface.closest('.blob-workspace-pane')?.hidden&&!document.hidden;}
 async function dock(value){
  if(nativeUnavailable||!value.workspaceId)return false;
  // The blob's own page in the home workspace: <workspace>/<page> (or the workspace alone).
  const target=value.viewId?value.workspaceId+'/'+value.viewId:value.workspaceId;
  const result=await call('program-window-open',{template:TEMPLATE,target,rect:rect()}).catch(error=>({ok:false,message:error.message}));
  if(result?.ok){docked=true;return true;}
  // Older Papers builds, or no native AppFlowy on this computer: use the web app from now on.
  if(result?.code==='PROGRAM_WINDOWS_UNAVAILABLE'||/unknown|unsupported|not installed/i.test(result?.message||''))nativeUnavailable=true;
  console.warn('AppFlowy native window unavailable; using the web app.',result?.message||result);
  return false;
 }
 async function present(value,launchUrl=value.launchUrl||value.url){
  const ticket=++generation;return enqueue(async()=>{
   await release();if(ticket!==generation||!visible())return;
   surface.hidden=false;
   if(desktop){
    if(await dock(value)){if(ticket!==generation||!visible())await release();return;}
    const result=await call('browser-open',{url:launchUrl,rect:rect()});if(!result?.ok||!result.sessionId)throw Error(result?.message||'AppFlowy could not open.');session=result.sessionId;if(ticket!==generation||!visible())await release();
   }
   else{const frame=document.createElement('iframe');frame.title='AppFlowy';frame.src=launchUrl;surface.replaceChildren(frame);}
  });
 }
 function place(){
  if(!visible())return;
  if(session)void call('browser-move',{sessionId:session,rect:rect()}).catch(()=>{});
  else if(docked)void call('program-window-move',{template:TEMPLATE,rect:rect()}).catch(()=>{});
 }
 async function open(binding,body,name,intervalId){
  if(last?.documentId===binding.documentId&&(session||docked)&&visible()&&!surface.hidden){place();return;}
  await hide();
  const opening=++generation;
  if(!surface){surface=document.createElement('div');surface.className='full-appflowy-surface';surface.hidden=true;
   let scheduled=false;const move=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;place();});};new ResizeObserver(move).observe(surface);addEventListener('resize',move);
   document.addEventListener('visibilitychange',()=>{if(!visible())return;if(desktop? !session&&surface.hidden: !surface.querySelector('iframe'))void present(last).catch(showError);});
  }
  body.append(surface);
  const pane=body.closest('.blob-workspace-pane');
  openingDocumentId=binding.documentId;
  if(!pane.__fullAppFlowyObserver){pane.__fullAppFlowyObserver=new MutationObserver(()=>{if(pane.hidden)void hide();});pane.__fullAppFlowyObserver.observe(pane,{attributes:true,attributeFilter:['hidden']});}
  // "Connecting…" only when it actually takes a moment, never on an ordinary tab switch.
  const status=pane.querySelector('[role=status]'),CONNECTING='Connecting to AppFlowy…';
  if(status){status.textContent='';status.hidden=true;}
  const slow=status?setTimeout(()=>{if(opening===generation&&status.hidden){status.hidden=false;status.textContent=CONNECTING;}},900):null;
  const settled=()=>{clearTimeout(slow);if(status&&status.textContent===CONNECTING){status.textContent='';status.hidden=true;}};
  const remember=value=>({url:value.url,launchUrl:value.launchUrl,workspaceId:value.workspaceId,viewId:value.viewId,documentId:binding.documentId});
  try{
  // The native app needs only the page, so a page already known shows at once; BOP is
  // asked afterwards and only a changed answer (say the page was deleted) re-docks.
  const known=pages.get(binding.documentId);
  if(known&&desktop&&!nativeUnavailable){
   last={...known};
   await present(last);
   if(opening!==generation)return;
   if(docked){
    settled();
    void ask(binding,name,intervalId).then(value=>{
     if(opening!==generation)return;
     const next=remember(value);pages.set(binding.documentId,next);
     if(next.workspaceId!==last.workspaceId||next.viewId!==last.viewId){last=next;void present(last).catch(showError);}else last=next;
    }).catch(()=>{});
    return;
   }
  }
  const value=await ask(binding,name,intervalId);
  if(opening!==generation)return;
  last=remember(value);pages.set(binding.documentId,last);
  await present(last,value.launchUrl||value.url);
  settled();
  }catch(error){clearTimeout(slow);showError(error);throw error;}
 }
 // BOP's answer for a blob: its page in the home workspace, plus a fresh sign-in link for the web app.
 async function ask(binding,name,intervalId){
  let value=binding.appflowyWorkspaceId?{workspaceId:binding.appflowyWorkspaceId,url:ORIGIN+'/app/'+binding.appflowyWorkspaceId}:null;
  const api=root.__proximaDeviceCopy;
  if(api){
   const devices=await api.devices(),bop=devices.others.find(device=>device.id==='44091a08-55e1-46b8-8fa7-df60366779c2'||/^bop$/i.test(device.name));
   if(!bop)throw Error('Connect this device to BOP to open AppFlowy.');
   const response=await api.exchange(bop,{workspaceProtocol:1,appflowy:{operation:'open',documentId:binding.documentId,name}});value=response.appflowy;
   if(value?.error)throw Error(value.error);
   if(!value||!value.url.startsWith(ORIGIN+'/app/')||!value.launchUrl?.startsWith(ORIGIN+'/papers-launch#'))throw Error('BOP did not confirm the AppFlowy workspace.');
   const item=Store.timelineIntervals().find(item=>item.id===intervalId),current=(item?.templates||[]).find(b=>b.kind==='appflowy');
   if(!current||current.documentId!==binding.documentId)throw Error('This blob template changed while AppFlowy was opening.');
   if(current.appflowyWorkspaceId!==value.workspaceId){const saved=await Store.command({type:'timeline-interval.template',ifRev:item.rev,payload:{intervalId,template:'appflowy',appflowyWorkspaceId:value.workspaceId}});if(!saved.ok)throw Error('This blob changed before its AppFlowy link was saved.');}
  }
  if(!value)throw Error('Open this AppFlowy template in Papers on one of your connected devices first.');
  return value;
 }
 function showError(error){const pane=surface?.closest('.blob-workspace-pane'),status=pane?.querySelector('[role=status]');if(status){status.hidden=false;status.textContent='AppFlowy is unavailable. '+error.message;}}
 root.ProximaFullAppFlowy=Object.freeze({open,hide});
 // Leaving the page hands the native window back to the desktop instead of keeping it hidden.
 addEventListener('pagehide',()=>{void hide();if(docked){docked=false;void call('program-window-close',{template:TEMPLATE}).catch(()=>{});}});
})(globalThis);
