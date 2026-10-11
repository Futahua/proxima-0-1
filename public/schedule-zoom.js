/* Presentation-only calendar zoom. Events and calendar state retain their existing owners. */
window.createScheduleZoom = function(body) {
  let layer = null, animations = [], hidden = [], generation = 0, lastMinute = new Date().getHours()*60;
  const key = el => el.dataset.eventId + ':' + (el.dataset.occurrenceKey || el.dataset.start);
  const dateParts = () => [...body.querySelectorAll('.schedule-day-column,.schedule-month-cell,.schedule-day-head,.schedule-cell-head')];
  const dateKey = el => (el.matches('.schedule-day-head,.schedule-cell-head')?'label:':'day:') + (el.dataset.day || el.parentElement.dataset.day);
  const dateRect = el => {
    const r=el.getBoundingClientRect(), b=body.getBoundingClientRect();
    if(!el.matches('.schedule-day-column'))return r;
    const top=Math.max(r.top,b.top+54), bottom=Math.min(r.bottom,b.bottom);
    return {left:r.left,top,width:r.width,height:Math.max(1,bottom-top),right:r.right,bottom};
  };
  const stop = () => { animations.forEach(a=>a.cancel()); animations=[]; hidden.forEach(el=>el.style.removeProperty('opacity')); hidden=[]; layer?.remove(); layer=null; };
  const capture = () => {
    const cards = new Map();
    body.querySelectorAll('.schedule-event').forEach(el=>cards.set(key(el),{rect:el.getBoundingClientRect(),node:el.cloneNode(true)}));
    layer?.querySelectorAll('[data-zoom-key]').forEach(el=>cards.set(el.dataset.zoomKey,{rect:el.getBoundingClientRect(),node:el.cloneNode(true)}));
    return cards;
  };
  return function zoom(render, pointer, direction, motion = 'zoom') {
    const token = ++generation, before = capture(), box = body.getBoundingClientRect();
    const dates=new Map(dateParts().map(el=>[dateKey(el),{rect:dateRect(el),node:el.cloneNode(true)}]));
    layer?.querySelectorAll('[data-date-key]').forEach(el=>dates.set(el.dataset.dateKey,{rect:el.getBoundingClientRect(),node:el.cloneNode(true)}));
    const oldScroll = body.scrollTop;
    const hovered = pointer.target?.closest('[data-day]');
    const day = hovered?.dataset.day;
    const column = pointer.target?.closest('.schedule-day-column');
    const minute = column ? Math.max(0,Math.min(1439,pointer.y-column.getBoundingClientRect().top)) : null;
    if(minute!==null)lastMinute=minute;
    stop();body.dataset.zoomRendering='1';render(day);
    const nextColumn = day && [...body.querySelectorAll('.schedule-day-column')].find(el=>el.dataset.day===day);
    if(nextColumn) {
      const r=nextColumn.getBoundingClientRect();body.scrollTop += r.top + lastMinute - pointer.y;
    } else if (body.querySelector('.schedule-timed-content')) body.scrollTop=oldScroll;
    const anchor = day && [...body.querySelectorAll('.schedule-day-column,.schedule-month-cell')].find(el=>el.dataset.day===day);
    if(anchor) { const r=anchor.getBoundingClientRect();body.scrollLeft += (r.left+r.right)/2-pointer.x; }
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){delete body.dataset.zoomRendering;return;}
    const current=body.getBoundingClientRect();
    layer=document.createElement('div');layer.className='schedule-zoom-overlay';Object.assign(layer.style,{left:current.left+'px',top:current.top+'px',width:current.width+'px',height:current.height+'px'});document.body.append(layer);
    const timing={duration:420,easing:'cubic-bezier(.2,.75,.2,1)',fill:'both'};
    // Keep event transport within the content area beneath the sticky date strip.
    const header=body.querySelector('.schedule-timed-header,.schedule-weekday');
    const cardLayer=document.createElement('div');
    const cardTop=header?Math.max(0,header.getBoundingClientRect().bottom-current.top):0;
    Object.assign(cardLayer.style,{position:'absolute',inset:'0',zIndex:'2',pointerEvents:'none',clipPath:'inset('+cardTop+'px 0 0 0)'});
    layer.append(cardLayer);

    {
      // Each date owns a plane and a label: the same date morphs between column and cell.
      for(const el of dateParts()) {
        const id=dateKey(el), old=dates.get(id), r=dateRect(el);
        const ghost=old?.node || el.cloneNode(true);
        ghost.querySelectorAll('.schedule-event,.schedule-now-line,.schedule-slot,.schedule-cell-add,.schedule-more').forEach(n=>n.remove());
        ghost.dataset.dateKey=id;
        ghost.className=el.className;
        Object.assign(ghost.style,{position:'absolute',minHeight:'0',margin:'0',boxSizing:'border-box',overflow:'hidden',left:r.left-current.left+'px',top:r.top-current.top+'px',width:r.width+'px',height:r.height+'px',opacity:'1',zIndex:id.startsWith('label:')?'3':'0'});
        layer.append(ghost);el.style.opacity='0';hidden.push(el);
        const from=old?.rect;
        animations.push(ghost.animate([
          {left:(from?.left ?? (motion==='slide'?r.left+direction*box.width:pointer.x))-current.left+'px',top:(from?.top ?? (motion==='slide'?r.top:pointer.y))-current.top+'px',width:(from?.width ?? (motion==='slide'?r.width:0))+'px',height:(from?.height ?? (motion==='slide'?r.height:0))+'px',opacity:from||motion==='slide'?1:0},
          {left:r.left-current.left+'px',top:r.top-current.top+'px',width:r.width+'px',height:r.height+'px',opacity:1}
        ],timing));
      }
      const nextDates=new Set(dateParts().map(dateKey));
      for(const [id,old] of dates) {
        if(nextDates.has(id))continue;
        const ghost=old.node;ghost.querySelectorAll('.schedule-event,.schedule-now-line,.schedule-slot,.schedule-cell-add').forEach(n=>n.remove());ghost.dataset.dateKey=id;
        Object.assign(ghost.style,{position:'absolute',minHeight:'0',overflow:'hidden',left:old.rect.left-current.left+'px',top:old.rect.top-current.top+'px',width:old.rect.width+'px',height:old.rect.height+'px'});layer.append(ghost);
        animations.push(ghost.animate(motion==='slide'?[{transform:'translateX(0)',opacity:1},{transform:'translateX('+(-direction*box.width)+'px)',opacity:1}]:[{opacity:1},{opacity:0}],timing));
      }
    }
    for(const el of body.querySelectorAll('.schedule-event')){
      const id=key(el), previous=before.get(id), r=el.getBoundingClientRect();
      if(r.bottom<current.top||r.top>current.bottom)continue;
      const ghost=previous?.node || el.cloneNode(true);ghost.className=el.className;ghost.dataset.zoomKey=id;ghost.removeAttribute('id');ghost.classList.add('schedule-zoom-event');ghost.draggable=false;
      Object.assign(ghost.style,{position:'absolute',margin:'0',minHeight:'0',right:'auto',bottom:'auto',opacity:'1',left:r.left-current.left+'px',top:r.top-current.top+'px',width:r.width+'px',height:r.height+'px'});cardLayer.append(ghost);
      el.style.opacity='0';hidden.push(el);
      const old=previous?.rect;
      animations.push(ghost.animate([{left:(old?old.left:motion==='slide'?r.left+direction*box.width:pointer.x)-current.left+'px',top:(old?old.top:motion==='slide'?r.top:pointer.y)-current.top+'px',width:(old?old.width:motion==='slide'?r.width:r.width*.8)+'px',height:(old?old.height:motion==='slide'?r.height:r.height*.8)+'px',opacity:old||motion==='slide'?1:0},{left:r.left-current.left+'px',top:r.top-current.top+'px',width:r.width+'px',height:r.height+'px',opacity:1}],timing));
    }
    const nextKeys=new Set([...body.querySelectorAll('.schedule-event')].map(key));
    for(const [id, old] of before){
      if(nextKeys.has(id)||old.rect.bottom<current.top||old.rect.top>current.bottom)continue;
      const ghost=old.node;ghost.dataset.zoomKey=id;ghost.classList.add('schedule-zoom-event');
      Object.assign(ghost.style,{position:'absolute',margin:'0',minHeight:'0',opacity:'1',transform:'none',right:'auto',left:old.rect.left-current.left+'px',top:old.rect.top-current.top+'px',width:old.rect.width+'px',height:old.rect.height+'px'});cardLayer.append(ghost);
      animations.push(ghost.animate([{opacity:1,transform:'none'},{opacity:motion==='slide'?1:0,transform:motion==='slide'?'translateX('+(-direction*box.width)+'px)':'scale(.8)'}],timing));
    }
    requestAnimationFrame(()=>{if(generation===token)delete body.dataset.zoomRendering;});
    Promise.all(animations.map(a=>a.finished.catch(()=>{}))).then(()=>{if(generation===token)stop();});
  };
};
