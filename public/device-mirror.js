/* The driver of Proxima sync between the creator's devices (rules: sync-core.js; storage and exchange:
 * proxima-sync.js). There is one Proxima on every device, so nothing here is shown: no device icons,
 * no device-name button and no copy button (creator, 2026-10-14).
 *
 * Every device keeps its own full Proxima and works offline. A couple of seconds after an edit and
 * every 10 seconds (20 on the phone), this device exchanges calendar changes the other has not seen
 * with every device it can reach, all at once, so a slow or unreachable device delays no one (an edit
 * made on BOP's web page arrives within seconds). Blob folder files sync in their own 30-second loop;
 * both sides merge field by field (the later edit wins) and repair. A device the last exchange could
 * not reach (offline, or Proxima not open there) is retried after 1, 2, 4 … 30 minutes. Merges that
 * had to decide something are reported in a short note.
 *
 * Runs in a device's own Proxima only (computer page, phone page); on a computer one open Proxima page
 * drives at a time. The phone's owner engine answers computers while the phone's Proxima is closed
 * (Papers clients/android assets/proxima/owner.js).
 *
 * This replaced the earlier "authoritative device" toggle; its leftover keys are cleared once sync is
 * ready, and copies still pushed by a device running the old code are refused so they cannot
 * overwrite edits. */
(function(root){
  if(new URL(location.href).searchParams.get('papers-device'))return; // a view of another device's Proxima
  const api=root.__proximaDeviceCopy,sync=root.ProximaSync;
  if(!api||!sync)return;
  const PHONE=new URL(location.href).searchParams.has('papers-phone');
  const CALENDAR_EVERY=PHONE?20000:10000,FILES_EVERY=30000,AFTER_EDIT=2000;

  // The device-name button and the old copy button have no purpose with one Proxima.
  const style=document.createElement('style');
  style.textContent='.schedule-head-actions .proxima-device-name,.proxima-copy-icon{display:none}';
  (document.head||document.documentElement).append(style);

  let known=null,knownAt=0,timer=0,driving=false,running=null;
  const status=new Map(); // device id -> {state:'ok'|'failed', at, error, wait, retryAt}
  async function devices(){if(!known||Date.now()-knownAt>30000){known=await api.devices();knownAt=Date.now();}return known;}
  async function syncOne(device){
    const previous=status.get(device.id);
    try{
      const {self}=await devices();
      const result=await sync.syncWith(device.id,message=>api.exchange(device,message),{self:self.name,peer:device.name});
      dispatchEvent(new Event('proxima-sync:conflicts')); // a merge can add conflicts without changing what shows
      status.set(device.id,{state:'ok',at:Date.now()});
      if(result.notes.length)api.toast('Synced with '+device.name+': '+result.notes.join(' '),9000);
    }catch(error){
      const wait=Math.min(30*60000,previous?.wait?previous.wait*2:60000);
      status.set(device.id,{state:'failed',at:Date.now(),error:error.message,wait,retryAt:Date.now()+wait});
    }
  }
  const reachable=async()=>{const {others}=await devices();return others.filter(device=>!(status.get(device.id)?.retryAt>Date.now()));};
  async function syncAll(){
    if(running)return running;
    running=(async()=>{try{await Promise.all((await reachable()).map(syncOne));}catch{}finally{running=null;caughtUp?.();}})();
    return running;
  }
  // Blob folder records and files: slower, and kept apart so they never hold up calendar edits.
  let filesRunning=null;
  function syncFiles(){
    if(filesRunning||!root.ProximaWorkspaces)return filesRunning;
    filesRunning=(async()=>{try{await Promise.all((await reachable()).filter(device=>status.get(device.id)?.state==='ok').map(device=>root.ProximaWorkspaces.syncWith(device,message=>api.exchange(device,message)).catch(()=>{})));}catch{}finally{filesRunning=null;}})();
    return filesRunning;
  }
  function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>{if(driving)void syncAll();},ms);}
  // One open Proxima page per device drives; another takes over when it closes.
  function drive(){
    const start=()=>{driving=true;schedule(1500);setInterval(()=>void syncAll(),CALENDAR_EVERY);setTimeout(()=>{void syncFiles();setInterval(()=>void syncFiles(),FILES_EVERY);},5000);addEventListener('proxima-sync:local-change',()=>schedule(AFTER_EDIT));return new Promise(()=>{});};
    if(root.navigator?.locks)navigator.locks.request('proxima-sync-driver',start);else void start();
  }

  // Sync requests ride the replace route; whole copies from a device still running the authority
  // model are refused, because they would overwrite edits.
  const replaceAll=root.__proximaReplaceAll;
  // A device that just reached this one is online, so a backoff from when it was unreachable must not
  // keep this side from syncing back (and recording its acknowledgement) for up to 30 minutes. At most
  // once a minute, so a device that is still unreachable is not retried on every contact.
  // The page that receives an exchange (on a computer, the hidden owner) need not be the page that
  // drives, so the contact is told to every Proxima page on this device.
  let contactAt=0;
  const contacts=typeof BroadcastChannel==='function'?new BroadcastChannel('proxima-sync-peer-contact'):null;
  function retryFailed(){
    let retry=false;
    for(const [id,value] of status)if(value.state==='failed'&&value.retryAt>Date.now()){status.set(id,{...value,retryAt:0});retry=true;}
    if(retry)schedule(1000);
  }
  function peerContact(){
    if(Date.now()-contactAt<60000)return;contactAt=Date.now();
    retryFailed();contacts?.postMessage('contact');
  }
  contacts?.addEventListener('message',retryFailed);
  if(replaceAll)root.__proximaReplaceAll=(projection,from)=>{
    if(projection?.proximaSync){peerContact();return sync.exchange(projection.proximaSync).then(proximaSync=>({proximaSync}));}
    if(projection?.mirror)throw Error('This device now syncs instead of taking whole copies; update '+(projection.mirror.name||'the sending device')+'.');
    return replaceAll(projection,from);
  };
  // On the phone the owner engine merges while this page may be open; it tells the page.
  addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='papers:phone:owner-changed')void sync.ready.then(()=>{if(typeof Store!=='undefined')return Store.remoteProjection({ownerId:'computer',backpackId:'proxima'}).then(()=>{dispatchEvent(new Event('proxima:remote-imported'));const t=document.querySelector('.exact-timeline');if(t)root.ExactTimeline?.mount(t,null)?.refresh();});});});

  // For checks: the sync state and an immediate sync.
  root.__proximaMirror={devices,status:()=>status,syncNow:syncAll,syncFiles};
  // Automatic changes (a queue freezing when its time is up) wait until this device has caught up with
  // the others it can reach, so a device opened after a while does not redo, from its old copy, what
  // another device already did. At most 20 seconds when a device does not answer.
  let caughtUp;root.__proximaCaughtUp=new Promise(resolve=>{caughtUp=resolve;setTimeout(resolve,20000);});
  void sync.ready.then(()=>{try{for(const key of ['proxima.mirror.self','proxima.mirror.authority','proxima.mirror.backedUp'])localStorage.removeItem(key);}catch{}drive();});
})(globalThis);
