/** Read-only source presentation; only the receiving Proxima's command owner imports. */
import {applyDeviceTheme} from './device-theme.js?v=one-palette';
export function createRemoteBackpackView({document:d,container,call,close=()=>{},importProjection=null,pendingImports=()=>[],following=null}){
 const root=d.createElement('section');root.setAttribute('aria-label','Proxima on another device');root.style.cssText='position:fixed;inset:0;z-index:1000;background:#1e2923;color:inherit;display:none;overflow:auto';container.append(root);
 const toolbar=d.createElement('div');toolbar.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';const heading=d.createElement('strong'),status=d.createElement('p'),body=d.createElement('div'),approval=d.createElement('div');status.setAttribute('role','status');root.append(status,body);
 let active=false,owner=null,resource=null,snapshot=null,online=false,generation=0,polling=false,timer=null,preview=null,overview=false,frameReady=false,snapshotReceivedAt=0;const selected=new Map();
 const sourceFrame=d.createElement('iframe');sourceFrame.title='Read-only source calendar and timeline';sourceFrame.setAttribute('sandbox','allow-scripts allow-same-origin');sourceFrame.src=new URL('./remote-overview.html',import.meta.url).href;sourceFrame.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0;display:none;background:#1e2923';root.append(sourceFrame);
 function sendSource(){if(frameReady&&snapshot)sourceFrame.contentWindow.postMessage({type:'proxima:source-view',snapshot,online,receivedAt:snapshotReceivedAt,visible:active&&sourceFrame.style.display==='block',label:(owner?.name||'Source')+' / '+(resource?.name||'Proxima')},d.defaultView.location.origin);}
 function sourceReady(event){if(event.source!==sourceFrame.contentWindow||event.origin!==d.defaultView.location.origin||event.data?.type!=='proxima:source-view-ready')return;frameReady=true;sendSource();}d.defaultView.addEventListener('message',sourceReady);
 // Shown only once the remote Proxima has drawn its own data (or there is something to say), never the default layout first.
 const showRoot=()=>{root.style.visibility='';};function remoteReady(event){if(event.source===sourceFrame.contentWindow&&event.data?.type==='proxima:device-view-ready')showRoot();}d.defaultView.addEventListener('message',remoteReady);
 let peer=null;
 // The phone's own Proxima, as the phone last published it to this computer: view-only.
 async function peerRequest(event){
  const message=event.data;if(message?.type!=='papers:proxima-device:request'||message.ownerId!==peer.id)return;
  const current=generation,reply=value=>{if(active&&current===generation&&peer)event.source.postMessage({type:'papers:proxima-device:result',requestId:message.requestId,...value},d.defaultView.location.origin);};
  try{
   if(message.operation==='devices'){reply({ok:true,result:(await request({operation:'status'})).devices});return;}
   if(message.operation!=='snapshot')throw Error('The phone\'s Proxima is view-only on this computer.');
   const saved=await request({operation:'peer-proxima',deviceId:peer.id});
   const {deviceName,...published}=saved.snapshot;
   const projection=ProximaRemoteDomain.validateProjection({...published,source:{...published.source,ownerId:peer.id}});
   reply({ok:true,result:{snapshot:projection,online:true,name:deviceName||saved.name,receivedAt:saved.receivedAt}});
  }catch(error){reply({ok:false,error:error.message||String(error)});}
 }
 function ownerChanged(event){if(event.source!==d.defaultView||event.origin!==d.defaultView.location.origin||event.data?.type!=='papers:device:changed'||!active||event.data.ownerId!==owner?.id)return;sourceFrame.contentWindow.postMessage(event.data,d.defaultView.location.origin);}
 d.defaultView.addEventListener('message',ownerChanged);
 async function sourceRequest(event){
  if(event.source!==sourceFrame.contentWindow||event.origin!==d.defaultView.location.origin||!active)return;
  if(peer){await peerRequest(event);return;}
  if(!resource)return;
  const message=event.data,current=generation,boundResource=resource.id;
  if(message.type==='papers:proxima-device:open'){try{const chosen=(await request({operation:'status'})).devices.find(device=>device.id===message.ownerId);if(!chosen)throw Error('Unknown computer.');const catalog=await request({operation:'backpacks',ownerId:chosen.id});if(!catalog.online)throw Error('The owner is offline.');if(current!==generation||!active)return;owner=chosen;resource=catalog.entries.find(entry=>entry.kind==='proxima')??null;snapshot=null;overview=false;sourceFrame.src='about:blank';await render();}catch(error){status.textContent=error.message;}return;}
  if(message.type!=='papers:proxima-device:request')return;
  if(message.ownerId!==owner.id)return;
  const reply=value=>{if(active&&current===generation&&resource?.id===boundResource)event.source.postMessage({type:'papers:proxima-device:result',requestId:message.requestId,...value},d.defaultView.location.origin);};
  try{
   if(message.operation==='devices'){reply({ok:true,result:(await request({operation:'status'})).devices});return;}
   if(!['snapshot','command'].includes(message.operation))throw Error('Unsupported Proxima request.');
   const result=await request({operation:message.operation==='command'?'backpack-command':'backpack-view',ownerId:owner.id,resourceId:boundResource,...(message.operation==='command'?{command:message.command}:{})});
   if(!result.online)throw Error('The owner is offline. No edit was sent or saved locally.');
   const next=ProximaRemoteDomain.validateProjection(result.snapshot);
   if(next.source.ownerId!==owner.id||snapshot&&next.source.backpackId!==snapshot.source.backpackId)throw Error('Source Proxima identity changed.');
   if(current!==generation||!active)return;snapshot=next;online=true;snapshotReceivedAt=Date.now();
   reply({ok:true,result:{...result,name:owner.name}});
  }catch(error){reply({ok:false,error:error.message||String(error)});}
 }
 d.defaultView.addEventListener('message',sourceRequest);
 function openFullView(){if(!snapshot||!online){status.textContent='Open Proxima on the live owner computer first.';return;}overview=true;body.hidden=true;status.hidden=true;sourceFrame.style.display='block';const url=new URL('./index.html',import.meta.url);url.searchParams.set('papers-device',owner.id);url.searchParams.set('papers-control','1');if(sourceFrame.src!==url.href){frameReady=false;sourceFrame.src=url.href;}status.textContent=owner.name+' · Edits are applied by this computer.';}
 let desktopObserver=null;
 function focusSource(){
  if(!active||!overview||sourceFrame.style.display!=='block')return;
  const doc=sourceFrame.contentDocument;if(!doc)return;
  applyDeviceTheme(doc,owner);doc.documentElement.dataset.remoteDesktop='true';
  const update=()=>{
   for(const button of doc.querySelectorAll('.topbar button,.schedule-head-actions button'))if(button.textContent===doc.documentElement.dataset.device&&button.textContent&&!button.dataset.returnLocal){button.dataset.returnLocal='true';button.textContent=owner.name;button.classList.add('proxima-device-name');button.title='Return to local Proxima';button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();hide();},true);}
   const menu=doc.querySelector('.proxima-device-menu');if(menu&&!menu.querySelector('[data-return-local]')){const local=doc.createElement('button');local.type='button';local.dataset.returnLocal='true';local.textContent='Local';local.addEventListener('click',hide);menu.prepend(local);}
  };
  desktopObserver?.disconnect();desktopObserver=new d.defaultView.MutationObserver(update);desktopObserver.observe(doc.body,{childList:true,subtree:true});update();sourceFrame.contentWindow.focus();
 }sourceFrame.addEventListener('load',focusSource);
 function guardKeys(event){
  if(!active)return;
  if(event.key==='Escape'){event.preventDefault();hide();}
  else if(overview&&['z','y'].includes(event.key.toLowerCase())&&!event.target.closest?.('input,textarea,select,[contenteditable="true"]')){
   const view=sourceFrame.contentWindow,target=view?.document.activeElement;
   if(target){event.preventDefault();target.dispatchEvent(new view.KeyboardEvent('keydown',{key:event.key,code:event.code,repeat:event.repeat,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey,bubbles:true,cancelable:true}));}
  }
  event.stopImmediatePropagation();
 }d.defaultView.addEventListener('keydown',guardKeys,true);
 const labels={projects:'Projects',tasks:'Tasks',scheduleEvents:'Calendar entries',timelineRows:'Activities',timelineIntervals:'Sessions',importedRuns:'Saved runs'};
 function button(label,action){const b=d.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>{void Promise.resolve().then(action).catch(error=>{status.textContent=error.message||String(error);});});return b;}
 async function request(params){const result=await call(params);if(result?.ok===false)throw Error(result.message||result.code||'Connection unavailable.');return result?.result??result;}
 function row(name){const r=d.createElement('div');r.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #ffffff18;padding:9px';const label=d.createElement('span');label.textContent=name;r.append(label);return r;}
 const exit=button('Close devices ×',()=>hide());exit.setAttribute('aria-label','Close devices and return to local Proxima');exit.style.marginLeft='auto';toolbar.append(exit);
 const back=button('Back',()=>{if(!owner){hide();return;}if(resource){resource=null;snapshot=null;selected.clear();sourceFrame.src='about:blank';}else owner=null;return render();}),copy=button('Copy selected',()=>showPreview(false)),all=button('Copy all',()=>showPreview(true));toolbar.append(button('Local',()=>hide()),heading,back,button('Refresh',()=>render()),button('Proxima',openFullView),button('Records',()=>{overview=false;body.hidden=false;sourceFrame.style.display='none';sourceFrame.src='about:blank';if(snapshot)draw();}));if(importProjection)toolbar.append(copy,all);if(following)toolbar.append(button('Following',()=>{sourceFrame.style.display='none';sourceFrame.src='about:blank';body.hidden=false;body.replaceChildren();approval.replaceChildren();preview={};following(body,status); }));
 async function commit(projection,importId,label,options={}){const result=await importProjection(projection,importId,label,options);if(!result?.ok)throw Error(result?.details?.reason||result?.message||'Copy was not saved.');status.textContent=result.changed?'Saved to this Proxima.':'This copy is already saved.';preview=null;approval.replaceChildren();return result;}
 function showPreview(complete){if(!snapshot||!importProjection)return;const selection=complete?null:[...selected.values()];if(selection&&!selection.length){status.textContent='Choose source entries first.';return;}const source=ProximaRemoteDomain.project({...snapshot.records,seq:snapshot.source.seq},snapshot.source,selection,Date.parse(snapshot.source.observedAt),snapshot.effectiveIntervals);source.provenance=Object.fromEntries(ProximaRemoteDomain.kinds.map(kind=>[kind,Object.fromEntries(source.records[kind].filter(item=>snapshot.provenance?.[kind]?.[item.id]).map(item=>[item.id,snapshot.provenance[kind][item.id]]))]));const importId=d.defaultView.crypto.randomUUID(),candidate=ProximaRemoteDomain.prepareImport(source,importId);preview={source,importId};approval.replaceChildren();const title=d.createElement('h3');title.textContent='Create an independent local copy';approval.append(title);for(const kind of ProximaRemoteDomain.kinds){const items=candidate.records[kind];if(!items.length)continue;const details=d.createElement('details'),summary=d.createElement('summary');summary.textContent=(labels[kind]||kind)+' — '+items.length;details.append(summary);for(const item of items){const label=d.createElement('p');label.textContent=item.name||item.lockedAt;details.append(label);}approval.append(details);}for(const notice of candidate.notices){const text=d.createElement('p');text.textContent=notice;approval.append(text);}const follow=d.createElement('input');follow.type='checkbox';if(following){const option=d.createElement('label');option.append(follow,d.createTextNode(' Copy and follow these entries. Local edits ask before replacement.'));approval.append(option);}const confirm=button('Create local copy',async()=>{confirm.disabled=true;try{await commit(source,importId,owner.name+' / '+resource.name,{mode:follow.checked?'follow':'independent',binding:{ownerId:owner.id,resourceId:resource.id}});}finally{confirm.disabled=false;}});approval.append(button('Cancel',()=>{preview=null;approval.replaceChildren();}),confirm);}
 function draw(){delete body.dataset.followReview;body.hidden=overview;sourceFrame.style.display=overview?'block':'none';sendSource();body.replaceChildren();const data=snapshot.records;
  for(const kind of ProximaRemoteDomain.kinds){const items=data[kind]||[];if(!items.length)continue;const title=d.createElement('h3');title.textContent=labels[kind]||kind;body.append(title);for(const item of items){const r=row(item.name||item.lockedAt);if(importProjection){const input=d.createElement('input');input.type='checkbox';input.setAttribute('aria-label','Select '+(kind==='timelineRows'?'activity ':kind==='timelineIntervals'?'session ':'')+(item.name||item.lockedAt));const key=kind+':'+item.id;input.checked=selected.has(key);input.addEventListener('change',()=>{if(input.checked)selected.set(key,{kind,id:item.id});else selected.delete(key);});r.prepend(input);}const detail=d.createElement('small');detail.textContent=kind==='tasks'?[item.status,item.start,item.deadline?'Due '+item.deadline:''].filter(Boolean).join(' · '):kind==='scheduleEvents'?item.start+' → '+item.deadline:kind==='timelineIntervals'?item.start+' → '+item.end+(item.followNow?' · Running on source':''):(item.description||'');r.append(detail);body.append(r);}}
  if(data.run){const r=row('Source run — '+data.run.lockedAt);if(importProjection){const input=d.createElement('input');input.type='checkbox';input.setAttribute('aria-label','Select source run');input.checked=selected.has('run');input.addEventListener('change',()=>{if(input.checked)selected.set('run',{kind:'run'});else selected.delete('run');});r.prepend(input);}body.append(r);}
  copy.disabled=all.disabled=!snapshot;
 }
 async function render(){if(!active)return;delete body.dataset.followReview;sourceFrame.style.display='none';body.hidden=false;const current=++generation;heading.textContent=owner?.name||'Devices';back.disabled=false;copy.disabled=all.disabled=true;status.hidden=false;status.textContent='Loading…';body.replaceChildren();
  try{if(!owner){const devices=(await request({operation:'status'})).devices;if(current!==generation||!active)return;if(devices.length===1){owner=devices[0];return render();}showRoot();status.textContent=devices.length?'Choose a computer.':'Connect a computer in Papers Settings → Devices.';for(const device of devices){const r=row(device.name);r.append(button('Open Proxima',()=>{owner=device;return render();}));body.append(r);}if(importProjection)for(const pending of pendingImports()){const r=row('Unfinished copy — '+pending.label);r.append(button('Finish saved copy',()=>commit(pending.projection,pending.id,pending.label,pending)));body.append(r);}return;}
   if(!resource){const catalog=await request({operation:'backpacks',ownerId:owner.id});if(current!==generation||!active)return;if(!catalog.online)throw Error(owner.name+' is offline.');resource=catalog.entries.find(entry=>entry.kind==='proxima')??null;if(resource)return render();showRoot();status.textContent='No Proxima is open on this computer.';for(const entry of catalog.entries){const r=row(entry.name);r.append(button('View',()=>{resource=entry;selected.clear();return render();}));body.append(r);}if(!catalog.entries.length)status.textContent='No Proxima data is shared with this device.';return;}
   const response=await request({operation:'backpack-view',ownerId:owner.id,resourceId:resource.id});if(current!==generation||!active)return;snapshot=ProximaRemoteDomain.validateProjection(response.snapshot);if(snapshot.source.ownerId!==owner.id)throw Error('Source owner identity changed.');snapshotReceivedAt=Date.now();online=response.online;heading.textContent=owner.name+' / '+resource.name;status.textContent=(online?'Live source':'Offline saved source')+' · '+snapshot.source.observedAt;const known=new Set(ProximaRemoteDomain.kinds.flatMap(kind=>snapshot.records[kind].map(item=>kind+':'+item.id)));for(const key of selected.keys())if(key!=='run'&&!known.has(key))selected.delete(key);overview=false;if(online)openFullView();else throw Error(owner.name+' is offline.');
  }catch(error){if(current===generation){showRoot();status.textContent=error.message||'Owner unavailable.';}}
 }
 async function poll(){if(!active||!resource||preview||polling||overview)return;polling=true;const current=generation;try{const response=await request({operation:'backpack-snapshot',ownerId:owner.id,resourceId:resource.id});if(!active||current!==generation)return;const next=ProximaRemoteDomain.validateProjection(response.snapshot);const changed=!snapshot||next.source.seq!==snapshot.source.seq||response.online!==online;snapshot=next;snapshotReceivedAt=Date.now();online=response.online;if(changed){status.textContent=(online?'Live source':'Offline saved source')+' · '+snapshot.source.observedAt;draw();}else sendSource();}catch(error){status.textContent=error.message;}finally{polling=false;}}
 function hide(){active=false;peer=null;generation++;desktopObserver?.disconnect();desktopObserver=null;root.style.display='none';sourceFrame.style.display='none';sourceFrame.src='about:blank';clearInterval(timer);timer=null;preview=null;approval.replaceChildren();close();}
 return {get visible(){return active;},
  /** Open one device's Proxima: a computer (live, with control) or a phone (its last published copy, view-only). */
  async showDevice(device){if(active)hide();active=true;generation++;root.style.visibility='hidden';root.style.display='block';setTimeout(showRoot,15000);if(!timer)timer=setInterval(()=>{void poll();},1500);
   if(device.peer){peer={id:device.id,name:device.name};owner={id:device.id,name:device.name,kind:'phone'};resource=null;snapshot=null;overview=true;body.hidden=true;status.hidden=true;sourceFrame.style.display='block';const url=new URL('./index.html',import.meta.url);url.searchParams.set('papers-device',device.id);frameReady=false;sourceFrame.src=url.href;return;}
   owner={id:device.id,name:device.name,kind:device.kind};resource=null;snapshot=null;overview=false;await render();},
  toggle(){if(active){hide();return Promise.resolve();}return this.show();},async show(){active=true;root.style.visibility='hidden';root.style.display='block';setTimeout(showRoot,15000);if(!timer)timer=setInterval(()=>{void poll();},1500);await render();},hide,dispose(){hide();d.defaultView.removeEventListener('keydown',guardKeys,true);d.defaultView.removeEventListener('message',sourceReady);d.defaultView.removeEventListener('message',remoteReady);d.defaultView.removeEventListener('message',sourceRequest);d.defaultView.removeEventListener('message',ownerChanged);root.remove();}};
}
