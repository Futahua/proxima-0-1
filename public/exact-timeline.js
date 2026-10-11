/* Exact elapsed-time geometry. Zooming never rounds or edits stored timestamps. */
(function(root){
 const geometry={position:(t,start,scale)=>(t-start)*scale,time:(x,start,scale)=>start+x/scale,
  zoom(start,scale,factor,x){const next=Math.max(1e-10,Math.min(1,scale*factor));return {start:start+x/scale-x/next,scale:next};}};
 const instances=new WeakMap();
 function mount(element,store){
  if(instances.has(element))return instances.get(element);
  let start=Date.now()-3600000,scale=1/60000,initialized=false,editing=null;
  const ruler=document.createElement('div');ruler.className='exact-ruler';const tracks=document.createElement('div');tracks.className='exact-tracks';element.replaceChildren(ruler,tracks);
  const dialog=document.createElement('dialog');dialog.className='exact-interval-dialog';
  dialog.innerHTML='<form><h2>Time interval</h2><label>Name<input name="name" required maxlength="200"></label><label>Start<input name="start" required placeholder="2026-10-11T12:00:00+07:00"></label><label>End<input name="end" required placeholder="2026-10-11T13:00:00+07:00"></label><small>Exact timestamps with a timezone, including milliseconds if needed.</small><p role="alert"></p><div class="exact-dialog-actions"><button type="button" data-delete>Delete</button><button type="button" data-cancel>Cancel</button><button type="submit">Save</button></div></form>';
  document.body.append(dialog);const form=dialog.querySelector('form'),error=dialog.querySelector('[role=alert]');
  const steps=[1,10,100,1000,5000,15000,60000,300000,900000,3600000,10800000,21600000,43200000,86400000,604800000,2592000000,31536000000];
  const label=t=>new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Ho_Chi_Minh',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:scale>=.02?'2-digit':undefined,fractionalSecondDigits:scale>=1?3:undefined,hour12:false});
  function items(){return store.timelineIntervals().filter(x=>Number.isFinite(Date.parse(x.start))&&Date.parse(x.end)>Date.parse(x.start));}
  function render(){
   const width=element.clientWidth;if(!width)return;
   ruler.replaceChildren();tracks.replaceChildren();
   const visibleEnd=start+width/scale;
   const step=steps.find(x=>x*scale>=100)||steps.at(-1)*Math.ceil(100/(steps.at(-1)*scale));
   for(let t=Math.ceil(start/step)*step;t<=visibleEnd;t+=step){const mark=document.createElement('span');mark.className='exact-tick';mark.style.left=geometry.position(t,start,scale)+'px';mark.textContent=label(t);ruler.append(mark);const line=document.createElement('span');line.className='exact-gridline';line.style.left=mark.style.left;tracks.append(line);}
   const lanes=[];
   for(const item of items().sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))){const a=Date.parse(item.start),b=Date.parse(item.end);let lane=lanes.findIndex(end=>end<=a);if(lane<0)lane=lanes.length;lanes[lane]=b;if(b<start||a>visibleEnd)continue;
    const bar=document.createElement('button');bar.type='button';bar.className='exact-interval';bar.dataset.intervalId=item.id;
    bar.style.left=geometry.position(a,start,scale)+'px';bar.style.width=((b-a)*scale)+'px';bar.style.top=(20+lane*60)+'px';
    bar.textContent=item.name;bar.title=item.name+'\n'+item.start+' → '+item.end+'\n'+(b-a)+' ms';bar.addEventListener('click',e=>{e.stopPropagation();open(item);});tracks.append(bar);
   }
   const now=document.createElement('div');now.className='exact-now';now.style.left=geometry.position(Date.now(),start,scale)+'px';tracks.append(now);
   tracks.style.minHeight=Math.max(160,lanes.length*60+40)+'px';
   element.dataset.viewportStart=String(start);element.dataset.pixelsPerMillisecond=String(scale);
  }
  function refresh(){const data=items();if(!initialized&&element.clientWidth){initialized=true;if(data.length){const a=Math.min(...data.map(x=>Date.parse(x.start))),b=Math.max(...data.map(x=>Date.parse(x.end)));scale=Math.max(1e-10,Math.min(1,(element.clientWidth-80)/(b-a)));start=a-40/scale;}else{scale=element.clientWidth/86400000;start=Date.now()-43200000;}}render();}
  function open(item,t){editing=item;form.elements.name.value=item?.name||'';form.elements.start.value=item?.start||new Date(Math.round(t)).toISOString();form.elements.end.value=item?.end||new Date(Math.round(t+3600000)).toISOString();error.textContent='';dialog.querySelector('[data-delete]').hidden=!item;dialog.showModal();form.elements.name.focus();}
  async function save(type,payload){const result=await store.command({type,payload,...(editing?{ifRev:editing.rev}:{})});if(!result.ok){error.textContent=result.code||'Could not save the interval.';return;}dialog.close();refresh();}
  form.addEventListener('submit',async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(form));const valid=v=>/(Z|[+-]\d\d:\d\d)$/i.test(v)&&Number.isFinite(Date.parse(v));if(!valid(values.start)||!valid(values.end)||Date.parse(values.end)<=Date.parse(values.start)){error.textContent='Use valid timestamps with a timezone, with End after Start.';return;}await save(editing?'timeline-interval.patch':'timeline-interval.create',editing?{intervalId:editing.id,patch:values}:values);});
  dialog.querySelector('[data-cancel]').addEventListener('click',()=>dialog.close());dialog.querySelector('[data-delete]').addEventListener('click',()=>save('timeline-interval.delete',{intervalId:editing.id}));
  element.addEventListener('dblclick',e=>{if(e.target.closest('.exact-interval'))return;open(null,geometry.time(e.clientX-element.getBoundingClientRect().left,start,scale));});
  element.addEventListener('wheel',e=>{e.preventDefault();const delta=(e.deltaX||e.deltaY)*(e.deltaMode===1?16:e.deltaMode===2?element.clientWidth:1);if(e.ctrlKey){const next=geometry.zoom(start,scale,Math.exp(-delta*.002),e.clientX-element.getBoundingClientRect().left);start=next.start;scale=next.scale;}else start+=delta/scale;render();},{passive:false});
  element.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target===element){e.preventDefault();open(null,geometry.time(element.clientWidth/2,start,scale));}if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();start+=(e.key==='ArrowLeft'?-100:100)/scale;render();}});
  new ResizeObserver(refresh).observe(element);
  const timer=setInterval(()=>{if(element.getClientRects().length){const now=tracks.querySelector('.exact-now');if(now)now.style.left=geometry.position(Date.now(),start,scale)+'px';}},1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  const api={refresh};instances.set(element,api);refresh();return api;
 }
 root.ExactTimeline={geometry,mount};
})(globalThis);
