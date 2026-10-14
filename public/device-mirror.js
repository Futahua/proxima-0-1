/* The authoritative device. The header shows an icon for each device (desktop, laptop, phone). Clicking
 * one makes it authoritative: a circular arrow turns around it, and whenever that device's Proxima
 * changes it overwrites the other devices' Proxima with its own (a couple of seconds after the edit,
 * not on a timer). A device that was offline or had Proxima closed is retried every minute until it
 * takes the copy. Clicking the authoritative icon again turns it off.
 *
 * It reuses device-copy.js's transport and backups. A receiving computer applies the copy in place
 * (no reload) and keeps one backup per authority session, not one per edit. When two devices claim
 * authority, the later claim wins and the earlier one turns itself off.
 * Phones receive the data like any overwrite; marking a phone authoritative is done on the phone. */
(function(root){
  if(new URL(location.href).searchParams.get('papers-device'))return; // a view of another device's Proxima
  const api=root.__proximaDeviceCopy;
  if(!api)return;
  const SELF='proxima.mirror.self',AUTHORITY='proxima.mirror.authority',BACKED='proxima.mirror.backedUp',DEBOUNCE=2500,RETRY=60000;
  const load=key=>{try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}};
  const store=(key,value)=>{try{value==null?localStorage.removeItem(key):localStorage.setItem(key,JSON.stringify(value));}catch{}};
  let known=null,strip=null,timer=0,retryTimer=0,busy=false,again=false;
  const delivered=new Map(); // device name -> {ok, at, error}
  async function devices(){if(!known)known=await api.devices();return known;}
  const selfClaim=()=>load(SELF);
  const authority=()=>load(AUTHORITY);

  // ── Sending: this device is authoritative ──
  function schedule(ms=DEBOUNCE){clearTimeout(timer);timer=setTimeout(()=>void pushAll(true),ms);}
  async function pushAll(active){
    const claim=selfClaim();if(active&&!claim)return;
    if(busy){again=true;return;}busy=true;
    try{
      const {self,others}=await devices();
      const mirror={name:self.name,since:claim?.since||Date.now(),active};
      const projection=await api.ownProjection();
      for(const device of others){
        try{await api.pushTo(device,device.kind==='phone'?projection:{...projection,mirror});delivered.set(device.name,{ok:true,at:Date.now()});}
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

  // ── Receiving: another device is authoritative (computers only; the phone app applies its own) ──
  async function receive(projection,mirror){
    const {self}=await devices();
    if(mirror.name===self.name){ // another device asked this one to become (or stop being) authoritative
      if(mirror.active){store(SELF,{since:mirror.since});store(AUTHORITY,{name:self.name,since:mirror.since});render();schedule(300);}
      else{store(SELF,null);store(AUTHORITY,null);render();void pushAll(false);}
      return {mirrored:'claim'};
    }
    const own=selfClaim();
    if(own&&own.since>mirror.since)throw Error('MIRROR_NEWER_AUTHORITY: '+self.name+' is authoritative.');
    if(own){store(SELF,null);clearTimeout(timer);clearTimeout(retryTimer);}
    if(!mirror.active){if(authority()?.name===mirror.name)store(AUTHORITY,null);render();return {mirrored:'off'};}
    store(AUTHORITY,{name:mirror.name,since:mirror.since});render();
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

  // ── The icons ──
  const style=document.createElement('style');
  style.textContent=`
.proxima-mirror{display:inline-flex;align-items:center;gap:6px;margin-right:10px;vertical-align:middle}
.proxima-mirror button{position:relative;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:none;color:var(--dim,#97a0b0);cursor:pointer;display:grid;place-items:center;opacity:.55;transition:opacity .15s,color .15s}
.proxima-mirror button:hover{opacity:1;color:var(--ink,#e6e9ef)}
.proxima-mirror button.self{opacity:.85}
.proxima-mirror button.authority{opacity:1;color:var(--device-tint)}
.proxima-mirror button.failed::after{content:'';position:absolute;right:1px;bottom:2px;width:6px;height:6px;border-radius:50%;background:#c8714f}
.proxima-mirror .glyph{width:15px;height:15px;pointer-events:none}
.proxima-mirror .ring{position:absolute;inset:-2px;width:30px;height:30px;pointer-events:none;color:var(--device-tint);display:none}
.proxima-mirror button.authority .ring{display:block;animation:proxima-mirror-turn 3.2s linear infinite}
@keyframes proxima-mirror-turn{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.proxima-mirror button.authority .ring{animation:none}}`;
  const glyphs={
    desktop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    laptop:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 12.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    phone:'<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.3h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'};
  const ring='<svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><path d="M15 2.5a12.5 12.5 0 1 1-11.4 7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M1.6 6.6l2 3.5 3.6-1.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The same owner identities device-theme.js colours: SlopTop blue, LapDog green, the phone grey.
  const tint=device=>device.kind==='phone'?'#c4c6ca':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/^lapdog\b/i.test(device.name)?'#b5c3af':'#afc3d4';
  const glyph=device=>device.kind==='phone'?'phone':device.id==='417c0ac8-2d5c-4f32-9cf0-61c22ac0d774'||/lap|book/i.test(device.name)?'laptop':'desktop';
  const ago=at=>{const s=Math.round((Date.now()-at)/1000);return s<60?'just now':s<3600?Math.round(s/60)+' min ago':Math.round(s/3600)+' h ago';};
  function describe(device,isSelf,others){
    const lead=authority();
    if(lead?.name===device.name){
      const rest=others.filter(item=>item.name!==device.name).map(item=>item.name);
      let text=device.name+' is authoritative: whenever its Proxima changes it overwrites '+(rest.join(' and ')||'the other devices')+'.';
      if(isSelf)for(const [name,state] of delivered)text+='\n'+name+': '+(state.ok?'up to date ('+ago(state.at)+')':'not reached yet, retrying ('+state.error+')');
      return text+'\nClick to stop.';
    }
    if(device.kind==='phone'&&!isSelf)return device.name+'\nTo make the phone authoritative, turn it on in the phone’s Proxima.';
    return device.name+(isSelf?' (this device)':'')+'\nClick to make '+device.name+' authoritative: it will overwrite the other devices’ Proxima whenever it changes.';
  }
  function render(){
    if(!strip||!known)return;
    const everyone=[{...known.self,self:true},...known.others],lead=authority();
    strip.replaceChildren(...everyone.map(device=>{
      const button=document.createElement('button');button.type='button';
      button.className=(device.self?'self ':'')+(lead?.name===device.name?'authority ':'')+(device.self&&lead?.name===device.name&&[...delivered.values()].some(item=>!item.ok)?'failed':'');
      button.style.setProperty('--device-tint',tint(device));
      button.innerHTML=glyphs[glyph(device)]+ring;
      button.title=describe(device,device.self,everyone);button.setAttribute('aria-label',button.title.split('\n')[0]);
      button.setAttribute('aria-pressed',String(lead?.name===device.name));
      button.addEventListener('click',event=>{event.stopPropagation();void toggle(device);});
      return button;
    }));
  }
  async function toggle(device){
    const lead=authority(),{self,others}=await devices(),turningOff=lead?.name===device.name,rest=[self,...others].filter(item=>item.name!==device.name).map(item=>item.name).join(' and ');
    if(device.self){
      if(turningOff){store(SELF,null);store(AUTHORITY,null);clearTimeout(timer);clearTimeout(retryTimer);delivered.clear();render();void pushAll(false);return;}
      if(!await api.confirmBox([[self.name+' becomes authoritative.'],['Whenever its Proxima changes, it overwrites '+rest+'’s Proxima data.'],['Each device keeps a backup of what it had before.','note']],'Make authoritative'))return;
      const since=Date.now();store(SELF,{since});store(AUTHORITY,{name:self.name,since});delivered.clear();render();void pushAll(true);return;
    }
    if(device.kind==='phone'){api.toast('Turn this on in the phone’s Proxima.',5000);return;}
    if(!turningOff&&!await api.confirmBox([[device.name+' becomes authoritative.'],['Whenever its Proxima changes, it overwrites '+rest+'’s Proxima data, including this one.'],['Each device keeps a backup of what it had before.','note']],'Make authoritative'))return;
    try{
      // The device is told through its own data: its Proxima is sent back to it unchanged, with the claim.
      const projection=await api.fetchFrom(device),since=Date.now();
      await api.pushTo(device,{...projection,mirror:{name:device.name,since,active:!turningOff}});
      if(turningOff)store(AUTHORITY,null);else{store(SELF,null);store(AUTHORITY,{name:device.name,since});}
      render();
    }catch(error){api.toast('Nothing was changed: '+error.message,8000);}
  }
  function mount(){
    const actions=document.querySelector('.schedule-head-actions');if(!actions)return;
    if(!strip){strip=document.createElement('span');strip.className='proxima-mirror';}
    const name=actions.querySelector('.proxima-device-name');
    if(strip.parentNode!==actions||(name&&strip.nextSibling!==name))actions.insertBefore(strip,name||null);
  }
  async function install(){
    document.head.append(style);mount();setInterval(mount,1000);
    try{await devices();}catch{return;}
    render();
    if(selfClaim())schedule(4000); // catch up on anything missed while this page was closed
  }
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',()=>void install(),{once:true});else void install();
})(globalThis);
