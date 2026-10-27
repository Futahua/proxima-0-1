/* The phone's own Proxima: this page opened in the phone app without ?papers-device. Its facts live
 * in this WebView's IndexedDB (persistence.js), owned by the phone like the phone's own As you Go.
 * Loaded before persistence.js; it does nothing elsewhere. It supplies what device-view.js supplies
 * for another device's Proxima: the device switcher, touch pan / pinch on the timeline, and the
 * "drawn, show me" signal the phone waits for before revealing the page. */
(function(root){
  const params=new URL(location.href).searchParams;
  if(!params.has('papers-phone')||params.get('papers-device'))return;
  const pending=new Map();
  addEventListener('message',event=>{const value=event.data;if(event.source!==parent||value?.type!=='papers:proxima-device:result')return;const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);value.ok?task.resolve(value.result):task.reject(Error(value.error||'The phone did not answer.'));});
  const ask=(operation)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();pending.set(requestId,{resolve,reject});parent.postMessage({type:'papers:proxima-device:request',requestId,operation,ownerId:'local'},location.origin);setTimeout(()=>{if(pending.delete(requestId))reject(Error('The phone did not answer.'));},20000);});
  document.documentElement.classList.add('proxima-phone-local');

  // Shown only once Proxima has drawn its own data (no default-layout frame).
  document.documentElement.style.visibility='hidden';
  const reveal=()=>{if(document.documentElement.style.visibility!=='hidden')return;document.documentElement.style.visibility='';parent.postMessage({type:'proxima:device-view-ready',ownerId:'local'},location.origin);};
  addEventListener('DOMContentLoaded',()=>{const ready=root.ProximaPersistence?.ready;Promise.resolve(ready).then(()=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(reveal)),50),reveal);});
  setTimeout(reveal,15000);

  // The device switcher: this phone first, then the computers.
  root.__proximaPhoneLocal={buttons(){
    for(const container of [document.querySelector('.topbar'),document.querySelector('.schedule-head-actions')]){
      if(!container)continue;
      const button=document.createElement('button');button.type='button';button.className='proxima-device-name';button.textContent='This phone';
      void ask('devices').then(devices=>{const self=devices.find(device=>device.id==='local');if(self?.name)button.textContent=self.name;}).catch(()=>{});
      button.addEventListener('click',async()=>{
        document.querySelector('.proxima-device-menu')?.remove();
        const devices=await ask('devices').catch(()=>[]);const menu=document.createElement('div');menu.className='proxima-device-menu';
        const box=button.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(box.left,innerWidth-200))+'px';menu.style.top=(box.bottom+4)+'px';
        for(const device of devices){const item=document.createElement('button');item.type='button';item.textContent=device.name;item.setAttribute('aria-pressed',String(device.id==='local'));item.addEventListener('click',()=>{menu.remove();if(device.id!=='local')parent.postMessage({type:'papers:proxima-device:open',ownerId:device.id},location.origin);});menu.append(item);}
        document.body.append(menu);setTimeout(()=>addEventListener('pointerdown',function away(event){if(!menu.contains(event.target)){menu.remove();removeEventListener('pointerdown',away,true);}},true));
      });
      container.append(button);
    }
  }};
  addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent='.proxima-phone-local .exact-timeline,.proxima-phone-local .exact-tracks{touch-action:pan-y}.proxima-device-menu{position:fixed;z-index:3000;display:grid;gap:4px;padding:6px;border-radius:10px;background:var(--panel,#1f252b);box-shadow:0 10px 30px #0008}.proxima-device-menu button{padding:10px 14px;text-align:left}';document.head.append(style);});

  // Touch on the timeline, as for another device's Proxima: one finger pans sideways, two fingers
  // pinch-zoom about their centre (the timeline's own proxima:timeline-touch moves).
  let pinch=null,pan=null;
  addEventListener('pointerdown',event=>{if(event.pointerType==='touch'&&event.target.closest?.('.exact-tracks'))event.stopImmediatePropagation();},{capture:true});
  const timelineAt=target=>{const timeline=target.closest?.('.exact-timeline');return timeline?{target:timeline,left:timeline.getBoundingClientRect().left}:null;};
  const move=(timeline,detail)=>timeline.target.dispatchEvent(new CustomEvent('proxima:timeline-touch',{detail}));
  addEventListener('touchstart',event=>{
    if(event.touches.length===2){const [a,b]=event.touches,timeline=timelineAt(event.target);pinch=timeline?{distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),timeline}:null;pan=null;return;}
    const t=event.touches[0];pan=event.target.closest?.('.exact-tracks')?{x:t.clientX,y:t.clientY,horizontal:null,timeline:timelineAt(event.target)}:null;
  },{passive:true,capture:true});
  addEventListener('touchmove',event=>{
    if(root.__phoneMouse?.active())return;
    if(pan&&event.touches.length===1){
      const t=event.touches[0],dx=t.clientX-pan.x,dy=t.clientY-pan.y;
      if(pan.horizontal===null&&Math.hypot(dx,dy)>8)pan.horizontal=Math.abs(dx)>Math.abs(dy);
      if(pan.horizontal&&pan.timeline){event.preventDefault();move(pan.timeline,{deltaX:-dx});pan.x=t.clientX;pan.y=t.clientY;}
      return;
    }
    if(!pinch||event.touches.length!==2)return;
    const [a,b]=event.touches,distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),x=(a.clientX+b.clientX)/2;
    event.preventDefault();
    if(distance>0&&pinch.distance>0)move(pinch.timeline,{factor:distance/pinch.distance,x:x-pinch.timeline.left});
    pinch.distance=distance;
  },{passive:false,capture:true});
  addEventListener('touchend',event=>{if(event.touches.length<2)pinch=null;if(!event.touches.length)pan=null;},{passive:true,capture:true});
  addEventListener('touchcancel',()=>{pinch=null;pan=null;},{passive:true,capture:true});
})(globalThis);
