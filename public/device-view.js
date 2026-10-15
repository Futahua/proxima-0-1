/* Another device's Proxima, shown by this same page. Loaded before persistence.js; it does
 * nothing unless the page was opened with ?papers-device=<id> (the phone's Proxima). The
 * device's live snapshot stands in for local storage, every command is refused, and touch
 * is turned into the wheel and drag gestures the desktop page already understands. */
(function(root){
  const params=new URL(location.href).searchParams,ownerId=params.get('papers-device');
  if(!/^[0-9a-f-]{36}$/i.test(ownerId||''))return;
  const pending=new Map();
  addEventListener('message',event=>{const value=event.data;if(event.source!==parent||value?.type!=='papers:proxima-device:result')return;const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.result):task.reject(Error(value.error||'The device did not answer.'));});
  const ask=(operation,extra={})=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();pending.set(requestId,{resolve,reject});parent.postMessage({type:'papers:proxima-device:request',requestId,operation,ownerId,...extra},location.origin);setTimeout(()=>{if(pending.delete(requestId))reject(Error('The device did not answer.'));},20000);});
  // The device's records in the shape Proxima keeps them.
  const toState=snapshot=>{const records=snapshot.records||{};return {version:1,seq:snapshot.source?.seq||0,projects:records.projects||[],tasks:(records.tasks||[]).map(item=>({...item,...snapshot.viewLayout?.tasks?.[item.id]})),scheduleEvents:records.scheduleEvents||[],timelineRows:(records.timelineRows||[]).map(item=>({...item,...snapshot.viewLayout?.timelineRows?.[item.id]})),timelineIntervals:records.timelineIntervals||[],importedRuns:records.importedRuns||[],run:records.run||null};};
  let state=null,seq=null,sourceIdentity=null,online=false,commandQueue=Promise.resolve(),commanding=0,polling=false,pushEvents=false;
  const canControl=params.get('papers-control')==='1';
  function receive(loaded){const source=loaded.snapshot?.source;if(source?.ownerId!==ownerId||!source.backpackId)throw Error('Source Proxima identity changed.');if(sourceIdentity&&source.backpackId!==sourceIdentity)throw Error('Source Proxima identity changed.');if(seq!==null&&source.seq<seq)return;sourceIdentity=source.backpackId;seq=source.seq;state=toState(loaded.snapshot);online=loaded.online===true;pushEvents=loaded.events===true;}
  const api={initialRaw:null,read:async()=>structuredClone(state),write:async()=>{throw Error('Remote data can only be saved by its owner.');},close:()=>{},ready:null,device:{ownerId}};
  api.ready=(async()=>{const loaded=await ask('snapshot');if(canControl&&!loaded.online)throw Error('The owner must be online to open Proxima for control.');receive(loaded);api.initialRaw=JSON.stringify(state);document.documentElement.dataset.device=loaded.name||'';})();
  root.ProximaPersistence=api;
  async function refreshView(){if(typeof Store!=='undefined')await Store.refreshReadSnapshot();dispatchEvent(new Event('proxima:remote-imported'));const timeline=document.querySelector('.exact-timeline');if(timeline)root.ExactTimeline?.mount(timeline,null)?.refresh();}
  const command=envelope=>{commanding++;const execute=async()=>{if(!canControl)return {ok:false,changed:false,code:'READ_ONLY'};try{if(!online)receive(await ask('snapshot'));if(!online)return {ok:false,changed:false,code:'OWNER_OFFLINE'};const loaded=await ask('command',{command:{...envelope,commandId:envelope.commandId||crypto.randomUUID(),expectedSeq:seq}});receive(loaded);await refreshView();return loaded.command;}catch(error){online=false;return {ok:false,changed:false,code:'OWNER_UNCONFIRMED',message:error.message};}};const next=commandQueue.then(execute);commandQueue=next.catch(()=>{});return next.finally(()=>commanding--);};
  root.__proximaDevice={ownerId,ask,canControl,command};
  // Only accepted owner checkpoints update this in-memory view; never local persistence.
  const pollTimer=setInterval(async()=>{if(pushEvents||polling||commanding||document.hidden)return;polling=true;try{const loaded=await ask('snapshot');if(commanding)return;const previous=seq;receive(loaded);if(seq!==previous){if(canControl)await refreshView();else location.reload();}}catch{online=false;}finally{polling=false;}},5000);
  addEventListener('message',async event=>{
    if(event.source!==parent||event.data?.type!=='papers:device:changed'||event.data.ownerId!==ownerId)return;
    try{await api.ready;await commandQueue;const before=seq;receive(await ask('snapshot'));if(before!==seq)await refreshView();}catch{online=false;}
  });
  addEventListener('pagehide',()=>clearInterval(pollTimer),{once:true});
  document.documentElement.classList.add('proxima-device-view');
  // No frame of the default layout: the page stays hidden until it has drawn the device's own data,
  // then tells its host (the PC's Devices view or the phone) that it is ready to be shown.
  document.documentElement.style.visibility='hidden';
  const reveal=()=>{if(document.documentElement.style.visibility!=='hidden')return;document.documentElement.style.visibility='';try{parent.postMessage({type:'proxima:device-view-ready',ownerId},location.origin);}catch{}};
  api.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(reveal)),reveal);setTimeout(reveal,15000);

  // Touch: one finger keeps the page's own read-only drag; two fingers pinch-zoom the timeline
  // (the desktop's ctrl+wheel at the pinch centre); a horizontal swipe on the calendar moves the
  // period (the desktop's wheel over the weekday header).
  // Some Android WebViews deliver no pointer events for touch at all, so touch always pans through
  // this layer (the desktop's wheel pan) and a touch pointer never starts the mouse drag as well.
  let pinch=null,swipe=null,pan=null;
  addEventListener('pointerdown',event=>{if(event.pointerType==='touch'&&event.target.closest?.('.exact-tracks'))event.stopImmediatePropagation();},{capture:true});
  const wheel=(target,init)=>target.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaMode:0,...init}));
  const timelineAt=target=>{const timeline=target.closest?.('.exact-timeline');return timeline?{target:timeline,left:timeline.getBoundingClientRect().left}:null;};
  const moveTimeline=(timeline,detail)=>timeline.target.dispatchEvent(new CustomEvent('proxima:timeline-touch',{detail}));
  addEventListener('touchstart',event=>{
    if(event.touches.length===2){const [a,b]=event.touches,timeline=timelineAt(event.target);pinch=timeline?{distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),timeline}:null;swipe=null;pan=null;return;}
    const t=event.touches[0];
    pan=event.target.closest?.('.exact-tracks')?{x:t.clientX,y:t.clientY,horizontal:null,timeline:timelineAt(event.target)}:null;
    swipe=event.target.closest?.('#scheduleBody,.schedule-body')?{x:t.clientX,y:t.clientY,target:event.target}:null;
  },{passive:true,capture:true});
  addEventListener('touchmove',event=>{
    if(pan&&event.touches.length===1){
      const t=event.touches[0],dx=t.clientX-pan.x,dy=t.clientY-pan.y;
      if(pan.horizontal===null&&Math.hypot(dx,dy)>8)pan.horizontal=Math.abs(dx)>Math.abs(dy);
      if(pan.horizontal&&pan.timeline){event.preventDefault();moveTimeline(pan.timeline,{deltaX:-dx});pan.x=t.clientX;pan.y=t.clientY;}
      return;
    }
    if(!pinch||event.touches.length!==2)return;
    const [a,b]=event.touches,distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),x=(a.clientX+b.clientX)/2,y=(a.clientY+b.clientY)/2;
    event.preventDefault();
    if(distance>0&&pinch.distance>0)moveTimeline(pinch.timeline,{factor:distance/pinch.distance,x:x-pinch.timeline.left});
    pinch.distance=distance;
  },{passive:false,capture:true});
  addEventListener('touchend',event=>{
    if(event.touches.length<2)pinch=null;
    if(!event.touches.length)pan=null;
    if(!swipe||event.touches.length)return;
    const t=event.changedTouches[0],dx=t.clientX-swipe.x,dy=t.clientY-swipe.y;swipe=null;
    if(Math.abs(dx)<48||Math.abs(dx)<Math.abs(dy)*1.5)return;
    const header=document.querySelector('.schedule-weekday,.schedule-timed-header');
    if(header){const box=header.getBoundingClientRect();wheel(header,{clientX:box.left+box.width/2,clientY:box.top+box.height/2,deltaY:dx<0?100:-100});}
  },{passive:true,capture:true});
  addEventListener('touchcancel',()=>{pinch=null;pan=null;swipe=null;},{passive:true,capture:true});

  // Proxima's own Devices buttons switch between devices here.
  addEventListener('DOMContentLoaded',()=>{
    const style=document.createElement('style');
    style.textContent='.proxima-device-view .exact-timeline,.proxima-device-view .exact-tracks{touch-action:pan-y}.proxima-device-view #scheduleNew,.proxima-device-view .exact-actions,.proxima-device-view .exact-unlink,.proxima-device-view .exact-name-check{display:none!important}.proxima-device-menu{position:fixed;z-index:3000;display:grid;gap:4px;padding:6px;border-radius:10px;background:var(--panel,#1f252b);box-shadow:0 10px 30px #0008}.proxima-device-menu button{padding:10px 14px;text-align:left}';
    if(canControl)style.textContent=style.textContent.replace(/\.proxima-device-view #scheduleNew[^}]+}/,'');
    document.head.append(style);
  });
  root.__proximaDeviceButtons=()=>{
    for(const container of [document.querySelector('.topbar'),document.querySelector('.schedule-head-actions')]){
      if(!container)continue;
      const button=document.createElement('button');button.type='button';button.className='proxima-device-name';button.textContent=document.documentElement.dataset.device||'';new MutationObserver(()=>{if(document.documentElement.dataset.device&&!button.textContent.startsWith('Remote'))button.textContent=document.documentElement.dataset.device;}).observe(document.documentElement,{attributes:true,attributeFilter:['data-device']});
      button.addEventListener('click',async()=>{
        document.querySelector('.proxima-device-menu')?.remove();
        const devices=await ask('devices').catch(()=>[]);const menu=document.createElement('div');menu.className='proxima-device-menu';
        const box=button.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(box.left,innerWidth-200))+'px';menu.style.top=(box.bottom+4)+'px';
        for(const device of devices){const item=document.createElement('button');item.type='button';item.textContent=device.name;item.setAttribute('aria-pressed',String(device.id===ownerId));item.addEventListener('click',()=>{menu.remove();parent.postMessage({type:'papers:proxima-device:open',ownerId:device.id},location.origin);});menu.append(item);}
        document.body.append(menu);setTimeout(()=>addEventListener('pointerdown',function away(event){if(!menu.contains(event.target)){menu.remove();removeEventListener('pointerdown',away,true);}},true));
      });
      container.append(button);
    }
  };
})(globalThis);
