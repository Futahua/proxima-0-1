/* The device strip in the header: one icon per device (desktop, laptop, phone), and the driver of
 * Proxima sync between them (rules: sync-core.js; storage and exchange: proxima-sync.js).
 *
 * Every device keeps its own full Proxima and works offline. A couple of seconds after an edit, every
 * 30 seconds, and when an icon is clicked, this device exchanges what the other has not seen with each
 * device it can reach; both sides merge field by field (the later edit wins) and repair. While an
 * exchange runs a circular arrow turns around that device's icon; a small dot marks a device the last
 * exchange could not reach (offline, or Proxima not open there). Merges that had to decide something
 * are reported in a short note.
 * With every device holding the same Proxima there is nothing to switch to: the strip replaces the
 * device-name button and the old copy button (creator, 2026-10-14), and views of another device are
 * no longer offered from here.
 *
 * Four pages show the strip: a computer's own Proxima, a computer's view of another device (an iframe
 * inside its own Proxima), the phone's own Proxima and the phone's view of a computer. Only a device's
 * own Proxima syncs; the views borrow its state (computer) or only list devices (phone). On a computer only one
 * open Proxima page drives sync at a time. The phone's owner engine answers computers while the phone's
 * Proxima is closed (Papers clients/android assets/proxima/owner.js).
 *
 * This replaced the earlier "authoritative device" toggle; its leftover keys are cleared once sync is
 * ready, and copies still pushed by a device running the old code are refused so they cannot
 * overwrite edits. */
