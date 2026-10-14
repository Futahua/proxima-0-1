/* The device strip in the header: one icon per device (desktop, laptop, phone).
 *
 * Clicking an icon makes that device authoritative: a circular arrow turns around it, and whenever its
 * Proxima changes it overwrites the other devices' Proxima with its own (a couple of seconds after the
 * edit, not on a timer). A device that was offline or had Proxima closed is retried every minute until
 * it takes the copy. Clicking the authoritative icon again turns it off.
 * The strip under each icon switches the view to that device (it replaces the device-name button); a
 * small arrow marks the device being shown.
 *
 * It reuses device-copy.js's transport and backups. A receiving computer applies the copy in place
 * (no reload) and keeps one backup per authority session, not one per edit. When two devices claim
 * authority, the later claim wins and the earlier one turns itself off.
 * The phone takes part fully: its owner engine (Papers clients/android assets/proxima/owner.js) applies
 * copies and claims the same way and tells the open page, which then shares the phone's edits.
 *
 * Four pages show the strip: a computer's own Proxima, a computer's view of another device (an iframe
 * inside its own Proxima), the phone's own Proxima and the phone's view of a computer. Only a device's
 * own Proxima sends and receives; the views borrow it (computer) or only switch (phone). */
(function(root){
  const params=new URL(location.href).searchParams,viewing=params.get('papers-device'),phone=params.has('papers-phone');
  const SELF='proxima.mirror.self',AUTHORITY='proxima.mirror.authority',BACKED='proxima.mirror.backedUp',DEBOUNCE=2500,RETRY=60000;
  const load=key=>{try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}};
  const store=(key,value)=>{try{value==null?localStorage.removeItem(key):localStorage.setItem(key,JSON.stringify(value));}catch{}};
  const selfClaim=()=>load(SELF);
  const authority=()=>load(AUTHORITY);
  // One phone: a computer and the phone may name it differently.
  const isLead=(lead,device)=>!!lead&&(lead.name===device.name||lead.kind==='phone'&&device.kind==='phone');
  let strip=null,render=()=>{};

  // ── The page's context: what the strip lists, toggles and switches to ──
  let context=null;
  const ownerPage=(()=>{if(!viewing||phone)return null;try{return parent!==root&&parent.__proximaMirror?parent:null;}catch{return null;}})();
  if(!viewing&&root.__proximaDeviceCopy)context=createOwner(root.__proximaDeviceCopy);
  else if(ownerPage)context={devices:()=>ownerPage.__proximaMirror.devices(),toggle:device=>ownerPage.__proximaMirror.toggle(device),delivered:new Map(),current:viewing,
    switchTo:device=>ownerPage.__proximaShowDevice?.(device.self?null:device)};
  else if(viewing&&phone)context=createPhoneView();
  if(!context)return;

  function createOwner(api){
    let known=null,timer=0,retryTimer=0,busy=false,again=false;
    const delivered=new Map(); // device name -> {ok, at, error}
    async function devices(){if(!known)known=await api.devices();return known;}

    // Sending: this device is authoritative.
    function schedule(ms=DEBOUNCE){clearTimeout(timer);timer=setTimeout(()=>void pushAll(true),ms);}
    async function pushAll(active){
      const claim=selfClaim();if(active&&!claim)return;
      if(busy){again=true;return;}busy=true;
      try{
        const {self,others}=await devices();
        const mirror={name:self.name,kind:self.kind,since:claim?.since||Date.now(),active};
        const projection=await api.ownProjection();
        for(const device of others){
          try{await api.pushTo(device,{...projection,mirror});delivered.set(device.name,{ok:true,at:Date.now()});}
          catch(error){
            if(/MIRROR_NEWER_AUTHORITY/.test(error.message)){store(SELF,null);api.toast(device.name+' became authoritative after '+self.name+'; '+self.name+' stopped overwriting.',8000);break;}
            delivered.set(device.name,{ok:false,at:Date.now(),error:error.message});
          }
        }
      }catch(error){api.toast('Could not share this Proxima: '+error.message,6000);}
      finally{
        busy=false;render();
        clearTimeout(retryTimer);
        if(selfClaim()&&[...delivered.values()].some(item=>!item.ok))retryTimer=setTimeout(()=>void pushAll(true),RETRY);
        if(again){again=false;schedule();}
      }
    }
    // Every saved change on this device schedules one overwrite of the others.
    if(root.ProximaPersistence?.write){const write=ProximaPersistence.write.bind(ProximaPersistence);ProximaPersistence.write=async state=>{const result=await write(state);if(selfClaim())schedule();return result;};}

    // Receiving (computers; the phone's owner engine does the same).
    async function receive(projection,mirror){
      const {self}=await devices();
      if(mirror.claim){ // another device asked this one to become (or stop being) authoritative
        if(mirror.active){store(SELF,{since:mirror.since});store(AUTHORITY,{name:self.name,kind:self.kind,since:mirror.since});render();schedule(300);}
        else{store(SELF,null);store(AUTHORITY,null);render();void pushAll(false);}
        return {mirrored:'claim'};
      }
      const own=selfClaim();
      if(own&&own.since>mirror.since)throw Error('MIRROR_NEWER_AUTHORITY: '+self.name+' is authoritative.');
      if(own){store(SELF,null);clearTimeout(timer);clearTimeout(retryTimer);}
      const lead={name:mirror.name,kind:mirror.kind,since:mirror.since};
      if(!mirror.active){if(isLead(authority(),lead))store(AUTHORITY,null);render();return {mirrored:'off'};}
      store(AUTHORITY,lead);render();
      await ProximaPersistence.ready;await Store.flushCommands();
      const session=mirror.name+'@'+mirror.since;
      const write=async()=>{const current=await ProximaPersistence.read();if(load(BACKED)!==session){await api.backup(current,'Before '+mirror.name+' became authoritative');store(BACKED,session);}await ProximaPersistence.write(api.stateFrom(projection,current));};
      if(navigator.locks)await navigator.locks.request('proxima-store-write',write);else await write();
      await Store.remoteProjection({ownerId:'computer',backpackId:'proxima'}); // re-reads the store from what was just written
      dispatchEvent(new Event('proxima:remote-imported'));
      const timeline=document.querySelector('.exact-timeline');if(timeline)root.ExactTimeline?.mount(timeline,null)?.refresh();
      return {mirrored:true};
    }
    const replaceAll=root.__proximaReplaceAll;
    if(replaceAll)root.__proximaReplaceAll=(projection,from)=>{const mirror=projection?.mirror;if(!mirror||typeof mirror.name!=='string')return replaceAll(projection,from);const {mirror:_,...data}=projection;return receive(data,mirror);};

    async function toggle(device){
      const lead=authority(),{self,others}=await devices(),turningOff=isLead(lead,device),rest=[self,...others].filter(item=>item.name!==device.name).map(item=>item.name).join(' and ');
      if(device.self){
        if(turningOff){store(SELF,null);store(AUTHORITY,null);clearTimeout(timer);clearTimeout(retryTimer);delivered.clear();render();void pushAll(false);return;}
        if(!await api.confirmBox([[self.name+' becomes authoritative.'],['Whenever its Proxima changes, it overwrites '+rest+'’s Proxima data.'],['Each device keeps a backup of what it had before.','note']],'Make authoritative'))return;
        const since=Date.now();store(SELF,{since});store(AUTHORITY,{name:self.name,kind:self.kind,since});delivered.clear();render();void pushAll(true);return;
      }
      if(!turningOff&&!await api.confirmBox([[device.name+' becomes authoritative.'],['Whenever its Proxima changes, it overwrites '+rest+'’s Proxima data, including this one.'],['Each device keeps a backup of what it had before.','note']],'Make authoritative'))return;
      try{
        // The device is told through its own data: its Proxima is sent back to it unchanged, with the claim.
        const projection=await api.fetchFrom(device),since=Date.now();
        await api.pushTo(device,{...projection,mirror:{name:device.name,kind:device.kind,since,active:!turningOff,claim:true}});
        if(turningOff)store(AUTHORITY,null);else{store(SELF,null);store(AUTHORITY,{name:device.name,kind:device.kind,since});}
        render();
      }catch(error){api.toast('Nothing was changed: '+error.message,8000);}
    }
    // On the phone the owner engine applies copies and claims, then tells this page.
    let wasSelf=!!selfClaim();
    addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='papers:phone:owner-changed')return;const now=!!selfClaim();render();if(now&&!wasSelf)schedule(300);wasSelf=now;});
    // A computer's views of other devices borrow this page's list and toggle.
    root.__proximaMirror={devices,toggle:device=>toggle(device)};
    const switchTo=phone
      ?device=>parent.postMessage({type:'papers:proxima-device:open',ownerId:device.self?'local':device.id},location.origin)
      :device=>{if(!device.self)root.__proximaShowDevice?.(device);};
    return {devices,toggle,switchTo,delivered,current:null,start(){if(selfClaim())schedule(4000);}}; // catch up on anything missed while closed
  }

  // The phone's view of a computer: it lists and switches; authority is set from the phone's own Proxima.
  function createPhoneView(){
    const pending=new Map();
    addEventListener('message',event=>{const value=event.data;if(event.source!==parent||value?.type!=='papers:proxima-device:result')return;const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.result):task.reject(Error(value.error||'The phone did not answer.'));});
    const ask=operation=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();pending.set(requestId,{resolve,reject});parent.postMessage({type:'papers:proxima-device:request',requestId,operation,ownerId:viewing},location.origin);setTimeout(()=>{if(pending.delete(requestId))reject(Error('The phone did not answer.'));},20000);});
    let known=null;
    return {delivered:new Map(),current:viewing,toggle:null,
      async devices(){if(!known){const list=await ask('devices'),self=list.find(item=>item.id==='local');known={self:{id:'local',name:self?.name||'This phone',kind:'phone'},others:list.filter(item=>item.id!=='local').map(item=>({id:item.id,name:item.name,kind:item.kind==='phone'?'phone':'pc'}))};}return known;},
      switchTo:device=>parent.postMessage({type:'papers:proxima-device:open',ownerId:device.self?'local':device.id},location.origin)};
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
.proxima-mirror .device.authority{opacity:1;color:var(--device-tint)}
.proxima-mirror .device.failed::after{content:'';position:absolute;right:1px;bottom:2px;width:6px;height:6px;border-radius:50%;background:#c8714f}
.proxima-mirror .glyph{width:15px;height:15px;pointer-events:none}
.proxima-mirror .ring{position:absolute;inset:-2px;width:30px;height:30px;pointer-events:none;color:var(--device-tint);display:none}
.proxima-mirror .device.authority .ring{display:block;animation:proxima-mirror-turn 3.2s linear infinite}
.proxima-mirror .switch{width:30px;height:14px;display:grid;place-items:center;color:var(--dim,#97a0b0)}
.proxima-mirror .switch svg{width:9px;height:6px;opacity:0;transition:opacity .15s}
.proxima-mirror .switch:hover svg{opacity:.6}
.proxima-mirror .current .switch svg{opacity:.9;color:var(--accent,#afc3d4)}
.proxima-mirror .current .switch{cursor:default}
html.proxima-mirror-strip .schedule-head-actions .proxima-device-name{display:none}
@keyframes proxima-mirror-turn{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.proxima-mirror .device.authority .ring{animation:none}}`;
  const glyphs={
    desktop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    laptop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 12.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    phone:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.3h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'};
  const ring='<svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><path d="M21 4.6A12 12 0 1 1 9 4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.8 3L9.9 7.1 7.3 2.6Z" fill="currentColor"/></svg>';
  const caret='<svg viewBox="0 0 9 6" aria-hidden="true"><path d="M4.5 0L9 6H0Z" fill="currentColor"/></svg>';
  // The same owner identities device-theme.js colours: SlopTop blue, LapDog green, the phone grey.
  const tint=device=>device.kind==='phone'?'#c4c6ca':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/^lapdog\b/i.test(device.name)?'#b5c3af':'#afc3d4';
  const glyph=device=>device.kind==='phone'?'phone':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/lap|book/i.test(device.name)?'laptop':'desktop';
  const ago=at=>{const s=Math.round((Date.now()-at)/1000);return s<60?'just now':s<3600?Math.round(s/60)+' min ago':Math.round(s/3600)+' h ago';};
  function describe(device,everyone){
    const lead=authority();
    if(isLead(lead,device)){
      const rest=everyone.filter(item=>item!==device).map(item=>item.name);
      let text=device.name+' is authoritative: whenever its Proxima changes it overwrites '+(rest.join(' and ')||'the other devices')+'.';
      if(device.self)for(const [name,state] of context.delivered)text+='\n'+name+': '+(state.ok?'up to date ('+ago(state.at)+')':'not reached yet, retrying ('+state.error+')');
      return text+(context.toggle?'\nClick to stop.':'');
    }
    if(!context.toggle)return device.name+'\nMake a device authoritative from the phone’s own Proxima.';
    return device.name+(device.self?' (this device)':'')+'\nClick to make '+device.name+' authoritative: it will overwrite the other devices’ Proxima whenever it changes.';
  }
  let known=null;
  render=()=>{
    if(!strip||!known)return;
    const everyone=[{...known.self,self:true},...known.others],lead=authority();
    strip.replaceChildren(...everyone.map(device=>{
      const slot=document.createElement('span'),shown=context.current?device.id===context.current:device.self;slot.className='proxima-mirror-slot'+(shown?' current':'');
      const button=document.createElement('button');button.type='button';
      button.className='device '+(isLead(lead,device)?'authority ':'')+(device.self&&isLead(lead,device)&&[...context.delivered.values()].some(item=>!item.ok)?'failed':'');
      button.style.setProperty('--device-tint',tint(device));
      button.innerHTML=glyphs[glyph(device)]+ring;
      button.title=describe(device,everyone);button.setAttribute('aria-label',button.title.split('\n')[0]);
      button.setAttribute('aria-pressed',String(isLead(lead,device)));
      button.addEventListener('click',event=>{event.stopPropagation();if(context.toggle)void context.toggle(device);});
      const view=document.createElement('button');view.type='button';view.className='switch';view.innerHTML=caret;
      view.title=shown?'Showing '+device.name:'Show '+device.name+'’s Proxima';view.setAttribute('aria-label',view.title);view.setAttribute('aria-current',String(shown));
      view.addEventListener('click',event=>{event.stopPropagation();if(!shown)context.switchTo(device);});
      slot.append(button,view);
      return slot;
    }));
  };
  addEventListener('storage',event=>{if(event.key===AUTHORITY||event.key===SELF)render();});
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
  }
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',()=>void install(),{once:true});else void install();
})(globalThis);
