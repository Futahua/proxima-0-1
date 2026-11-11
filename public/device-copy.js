/* Copying Proxima between the creator's devices (SlopTop, LapDog, the phone). A copy icon under the
 * year in the timeline's time strip opens "Copies data from" (the other two devices) and "Overwrite
 * all devices' Proxima data with <this device>". Every overwrite is confirmed first and backs up the
 * replaced data (IndexedDB 'proxima-backups', newest 10 kept) before the new data is written under
 * the store's own write lock; the page then reloads into it.
 * Only a device's own Proxima has the icon (not a view of another device). On the phone this file
 * also publishes the phone's Proxima to the computers whenever it changes, and applies a replacement
 * a computer left for it. */
(function(root){
  const params=new URL(location.href).searchParams;
  if(params.get('papers-device'))return; // a view of another device's Proxima
  const phone=params.has('papers-phone');

  // ── Talking to the host: the phone app (parent frame) or Papers on a computer ──
  const pending=new Map();
  addEventListener('message',event=>{
    const value=event.data;
    if(phone&&event.source===parent&&value?.type==='papers:proxima-device:result'){const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.result):task.reject(Error(value.error||'The phone did not answer.'));}
    if(!phone&&event.source===window&&value?.type==='papers:host:result'){const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.fileCapability):task.reject(Error(value.error||'Papers refused the request.'));}
  });
  const wait=(requestId,ms)=>new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});setTimeout(()=>{if(pending.delete(requestId))reject(Error('The device did not answer in time.'));},ms);});
  const ask=(operation,extra={},ms=60000)=>{const requestId=crypto.randomUUID();const answer=wait(requestId,ms);parent.postMessage({type:'papers:proxima-device:request',requestId,operation,ownerId:extra.ownerId??'local',...extra},location.origin);return answer;};
  const call=async(params,ms=60000)=>{const requestId=crypto.randomUUID();const answer=wait(requestId,ms);window.postMessage({type:'papers:project:file-capability',requestId,operation:'remote-files',params},location.origin);const result=await answer;if(result?.ok===false)throw Error(result.message||result.code||'Papers refused the request.');return result?.result??result;};

  /** This device and the other two: {self:{name}, others:[{id,name,kind:'pc'|'phone'}]}. */
  async function devices(){
    if(phone){const list=await ask('devices');const self=list.find(device=>device.id==='local');return {self:{name:self?.name||'This phone',kind:'phone'},others:list.filter(device=>device.id!=='local').map(device=>({id:device.id,name:device.name,kind:'pc'}))};}
    const status=await call({operation:'status'});
    // A phone names itself in what it publishes (it paired under its model name).
    for(const peer of status.peers||[]){try{const published=(await call({operation:'peer-proxima',deviceId:peer.id})).snapshot?.deviceName;if(published)peer.name=published;}catch{}}
    return {self:{name:status.owner?.name||'This computer',id:status.owner?.id,kind:'pc'},others:[...(status.devices||[]).map(device=>({id:device.id,name:device.name,kind:device.kind==='phone'?'phone':'pc',native:true})),...(status.peers||[]).map(peer=>({id:peer.id,name:peer.name,kind:'phone',receivedAt:peer.receivedAt}))]};
  }
  async function proximaShare(ownerId){const catalog=await call({operation:'backpacks',ownerId});if(catalog.online===false)throw Error('That computer is offline.');const share=(catalog.entries||[]).find(entry=>entry.kind==='proxima');if(!share)throw Error('That computer has no Proxima open.');return share;}
  /** Another device's Proxima as a projection. */
  async function fetchFrom(device){
    if(phone)return (await ask('snapshot',{ownerId:device.id})).snapshot;
    if(device.kind==='phone'&&!device.native)return (await call({operation:'peer-proxima',deviceId:device.id})).snapshot;
    const share=await proximaShare(device.id);
    const result=await call({operation:'backpack-view',ownerId:device.id,resourceId:share.id});
    if(result.online===false)throw Error(device.name+' is offline.');
    return result.snapshot;
  }
  /** Overwrites through the live owner, resolving only after its backup and persistence succeed. */
  async function pushTo(device,projection){
    if(phone){await ask('replace',{ownerId:device.id,snapshot:projection},120000);return 'replaced';}
    if(device.kind==='phone'&&!device.native){const sent=await call({operation:'peer-proxima-replace',deviceId:device.id,snapshot:projection},120000);if(!sent?.delivered)throw Error('The phone did not confirm replacement.');return 'replaced';}
    const share=await proximaShare(device.id);
    await call({operation:'backpack-replace',ownerId:device.id,resourceId:share.id,snapshot:projection},120000);
    return 'replaced';
  }
  /** One Proxima sync exchange (proxima-sync.js) with a device's live owner; it rides the replace route,
   * whose owner hands a payload carrying proximaSync to the sync instead of replacing anything. */
  async function exchange(device,message){
    // records.tasks is deliberately not a list: a device still running the old whole-copy code then fails
    // while building the copy, before writing anything, instead of replacing its Proxima with nothing.
    const payload={version:1,source:{ownerId:'proxima-sync',backpackId:'proxima',seq:0,observedAt:new Date().toISOString()},records:{tasks:'proxima-sync'},proximaSync:message};
    const pick=value=>value?.proximaSync??value?.result?.proximaSync??value?.result?.result?.proximaSync;
    if(phone)return pick(await ask('replace',{ownerId:device.id,snapshot:payload},90000));
    if(device.kind==='phone'&&!device.native)throw Error('The phone must be connected.');
    const share=await proximaShare(device.id);
    return pick(await call({operation:'backpack-replace',ownerId:device.id,resourceId:share.id,snapshot:payload},90000));
  }
  const ownProjection=()=>Store.remoteProjection({ownerId:phone?'phone':'computer',backpackId:'proxima'},null,true);

  // ── Replacing this device's data (backup first) ──
  function openBackups(){return new Promise((resolve,reject)=>{const request=indexedDB.open('proxima-backups',1);request.onupgradeneeded=()=>request.result.createObjectStore('backups',{keyPath:'at'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function backup(state,reason){
    const db=await openBackups();
    await new Promise((resolve,reject)=>{const tx=db.transaction('backups','readwrite'),table=tx.objectStore('backups');table.put({at:Date.now(),reason,state});const keys=table.getAllKeys();keys.onsuccess=()=>{for(const key of keys.result.sort((a,b)=>a-b).slice(0,-10))table.delete(key);};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    db.close();
  }
  function stateFrom(projection,current){
    const records=projection.records||{},layout=projection.viewLayout||{};
    return {version:1,seq:Math.max(current?.seq||0,projection.source?.seq||0)+1,projects:records.projects||[],
      tasks:(records.tasks||[]).map(item=>({...item,...layout.tasks?.[item.id]})),scheduleEvents:records.scheduleEvents||[],
      timelineRows:(records.timelineRows||[]).map(item=>({...item,...layout.timelineRows?.[item.id]})),
      timelineIntervals:records.timelineIntervals||[],importedRuns:records.importedRuns||[],run:records.run||null};
  }
  async function replaceAll(projection,from){
    if(!projection?.records)throw Error('That device sent no Proxima data.');
    await ProximaPersistence.ready;await Store.flushCommands();
    const write=async()=>{const current=await ProximaPersistence.read();await backup(current,'Before copying from '+from);await ProximaPersistence.write(stateFrom(projection,current),{origin:'human',type:'device-copy.replace'});};
    if(navigator.locks)await navigator.locks.request('proxima-store-write',write);else await write();
    setTimeout(()=>location.reload(),300);
    return {replaced:true};
  }
  // A computer's own Proxima can be replaced by another device through Papers (confirmed over there).
  if(!phone)root.__proximaReplaceAll=(projection,from)=>replaceAll(projection,from||'another device');

  // ── The icon and its menus ──
  const style=document.createElement('style');
  style.textContent=`
.proxima-copy-confirm{position:fixed;inset:0;z-index:3200;display:grid;place-items:center;background:#0008}
.proxima-copy-confirm>div{width:min(360px,calc(100vw - 32px));padding:18px;border-radius:12px;background:var(--panel,#1f252b);border:1px solid var(--line,#414d5b);box-shadow:0 20px 50px #000a;color:var(--ink,#e6e9ef);font-size:14px;line-height:1.45}
.proxima-copy-confirm p{margin:0 0 6px}.proxima-copy-confirm .note{color:var(--dim,#97a0b0);font-size:12px}
.proxima-copy-confirm .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.proxima-copy-confirm .actions button{padding:8px 14px;border-radius:6px;border:1px solid var(--line,#414d5b);background:none;color:var(--ink,#e6e9ef);font:inherit;cursor:pointer}
.proxima-copy-confirm .actions .danger{background:#a8463f;border-color:#a8463f;color:#fff}
.proxima-copy-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:3300;max-width:calc(100vw - 32px);padding:10px 14px;border-radius:8px;background:var(--panel-2,#323b46);color:var(--ink,#e6e9ef);font-size:13px;box-shadow:0 8px 24px #0008}`;
  function toast(text,ms=5000){const node=document.createElement('div');node.className='proxima-copy-toast';node.setAttribute('role','status');node.textContent=text;document.body.append(node);setTimeout(()=>node.remove(),ms);}
  function confirmBox(lines,action){
    return new Promise(resolve=>{
      const shade=document.createElement('div');shade.className='proxima-copy-confirm';const box=document.createElement('div');shade.append(box);
      for(const [text,cls] of lines){const p=document.createElement('p');p.textContent=text;if(cls)p.className=cls;box.append(p);}
      const actions=document.createElement('div');actions.className='actions';
      const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
      const go=document.createElement('button');go.type='button';go.className='danger';go.textContent=action;
      actions.append(cancel,go);box.append(actions);
      const done=value=>{shade.remove();resolve(value);};
      cancel.addEventListener('click',()=>done(false));go.addEventListener('click',()=>done(true));shade.addEventListener('click',event=>{if(event.target===shade)done(false);});
      document.body.append(shade);go.focus();
    });
  }
  document.head.append(style);

  // device-mirror.js (the authoritative-device toggle) reuses these rather than a second transport.
  root.__proximaDeviceCopy={devices,fetchFrom,pushTo,exchange,ownProjection,backup,stateFrom,toast,confirmBox};

  // ── The phone: publish its Proxima to the computers, and take a replacement left for it ──
  if(phone){
    let timer=0;
    const publish=()=>{clearTimeout(timer);timer=setTimeout(async()=>{try{await ask('publish',{snapshot:await ownProjection()},120000);}catch{}},1500);};
    addEventListener('load',async()=>{
      await ProximaPersistence.ready;
      const write=ProximaPersistence.write.bind(ProximaPersistence);
      ProximaPersistence.write=async (state,intent)=>{const result=await write(state,intent);publish();return result;};
      publish();
    },{once:true});
    addEventListener('message',async event=>{
      if(event.source!==parent||event.data?.type!=='papers:phone:owner-changed')return;
      await ProximaPersistence.ready;
      if(typeof Store==='undefined')return;
      await Store.refreshReadSnapshot();dispatchEvent(new Event('proxima:remote-imported'));
      const timeline=document.querySelector('.exact-timeline');if(timeline)root.ExactTimeline?.mount(timeline,null)?.refresh();
    });
  }
})(globalThis);