(function(root){
  const params=new URL(location.href).searchParams,viewing=params.get('papers-device'),phone=params.has('papers-phone');
  const SYNC_EVERY=30000,AFTER_EDIT=2000;
  let strip=null,render=()=>{};

  // ── The page's context: what the strip lists and activates ──
  let context=null;
  const ownerPage=(()=>{if(!viewing||phone)return null;try{return parent!==root&&parent.__proximaMirror?parent:null;}catch{return null;}})();
  if(!viewing&&root.__proximaDeviceCopy&&root.ProximaSync)context=createOwner(root.__proximaDeviceCopy,root.ProximaSync);
  else if(ownerPage)context={devices:()=>ownerPage.__proximaMirror.devices(),activate:device=>ownerPage.__proximaMirror.activate(device),status:()=>ownerPage.__proximaMirror.status(),current:viewing};
  else if(viewing&&phone)context=createPhoneView();
  if(!context)return;

  function createOwner(api,sync){
    let known=null,timer=0,driving=false;
    const status=new Map(); // device id -> {state:'syncing'|'ok'|'failed', at, error}
    async function devices(){if(!known)known=await api.devices();return known;}
    async function syncOne(device){
      const previous=status.get(device.id);
      status.set(device.id,{...previous,state:'syncing'});render();
      try{
        const result=await sync.syncWith(device.id,message=>api.exchange(device,message));
        status.set(device.id,{state:'ok',at:Date.now()});
        if(result.notes.length)api.toast('Synced with '+device.name+': '+result.notes.join(' '),9000);
      }catch(error){
        // An unreachable device is retried after 1, 2, 4 … 30 minutes (a click retries at once).
        const wait=Math.min(30*60000,previous?.wait?previous.wait*2:60000);
        status.set(device.id,{state:'failed',at:Date.now(),error:error.message,wait,retryAt:Date.now()+wait});
      }
      render();
    }
    let running=null;
    async function syncAll(manual=false){
      if(running)return running;
      running=(async()=>{try{const {others}=await devices();for(const device of others)if(manual||!(status.get(device.id)?.retryAt>Date.now()))await syncOne(device);}catch{}finally{running=null;}})();
      return running;
    }
    function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>{if(driving)void syncAll();},ms);}
    // One open Proxima page per device drives; another takes over when it closes.
    function drive(){
      const start=()=>{driving=true;schedule(1500);setInterval(()=>void syncAll(),SYNC_EVERY);addEventListener('proxima-sync:local-change',()=>schedule(AFTER_EDIT));return new Promise(()=>{});};
      if(root.navigator?.locks)navigator.locks.request('proxima-sync-driver',start);else void start();
    }
    // Copies pushed by a device still running the authority model are refused: they would overwrite edits.
    const replaceAll=root.__proximaReplaceAll;
    if(replaceAll)root.__proximaReplaceAll=(projection,from)=>{
      if(projection?.proximaSync)return sync.exchange(projection.proximaSync).then(proximaSync=>({proximaSync}));
      if(projection?.mirror)throw Error('This device now syncs instead of taking whole copies; update '+(projection.mirror.name||'the sending device')+'.');
      return replaceAll(projection,from);
    };
    // On the phone the owner engine merges while this page may be open; it tells the page.
    addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='papers:phone:owner-changed')void sync.ready.then(()=>{if(typeof Store!=='undefined')return Store.remoteProjection({ownerId:'computer',backpackId:'proxima'}).then(()=>{dispatchEvent(new Event('proxima:remote-imported'));const t=document.querySelector('.exact-timeline');if(t)root.ExactTimeline?.mount(t,null)?.refresh();});});});
    const activate=device=>device.self?syncAll(true):syncOne(device);
    root.__proximaMirror={devices,activate,status:()=>status};
    return {devices,activate,status:()=>status,current:null,
      start(){void sync.ready.then(()=>{try{for(const key of ['proxima.mirror.self','proxima.mirror.authority','proxima.mirror.backedUp'])localStorage.removeItem(key);}catch{}drive();});}};
  }

  // The phone's view of a computer: it lists; the phone's own Proxima syncs.
  function createPhoneView(){
    const pending=new Map();
    addEventListener('message',event=>{const value=event.data;if(event.source!==parent||value?.type!=='papers:proxima-device:result')return;const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.result):task.reject(Error(value.error||'The phone did not answer.'));});
    const ask=operation=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();pending.set(requestId,{resolve,reject});parent.postMessage({type:'papers:proxima-device:request',requestId,operation,ownerId:viewing},location.origin);setTimeout(()=>{if(pending.delete(requestId))reject(Error('The phone did not answer.'));},20000);});
    let known=null;
    return {current:viewing,activate:null,status:()=>new Map(),
      async devices(){if(!known){const list=await ask('devices'),self=list.find(item=>item.id==='local');known={self:{id:'local',name:self?.name||'This phone',kind:'phone'},others:list.filter(item=>item.id!=='local').map(item=>({id:item.id,name:item.name,kind:item.kind==='phone'?'phone':'pc'}))};}return known;}};
  }

  // ── The strip ──
  const style=document.createElement('style');
  style.textContent=`
.proxima-mirror{display:inline-flex;align-items:flex-start;gap:6px;margin-right:4px;vertical-align:middle}
.proxima-mirror-slot{display:grid;justify-items:center}
.proxima-mirror-slot>button{border:0;background:none;padding:0;cursor:pointer}
.proxima-mirror .device{position:relative;width:26px;height:26px;border-radius:50%;color:var(--dim,#97a0b0);display:grid;place-items:center;opacity:.55;transition:opacity .15s,color .15s}
.proxima-mirror .device:hover{opacity:1;color:var(--ink,#e6e9ef)}
.proxima-mirror .current .device{opacity:.9}
.proxima-mirror .device.syncing{opacity:1;color:var(--device-tint)}
.proxima-mirror .device.failed::after{content:'';position:absolute;right:1px;bottom:2px;width:6px;height:6px;border-radius:50%;background:#c8714f}
.proxima-mirror .glyph{width:15px;height:15px;pointer-events:none}
.proxima-mirror .ring{position:absolute;inset:-2px;width:30px;height:30px;pointer-events:none;color:var(--device-tint);display:none}
.proxima-mirror .device.syncing .ring{display:block;animation:proxima-mirror-turn 1.2s linear infinite}
html.proxima-mirror-strip .schedule-head-actions .proxima-device-name,html.proxima-mirror-strip .proxima-copy-icon{display:none}
@keyframes proxima-mirror-turn{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.proxima-mirror .device.syncing .ring{animation:none}}`;
  const glyphs={
    desktop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    laptop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 12.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    phone:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.3h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'};
  const ring='<svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><path d="M21 4.6A12 12 0 1 1 9 4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.8 3L9.9 7.1 7.3 2.6Z" fill="currentColor"/></svg>';
  // The same owner identities device-theme.js colours: SlopTop blue, LapDog green, the phone grey.
  const tint=device=>device.kind==='phone'?'#c4c6ca':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/^lapdog\b/i.test(device.name)?'#b5c3af':'#afc3d4';
  const glyph=device=>device.kind==='phone'?'phone':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/lap|book/i.test(device.name)?'laptop':'desktop';
  let known=null;
  render=()=>{
    if(!strip||!known)return;
    const everyone=[{...known.self,self:true},...known.others],status=context.status();
    const syncingAny=[...status.values()].some(item=>item.state==='syncing');
    strip.replaceChildren(...everyone.map(device=>{
      const slot=document.createElement('span'),shown=context.current?device.id===context.current:device.self;slot.className='proxima-mirror-slot'+(shown?' current':'');
      const state=device.self?(syncingAny?'syncing':''):status.get(device.id)?.state||'';
      const button=document.createElement('button');button.type='button';
      button.className='device '+state;
      button.style.setProperty('--device-tint',tint(device));
      button.innerHTML=glyphs[glyph(device)]+ring;
      button.setAttribute('aria-label',device.self?'Sync '+device.name+' with the other devices now':'Sync with '+device.name+' now'+(state==='failed'?' (last attempt could not reach it)':'')); // no hover tooltip (creator)
      button.addEventListener('click',event=>{event.stopPropagation();if(context.activate)void context.activate(device);});
      slot.append(button);
      return slot;
    }));
  };
  function mount(){
    const actions=document.querySelector('.schedule-head-actions');if(!actions)return;
    if(!strip){strip=document.createElement('span');strip.className='proxima-mirror';}
    const name=actions.querySelector('.proxima-device-name');
    if(strip.parentNode!==actions||(name&&strip.nextSibling!==name))actions.insertBefore(strip,name||null);
  }
  async function install(){
    document.head.append(style);mount();setInterval(mount,1000);
    try{known=await context.devices();}catch{return;}
    document.documentElement.classList.add('proxima-mirror-strip'); // the strip replaces the device-name button
    render();context.start?.();
    if(!context.start)setInterval(render,1000); // a view mirrors its owner page's sync state
  }
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',()=>void install(),{once:true});else void install();
})(globalThis);
