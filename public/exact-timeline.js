/* Exact elapsed-time geometry. Zooming never rounds or edits stored timestamps. */
(function(root){
 const geometry={position:(t,start,scale)=>(t-start)*scale,time:(x,start,scale)=>start+x/scale,
  zoom(start,scale,factor,x){const next=Math.max(1e-10,Math.min(1,scale*factor));return {start:start+x/scale-x/next,scale:next};}};
 /* Which edge a Shift extension moves for a pointer time. spans: [{start,end}] in ms, a live end already resolved to now.
    Outside the selection's union the outward edge is taken, as before. Inside it the nearer union edge is taken (ties go to
    start), and only while every selected span keeps positive length; extend-selection writes ONE time to that edge of every
    member, so a start past any member's end (or an end before any member's start) would invert it and the store refuses it. */
 function extensionEdge(time,spans){if(!spans.length||!Number.isFinite(time))return null;const earliest=Math.min(...spans.map(x=>x.start)),latest=Math.max(...spans.map(x=>x.end));if(time<earliest)return 'start';if(time>latest)return 'end';
  if(time-earliest<=latest-time)return time<Math.min(...spans.map(x=>x.end))?'start':null;return time>Math.max(...spans.map(x=>x.start))?'end':null;}
 // Screen-space silhouettes only. Exact timestamps still own hits, drag and storage.
 function taskFillShape(spans,width){
  if(width<=0)return {path:'',stretches:[],lobes:[]};
  const lobes=[];
  for(const {x0,x1} of spans){
   if(x1<=0||x0>=width||x1<=x0)continue;
   const spread=Math.max(0,(11-(x1-x0))/2);
   const left=Math.max(-24,x0-spread),right=Math.min(width+24,x1+spread);
   const previous=lobes[lobes.length-1];
   if(previous&&left<=previous.right+3)previous.right=Math.max(previous.right,right);
   else lobes.push({left,right});
  }
  const paths=[],stretches=[];
  // Smoothstep gives each transition zero slope at both ends.
  const blend=(from,to,value)=>{
   const t=Math.max(0,Math.min(1,(value-from)/(to-from)));
   return t*t*(3-2*t);
  };
  const bottom=42,baseline=bottom-1.5;
  let underlineStart=0;
  const underlineTo=end=>{
   if(end>underlineStart)paths.push(['M',underlineStart,baseline,'H',end,'V',bottom,'H',underlineStart,'Z'].join(' '));
  };
  // Cut through the base of each fold. Draw the underline only between folds.
  const opening=(center,half,top,lean)=>{
   if(half<.05)return;
   paths.push([
    'M',center-half,bottom,
    'C',center-half*.82,baseline-8,center-half*.82+lean,top,center+lean,top,
    'C',center+half*.82+lean,top,center+half*.82,baseline-8,center+half,bottom,'Z'
   ].join(' '));
  };
  for(const {left,right} of lobes){
   const length=right-left,mid=(left+right)/2;
   const solid=blend(26,52,length);
   const fold=blend(12,21,length)*(1-solid);
   const top=0,rise=baseline-top;
   underlineTo(Math.max(0,left));
   underlineStart=Math.min(width,right);
   const shoulder=Math.min(length*(.38-.12*fold),12);
   const crestLeft=left+shoulder,crestRight=right-shoulder;
   const valley=top+rise*.94*fold;
   paths.push([
    'M',left,baseline,'C',left+shoulder*.65,baseline,crestLeft-shoulder*.35,top,crestLeft,top,
    'C',crestLeft+(mid-crestLeft)*.68,top,mid-(mid-crestLeft)*.42,valley,mid,valley,
    'C',mid+(crestRight-mid)*.42,valley,crestRight-(crestRight-mid)*.68,top,crestRight,top,
    'C',crestRight+shoulder*.35,top,right-shoulder*.65,baseline,right,baseline,
    'V',bottom,'H',left,'Z'
   ].join(' '));
   const separate=blend(12,22,length);
   const leftOpening=mid+(crestLeft-mid)*separate;
   const creaseTop=top+4.2+4.4*solid;
   opening(leftOpening,1.45+1.25*fold,creaseTop,.6);
   opening(crestRight,Math.min(1.35+1.05*fold,(crestRight-leftOpening)*.25)*separate,creaseTop,-.6);
   if(solid>.5&&valley<20){
    const x0=Math.max(0,crestLeft+3),x1=Math.min(width,crestRight-3);
    if(x1>x0)stretches.push({x0,x1});
   }
  }
  if(lobes.length)underlineTo(width);
  return {path:paths.join(' '),stretches,lobes};
 }
 const taskLineFade=[[0,0],[.38,1],[.60,1],[1,0]];
 let timelineGradientId=0;
 function taskLineStops(width,left,viewWidth,lobes){
  const halo=Math.min(110,viewWidth*.22);
  const points=[0,width,...taskLineFade.map(([fraction])=>left+viewWidth*fraction),left+viewWidth*.06,left+viewWidth*.94];
  for(const lobe of lobes){
   for(const fraction of [0,.33,.66,1])points.push(lobe.left-halo*fraction,lobe.right+halo*fraction);
  }
  let index=0;
  return [...new Set(points.filter(x=>x>=0&&x<=width))].sort((a,b)=>a-b).map(x=>{
   const t=Math.max(0,Math.min(1,(x-left)/viewWidth));
   const fade=Math.min(1,t/taskLineFade[1][0],(1-t)/(1-taskLineFade[2][0]));
   while(index<lobes.length&&lobes[index].right<x)index++;
   const previous=lobes[index-1],next=lobes[index];
   const distance=Math.min(previous?x-previous.right:Infinity,next?Math.max(0,next.left-x):Infinity);
   const glow=Math.max(0,1-distance/halo);
   const edge=Math.min(1,t/.06,(1-t)/.06);
   return [x/width,fade+(1-fade)*edge*glow*glow*(3-2*glow)];
  });
 }
 const instances=new WeakMap();
 function firstFreeRow(rows,entries,time,queuedRows=new Set()){
  return rows.find(row=>!row.groupChildren&&!row.groupDepth&&!row.queuePlaceholder&&!queuedRows.has(row.rowId||row.id)&&entries.filter(item=>(item.rowId||item.id)===(row.rowId||row.id)).every(item=>!item.followNow&&Date.parse(item.end)<=time))||null;
 }
 // Presentation only: a row is occupied while any session intersects the exposed
 // time window. Keep live rows and their expanded ancestors, without changing
 // durable order, membership, endpoints, selection or history.
 function occupiedLanes(rows,entries,from,to,keep=new Set(),now=Infinity){
  const occupied=new Set(keep);
  for(const item of entries){const id=item.viewRowId||item.rowId||item.id;
   const begin=Date.parse(item.start);
   const end=item.followNow?Math.max(begin+1,now):Date.parse(item.end);
   const pinnedLive=!item.groupDepth&&(item.followNow||item.groupLive);
   if(pinnedLive||item.queueId||begin<to&&end>from)occupied.add(id);
  }
  for(let i=entries.length-1;i>=0;i--){const item=entries[i];if(!occupied.has(item.viewRowId||item.rowId||item.id))continue;const depth=item.groupDepth||0;let above=depth;for(let j=i-1;j>=0&&above>0;j--){const parent=entries[j];if((parent.groupDepth||0)<above){occupied.add(parent.viewRowId||parent.rowId||parent.id);above=parent.groupDepth||0;}}}
  return rows.filter(row=>row.queuePlaceholder||occupied.has(row.viewRowId||row.rowId||row.id));
 }
 function queueSelectionAction(members,rows){
  const grouped=members.filter(item=>item.queueId||rows.find(row=>row.id===item.rowId)?.queueReturn);
  const groups=new Set(grouped.map(item=>item.queueId||item.rowId));
  if(grouped.length===members.length&&groups.size===1)return 'restore';
  if(members.some(item=>item.queueId))return 'enqueue';
  return 'collapse';
 }
 // Preview store: store.js loaded again, like the page loads its own scripts, inside a hidden blank frame of this
 // origin, over a private in-memory copy of the current data. That frame gets its own ProximaPersistence, an empty
 // navigator (so no shared write lock) and a memory localStorage, so commands there save, sync and lock nothing.
 // No fetch or code-from-text is needed, so it works under any script policy the page has.
 let previewFrame=null;
 function dropPreviewStore(){previewFrame?.remove();previewFrame=null;}
 async function previewStore(real){
  dropPreviewStore();
  const frame=document.createElement('iframe');frame.hidden=true;frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;document.body.append(frame);previewFrame=frame;
  const win=frame.contentWindow;let doc=real.snapshot();const memory=new Map();
  win.ProximaPersistence={initialRaw:JSON.stringify(doc),ready:Promise.resolve(),read:async()=>structuredClone(doc),write:async state=>{doc=structuredClone(state);return {ok:true};}};
  Object.defineProperty(win,'navigator',{value:{},configurable:true});
  Object.defineProperty(win,'localStorage',{value:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)},configurable:true});
  const version=new URL(document.currentScript?.src||location.href).searchParams.get('v')||'preview';
  for(const name of ['remote-domain','store','store-preview-export'])await new Promise((resolve,reject)=>{const script=win.document.createElement('script');script.src=new URL(name+'.js?v='+version,document.baseURI).href;script.onload=resolve;script.onerror=()=>reject(Error(name+'.js'));win.document.head.append(script);});
  if(previewFrame!==frame||!win.__proximaPreviewStore)throw Error('Preview store unavailable.');
  return win.__proximaPreviewStore;
 }
 function mount(element,store,options={}){
  const realStore=store;let previewing=false;
  // Row pitch follows the zoom (creator, 2026-11-09): 60 px when a day is 18 px or wider, squeezing to 14 px as
  // you zoom out. Below 40 px the timeline is a far overview: no labels or row actions, no editing; a click on a
  // blob zooms to it. Activities keep their own lines and order.
  let ROW=60,far=false;
  // Each retained Papers page owns its viewport; a hidden sibling must not overwrite it.
  const surfaceKey=new URL(location.href).searchParams.get('papers-surface-key');
  const baseLayoutKey=options.layoutKey||(element.id==='exactTimeline'?'proxima.timeline.layout.v1':null);
  options={...options,...(baseLayoutKey?{layoutKey:surfaceKey?baseLayoutKey+':page:'+surfaceKey:baseLayoutKey}:{})};
  element.classList.toggle('exact-phone',new URL(location.href).searchParams.has('papers-phone'));
  const clockNow=()=>options.now?.()??Date.now();
  if(instances.has(element)){const api=instances.get(element);api.configure?.(options);return api;}
  let start=clockNow()-3600000,scale=1/60000,initialized=false,editing=null;
  let savedLayout=null,layoutSaveTimer=0,lastSavedLayout=null;
  try{savedLayout=options.layoutKey?JSON.parse(localStorage.getItem(options.layoutKey)||localStorage.getItem(baseLayoutKey)||'null'):null;if(Number.isFinite(savedLayout?.start)&&Number.isFinite(savedLayout?.scale)&&savedLayout.scale>=1e-10&&savedLayout.scale<=1){start=savedLayout.start;scale=savedLayout.scale;initialized=true;}}catch{}
  function saveLayout(){layoutSaveTimer=0;if(!options.layoutKey||!initialized)return;try{const value=JSON.stringify({start:goal?.start??start,scale:goal?.scale??scale,scheduleDay,scrollTop:tracks.scrollTop,scheduleScrollTop:scheduleBand.scrollTop});if(value===lastSavedLayout)return;localStorage.setItem(options.layoutKey,value);lastSavedLayout=value;}catch{}}
  function scheduleLayoutSave(){if(!options.layoutKey||layoutSaveTimer)return;layoutSaveTimer=setTimeout(saveLayout,150);}
  window.addEventListener('pagehide',saveLayout);
  let animation=0,goal=null,resizing=null,suppressClick=false,layout=[],laneCount=0;
  const queueZones=new Map();let placingQueue=false,queuePlacement=null,queueDrag=null,queueBoundaryPreview=null,queueDeletePrompt=null;const expiringQueues=new Set();const bars=new Map(),ticks=new Map(),lines=new Map(),dates=new Map(),months=new Map(),deadlines=new Map(),outsideNames=new Map();
  // host is the blob's bar, or its edge label when the bar is off-screen (onlyWithFolder: the label
  // carries the button only for a blob that has a folder).
  function renderTemplateControl(bar,item,{onlyWithFolder=false}={}){
   if(item.groupChildren){
    let button=bar.querySelector('.exact-blob-content');if(!button){button=document.createElement('button');button.type='button';button.className='exact-blob-content has-picture exact-group-count';for(const type of ['pointerdown','contextmenu','dblclick','keydown'])button.addEventListener(type,event=>event.stopPropagation());button.addEventListener('click',event=>{event.stopPropagation();const value=bar.interval,opening=!expandedGroups.has(value.id);const visited=new Set();const walk=key=>{if(visited.has(key))return;visited.add(key);const group=allItems().find(x=>x.id===key);if(!group?.groupChildren)return;if(opening)expandedGroups.add(key);else expandedGroups.delete(key);for(const child of group.groupChildren)walk(child);};toggleGroup(value.id,opening,()=>walk(value.id));});bar.append(button);}button.textContent=String(item.groupLeaves.length);button.title=(expandedGroups.has(item.id)?'Collapse':'Expand')+' all children';button.setAttribute('aria-label',button.title+' ('+item.groupLeaves.length+' blobs)');button.setAttribute('aria-expanded',String(expandedGroups.has(item.id)));return;
   }
   // A bar entirely off-screen leaves its button to its edge label (set when the label is drawn).
   if(settings.remoteReadOnly||!onlyWithFolder&&bar.dataset.offscreen==='1'||onlyWithFolder&&!window.ProximaBlobWorkspaces?.button(item)?.propagated){bar.querySelector('.exact-blob-content')?.remove();return;}
   let button=bar.querySelector('.exact-blob-content');if(!button){button=document.createElement('button');button.type='button';button.className='exact-blob-content';button.textContent='▤';button.title='Open blob contents · Middle-click opens a Papers tab';button.setAttribute('aria-label','Open blob contents');for(const type of ['pointerdown','contextmenu','dblclick','keydown'])button.addEventListener(type,event=>event.stopPropagation());button.addEventListener('click',event=>{event.stopPropagation();dispatchEvent(new CustomEvent('proxima:blob-open',{detail:{id:bar.interval.id}}));});button.addEventListener('auxclick',event=>{if(event.button!==1)return;event.preventDefault();event.stopPropagation();dispatchEvent(new CustomEvent('proxima:blob-open',{detail:{id:bar.interval.id,newTab:true}}));});bar.append(button);}
   // A blob with a folder always shows its button, as the folder's picture when it has one.
   const state=window.ProximaBlobWorkspaces?.button(item)||{propagated:false,icon:null};button.classList.toggle('has-template',state.propagated);button.classList.toggle('has-picture',!!state.icon);
   const picture=state.icon?'url("'+state.icon.replace(/["\\\n\r]/g,'')+'")':'';if(button.style.backgroundImage!==picture)button.style.backgroundImage=picture;const glyph=state.icon?'':'▤';if(button.textContent!==glyph)button.textContent=glyph;
  }
  const ruler=document.createElement('div');ruler.className='exact-ruler';const dateStrip=document.createElement('div');dateStrip.className='exact-date-strip';const monthStrip=document.createElement('div');monthStrip.className='exact-month-strip';const currentYear=document.createElement('span');currentYear.className='exact-current-year';ruler.append(monthStrip,dateStrip);const tracks=document.createElement('div');tracks.className='exact-tracks';element.replaceChildren(ruler,tracks,currentYear);const rowExtent=document.createElement('div');rowExtent.className='exact-row-extent';tracks.append(rowExtent);
  const blobName=document.createElement('span');blobName.className='exact-hover-name';element.append(blobName);
  function paintGroupTitleGlow(label,item){
   label.classList.toggle("exact-group-title",!!item.groupChildren);
   if(!item.groupChildren)return;
   const colors=item.groupLeaves.map(member=>member.color||"#a1cc43");
   const key=colors.join(",");
   if(label.groupGlowKey===key)return;
   const channels=[0,0,0];let count=0;
   for(const color of colors){
    if(!/^#[\da-f]{6}$/i.test(color))continue;
    for(let i=0;i<3;i++)channels[i]+=parseInt(color.slice(1+i*2,3+i*2),16);
    count++;
   }
   const average=count?"rgb("+channels.map(value=>Math.round(value/count)).join(" ")+")":item.color||"#758995";
   label.style.setProperty("--group-title-glow",average);
   label.groupGlowKey=key;
  }
  function renderName(label,item){paintGroupTitleGlow(label,item);let text=label.querySelector('.exact-name-text'),check=label.querySelector('.exact-name-check');if(!text){label.replaceChildren();text=document.createElement('span');text.className='exact-name-text';check=document.createElement('input');check.type='checkbox';check.className='exact-name-check';check.setAttribute('aria-label','Mark blob name complete');for(const type of ['pointerdown','click','dblclick','contextmenu'])check.addEventListener(type,event=>event.stopPropagation());check.addEventListener('change',async()=>{const current=items().find(x=>x.id===label.interval.id);if(!current)return;const result=await store.command({type:'timeline-interval.patch',ifRev:current.rev,payload:{intervalId:current.id,patch:{checked:check.checked,...(check.checked&&current.followNow&&!current.queueId?{followNow:false,end:new Date(Math.max(Date.parse(current.start)+1,clockNow())).toISOString()}:{})}}});if(!result.ok)error.textContent=result.code;refresh();});label.append(text,check);}check.hidden=!!settings.remoteReadOnly;check.disabled=!!settings.remoteReadOnly;label.interval=item;label.title=item.sourceFollowing?(item.sourceLive?'Following live source ':'Saved source snapshot ')+item.sourceOwner:'';text.textContent=item.name;if(item.groupChildren&&!text.dataset.groupBound){text.dataset.groupBound='1';text.addEventListener('pointerdown',event=>{if(label.interval?.groupChildren)event.stopPropagation();});text.addEventListener('click',event=>{if(label.interval?.groupChildren){event.preventDefault();event.stopPropagation();enterWithMotion(label.interval.id);}});}check.hidden=check.hidden||!!item.groupChildren;check.checked=!!item.checked;label.classList.toggle('is-checked',!!item.checked);}
  let middlePanClickUntil=0;
  element.addEventListener('pointerdown',event=>{if(event.button!==1||event.target.closest('input,textarea,.exact-color-picker,.exact-edge-calendar'))return;event.preventDefault();const originX=event.clientX,originY=event.clientY,initialStart=start,initialScale=scale,initialScroll=tracks.scrollTop;let moved=false;const move=e=>{const dx=e.clientX-originX,dy=e.clientY-originY;if(!moved&&Math.hypot(dx,dy)<5)return;moved=true;middlePanClickUntil=performance.now()+400;cancelAnimationFrame(animation);goal=null;start=initialStart-dx/initialScale;scale=initialScale;tracks.scrollTop=initialScroll-dy;element.classList.add('is-middle-panning');render();};const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);element.classList.remove('is-middle-panning');if(moved)middlePanClickUntil=performance.now()+400;};window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);},true);
  element.addEventListener('auxclick',event=>{if(event.button===1&&performance.now()<middlePanClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  // Group gestures include the name and child-count button, whose own handlers
  // otherwise stop bubbling. A middle drag remains timeline panning.
  const groupGestureOwner=target=>{const owner=target.closest?.('.exact-selectable,.exact-outside-name');return owner?.interval?.groupChildren?owner:null;};
  element.addEventListener('auxclick',event=>{if(event.button!==1||event.target.closest('input,textarea'))return;const owner=groupGestureOwner(event.target);if(!owner)return;event.preventDefault();event.stopImmediatePropagation();if(!settings.readOnly)open(owner.interval);},true);
  element.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea'))return;const owner=groupGestureOwner(event.target);if(!owner)return;event.preventDefault();event.stopImmediatePropagation();if(performance.now()<suppressContextUntil||!marquee.hidden||lastMarqueePointer&&marqueeController.isActive(lastMarqueePointer.pointerId))return;bars.get(owner.interval.id)?.querySelector('.exact-group-count')?.click();},true);
  element.addEventListener('pointerdown',event=>{if(event.button===1&&event.target.closest('.exact-selectable,.exact-outside-name')&&!event.target.closest('.exact-resize-edge,.exact-queue-boundary,input,button'))event.preventDefault();});
  element.addEventListener('auxclick',event=>{if(event.button===1&&performance.now()<middlePanClickUntil){event.preventDefault();event.stopImmediatePropagation();return;}if(event.button!==1||settings.readOnly||event.target.closest('.exact-resize-edge,.exact-queue-boundary,input,button'))return;const owner=event.target.closest('.exact-selectable,.exact-outside-name');if(!owner?.interval)return;event.preventDefault();event.stopPropagation();open(owner.interval);});
  function creationColor(){try{const color=localStorage.getItem('proxima.timeline.creation-color');if(/^#[0-9a-f]{6}$/i.test(color))return color;}catch{}return '#a1cc43';}
  const dayMarkers=new Map();
  const boundaryFusion=document.createElement('div');boundaryFusion.className='exact-boundary-fusion';boundaryFusion.hidden=true;element.append(boundaryFusion);
  const cursorStrip=document.createElement('div');cursorStrip.className='exact-cursor-strip';cursorStrip.hidden=true;const cursorTime=document.createElement('span'),nowTime=document.createElement('span');cursorTime.className='exact-cursor-time';nowTime.className='exact-current-time';element.append(cursorStrip,cursorTime,nowTime);cursorTime.hidden=true;let cursorX=null,visualCursorX=null,cursorMotionFrame=0,cursorMotionTime=0;
  const rulerTime=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit'});
  const rulerDate=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',day:'numeric',month:'short'});
  function rulerStamp(time){return (86400000*scale<120?rulerDate.format(time).toLowerCase():rulerTime.format(time));}
  function positionTimeLabels(){const hour=((clockNow()+7*3600000)%86400000)/3600000,stops=[[0,[133,131,209]],[6,[192,91,84]],[12,[255,239,55]],[18,[133,131,209]],[24,[133,131,209]]];let index=0;while(index<stops.length-2&&hour>stops[index+1][0])index++;const fraction=(hour-stops[index][0])/(stops[index+1][0]-stops[index][0]),activeColor='rgb('+stops[index][1].map((value,n)=>Math.round(value+(stops[index+1][1][n]-value)*fraction)).join(',')+')';element.style.setProperty('--day-active-color',activeColor);const width=element.clientWidth,nowX=geometry.position(clockNow(),start,scale);nowTime.hidden=nowX<0||nowX>width;nowTime.textContent=rulerStamp(clockNow());const clamp=x=>Math.max(0,Math.min(Math.max(0,width-100),x-22));nowTime.style.left=clamp(nowX)+'px';if(cursorX!==null){cursorStrip.hidden=false;cursorTime.hidden=false;const visualX=visualCursorX??cursorX;let fusedX=visualX;const dayPixels=86400000*scale,midnight=Math.floor((start+7*3600000)/86400000)*86400000-7*3600000,firstBoundary=geometry.position(midnight,start,scale),nearest=firstBoundary+Math.round((visualX-firstBoundary)/dayPixels)*dayPixels,distance=Math.abs(visualX-nearest),reach=32;if(dayPixels>60&&nearest>=0&&nearest<=width&&distance<reach){const strength=1-distance/reach,pull=Math.pow(strength,3),direction=Math.sign(visualX-nearest);fusedX=nearest+(visualX-nearest)*(1-pull);const gap=Math.abs(fusedX-nearest),padding=3+strength*3;boundaryFusion.hidden=false;boundaryFusion.style.left=(Math.min(fusedX,nearest)-padding)+'px';boundaryFusion.style.width=(gap+padding*2)+'px';boundaryFusion.style.opacity=String(strength*.4);boundaryFusion.style.setProperty('--fusion-strength',String(strength));cursorStrip.style.boxShadow='0 0 '+(1+strength*4)+'px '+(strength)+'px #8ddcff40';cursorStrip.style.background='rgba(177,226,255,'+(.2+strength*.35)+')';}else{boundaryFusion.hidden=true;cursorStrip.style.boxShadow='';cursorStrip.style.background='';}cursorStrip.style.left=fusedX+'px';cursorTime.textContent=rulerStamp(geometry.time(cursorX,start,scale));let left=clamp(cursorX);if(!nowTime.hidden&&Math.abs(left-clamp(nowX))<52)left=clamp(nowX)+(cursorX>=nowX?54:-54);cursorTime.style.left=Math.max(0,Math.min(width-148,left))+'px';}}
  element.addEventListener('pointermove',event=>{cursorX=Math.max(0,Math.min(element.clientWidth,event.clientX-element.getBoundingClientRect().left));visualCursorX=cursorX;positionTimeLabels();});element.addEventListener('pointerleave',()=>{cursorX=null;visualCursorX=null;cancelAnimationFrame(cursorMotionFrame);cursorMotionFrame=0;boundaryFusion.hidden=true;cursorStrip.hidden=true;cursorTime.hidden=true;});
  function renderTaskRing(bar,item){
   const task=item.groupChildren?null:item.tasks?.find(task=>!task.completedAt);let ring=bar.querySelector('.exact-task-ring');
   if(!task||settings.remoteReadOnly){ring?.remove();return;}
   if(!ring){ring=document.createElement('button');ring.type='button';ring.className='exact-unlink exact-task-ring';
    ring.setAttribute('aria-label',item.taskBlob?'Settle this task':'Preview running task');
    ring.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="#ffffff22" stroke-width="2.5"/><circle class="exact-task-ring-arc" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="47.12" transform="rotate(-90 10 10)"/></svg>';
    ring.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});
    ring.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const current=bar.interval;
     if(!current.taskBlob){showTaskCard(ring,bar);return;}
     if(settings.readOnly)return;
     const task=current.tasks?.find(task=>!task.completedAt);if(!task)return;
     ring.disabled=true;try{const result=await store.command({type:'timeline-interval.task',payload:{intervalId:current.id,action:'complete',taskId:task.id}});if(!result.ok)error.textContent=result.code;refresh();}finally{ring.disabled=false;}
    });
    bar.append(ring);}
   ring.classList.toggle('exact-task-ring-beside-arrow',!item.taskBlob&&item.followNow);
   updateTaskRing(ring,item,task);
  }
  function updateTaskRing(ring,item,task){
   const now=clockNow(),end=item.taskBlob?Date.parse(task.startedAt)+task.durationMs:window.ProximaBlobTasks?.attempt(task,now).end;
   if(!Number.isFinite(end))return;
   const left=Math.max(0,Math.min(1,(end-now)/task.durationMs)),hue=Math.round(120*left);
   const arc=ring.querySelector('.exact-task-ring-arc');arc.style.strokeDashoffset=String(47.12*(1-left));arc.style.stroke='hsl('+hue+' 70% 52%)';
  }
  function renderUnlink(bar,item){renderTaskRing(bar,item);let arrow=bar.querySelector('.exact-unlink:not(.exact-task-ring)');if(item.taskBlob||item.groupChildren){arrow?.remove();return;}if(settings.remoteReadOnly||!item.followNow){arrow?.remove();return;}if(!arrow){arrow=document.createElement('button');arrow.type='button';arrow.className='exact-unlink';arrow.textContent='→';arrow.setAttribute('aria-label','Unlink from current time');arrow.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});arrow.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const current=bar.interval;const result=await store.command(current.queueId?{type:'timeline-queue.complete',payload:{intervalId:current.id,color:current.color,rev:current.rev}}:{type:'timeline-interval.patch',ifRev:current.rev,payload:{intervalId:current.id,patch:{followNow:false,end:new Date(Math.max(Date.parse(current.start)+1,clockNow())).toISOString()}}});if(!result.ok)error.textContent=result.code;refresh();});bar.append(arrow);}}
  const nameLeader=document.createElementNS('http://www.w3.org/2000/svg','svg');nameLeader.classList.add('exact-hover-leader');const leaderPath=document.createElementNS(nameLeader.namespaceURI,'path'),leaderPoint=document.createElementNS(nameLeader.namespaceURI,'circle');leaderPath.setAttribute('fill','none');leaderPath.setAttribute('stroke-width','2');leaderPoint.setAttribute('r','3');leaderPoint.setAttribute('fill','none');leaderPoint.setAttribute('stroke','#e4e7ec');leaderPoint.setAttribute('stroke-width','1.5');const leaderOutline=document.createElementNS(nameLeader.namespaceURI,'path');leaderOutline.setAttribute('fill','none');leaderOutline.setAttribute('stroke','#ffffffa0');leaderOutline.setAttribute('stroke-width','3.5');leaderOutline.setAttribute('stroke-linejoin','round');leaderOutline.setAttribute('stroke-linecap','round');nameLeader.append(leaderOutline,leaderPath,leaderPoint);element.append(nameLeader);
  function showBlobName(bar,event){if(event.target?.closest?.('.exact-name-check')){blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');return;}if(!bar.nameHidden||resizing||reordering){blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');return;}blobName.classList.toggle('is-checked',!!bar.interval.checked);blobName.replaceChildren();if(bar.popupTimes){const startLine=document.createElement('span');startLine.className='exact-hover-time';startLine.textContent=bar.popupTimes.start;blobName.append(startLine);if(bar.interval.name){const titleLine=document.createElement('span');titleLine.textContent=bar.interval.name;blobName.append(titleLine);}const endLine=document.createElement('span');endLine.className='exact-hover-time';endLine.textContent=bar.popupTimes.end;blobName.append(endLine);}else blobName.textContent=bar.interval.name;const bounds=element.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top,labelWidth=blobName.offsetWidth,labelHeight=blobName.offsetHeight,left=Math.max(4,Math.min(element.clientWidth-labelWidth-4,x-labelWidth-58)),top=Math.max(104,Math.min(element.clientHeight-labelHeight-8,y+55));blobName.style.left=left+'px';blobName.style.top=top+'px';leaderPath.setAttribute('stroke',bar.interval.color||'#a1cc43');const endX=left+labelWidth+8,endY=top+labelHeight/2,elbowX=Math.max(endX,x-25);leaderPath.setAttribute('d',x>=endX?'M '+x+' '+y+' L '+elbowX+' '+endY+' L '+endX+' '+endY:'M '+x+' '+y+' L '+x+' '+(top-10)+' L '+endX+' '+(top-10)+' L '+endX+' '+endY);leaderOutline.setAttribute('d',leaderPath.getAttribute('d'));leaderPoint.setAttribute('cx',x);leaderPoint.setAttribute('cy',y);blobName.classList.add('is-visible');nameLeader.classList.add('is-visible');}
  const sourceStore=store;store=new Proxy(sourceStore,{get(target,key){if(key==='command')return args=>{if(settings.remoteReadOnly)return Promise.resolve({ok:false,code:'READ_ONLY',changed:false});const patch=args.payload?.patch,allowed=args.type==='timeline-interval.patch'&&patch&&Object.keys(patch).every(key=>['checked','followNow','end'].includes(key))||args.type==='timeline-queue.complete';return settings.readOnly&&!allowed?Promise.resolve({ok:false,code:'READ_ONLY',changed:false}):target.command(args);};return target[key];}});
  const navigationTarget=target=>target.closest?.('.exact-date-strip,.exact-month-strip,.exact-current-year,.exact-year-divider,.exact-return-now,.exact-row-arrow,.exact-schedule-toggle,.exact-group-count,.exact-blob-content')||(target.closest?.('.exact-name-text')?.parentElement?.interval?.groupChildren?target:null);/* opening and entering groups only changes the view, so read-only views allow them */
  for(const type of ['click','dblclick','contextmenu','auxclick','pointerdown','drop','dragover'])element.addEventListener(type,event=>{if(!settings.readOnly)return;if(settings.remoteReadOnly&&type==='pointerdown'&&event.button===0&&!navigationTarget(event.target)){event.preventDefault();event.stopImmediatePropagation();const originX=event.clientX,originY=event.clientY,initialStart=start,initialScroll=tracks.scrollTop;const move=e=>{start=initialStart-(e.clientX-originX)/scale;tracks.scrollTop=initialScroll-(e.clientY-originY);render();};const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);return;}if(!settings.remoteReadOnly&&event.target.closest?.('.exact-name-check,.exact-unlink'))return;if(type==='auxclick'&&event.button===1&&event.target.closest('.exact-resize-end'))return;if(type==='pointerdown'&&(event.button===1||event.button===2&&!settings.remoteReadOnly))return;if(type==='pointerdown'&&event.button===0&&!event.target.closest('.exact-actions'))return;if((type==='click'||type==='pointerdown')&&navigationTarget(event.target))return;if(type==='contextmenu'&&event.target.closest?.('.exact-blob-group'))return;event.preventDefault();event.stopImmediatePropagation();},true);
  const settings={...options};let scheduleDay=Number.isFinite(savedLayout?.scheduleDay)?savedLayout.scheduleDay:null,scheduleDrag=null;const scheduleStates={main:scheduleDay,preview:null};const scheduleStateKey=(options.layoutKey||'')+':calendar-strip';if(options.layoutKey)try{const saved=JSON.parse(localStorage.getItem(scheduleStateKey)||'null');if(saved){scheduleStates.main=Number.isFinite(saved.main)?saved.main:null;scheduleStates.preview=Number.isFinite(saved.preview)?saved.preview:null;}scheduleDay=settings.readOnly?scheduleStates.preview:scheduleStates.main;}catch{}function saveScheduleState(){scheduleStates[settings.readOnly?'preview':'main']=scheduleDay;if(options.layoutKey)try{localStorage.setItem(scheduleStateKey,JSON.stringify(scheduleStates));}catch{}}const scheduleBand=document.createElement('div');scheduleBand.className='exact-horizontal-schedule';element.append(scheduleBand);const scheduleToggle=document.createElement('div');scheduleToggle.className='exact-schedule-toggle';scheduleToggle.tabIndex=0;scheduleToggle.setAttribute('role','button');scheduleToggle.setAttribute('aria-label','Expand or collapse this day’s schedule');scheduleToggle.setAttribute('aria-expanded','false');ruler.append(scheduleToggle);const scheduleNodes=new Map(),scheduleTextWidths=new Map();let scheduleCache=null;const scheduleMeasure=document.createElement('canvas').getContext('2d');scheduleMeasure.font='700 11px '+getComputedStyle(element).fontFamily;const labelMeasure=document.createElement('canvas').getContext('2d'),labelWidths=new Map();labelMeasure.font='12px '+getComputedStyle(element).fontFamily;const measureName=name=>{if(!labelWidths.has(name))labelWidths.set(name,labelMeasure.measureText(name).width);return labelWidths.get(name);};const scheduleTimeFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit'});
  function toggleSchedule(event){const time=event.clientX?geometry.time(event.clientX-element.getBoundingClientRect().left,start,scale):clockNow(),day=Math.floor((time+7*3600000)/86400000)*86400000-7*3600000;scheduleDay=scheduleDay===day?null:day;saveScheduleState();scheduleToggle.setAttribute('aria-expanded',String(scheduleDay!==null));render();}
  scheduleToggle.addEventListener('click',toggleSchedule);scheduleToggle.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSchedule(event);}});
  function visibleScheduleEntries(){const to=start+element.clientWidth/scale,version=settings.schedule.version?.()||'';if(!scheduleCache||scheduleCache.version!==version||start<scheduleCache.from||to>scheduleCache.to){const padding=(to-start)*.5,from=start-padding,end=to+padding;scheduleCache={from,to:end,version,entries:settings.schedule.events({start:new Date(from),end:new Date(end)}).sort((a,b)=>a.start-b.start)};}return scheduleCache.entries.filter(entry=>entry.end.getTime()>start&&entry.start.getTime()<to);}
  function renderHorizontalSchedule(){const renderBegan=performance.now(),viewportWidth=element.clientWidth,scheduleView=availableViewport();const enabled=scheduleDay!==null&&settings.schedule,rows=enabled?visibleScheduleEntries().filter(entry=>settings.readOnly||scheduleDrag||entry.end.getTime()>start+scheduleView.left/scale&&entry.start.getTime()<start+scheduleView.right/scale):[],laneEnds=[],live=new Set();let title=scheduleBand.querySelector('.exact-horizontal-schedule-title');if(!title){title=document.createElement('span');title.className='exact-horizontal-schedule-title';scheduleBand.append(title);}title.textContent=enabled?'Schedule'+(rows.length?'':' · No events in view'):'';for(const entry of rows){const key=entry.item.id+':'+(entry.occurrenceKey||entry.start.toISOString());live.add(key);const a=Math.max(start,entry.start.getTime()),b=Math.min(start+viewportWidth/scale,entry.end.getTime());let lane=laneEnds.findIndex(end=>end<=a);if(lane<0)lane=laneEnds.length;laneEnds[lane]=b;let node=scheduleNodes.get(key);if(!node){node=document.createElement('div');node.className='exact-horizontal-event';const name=document.createElement('span');name.className='exact-horizontal-event-name';node.append(name);node.addEventListener('pointermove',event=>{const bounds=node.getBoundingClientRect(),atStart=event.clientX-bounds.left<=6,atEnd=bounds.right-event.clientX<=6;if(bounds.width<node.nameWidth+20){showBlobName({nameHidden:true,interval:{...node.interval,name:node.nameHidden?node.interval.name:''},popupTimes:{start:scheduleTimeFormatter.format(node.entry.start),end:scheduleTimeFormatter.format(node.entry.end)}},event);}else if(atStart||atEnd){const timestamp=atStart&&atEnd?(event.clientX<(bounds.left+bounds.right)/2?node.entry.start:node.entry.end):atStart?node.entry.start:node.entry.end;showBlobName({nameHidden:true,interval:{name:scheduleTimeFormatter.format(timestamp),color:node.interval.color}},event);}else showBlobName(node,event);});node.addEventListener('pointerleave',()=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});scheduleBand.append(node);scheduleNodes.set(key,node);}node.entry=entry;const actual=scheduleDrag?.key===key?scheduleDrag:{start:a,end:b};node.style.left=geometry.position(actual.start,start,scale)+'px';node.style.width=Math.max(0,(actual.end-actual.start)*scale)+'px';node.style.top=(26+lane*44)+'px';const color=entry.exception?.color||entry.item.color||'#334052';node.style.setProperty('--schedule-color',color);const name=node.querySelector('.exact-horizontal-event-name');const nameText=entry.exception?.name||entry.item.name;const signature=nameText+'|'+color+'|'+entry.start.getTime()+'|'+entry.end.getTime();if(node.renderSignature!==signature){name.textContent=nameText;node.setAttribute('aria-label',nameText+' '+scheduleTimeFormatter.format(entry.start)+'–'+scheduleTimeFormatter.format(entry.end));node.dataset.eventId=entry.item.id;node.dataset.start=entry.start.toISOString();node.dataset.occurrenceKey=entry.occurrenceKey||'';node.renderSignature=signature;}node.interval={name:nameText,color};name.style.visibility='visible';name.style.width='max-content';if(!scheduleTextWidths.has(name.textContent))scheduleTextWidths.set(name.textContent,scheduleMeasure.measureText(name.textContent).width);const textWidth=scheduleTextWidths.get(name.textContent);node.nameWidth=textWidth;const left=parseFloat(node.style.left),barWidth=parseFloat(node.style.width);const nameOffset=barWidth>=textWidth+20?10:Math.max(4,left-textWidth-12)-left;name.style.left=nameOffset+'px';node.layoutGeometry={left,right:left+barWidth,width:barWidth,top:26+lane*44,nameLeft:left+nameOffset,nameRight:left+nameOffset+textWidth};}
   for(const [key,node] of scheduleNodes)if(!live.has(key)){node.remove();scheduleNodes.delete(key);}const labelLanes=new Map();for(const node of scheduleNodes.values()){const lane=node.layoutGeometry.top;if(!labelLanes.has(lane))labelLanes.set(lane,[]);labelLanes.get(lane).push(node);}for(const nodes of labelLanes.values()){nodes.sort((a,b)=>b.layoutGeometry.left-a.layoutGeometry.left);const crowdedNames=new Set();let group=[];const finishGroup=()=>{if(group.length>1&&group.some(node=>node.layoutGeometry.width<node.nameWidth+20))for(const node of group)crowdedNames.add(node);group=[];};for(const node of nodes){const previous=group.at(-1);if(previous&&previous.layoutGeometry.left-node.layoutGeometry.right>12)finishGroup();group.push(node);}finishGroup();const occupied=[];nodes.forEach((node,index)=>{const box=node.layoutGeometry,name=node.querySelector('.exact-horizontal-event-name');const compressed=crowdedNames.has(node)||box.width<=36&&[nodes[index-1],nodes[index+1]].some(other=>other&&Math.max(box.left,other.layoutGeometry.left)-Math.min(box.right,other.layoutGeometry.right)<24),overlap=occupied.some(other=>box.nameLeft<other.right&&box.nameRight>other.left);const touches=nodes.some(other=>other!==node&&box.nameLeft<=other.layoutGeometry.right+2&&box.nameRight>=other.layoutGeometry.left-2);node.nameHidden=compressed||overlap||touches;name.style.visibility=node.nameHidden?'hidden':'visible';if(!node.nameHidden)occupied.push({left:box.nameLeft,right:box.nameRight});});}const height=enabled&&(rows.length||settings.readOnly)?Math.max(62,Math.min(246,30+laneEnds.length*44)):0;scheduleBand.style.height=height+'px';scheduleBand.classList.toggle('is-expanded',!!enabled);tracks.style.top=(101+height)+'px';let current=scheduleBand.querySelector('.exact-horizontal-now');if(!current){current=document.createElement('span');current.className='exact-horizontal-now';scheduleBand.append(current);}current.style.left=geometry.position(clockNow(),start,scale)+'px';scheduleBand.renderTime=performance.now()-renderBegan;
  }
  dateStrip.addEventListener('click',event=>{if(settings.readOnly&&settings.schedule?.returnToTimeline){event.stopPropagation();settings.schedule.returnToTimeline();return;}const cell=event.target.closest('.date-strip-cell');if(cell&&settings.schedule?.navigate){event.stopPropagation();settings.schedule.navigate('week',cell.dateStripTimestamp);}});
  monthStrip.addEventListener('click',event=>{if(settings.readOnly){event.stopPropagation();animate({start:clockNow()-element.clientWidth*.5/scale,scale},null);return;}const cell=event.target.closest('.exact-month-label');if(cell&&settings.schedule?.navigate){event.stopPropagation();settings.schedule.navigate('month',Number(cell.dataset.time));}});
  element.addEventListener('click',event=>{const year=event.target.closest('.exact-current-year,.exact-year-divider');if(year&&settings.schedule?.navigate){event.stopPropagation();settings.schedule.navigate('year',Date.UTC(Number(year.textContent),0,1)-7*3600000);}});
  const selected=new Set();const selectionRows=new Map();
  let inlineEditor=null,draftIndex=null,reordering=false,ignoreClickUntil=0,deadlineResize=null,timeEditor=null;const error=document.createElement('span');error.className='exact-inline-error';error.setAttribute('role','alert');element.append(error);let errorFadeTimer=0,errorClearTimer=0;new MutationObserver(()=>{clearTimeout(errorFadeTimer);clearTimeout(errorClearTimer);error.classList.remove('is-fading');if(error.textContent)errorFadeTimer=setTimeout(()=>{error.classList.add('is-fading');errorClearTimer=setTimeout(()=>{error.textContent='';},350);},2400);}).observe(error,{childList:true,characterData:true,subtree:true});
  const queueNotice=document.createElement('div');queueNotice.className='exact-queue-notice';queueNotice.setAttribute('role','status');queueNotice.hidden=true;const queueNoticeText=document.createElement('span'),queueNoticeClose=document.createElement('button');queueNoticeClose.type='button';queueNoticeClose.textContent='×';queueNoticeClose.setAttribute('aria-label','Dismiss queue completion notice');queueNotice.append(queueNoticeText,queueNoticeClose);element.append(queueNotice);
  let dismissedQueueNotices=[];try{dismissedQueueNotices=JSON.parse(localStorage.getItem('proxima:queue-notices:dismissed')||'[]');if(!Array.isArray(dismissedQueueNotices))dismissedQueueNotices=[];}catch{}
  // A queue notice is news for a day; after that it no longer shows on any device (creator, 2026-10-19).
  function showQueueNotice(){const notes=store.timelineRows().map(row=>row.queueCompletion).filter(note=>note?.id&&!dismissedQueueNotices.includes(note.id)&&!(Date.now()-Date.parse(note.endedAt)>24*3600*1000)).sort((a,b)=>Date.parse(b.endedAt)-Date.parse(a.endedAt));const note=notes[0];queueNotice.hidden=!note;if(!note)return;queueNotice.dataset.noticeId=note.id;const at=new Date(note.endedAt).toLocaleString('en-GB',{timeZone:'Asia/Ho_Chi_Minh',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});const names=(note.returned||[]).map(x=>'“'+x.name+'”').join(', ');queueNoticeText.textContent=(note.automatic?'Queue ended automatically at ':'Queue ended at ')+at+'. '+(note.active?'“'+note.active.name+'” stopped. ':'')+(names?names+' never started and returned to '+((note.returned||[]).length===1?'its original position.':'their original positions.'):'')+(notes.length>1?' ('+notes.length+' notices)':'');}
  queueNoticeClose.addEventListener('click',event=>{event.stopPropagation();dismissedQueueNotices=[...dismissedQueueNotices,queueNotice.dataset.noticeId].slice(-200);try{localStorage.setItem('proxima:queue-notices:dismissed',JSON.stringify(dismissedQueueNotices));}catch{}showQueueNotice();});
  const actions=document.createElement('div');actions.className='exact-actions';if(settings.remoteReadOnly)actions.hidden=true;const addButton=document.createElement('button'),deleteButton=document.createElement('button');addButton.type=deleteButton.type='button';addButton.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';addButton.title='Group selected blobs; ungroup one selected group; create a blob when nothing is selected';addButton.setAttribute('aria-label','Create a new blob');deleteButton.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>';deleteButton.setAttribute('aria-label','Delete selected blobs');deleteButton.title='Delete selected blobs';const queueButton=document.createElement('button');queueButton.type='button';queueButton.title='Collapse selected blobs, or place a queue end';queueButton.setAttribute('aria-label','Place a queue end');queueButton.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M17 3v18M4 12h10m-4-4 4 4-4 4"/></svg>';const timerButton=document.createElement('button');timerButton.type='button';timerButton.className='exact-timer-button';timerButton.setAttribute('aria-label','Start a task blob');timerButton.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>';actions.append(timerButton,addButton,queueButton,deleteButton);ruler.append(actions);// Group breadcrumb (As you Go style): Timeline › group › nested group; any crumb goes back to that level.
  // The main timeline puts it beside the clock in the page heading; other timelines keep it in their actions.
  const groupCrumbs=document.createElement('nav');groupCrumbs.className='exact-group-crumbs';groupCrumbs.setAttribute('aria-label','Group path');groupCrumbs.hidden=true;{const clock=element.id==='exactTimeline'&&document.getElementById('lifeProgressClock');if(clock)clock.after(groupCrumbs);else actions.prepend(groupCrumbs);}
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>renderCrumbs()).observe(element);
  const folderIcon=color=>'<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="'+String(color||'#c9a253').replace(/[^#a-zA-Z0-9(),.% ]/g,'')+'" d="M1.5 3.5h4.2l1.4 1.5h7.4v8.5h-13z"/></svg>';
  function renderCrumbs(){const visible=groupTrail.length&&element.getClientRects().length;groupCrumbs.hidden=!visible;if(!visible){groupCrumbs.replaceChildren();delete groupCrumbs.dataset.signature;return;}const all=allItems(),parts=[{name:'Timeline',depth:0}].concat(groupTrail.map((id,i)=>{const g=all.find(x=>x.id===id);return {name:g?.name||'Group',color:g?.color||g?.groupLeaves?.[0]?.color,depth:i+1};}));const signature=JSON.stringify(parts);if(groupCrumbs.dataset.signature===signature)return;groupCrumbs.dataset.signature=signature;groupCrumbs.replaceChildren();parts.forEach((part,i)=>{if(i){const sep=document.createElement('span');sep.className='exact-group-crumb-sep';sep.textContent='›';groupCrumbs.append(sep);}const last=i===parts.length-1,crumb=document.createElement(last?'span':'button');crumb.className='exact-group-crumb'+(last?' is-current':'');if(!last){crumb.type='button';crumb.title='Back to '+part.name;crumb.addEventListener('click',()=>leaveTo(part.depth));}crumb.innerHTML=i?folderIcon(part.color):'';const label=document.createElement('span');label.textContent=part.name;crumb.append(label);groupCrumbs.append(crumb);});}queueButton.addEventListener('click',queueButton.runAction=async()=>{if(resizing||reordering||inlineEditor)return;if(selected.size){if(allItems().some(x=>selected.has(x.id)&&x.groupChildren)){const result=await store.command({type:'timeline-group.queue',payload:selectionPayload()});if(!result.ok)error.textContent=result.code;else selected.clear();refresh();return;}const chosen=items().filter(item=>selected.has(item.id)),action=queueSelectionAction(chosen,store.timelineRows());const restore=action==='restore'?chosen:[];if(action==='enqueue'){const queues=[...new Set(chosen.map(item=>item.queueId).filter(Boolean))];if(queues.length!==1){error.textContent='QUEUE_LINKED_EDGE';return;}const additions=chosen.filter(item=>!item.queueId);const result=await store.command({type:'timeline-queue.enqueue',payload:{rowId:queues[0],intervalIds:additions.map(item=>item.id),revisions:Object.fromEntries(additions.map(item=>[item.id,item.rev]))}});if(!result.ok)error.textContent=result.code;refresh();return;}if(restore.length){const result=await store.command({type:'timeline-queue.restore',payload:{intervalIds:restore.map(item=>item.id)}});if(!result.ok)error.textContent=result.code;refresh();return;}const members=items().filter(x=>selected.has(x.id)).sort((a,b)=>(a.followNow?clockNow():Date.parse(a.end))-(b.followNow?clockNow():Date.parse(b.end))||Date.parse(a.start)-Date.parse(b.start));const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d'),colors={};members.forEach((item,index)=>{context.clearRect(0,0,1,1);context.fillStyle='oklch(68% 0.18 '+(index*360/members.length)+'deg)';context.fillRect(0,0,1,1);colors[item.id]='#'+[...context.getImageData(0,0,1,1).data].slice(0,3).map(x=>x.toString(16).padStart(2,'0')).join('');});const result=await store.command({type:'timeline-queue.collapse',payload:{intervalIds:members.map(x=>x.id),revisions:Object.fromEntries(members.map(x=>[x.id,x.rev])),colors}});if(!result.ok)error.textContent=result.code==='QUEUE_RUNNING_SELECTION'?'Only one running blob can be collapsed at a time.':result.code==='QUEUE_SHARED_END'?'Blobs with the same end time cannot be collapsed.':result.code==='INTERVAL_OVERLAP'?'These blobs overlap in time, so they cannot follow each other in one queue.':result.code;placingQueue=false;queueButton.classList.remove('is-active');element.classList.remove('exact-placing-queue');refresh();return;}placingQueue=!placingQueue;queueButton.classList.toggle('is-active',placingQueue);element.classList.toggle('exact-placing-queue',placingQueue);error.textContent=placingQueue?'Click a future time in the destination row. Escape cancels.':'';});
  addButton.addEventListener('click',addButton.runAction=async()=>{if(resizing||deadlineResize||reordering||inlineEditor||timeEditor)return;if(selected.size){const chosen=allItems().filter(x=>selected.has(x.id));if(chosen.length===1&&chosen[0].groupChildren){const result=await store.command({type:'timeline-group.ungroup',payload:{...selectionPayload(),groupId:chosen[0].id}});if(!result.ok)error.textContent=result.code;else selected.clear();refresh();return;}const result=await store.command({type:'timeline-group.create',payload:selectionPayload()});if(!result.ok)error.textContent=result.code==='TASK_BLOB_GROUP'?'A task blob can only be grouped with one live blob.':result.code==='TASK_RUNNING'?'That blob already has a running task; finish one of them first.':result.code;else{selected.clear();selected.add(result.value.groupId);refresh();const group=allItems().find(x=>x.id===result.value.groupId);if(result.value.createdNew&&group)open(group);}return;}if(resizing||deadlineResize||reordering||timeEditor)return;closeColor();const now=clockNow(),target=freeCreationDestination(now),index=target.index;open(null,now,index,target.row?(target.row.rowId||target.row.id):null,true);tracks.scrollTop=Math.max(0,20+index*ROW-tracks.clientHeight/2);if(now<start||now>start+element.clientWidth/scale)animate({start:now-element.clientWidth*.5/scale,scale},null);});
  let lastTextPoint=null;const textPreview=document.createElement('div');textPreview.className='exact-text-drop-preview';textPreview.hidden=true;tracks.append(textPreview);
  function textPoint(event){const x=event.clientX-element.getBoundingClientRect().left,y=event.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop,onPlus=!!event.target.closest?.('[aria-label="Create a new blob"]'),linked=onPlus||Math.abs(x-geometry.position(clockNow(),start,scale))<=10;return {time:linked?clockNow():Math.round(geometry.time(x,start,scale)),index:Math.max(0,Math.min(laneCount,Math.floor((y-11)/ROW))),linked,onPlus};}
  // A new blob goes to the topmost row you can see that has nothing from now on; with no such row it starts
  // a new row at the very top. Rows scrolled out of view are not reused (creator, 2026-11-08).
  // The free row is picked from every row, not just the ones the current zoom shows, so + lands in the same
  // place at any zoom. A row out of view takes the slot it will appear in.
  function freeCreationDestination(time){
   // A group counts as a row too: when the first free row is a group, the new blob takes a new row in its place.
   const visible=ordered(),all=durableOrdered(),data=items(),queued=new Set(queues().map(row=>row.id));
   const first=all.find(row=>!row.groupDepth&&!row.queuePlaceholder&&!queued.has(row.rowId||row.id)&&(row.groupChildren?!row.groupLive&&!row.followNow&&Date.parse(row.end)<=time:firstFreeRow([row],data,time,queued)));
   if(!first)return {row:null,index:0};
   const row=first.groupChildren?null:first,key=laneId(first);
   if(!row){const at=visible.findIndex(x=>laneId(x)===key);if(at>=0)return {row:null,index:at};const rank=new Map(all.map((x,i)=>[laneId(x),i]));return {row:null,index:visible.filter(x=>(rank.get(laneId(x))??Infinity)<rank.get(key)).length};}
   const shown=visible.findIndex(x=>laneId(x)===key);if(shown>=0)return {row:visible[shown],index:shown};
   const rank=new Map(all.map((x,i)=>[laneId(x),i]));return {row,index:visible.filter(x=>(rank.get(laneId(x))??Infinity)<rank.get(key)).length};
  }
  function textDestination(point){const data=items(),rows=ordered(),duration=point.linked?1:Math.max(1,Math.round(160/scale)),end=point.linked?Infinity:point.time+duration;const free=row=>!queues().some(x=>x.id===(row.rowId||row.id))&&!data.some(x=>(x.rowId||x.id)===(row.rowId||row.id)&&point.time<(x.followNow?Infinity:Date.parse(x.end))&&Date.parse(x.start)<end);if(point.onPlus)return freeCreationDestination(point.time);const row=rows[point.index];return {row:row&&free(row)?row:null,index:point.index};}
  async function createFromText(text,point){const name=String(text||'').trim().replace(/\s+/g,' ').slice(0,200);if(!name)return;const target=textDestination(point),now=clockNow(),stamp=point.linked?now:point.time;const result=await store.command({type:'timeline-interval.create',payload:{color:creationColor(),name,rowId:target.row?(target.row.rowId||target.row.id):undefined,beforeId:target.row?undefined:ordered()[target.index]?.id,start:new Date(stamp).toISOString(),end:new Date(point.linked?stamp+1:stamp+Math.max(1,Math.round(160/scale))).toISOString(),followNow:point.linked}});if(!result.ok)error.textContent=result.code;else{refresh();tracks.scrollTop=Math.max(0,20+target.index*ROW-tracks.clientHeight/2);}textPreview.hidden=true;}
  element.addEventListener('pointermove',event=>{lastTextPoint=textPoint(event);});
  element.addEventListener('dragover',event=>{if(!event.dataTransfer?.types.includes('text/plain')||event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';const point=textPoint(event),target=textDestination(point);textPreview.hidden=false;textPreview.style.left=Math.max(0,geometry.position(point.time,start,scale))+'px';textPreview.style.top=(20+target.index*ROW)+'px';textPreview.style.width=(point.linked?100:160)+'px';textPreview.textContent=point.linked?'Create live blob':'Create blob';});
  element.addEventListener('dragleave',event=>{if(!element.contains(event.relatedTarget))textPreview.hidden=true;});
  element.addEventListener('drop',event=>{const text=event.dataTransfer?.getData('text/plain');textPreview.hidden=true;if(!text||event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.stopPropagation();lastTextPoint=textPoint(event);void createFromText(text,lastTextPoint);});
  document.addEventListener('paste',event=>{if(event.defaultPrevented||settings.readOnly||!element.getClientRects().length||event.target.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])')||inlineEditor||timeEditor||document.querySelector('dialog[open]'))return;const text=event.clipboardData?.getData('text/plain');if(!text?.trim())return;event.preventDefault();const point={time:clockNow(),index:laneCount,linked:true,onPlus:true};void createFromText(text,point);});
  async function deleteSelection(){if(resizing||deadlineResize||reordering||inlineEditor||timeEditor||!selected.size)return;const rows=items().filter(x=>selected.has(x.id));const result=await store.command({type:'timeline-group.delete',payload:selectionPayload()});if(!result.ok)error.textContent=result.code;else selected.clear();refresh();}
  deleteButton.addEventListener('click',deleteSelection);deleteButton.runAction=deleteSelection;
  // Far overview: editing gestures on the tracks are off; panning (middle drag, wheel) and the header still work.
  const farGuard=event=>{
   if(!far||!element.contains(event.target)||!event.target.closest?.('.exact-tracks')||event.type==='pointerdown'&&event.button===1)return;
   event.preventDefault();event.stopImmediatePropagation();
   if(event.type!=='click')return;
   const node=event.target.closest('.exact-interval,.exact-queued-placeholder'),item=node?.interval;if(!item)return;
   const a=Date.parse(item.start),b=item.followNow?clockNow():Date.parse(item.end),span=Math.max(3600000,b-a);
   animate({start:a-span*.2,scale:Math.max(1e-10,element.clientWidth/(span*1.4))},null);
  };
  for(const type of ['pointerdown','click','dblclick','contextmenu','auxclick'])document.addEventListener(type,farGuard,true);
  // Hovering a header action shows its result on the timeline itself (creator, 2026-11-09): the button's own click
  // logic runs against a preview store, and leaving or pressing the button returns to the real data first.
  let previewToken=0,glideTimer=0,previewKept=null;
  function glide(){if(reducedMotion())return;element.classList.add('exact-animating');clearTimeout(glideTimer);glideTimer=setTimeout(()=>element.classList.remove('exact-animating'),320);}
  // During a glide, a blob or label that leaves fades out first instead of vanishing.
  function retire(node){if(!node)return;if(!element.classList.contains('exact-animating')){node.remove();return;}node.classList.add('exact-leaving');setTimeout(()=>node.remove(),300);}
  async function previewAction(button){
   if(resizing||deadlineResize||reordering||inlineEditor||timeEditor||button.disabled)return;
   const mode=button===deleteButton?'delete':button.dataset.action;
   if(mode==='place'||!selected.size&&mode!=='create')return;
   const token=++previewToken,now=clockNow(),target=mode==='create'?freeCreationDestination(now):null,before=mode==='create'?ordered()[target.index]?.id:null;
   let sandbox;try{sandbox=await previewStore(realStore);}catch{return;}
   if(token!==previewToken)return;
   // The action changes view state too (selection, which groups are open, scroll); all of it is put back afterwards.
   const keptSelection=new Set(selected),keptError=error.textContent,keptExpanded=new Set(expandedGroups),keptScroll=tracks.scrollTop;previewKept={selection:keptSelection,expanded:keptExpanded,error:keptError};
   previewing=true;store=sandbox;element.classList.add('is-action-preview');glide();
   try{
    if(mode==='create')await sandbox.command({type:'timeline-interval.create',payload:{name:'New blob',color:creationColor(),rowId:target.row?(target.row.rowId||target.row.id):undefined,beforeId:target.row?undefined:before,start:new Date(now).toISOString(),end:new Date(now+1).toISOString(),followNow:true}});
    else await button.runAction?.();
   }catch{}
   /* an action that would be refused previews as its refusal message */const refusal=error.textContent!==keptError?error.textContent:'';selected.clear();for(const id of keptSelection)selected.add(id);error.textContent=refusal||keptError;
   expandedGroups.clear();for(const id of keptExpanded)expandedGroups.add(id);tracks.scrollTop=keptScroll;
   if(token!==previewToken)return;
   glide();refresh();
  }
  function endActionPreview(){previewToken++;if(store===realStore&&!previewing)return;store=realStore;previewing=false;if(previewKept){selected.clear();for(const id of previewKept.selection)selected.add(id);expandedGroups.clear();for(const id of previewKept.expanded)expandedGroups.add(id);error.textContent=previewKept.error;previewKept=null;}element.classList.remove('is-action-preview');dropPreviewStore();glide();refresh();}
  for(const button of [addButton,queueButton,deleteButton]){
   button.addEventListener('mouseenter',()=>void previewAction(button));
   button.addEventListener('mouseleave',endActionPreview);
   button.addEventListener('pointerdown',endActionPreview,true);
  }
  // The clock starts a task on one eligible selected blob, or creates a standalone task blob.
  const TASK_MINUTES='proxima.timeline.task-blob-minutes';
  function popIn(node){node.getAnimations().forEach(a=>a.cancel());node.hidden=false;if(reducedMotion())return;node.animate([{opacity:0,transform:'translateY(-6px) scale(.96)'},{opacity:1,transform:'none'}],{duration:170,easing:'cubic-bezier(.2,.9,.3,1.2)'});}
  function popOut(node,after){if(node.hidden)return;if(reducedMotion()){node.hidden=true;after?.();return;}node.getAnimations().forEach(a=>a.cancel());const anim=node.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-6px) scale(.96)'}],{duration:130,easing:'ease-in'});anim.onfinish=()=>{node.hidden=true;after?.();};}
  const timerCard=document.createElement('div');timerCard.className='exact-timer-card';timerCard.hidden=true;
  const timerName=document.createElement('input');timerName.placeholder='Task name';timerName.maxLength=200;timerName.setAttribute('aria-label','Task name');
  const timerMinutes=document.createElement('input');timerMinutes.type='number';timerMinutes.min='1';timerMinutes.max='1440';timerMinutes.step='1';timerMinutes.title='Minutes';timerMinutes.setAttribute('aria-label','Minutes');
  const timerStart=document.createElement('button');timerStart.type='button';timerStart.textContent='Start';
  const timerUnit=document.createElement('span');timerUnit.textContent='min';const timerStatus=document.createElement('small');
  timerCard.append(timerName,timerMinutes,timerUnit,timerStart,timerStatus);element.append(timerCard);
  for(const field of [timerName,timerMinutes])field.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();void startTaskBlob();}if(event.key==='Escape'){event.preventDefault();closeTimerCard(true);}});
  timerCard.addEventListener('pointerdown',event=>event.stopPropagation());
  let timerCardClose=0,timerTarget=null;
  function openTimerCard(){
   if(settings.readOnly||far||previewing)return;
   clearTimeout(timerCardClose);
   if(!timerCard.hidden)return;
   const item=selected.size===1?allItems().find(item=>selected.has(item.id)):null;
   timerTarget=item&&!item.groupChildren&&!item.taskBlob&&!item.sourceFollowing&&!item.tasks?.some(task=>!task.completedAt)?item:null;
   timerName.value=timerTarget?.name||'';
   let minutes=25;
   try{const saved=Number(localStorage.getItem(TASK_MINUTES));if(Number.isInteger(saved)&&saved>=1&&saved<=1440)minutes=saved;}catch{}
   timerMinutes.value=String(minutes);timerStatus.textContent='';popIn(timerCard);
   const host=element.getBoundingClientRect(),box=timerButton.getBoundingClientRect();
   timerCard.style.top=(box.bottom-host.top+6)+'px';timerCard.style.right=Math.max(4,host.right-box.right)+'px';
  }
  function closeTimerCard(now){clearTimeout(timerCardClose);const go=()=>{if(timerCard.contains(document.activeElement)&&!now)return;popOut(timerCard);};if(now)go();else timerCardClose=setTimeout(go,350);}
  timerButton.addEventListener('mouseenter',openTimerCard);timerButton.addEventListener('click',()=>{openTimerCard();timerName.focus();});
  timerButton.addEventListener('mouseleave',()=>closeTimerCard(false));timerCard.addEventListener('mouseenter',()=>clearTimeout(timerCardClose));timerCard.addEventListener('mouseleave',()=>closeTimerCard(false));
  timerName.addEventListener('blur',()=>{if(!timerCard.matches(':hover'))closeTimerCard(false);});
  timerStart.addEventListener('click',()=>void startTaskBlob());
  async function startTaskBlob(){
   if(timerStart.disabled)return;
   const name=timerName.value.trim().replace(/\s+/g,' '),minutes=Math.round(Number(timerMinutes.value));
   if(!name){timerStatus.textContent='Name the task first.';timerName.focus();return;}
   if(!Number.isFinite(minutes)||minutes<1||minutes>1440){timerStatus.textContent='1 to 1440 minutes.';timerMinutes.focus();return;}
   const durationMs=minutes*60000;
   timerStart.disabled=true;
   try{
    let result;
    if(timerTarget){
     result=await store.command({type:'timeline-interval.task',payload:{intervalId:timerTarget.id,action:'start',name,durationMs}});
    }else{
     const now=clockNow(),target=freeCreationDestination(now);
     result=await store.command({type:'timeline-interval.create',payload:{name,color:creationColor(),rowId:target.row?(target.row.rowId||target.row.id):undefined,beforeId:target.row?undefined:ordered()[target.index]?.id,start:new Date(now).toISOString(),end:new Date(now+1).toISOString(),followNow:true,taskDurationMs:durationMs}});
    }
    if(!result.ok){timerStatus.textContent='Not started: '+result.code;return;}
    try{localStorage.setItem(TASK_MINUTES,String(minutes));}catch{}
    closeTimerCard(true);refresh();
   }finally{timerStart.disabled=false;}
  }
  const taskCard=document.createElement('div');taskCard.className='exact-task-card';taskCard.hidden=true;element.append(taskCard);
  let taskCardFor=null,taskCardPrevious=null,taskCardOpen=0,taskCardClose=0;
  function taskPreviewAnchor(target){
   const bar=target?.closest?.('.exact-interval,.exact-outside-name');
   if(!bar?.interval||bar.interval.groupChildren)return null;
   return bar.interval.taskBlob?bar:target.closest('.exact-task-ring');
  }
  function showTaskCard(anchor,bar=anchor.closest('.exact-interval,.exact-outside-name')){
   const tasks=window.ProximaBlobTasks,item=realStore.timelineIntervals().find(item=>item.id===bar?.interval.id);
   if(!tasks?.mount||far||previewing||!item||!item.taskBlob&&!tasks.running(item.id))return;
   clearTimeout(taskCardClose);
   if(taskCardFor!==bar.interval.id){if(taskCard.hidden)taskCardPrevious=tasks.current?.()||null;taskCardFor=bar.interval.id;tasks.mount(taskCard,bar.interval.id);}
   const opening=taskCard.hidden||taskCard.getAnimations().length>0;if(opening)popIn(taskCard);const host=element.getBoundingClientRect(),box=anchor.getBoundingClientRect(),width=Math.min(560,element.clientWidth-16),height=taskCard.offsetHeight||420;
   let left=Math.min(Math.max(8,box.right-host.left-width),element.clientWidth-width-8),top=box.bottom-host.top+6;if(top+height>element.clientHeight)top=Math.max(8,box.top-host.top-height-6);
   taskCard.style.width=width+'px';taskCard.style.left=left+'px';taskCard.style.top=top+'px';}
  function hideTaskCard(now){
   clearTimeout(taskCardOpen);clearTimeout(taskCardClose);
   const go=()=>{
    if(taskCard.hidden||!now&&taskCard.matches(':hover'))return;
    popOut(taskCard,()=>{
     const tasks=window.ProximaBlobTasks,previous=taskCardPrevious;
     taskCardFor=null;taskCardPrevious=null;
     if(previous&&!previous.hidden&&previous.container?.isConnected&&previous.container!==taskCard)tasks?.mount(previous.container,previous.intervalId);
     else tasks?.hide();
    });
   };
   if(now)go();else taskCardClose=setTimeout(go,120);
  }
  tracks.addEventListener('pointerover',event=>{const anchor=taskPreviewAnchor(event.target);if(!anchor||anchor===taskPreviewAnchor(event.relatedTarget))return;clearTimeout(taskCardClose);clearTimeout(taskCardOpen);taskCardOpen=setTimeout(()=>{if(anchor.isConnected&&anchor.matches(':hover'))showTaskCard(anchor);},250);});
  tracks.addEventListener('pointerout',event=>{const anchor=taskPreviewAnchor(event.target);if(anchor&&anchor!==taskPreviewAnchor(event.relatedTarget))hideTaskCard(false);});
  taskCard.addEventListener('mouseenter',()=>{clearTimeout(taskCardClose);if(taskCard.getAnimations().length)popIn(taskCard);clearRegionHover();blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});
  taskCard.addEventListener('mouseleave',()=>hideTaskCard(false));
  taskCard.addEventListener('pointermove',event=>event.stopPropagation());
  taskCard.addEventListener('pointerdown',event=>event.stopPropagation());taskCard.addEventListener('wheel',event=>event.stopPropagation());
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!taskCard.hidden){hideTaskCard(true);}},true);
  const steps=[1,10,100,1000,5000,15000,60000,300000,900000,3600000,10800000,21600000,43200000,86400000,604800000,2592000000,31536000000];
  const label=t=>new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',second:scale>=.02?'2-digit':undefined,fractionalSecondDigits:scale>=1?3:undefined,hour12:false});
  const expandedGroups=new Set(),groupTrail=[],groupReturnViews=[];
  const groupExpansionKey=options.layoutKey?options.layoutKey+':expanded-groups':null;
  if(groupExpansionKey)try{
   const saved=JSON.parse(localStorage.getItem(groupExpansionKey)||'[]');
   if(Array.isArray(saved))for(const id of saved)if(typeof id==='string')expandedGroups.add(id);
  }catch{}
  function saveGroupExpansion(){
   if(!groupExpansionKey||previewing)return;
   try{localStorage.setItem(groupExpansionKey,JSON.stringify([...expandedGroups]));}catch{}
  }
  function allItems(){
   const raw=store.timelineIntervals(),index=new Map(raw.map(x=>[x.id,x])),memo=new Map();
   function project(key,path=new Set()){if(memo.has(key))return memo.get(key);const item=index.get(key);if(!item||path.has(key))return null;if(!item.groupChildren)return item;const next=new Set([...path,key]),children=item.groupChildren.map(child=>project(child,next)).filter(Boolean),leaves=[...new Map(children.flatMap(x=>x.groupChildren?x.groupLeaves:[x]).map(x=>[x.id,x])).values()];if(!leaves.length)return {...item,groupLeaves:[],groupLive:false};const first=Math.min(...leaves.map(x=>Date.parse(x.start))),last=Math.max(...leaves.map(x=>x.followNow?Math.max(Date.parse(x.start)+1,clockNow()):Date.parse(x.end))),value={...item,start:new Date(first).toISOString(),end:new Date(Math.max(first+1,last)).toISOString(),followNow:false,groupLive:leaves.some(x=>x.followNow),groupLeaves:leaves.sort((a,b)=>(a.rowOrder||0)-(b.rowOrder||0)||Date.parse(a.start)-Date.parse(b.start))};memo.set(key,value);return value;}
   return raw.map(x=>project(x.id)).filter(x=>x&&Number.isFinite(Date.parse(x.start))&&Date.parse(x.end)>Date.parse(x.start));
  }
  function items(){
   const all=allItems(),index=new Map(all.map(x=>[x.id,x])),contained=new Set(all.flatMap(x=>x.groupChildren||[]));while(groupTrail.length&&!index.get(groupTrail.at(-1))?.groupChildren){groupTrail.pop();groupReturnViews.pop();}
   const focus=index.get(groupTrail.at(-1)),roots=(focus?focus.groupChildren.map(key=>index.get(key)).filter(Boolean):all.filter(x=>!contained.has(x.id))).sort((a,b)=>(a.rowOrder||0)-(b.rowOrder||0)||Date.parse(a.start)-Date.parse(b.start)),shown=[],seen=new Set();let order=0;
   function show(item,depth=0){if(seen.has(item.id))return;seen.add(item.id);shown.push({...item,viewRowId:item.groupChildren?item.id:depth?'in:'+(item.rowId||item.id):item.rowId,viewOrder:order++,groupDepth:depth});if(item.groupChildren&&expandedGroups.has(item.id))for(const key of item.groupChildren){const child=index.get(key);if(child)show(child,depth+1);}}
   const reachable=new Set();function mark(item){if(reachable.has(item.id))return;reachable.add(item.id);for(const key of item.groupChildren||[]){const child=index.get(key);if(child)mark(child);}}for(const item of roots)mark(item);if(!focus)for(const item of all)if(!reachable.has(item.id)){roots.push(item);mark(item);}for(const item of roots)show(item);return shown;
  }
  const laneId=item=>item.viewRowId||item.rowId||item.id;
  // Running attempts stay with their owner. Completed attempts can move between stretches in a collapsed row.
  let taskLineCache=null;
  function taskFillsFor(item){
   const B=window.ProximaBlobTasks;
   const running=B?.runningFill(item,clockNow());
   if(!taskLineCache){taskLineCache=new Map((store.timelineRows?.()||[]).filter(r=>r.queueTaskLines&&Object.keys(r.queueTaskLines).length).map(r=>[r.id,r.queueTaskLines]));queueMicrotask(()=>taskLineCache=null);}
   const lines=taskLineCache.get(item.rowId);
   if(!lines)return [...(B?.fills(item)||[]),...(running?[running]:[])];
   const done=x=>(Array.isArray(x.tasks)?x.tasks:[]).filter(t=>t&&t.completedAt).map(t=>({id:t.id,start:Date.parse(t.startedAt),end:Date.parse(t.completedAt)})).filter(t=>Number.isFinite(t.start)&&t.end>t.start);
   const fills=[...done(item).filter(t=>!lines[t.id]),...items().filter(x=>x.rowId===item.rowId&&x.id!==item.id).flatMap(done).filter(t=>lines[t.id]===item.id)];
   if(running)fills.push(running);
   return fills;
  }
  // The underline stays fixed while task attempts rise out of it.
  function paintTaskFills(bar,item,paintLeft,paintRight,viewStart,viewScale,exposed){
   if(item.groupChildren||(item.queueId&&item.queueIndex>0)){
    bar.fillStretches=null;
    bar.taskFillLayer?.remove();
    bar.taskFillLayer=null;
    bar.classList.remove('exact-task-blob');
    return;
   }
   const color=item.color||'#a1cc43',width=Math.max(0,paintRight-paintLeft);
   const spans=taskFillsFor(item).map(fill=>({
    x0:geometry.position(fill.start,viewStart,viewScale)-paintLeft,
    x1:geometry.position(fill.end,viewStart,viewScale)-paintLeft
   })).sort((a,b)=>a.x0-b.x0);
   const shape=taskFillShape(spans,width);
   bar.fillStretches=shape.stretches;
   bar.classList.add('exact-task-blob');
   const viewWidth=Math.max(1,exposed.width),viewLeft=exposed.left-paintLeft;
   const lineStops=taskLineFade.map(([offset,opacity])=>
    'color-mix(in srgb, '+color+' '+opacity*100+'%, transparent) '+offset*100+'%'
   );
   bar.style.background=shape.path?'transparent':
    'linear-gradient(to right,'+lineStops.join(',')+') '+viewLeft+'px bottom/'+viewWidth+'px 1.5px no-repeat,transparent';
   if(!shape.path){bar.taskFillLayer?.setAttribute('hidden','');return;}
   if(!bar.taskFillLayer){
    const namespace='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(namespace,'svg'),path=document.createElementNS(namespace,'path');
    const defs=document.createElementNS(namespace,'defs'),gradient=document.createElementNS(namespace,'linearGradient');
    gradient.id='task-line-fade-'+(++timelineGradientId);
    gradient.setAttribute('gradientUnits','userSpaceOnUse');
    defs.append(gradient);
    svg.append(defs);
    path.setAttribute('fill','url(#'+gradient.id+')');
    bar.taskLineGradient=gradient;
    svg.classList.add('exact-task-fill');svg.setAttribute('preserveAspectRatio','none');
    svg.setAttribute('aria-hidden','true');
    path.setAttribute('fill-rule','evenodd');
    svg.append(path);
    bar.prepend(svg);
    bar.taskFillLayer=svg;
   }
   const svg=bar.taskFillLayer,path=svg.lastElementChild;
   svg.removeAttribute('hidden');
   const viewBox='0 0 '+width+' 42';
   if(svg.getAttribute('viewBox')!==viewBox)svg.setAttribute('viewBox',viewBox);
   if(path.getAttribute('d')!==shape.path)path.setAttribute('d',shape.path);
   const stops=taskLineStops(width,viewLeft,viewWidth,shape.lobes);
   const signature=color+'|'+stops.map(stop=>stop.join(':')).join(',');
   if(bar.taskLineGradient.paintSignature!==signature){
    const gradient=bar.taskLineGradient;
    gradient.setAttribute('x1','0');gradient.setAttribute('x2',String(width));
    gradient.setAttribute('y1','0');gradient.setAttribute('y2','0');
    while(gradient.children.length<stops.length)gradient.append(document.createElementNS(gradient.namespaceURI,'stop'));
    while(gradient.children.length>stops.length)gradient.lastElementChild.remove();
    stops.forEach(([offset,opacity],index)=>{
     const stop=gradient.children[index];
     stop.setAttribute('offset',String(offset));
     stop.setAttribute('stop-color',color);
     stop.setAttribute('stop-opacity',String(opacity));
    });
    gradient.paintSignature=signature;
   }
  }
  // The name inside a blob is light over the underline part and the contrast colour over fills.
  function paintCaption(caption,bar,base){
   if(!bar.fillStretches){caption.style.backgroundImage='';caption.style.webkitBackgroundClip='';caption.style.color='';return;}
   const contrast=bar.style.color||'#fff',stops=[];let cursor=0;for(const x of bar.fillStretches){stops.push(base+' '+cursor+'px',base+' '+x.x0+'px',contrast+' '+x.x0+'px',contrast+' '+x.x1+'px');cursor=x.x1;}stops.push(base+' '+cursor+'px',base+' 100%');
   caption.style.backgroundImage='linear-gradient(to right,'+stops.join(',')+')';caption.style.webkitBackgroundClip='text';caption.style.backgroundClip='text';caption.style.color='transparent';
  }
  // Retain each member’s placement for the expand and collapse animations.
  function packGroup(item,left,right){
   const spans=[];for(const child of item.groupLeaves){const a=Math.max(left,geometry.position(Date.parse(child.start),start,scale)),b=Math.min(right,geometry.position(child.followNow?clockNow():Date.parse(child.end),start,scale));if(b>a)spans.push({child,a,b,pieces:[]});}
   spans.sort((x,y)=>x.a-y.a||y.b-x.b);const laneEnds=[];for(const span of spans){let lane=laneEnds.findIndex(end=>end<=span.a+.01);if(lane<0)lane=laneEnds.length;laneEnds[lane]=span.b;span.lane=lane;}
   const cuts=[...new Set(spans.flatMap(x=>[x.a,x.b]))].sort((x,y)=>x-y);
   if(spans.length>160){for(const span of spans)span.pieces.push({x0:span.a,x1:span.b,top:span.lane/laneEnds.length,height:1/laneEnds.length});}
   else for(let i=0;i+1<cuts.length;i++){const x0=cuts[i],x1=cuts[i+1];if(x1-x0<.01)continue;const active=spans.filter(x=>x.a<=x0+.01&&x.b>=x1-.01).sort((x,y)=>x.lane-y.lane);if(!active.length)continue;
    active.forEach((span,index)=>{const top=index/active.length,height=1/active.length,last=span.pieces.at(-1);if(last&&Math.abs(last.x1-x0)<.02&&last.top===top&&last.height===height)last.x1=x1;else span.pieces.push({x0,x1,top,height});});
   }
   const placements=new Map();for(const span of spans){const home=span.pieces.reduce((best,piece)=>piece.x1-piece.x0>(best?best.x1-best.x0:-1)?piece:best,null)||{top:0,height:1};placements.set(span.child.id,{x0:span.a-left,x1:span.b-left,top:home.top,height:home.height});}
   return {spans,placements};
  }
  let strandPanStart=null,strandPanScale=null,strandPhase=0,strandEaseFrame=0;
  function advanceStrandPhase(){
   if(strandPanStart!==null&&strandPanScale===scale){
    // One cycle per 360 screen pixels. Vertical scroll and zoom do not advance it.
    const distance=(start-strandPanStart)*scale;
    strandPhase=(strandPhase+distance*Math.PI/180)%(2*Math.PI);
   }
   strandPanStart=start;
   strandPanScale=scale;
  }
  function renderGroupBands(bar,item,left,right,exposed){
   let layers=bar.querySelector('.exact-group-bands');
   if(!layers){
    layers=document.createElementNS('http://www.w3.org/2000/svg','svg');
    layers.classList.add('exact-group-bands');layers.setAttribute('preserveAspectRatio','none');
    layers.setAttribute('aria-hidden','true');
    bar.prepend(layers);
   }
   const packed=packGroup(item,left,right),width=Math.max(1,right-left),open=expandedGroups.has(item.id);
   const fade=taskLineFade.map(([offset,opacity])=>'rgb(0 0 0 / '+opacity+') '+offset*100+'%');
   layers.style.maskImage='linear-gradient(to right,'+fade.join(',')+')';
   layers.style.maskSize=Math.max(1,exposed.width)+'px 100%';
   layers.style.maskPosition=(exposed.left-left)+'px 0';
   layers.style.maskRepeat='no-repeat';
   bar.groupPlacements=packed.placements;
   bar.classList.toggle('is-group-open',open);
   const memberOrder=new Map(item.groupLeaves.map((member,index)=>[member.id,index]));
   // Lanes are shared among the strands on screen, in member order: when a member scrolls out of view the
   // others spread into its space, easing there over a few frames instead of jumping.
   const shown=packed.spans.map(span=>memberOrder.get(span.child.id)).sort((x,y)=>x-y),rank=new Map(shown.map((index,i)=>[index,i]));
   const laneCount=Math.min(Math.max(1,shown.length),10),lanes=bar.strandLanes||(bar.strandLanes=new Map());let easing=false;
   const strands=packed.spans.map(span=>{
    const index=memberOrder.get(span.child.id);
    const a=span.a-left,end=span.b-left,length=end-a;
    const target=21+(rank.get(index)%laneCount-(laneCount-1)/2)*Math.min(3.4,24/Math.max(1,laneCount-1));
    const previous=lanes.get(span.child.id);
    let laneY=previous===undefined||reducedMotion()?target:previous+(target-previous)*.2;
    if(Math.abs(target-laneY)<.05)laneY=target;else easing=true;
    lanes.set(span.child.id,laneY);
    // All lanes share a shallow wave. Their spacing stays constant, even when
    // the viewport clips a member or several members end at the same time.
    const frequency=2*Math.PI/360,phase=reducedMotion()?0:strandPhase;
    const angle=x=>(left+x)*frequency+phase;
    const y=x=>laneY+2.4*Math.sin(angle(x));
    const slope=x=>2.4*frequency*Math.cos(angle(x));
    const curve=['M',a,y(a)],line=['M',a,41];
    const steps=Math.max(1,Math.ceil(length/75));
    for(let i=0;i<steps;i++){
     const x0=a+length*i/steps,x1=a+length*(i+1)/steps,third=(x1-x0)/3;
     curve.push('C',x0+third,y(x0)+slope(x0)*third,x1-third,y(x1)-slope(x1)*third,x1,y(x1));
     line.push('C',x0+third,41,x1-third,41,x1,41);
    }
    return {d:curve.join(' '),flat:line.join(' '),color:span.child.color||'#a1cc43',a,end,
     taper:Math.min(30,length*.45),fadeStart:span.a>left,fadeEnd:span.b<right};
   });
   if(easing&&!strandEaseFrame)strandEaseFrame=requestAnimationFrame(()=>{strandEaseFrame=0;render();});
   const signature=JSON.stringify([width,open,strands]);
   const changedMode=layers.wasOpen!==undefined&&layers.wasOpen!==open;
   layers.wasOpen=open;
   if(layers.paintSignature===signature)return;
   layers.paintSignature=signature;
   layers.setAttribute('viewBox','0 0 '+width+' 42');
   layers.replaceChildren();
   if(!strands.length||(open&&!changedMode))return;
   const namespace=layers.namespaceURI,defs=document.createElementNS(namespace,'defs');
   layers.append(defs);
   for(const {d,flat,color,a,end,taper,fadeStart,fadeEnd} of strands){
    const path=document.createElementNS(namespace,'path');
    path.setAttribute('d',open?flat:d);
    if(open)path.style.opacity='0';
    path.setAttribute('stroke',color);
    if(fadeStart||fadeEnd){
     const gradient=document.createElementNS(namespace,'linearGradient');
     gradient.id='group-strand-fade-'+(++timelineGradientId);
     gradient.setAttribute('gradientUnits','userSpaceOnUse');
     gradient.setAttribute('x1',String(a));gradient.setAttribute('x2',String(end));
     gradient.setAttribute('y1','0');gradient.setAttribute('y2','0');
     const fraction=taper/(end-a);
     for(const [offset,opacity] of [[0,fadeStart?0:1],[fraction,1],[1-fraction,1],[1,fadeEnd?0:1]]){
      const stop=document.createElementNS(namespace,'stop');
      stop.setAttribute('offset',String(offset));
      stop.setAttribute('stop-color',color);
      stop.setAttribute('stop-opacity',String(opacity));
      gradient.append(stop);
     }
     defs.append(gradient);
     path.setAttribute('stroke','url(#'+gradient.id+')');
    }
    layers.append(path);
    if(changedMode&&!reducedMotion()){
     path.animate([{d:'path("' +(open?d:flat)+'")',opacity:open?1:0},{d:'path("' +(open?flat:d)+'")',opacity:open?0:1}],MOTION);
    }
   }
  }
  const groupConnectors=new Map();
  function drawGroupConnectors(rows,exposed,width){
   const live=new Set(),colors=[];
   rows.forEach((row,index)=>{
    if(!row.groupChildren||!expandedGroups.has(row.id))return;
    let end=index;
    while(end+1<rows.length&&(rows[end+1].groupDepth||0)>(row.groupDepth||0))end++;
    if(end===index)return;
    const label=outsideNames.get(row.id),bar=bars.get(row.id);
    if(!label||!bar)return;
    const depth=row.groupDepth||0,gutter=Math.max(8,exposed.left+8)+depth*9;
    const labelRight=parseFloat(label.style.left)+label.nameWidth;
    const x=Math.min(exposed.right-10,Math.max(gutter+42,labelRight+12));
    if(x<=gutter+12)return;
    const y=parseFloat(bar.style.top),base=y+43;
    const last=bars.get(rows[end].id);
    const bottom=last?parseFloat(last.style.top)+49:base+(end-index)*ROW+6;
    const tail=Math.min(exposed.right-10,gutter+145);
    const turn=Math.min(24,Math.max(0,tail-gutter));
    const dx=x-(exposed.left+exposed.width/2),dy=y-tracks.scrollTop-tracks.clientHeight/2;
    // Match As you Go's folder palette: position-derived hue and 45° separation nearby.
    let hue=((Math.atan2(dy,dx)*180/Math.PI+Math.hypot(dx,dy)*120/500)%360+360)%360;
    const nearby=colors.filter(other=>Math.abs(other.y-y)<220);
    for(let attempt=0;attempt<8&&nearby.some(other=>Math.abs((hue-other.hue+540)%360-180)<44.99);attempt++)
     hue=(hue+45)%360;
    colors.push({y,hue});
    let svg=groupConnectors.get(row.id);
    if(!svg){
     svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
     svg.classList.add('exact-group-connector');
     svg.setAttribute('aria-hidden','true');
     const path=document.createElementNS(svg.namespaceURI,'path');
     path.setAttribute('pathLength','1');
     path.setAttribute('stroke-dasharray','1');
     svg.append(path);
     tracks.prepend(svg);
     groupConnectors.set(row.id,svg);
     if(!reducedMotion()){
      // Draws in while fading in; retracting plays it backwards, so it also fades out.
      const drawing=path.animate([{strokeDashoffset:'1',opacity:0},{strokeDashoffset:'0',opacity:.8}],{...MOTION,easing:'linear',fill:'both'});
      svg.groupDrawing=drawing;
      drawing.onfinish=()=>{
       if(!svg.retiring)return;
       svg.remove();
       if(groupConnectors.get(row.id)===svg)groupConnectors.delete(row.id);
      };
     }
    }
    if(svg.retiring){
     svg.retiring=false;
     svg.groupDrawing?.reverse();
    }
    const height=Math.max(1,bottom-y+2);
    svg.style.top=y+'px';svg.style.height=height+'px';
    svg.setAttribute('viewBox','0 0 '+width+' '+height);
    const path=svg.firstElementChild;
    path.setAttribute('stroke','oklch(68% 0.18 '+hue+'deg)');
    path.setAttribute('d',['M',x,8,'C',x-5,34,x-8,43,x-42,43,
     'H',gutter+24,'Q',gutter,43,gutter,67,'V',bottom-y-17,
     'Q',gutter,bottom-y,gutter+turn,bottom-y,'H',tail].join(' '));
    live.add(row.id);
   });
   for(const [id,svg] of groupConnectors){
    if(live.has(id)||svg.retiring)continue;
    if(!svg.groupDrawing||reducedMotion()){
     svg.remove();
     groupConnectors.delete(id);
    }else{
     svg.retiring=true;
     svg.groupDrawing.reverse();
    }
   }
  }
  // Group motion: expanding drops members out of the body into their rows, collapsing pushes them
  // back in, entering a group flies its members to the top. Transform-only Web Animations, so the
  // render loop keeps owning positions and nothing is written.
  const reducedMotion=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const MOTION={duration:380,easing:'cubic-bezier(.2,.8,.2,1)'};
  function barRects(){const out=new Map();for(const [id,bar] of bars)if(bar.isConnected)out.set(id,bar.getBoundingClientRect());return out;}
  function nameRects(){const out=new Map();for(const [id,node] of outsideNames)if(node.isConnected&&!node.hidden)out.set(id,node.getBoundingClientRect());return out;}
  // Where each member sits inside a group's body, on screen.
  function groupPieceRects(groupId){const bar=bars.get(groupId);if(!bar?.isConnected)return {group:null,pieces:new Map()};const box=bar.getBoundingClientRect(),pieces=new Map();for(const [id,p] of bar.groupPlacements||[])pieces.set(id,{left:box.left+p.x0,top:box.top+p.top*box.height,width:Math.max(2,p.x1-p.x0),height:Math.max(2,p.height*box.height)});return {group:box,pieces};}
  function memberRect(item,pieces,group){if(!item)return group;if(pieces.has(item.id))return pieces.get(item.id);const own=(item.groupLeaves||[]).map(x=>pieces.get(x.id)).filter(Boolean);if(own.length){const l=Math.min(...own.map(r=>r.left)),t=Math.min(...own.map(r=>r.top)),r=Math.max(...own.map(r=>r.left+r.width)),b=Math.max(...own.map(r=>r.top+r.height));return {left:l,top:t,width:r-l,height:b-t};}return group;}
  const toTransform=(from,to)=>'translate('+(from.left-to.left)+'px,'+(from.top-to.top)+'px) scale('+Math.max(.02,from.width/Math.max(1,to.width))+','+Math.max(.02,from.height/Math.max(1,to.height))+')';
  // A live node arriving: it starts where `from` is and settles into place.
  function arrive(node,from,{delay=0}={}){const to=node.getBoundingClientRect();if(!from||!to.width||!to.height)return;node.animate([{transformOrigin:'0 0',transform:toTransform(from,to),opacity:.6},{transformOrigin:'0 0',transform:'none',opacity:1}],{...MOTION,delay,fill:'backwards'});}
  // A copy of a departing node travels from where it was into `to`, then goes.
  function depart(bar,from,to){if(!from)return;const copy=bar.cloneNode(true);copy.removeAttribute('data-interval-id');copy.removeAttribute('data-id');copy.classList.add('exact-group-ghost');copy.style.pointerEvents='none';copy.style.zIndex='6';tracks.append(copy);const keyframes=to?[{transformOrigin:'0 0',transform:'none',opacity:1},{transformOrigin:'0 0',transform:'translate('+(to.left-from.left)+'px,'+(to.top-from.top)+'px) scale('+Math.max(.02,to.width/Math.max(1,from.width))+','+Math.max(.02,to.height/Math.max(1,from.height))+')',opacity:.85}]:[{transform:'none',opacity:1},{transform:'scale(.97)',opacity:0}];const anim=copy.animate(keyframes,{...(to?MOTION:{duration:240,easing:'ease-in'}),fill:'forwards'});anim.onfinish=anim.oncancel=()=>copy.remove();}
  function slide(before,beforeNames){for(const [id,bar] of bars){const old=before.get(id);if(!old)continue;const dy=old.top-bar.getBoundingClientRect().top;if(Math.abs(dy)>.5)bar.animate([{transform:'translateY('+dy+'px)'},{transform:'none'}],MOTION);}for(const [id,node] of outsideNames){const old=beforeNames.get(id);if(!old||node.hidden)continue;const dy=old.top-node.getBoundingClientRect().top;if(Math.abs(dy)>.5)node.animate([{transform:'translateY('+dy+'px)'},{transform:'none'}],MOTION);}}
  function fadeIn(nodes,delay){for(const node of nodes)node.animate([{opacity:0},{opacity:1}],{duration:240,delay,fill:'backwards'});}
  function toggleGroup(groupId,opening,apply){
   if(reducedMotion()){apply();saveGroupExpansion();refresh();return;}
   const before=barRects(),beforeNames=nameRects(),{group,pieces}=groupPieceRects(groupId);
   const shown=new Map([...bars].map(([id,bar])=>[id,{bar,item:bar.interval}]));
   apply();saveGroupExpansion();refresh();
   if(opening){let index=0;for(const [id,bar] of bars)if(!before.has(id))arrive(bar,memberRect(bar.interval,pieces,group),{delay:Math.min(120,index++*14)});fadeIn([...outsideNames].filter(([id,node])=>!beforeNames.has(id)&&!node.hidden).map(([,node])=>node),MOTION.duration*.7);slide(before,beforeNames);return;}
   const target=groupPieceRects(groupId);
   for(const [id,entry] of shown)if(!bars.has(id))depart(entry.bar,before.get(id),memberRect(entry.item,target.pieces,target.group));
   slide(before,beforeNames);
  }
  // Entering a group: everything else fades away and the members fly from their place in the body
  // to their rows at the top. Leaving (the breadcrumb) reverses it into the group we came out of.
  function enterWithMotion(id){
   if(reducedMotion()){enterGroup(id);return;}
   const {group,pieces}=groupPieceRects(id),before=barRects(),others=[...bars].filter(([key])=>key!==id).map(([key,bar])=>({bar,rect:before.get(key)}));
   enterGroup(id);for(const entry of others)depart(entry.bar,entry.rect,null);
   let index=0;for(const bar of bars.values())arrive(bar,memberRect(bar.interval,pieces,group),{delay:40+Math.min(160,index++*22)});
   fadeIn([...outsideNames.values()].filter(node=>!node.hidden),MOTION.duration*.6);
  }
  function leaveTo(depth){
   if(depth>=groupTrail.length)return;const exited=groupTrail[depth];
   const leaving=reducedMotion()?[]:[...bars.values()].map(bar=>({bar,item:bar.interval,rect:bar.getBoundingClientRect()}));
   let view=null;while(groupTrail.length>depth){groupTrail.pop();view=groupReturnViews.pop()||view;}
   if(view){start=view.start;scale=view.scale;}selected.clear();refresh();if(view)tracks.scrollTop=view.scrollTop;
   if(!leaving.length)return;const target=groupPieceRects(exited);
   for(const entry of leaving)depart(entry.bar,entry.rect,target.group?memberRect(entry.item,target.pieces,target.group):null);
   fadeIn([...bars].filter(([key])=>key!==exited).map(([,bar])=>bar),MOTION.duration*.5);
   fadeIn([...outsideNames.values()].filter(node=>!node.hidden),MOTION.duration*.6);
  }
  function selectionPayload(){const all=allItems();return {intervalIds:[...selected],revisions:Object.fromEntries(all.map(x=>[x.id,x.rev]))};}
  function enterGroup(id){const group=allItems().find(x=>x.id===id&&x.groupChildren);if(!group)return;groupReturnViews.push({start,scale,scrollTop:tracks.scrollTop});groupTrail.push(id);const a=Date.parse(group.start),b=Date.parse(group.end);scale=Math.max(1e-10,Math.min(1,(element.clientWidth-60)/Math.max(1,b-a)));start=a-30/scale;selected.clear();refresh();tracks.scrollTop=0;}
  function render(){
   {const day=86400000*scale,t=Math.max(0,Math.min(1,(day-3)/15));ROW=Math.round(14+46*t);const next=ROW<40;if(next!==far){far=next;element.classList.toggle('exact-far',far);}element.style.setProperty('--exact-blob-height',Math.min(42,ROW-4)+'px');}
   renderSelectionActions();
   const width=element.clientWidth;if(!width)return;const renderBaseColor=getComputedStyle(element).color||'#e4e7ec';
   const activeTicks=new Set(),activeBars=new Set();
   const visibleEnd=start+width/scale;
   const presented=ordered(),laneMap=new Map(presented.map((row,index)=>[laneId(row),index]));laneCount=presented.length;for(const entry of layout)entry.lane=laneMap.get(laneId(entry.item))??-1;
   advanceStrandPhase();
   const exposed=availableViewport();actions.style.right=Math.max(0,width-exposed.right)+'px';
   const gradientDayWidth=86400000*scale,dayColorVisibility=Math.max(0,Math.min(1,(gradientDayWidth-240)/160));element.style.setProperty('--day-color-visibility',String(dayColorVisibility));dateStrip.classList.toggle('has-day-gradient',gradientDayWidth>240);if(gradientDayWidth>240){const midnight=Math.floor((start+7*3600000)/86400000)*86400000-7*3600000;dateStrip.style.backgroundSize=gradientDayWidth+'px 100%';dateStrip.style.backgroundPosition=geometry.position(midnight,start,scale)+'px 0';}else{dateStrip.style.backgroundSize='';dateStrip.style.backgroundPosition='';}
   renderHorizontalSchedule();drawQueues();
   const step=steps.find(x=>x*scale>=100)||steps.at(-1)*Math.ceil(100/(steps.at(-1)*scale));
   const day=86400000,offset=7*3600000,dateStep=day*Math.max(1,Math.ceil(60/(day*scale))),activeDates=new Set();
   const localStart=new Date(start+offset),activeMonths=new Set();currentYear.textContent=String(localStart.getUTCFullYear());let year=localStart.getUTCFullYear(),month=localStart.getUTCMonth();
   for(let count=0;count<5000;count++){const t=Date.UTC(year,month,1)-offset,end=Date.UTC(year,month+1,1)-offset;if(t>=visibleEnd)break;const key=String(t);activeMonths.add(key);let group=months.get(key);if(!group){const label=document.createElement('span'),divider=document.createElement('span');label.className='exact-month-label';divider.className='exact-month-divider';monthStrip.append(label);element.append(divider);group={label,divider};months.set(key,group);}const left=Math.max(0,geometry.position(t,start,scale)),right=Math.min(width,geometry.position(end,start,scale));group.label.dataset.time=String(t);group.label.style.left=left+'px';group.label.style.width=(right-left)+'px';if(!group.label.textContent)group.label.textContent=new Date(t).toLocaleDateString('en-GB',{timeZone:'Asia/Ho_Chi_Minh',month:'short'}).toUpperCase();group.divider.classList.toggle('exact-year-divider',month===0);group.divider.textContent=month===0?String(year):'';group.divider.style.left=geometry.position(t,start,scale)+'px';group.divider.hidden=t<start;month++;if(month===12){year++;month=0;}}
   for(const [key,group] of months){if(!activeMonths.has(key)){group.label.remove();group.divider.remove();months.delete(key);}}
   for(let t=Math.floor((start+offset)/dateStep)*dateStep-offset;t<visibleEnd;t+=dateStep){const key=String(t);activeDates.add(key);let cell=dates.get(key);if(!cell){cell=DateStrip.create(t);dates.set(key,cell);dateStrip.append(cell);}else DateStrip.update(cell,t);const left=Math.max(0,geometry.position(t,start,scale)),right=Math.min(width,geometry.position(t+dateStep,start,scale));cell.style.left=left+'px';cell.style.width=(right-left)+'px';const weekday=right-left>=80?cell.dateStripDate.weekday:cell.dateStripDate.weekday[0];if(cell.lastChild.textContent!==weekday)cell.lastChild.textContent=weekday;}
   for(const [key,cell] of dates){if(!activeDates.has(key)){cell.remove();dates.delete(key);}}
   for(let t=Math.ceil(start/step)*step;t<=start+Math.max(0,width-132)/scale;t+=step){const key=String(t);activeTicks.add(key);let mark=ticks.get(key),line=lines.get(key);if(!mark){mark=document.createElement('span');mark.className='exact-tick';ruler.append(mark);ticks.set(key,mark);line=document.createElement('span');line.className='exact-gridline';tracks.append(line);lines.set(key,line);}mark.style.left=geometry.position(t,start,scale)+'px';mark.textContent=label(t);mark.dataset.hour=String(new Date(t+7*3600000).getUTCHours());line.style.left=mark.style.left;}
   for(const [key,mark] of ticks){if(!activeTicks.has(key)){mark.remove();lines.get(key).remove();ticks.delete(key);lines.delete(key);}}
   let lo=0,hi=layout.length;while(lo<hi){const mid=(lo+hi)>>>1;if(layout[mid].maxEnd<start)lo=mid+1;else hi=mid;}
   for(let index=0;index<layout.length;index++){const entry=layout[index];const {item,a,b,lane}=entry;if(lane<0)continue;if(a>visibleEnd&&layout.some(x=>(x.item.rowId||x.item.id)===(item.rowId||item.id)&&x.a>=visibleEnd&&x.a<a))continue;if(!item.followNow&&b<start&&(20+lane*ROW+42<tracks.scrollTop||20+lane*ROW>tracks.scrollTop+tracks.clientHeight))continue;
    activeBars.add(item.id);let bar=bars.get(item.id);const placeholder=!!item.queueId&&item.queueIndex>0,running=!!item.queueId&&item.queueIndex===0;if(bar&&(!!bar.queuePlaceholder!==placeholder||!!bar.queueRunning!==running)){bar.remove();bars.delete(item.id);bar=null;}if(!bar&&running){bar=createRunningQueueBlob();tracks.append(bar);bars.set(item.id,bar);}if(!bar&&placeholder){bar=createQueuePlaceholder(item);tracks.append(bar);bars.set(item.id,bar);}
    if(!bar){bar=document.createElement('div');bar.className='exact-interval'+(element.classList.contains('exact-animating')?' exact-entering':'');bar.dataset.intervalId=item.id;bar.tabIndex=0;bar.setAttribute('role','button');const caption=document.createElement('span');caption.className='exact-interval-caption';bar.append(caption);for(const edge of ['start','end']){const handle=document.createElement('span');handle.className='exact-resize-edge exact-resize-'+edge;handle.dataset.edge=edge;handle.removeAttribute('title');handle.addEventListener('pointerdown',event=>beginResize(event,bar,edge));handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(suppressClick||performance.now()<ignoreClickUntil){suppressClick=false;return;}editEdge(bar.interval.id,edge,event);});if(edge==='end'){handle.addEventListener('dblclick',event=>toggleLive(event,bar));handle.addEventListener('pointerdown',event=>{if(event.button===1){event.preventDefault();event.stopPropagation();}});handle.addEventListener('auxclick',async event=>{if(event.button!==1)return;event.preventDefault();event.stopPropagation();const item=bar.interval;if(item.queueId)return;const result=await store.command({type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:item.id,patch:{followNow:!item.followNow,...(!item.followNow?{checked:false}:{}),end:new Date(Math.max(Date.parse(item.start)+1,clockNow())).toISOString()}}});if(!result.ok)error.textContent=result.code;refresh();});}bar.append(handle);}bar.addEventListener('pointermove',event=>showBlobName(bar,event));bar.addEventListener('pointerleave',()=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});bar.addEventListener('pointerdown',e=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');beginReorder(e,bar);});bar.addEventListener('click',e=>{e.stopPropagation();if(e.target.closest?.('.exact-resize-edge,input')||performance.now()<ignoreClickUntil)return;if(suppressClick){suppressClick=false;return;}selectRow(bar.interval.id,e);});bar.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();if(bar.interval.groupChildren)bar.querySelector('.exact-group-count')?.click();else pickColor(bar,e);});bar.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();open(bar.interval);}});tracks.append(bar);bars.set(item.id,bar);}
    bar.classList.toggle('exact-blob-group',!!item.groupChildren);bar.classList.toggle('is-color-editing',pickerIds.has(item.id));renderUnlink(bar,item);bar.classList.toggle('is-task-blob',!!item.taskBlob);outsideNames.get(item.id)?.classList.toggle('is-task-blob',!!item.taskBlob);bar.classList.toggle('is-checked',!!item.checked);bar.classList.toggle('is-renaming',inlineEditor?.intervalId===item.id);bar.dataset.id=item.id;bar.classList.add('exact-selectable');bar.classList.toggle('is-selected',selected.has(item.id));bar.interval=item;renderTemplateControl(bar,item);bar.classList.toggle('exact-queued',!!item.queueId&&item.queueIndex>0);bar.classList.toggle('exact-queue-active',!!item.queueId&&item.queueIndex===0);
    const actual=queueBoundaryPreview?.get(item.id)||(resizing?.id===item.id?(resizing.edge==='start'&&item.followNow?{...resizing,end:Math.max(resizing.start+1,clockNow())}:resizing):{start:a,end:item.followNow?Math.max(a+1,clockNow()):item.groupLive?Math.max(b,clockNow()):b});bar.classList.toggle('exact-follows-now',!!item.followNow);bar.style.background=item.queueId&&item.queueIndex>0?'transparent':item.color||'#a1cc43';const rgb=(item.color||'#a1cc43').slice(1);const brightness=.299*parseInt(rgb.slice(0,2),16)+.587*parseInt(rgb.slice(2,4),16)+.114*parseInt(rgb.slice(4,6),16);bar.style.color=item.queueId&&item.queueIndex>0?'#e4e7ec':brightness>145?'#17210d':'#fff';
    const rawLeft=geometry.position(actual.start,start,scale),rawRight=geometry.position(actual.end,start,scale),paintLeft=Math.max(-2,Math.min(width+2,rawLeft)),paintRight=Math.max(-2,Math.min(width+2,rawRight));bar.style.left=paintLeft+'px';bar.style.width=Math.max(0,paintRight-paintLeft)+'px';bar.dataset.trueLeft=String(rawLeft);bar.dataset.trueRight=String(rawRight);bar.dataset.offscreen=rawRight<=0||rawLeft>=width?'1':'';const startHandle=bar.querySelector('.exact-resize-start'),endHandle=bar.querySelector('.exact-resize-end');if(startHandle)startHandle.hidden=!!item.groupChildren||rawLeft<0;if(endHandle)endHandle.hidden=!!item.groupChildren||rawRight>width;bar.classList.toggle('has-clipped-end',rawRight>width);paintTaskFills(bar,item,paintLeft,paintRight,start,scale,exposed);bar.style.top=(20+(lane+(draftIndex!==null&&lane>=draftIndex?1:0))*ROW)+'px';
    const nextEntry=layout.find(x=>(x.item.rowId||x.item.id)===(item.rowId||item.id)&&x.a>a);const deadline=Math.min(deadlineResize?.id===item.id?deadlineResize.time:Date.parse(item.deadline),nextEntry?.a??Infinity),nowTime=clockNow();let outline=deadlines.get(item.id);if(item.followNow&&Number.isFinite(deadline)&&deadline>nowTime){if(!outline){outline=document.createElement('div');outline.className='exact-deadline';const grab=document.createElement('span');grab.className='exact-deadline-edge';grab.title='Drag deadline';grab.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();confirmQueueDelete(null,event,items().find(x=>x.id===item.id));});grab.addEventListener('pointerdown',event=>beginDeadline(event,item.id));grab.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(performance.now()<ignoreClickUntil)return;editEdge(item.id,'deadline',event);});outline.append(grab);tracks.append(outline);deadlines.set(item.id,outline);}const deadlineLeft=Math.max(-2,Math.min(width+2,geometry.position(nowTime,start,scale))),deadlineRight=Math.max(-2,Math.min(width+2,geometry.position(deadline,start,scale)));outline.style.left=deadlineLeft+'px';outline.style.width=Math.max(0,deadlineRight-deadlineLeft)+'px';outline.firstChild.hidden=geometry.position(deadline,start,scale)>width||geometry.position(deadline,start,scale)<0;outline.style.top=bar.style.top;outline.title='Deadline '+new Date(deadline).toLocaleString('en-GB',{timeZone:'Asia/Ho_Chi_Minh'});}else if(outline){outline.remove();deadlines.delete(item.id);}
    if(item.groupChildren)renderGroupBands(bar,item,paintLeft,paintRight,exposed);const caption=bar.querySelector('.exact-interval-caption');renderName(caption,item);paintCaption(caption,bar,renderBaseColor);const visibleLeft=Math.max(0,geometry.position(actual.start,start,scale)),visibleRight=Math.min(width,geometry.position(actual.end,start,scale));caption.style.marginLeft='0px';caption.style.maxWidth=Math.max(0,visibleRight-visibleLeft-18)+'px';const behind=geometry.position(actual.end,start,scale)<=0,ahead=geometry.position(actual.start,start,scale)>=width;const superseded=behind&&layout.some(x=>(x.item.rowId||x.item.id)===(item.rowId||item.id)&&!(x.item.queueId&&x.item.queueIndex>0)&&x.a>a&&(x.item.followNow?clockNow():x.b)<=start);const nameFits=measureName(item.name)+44<=Math.max(0,visibleRight-visibleLeft-18);bar.nameHidden=placeholder&&!nameFits&&!behind&&!ahead;bar.setAttribute('aria-label',item.name);const needsOutside=!placeholder&&!superseded&&(!(behind||ahead)||!!item.followNow||!!item.groupLive);let outside=outsideNames.get(item.id);if(needsOutside){if(!outside){outside=document.createElement('div');outside.tabIndex=0;outside.setAttribute('role','button');outside.className='exact-outside-name'+(element.classList.contains('exact-animating')?' exact-entering':'');outside.addEventListener('pointerdown',event=>{const bar=bars.get(outside.interval.id);if(bar)beginReorder(event,bar);});outside.addEventListener('contextmenu',event=>{if(!outside.interval?.groupChildren)return;event.preventDefault();event.stopPropagation();open(outside.interval);});/* right-clicking a group's name renames it */outside.addEventListener('click',event=>{event.stopPropagation();if(performance.now()<ignoreClickUntil)return;selectRow(outside.interval.id,event);});tracks.append(outside);outsideNames.set(item.id,outside);}if(!outside.hoverBound){outside.hoverBound=true;outside.addEventListener('pointermove',event=>{const x=event.clientX-element.getBoundingClientRect().left,rowId=outside.interval.rowId||outside.interval.id;const covered=[...bars.values()].find(node=>(node.interval.rowId||node.interval.id)===rowId&&x>=parseFloat(node.style.left)&&x<=parseFloat(node.style.left)+parseFloat(node.style.width));if(covered?.nameHidden)showBlobName(covered,event);});outside.addEventListener('pointerleave',()=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});}outside.hidden=false;outside.interval=item;outside.classList.toggle('is-selected',selected.has(item.id));outside.classList.toggle('is-renaming',inlineEditor?.intervalId===item.id);renderName(outside,item);if(bar.dataset.offscreen==='1'){renderTemplateControl(outside,item,{onlyWithFolder:true});bar.querySelector('.exact-blob-content')?.remove();}else outside.querySelector('.exact-blob-content')?.remove();outside.removeAttribute('title');if(item.sourceFollowing)outside.title=(item.sourceLive?'Following live source ':'Saved source snapshot ')+item.sourceOwner;outside.style.top=bar.style.top;outside.style.left=(ahead?Math.max(4,width-280):4)+'px';const firstVisible=layout.filter(x=>(x.item.rowId||x.item.id)===(item.rowId||item.id)&&x.a>=start&&x.a<visibleEnd).reduce((left,x)=>Math.min(left,geometry.position(x.a,start,scale)),width);outside.style.width=(ahead?Math.min(276,width-8):behind?Math.max(0,Math.min(276,firstVisible-12)):Math.max(0,visibleLeft-12))+'px';outside.style.maxWidth='none';outside.style.width='max-content';outside.style.paddingLeft=behind?'30px':'4px';const nameWidth=measureName(item.name)+(behind?54:28);outside.nameWidth=nameWidth;const nameLeft=item.groupChildren&&!behind&&!ahead?Math.max(4,(visibleLeft+visibleRight-nameWidth)/2):ahead?Math.max(4,width-nameWidth-30):behind?4:nameFits?visibleLeft+8:Math.max(4,visibleLeft-nameWidth-12);outside.style.left=Math.max(nameLeft,item.groupDepth?exposed.left+10+item.groupDepth*9:0)+'px';outside.style.textAlign='left';/* A name that does not fit a non-live blob stays inside that blob, clipped, instead of spilling past its end. */const clipName=!item.followNow&&!item.groupLive&&!item.groupChildren&&!behind&&!ahead&&!nameFits;if(clipName){const clipped=Math.max(0,visibleRight-visibleLeft-12);outside.style.left=(visibleLeft+8)+'px';outside.style.width=clipped+'px';outside.nameWidth=clipped;}outside.style.overflow=clipName?'hidden':'';outside.classList.toggle('is-checked',!!item.checked);outside.hidden=false;caption.style.visibility=outside.hidden?'visible':'hidden';}else{outside?.remove();outsideNames.delete(item.id);caption.style.visibility=(behind||ahead)&&!item.followNow?'hidden':'visible';}if(bar.queuePlaceholder){const seam=bar.querySelector('.exact-queue-boundary');seam.hidden=rawRight>width||rawRight<0||!layout.some(x=>x.item.queueId===item.queueId&&x.item.queueIndex===item.queueIndex+1);}if(bar.nameHidden)caption.style.visibility='hidden';bar.removeAttribute('title');if(item.sourceFollowing)bar.title=(item.sourceLive?'Following live source ':'Saved source snapshot ')+item.sourceOwner;
   }
   for(const [id,bar] of bars){if(!activeBars.has(id)){retire(bar);bars.delete(id);deadlines.get(id)?.remove();deadlines.delete(id);retire(outsideNames.get(id));outsideNames.delete(id);}}
   const labelOwners=new Map();for(const [id,node] of outsideNames){if(node.hidden)continue;const entry=layout.find(x=>x.item.id===id);if(!entry||(entry.item.followNow?clockNow():entry.b)>start)continue;const key=entry.item.rowId||id,previous=labelOwners.get(key);if(!previous||entry.a>previous.a){if(previous)outsideNames.get(previous.item.id).hidden=true;labelOwners.set(key,entry);}else node.hidden=true;}
   const crowded=layout.map(entry=>{const bar=bars.get(entry.item.id);if(!bar)return null;const left=Math.max(0,parseFloat(bar.style.left)),right=Math.min(width,parseFloat(bar.style.left)+parseFloat(bar.style.width));return {entry,bar,left,right};}).filter(x=>x&&x.right>x.left);
   for(const current of crowded){if(current.bar.queueRunning||current.right-current.left>36)continue;const near=crowded.some(other=>other!==current&&!(other.bar.queuePlaceholder&&other.right-other.left>36)&&(other.entry.item.rowId||other.entry.item.id)===(current.entry.item.rowId||current.entry.item.id)&&Math.max(current.left,other.left)-Math.min(current.right,other.right)<24);if(!near)continue;current.bar.nameHidden=true;current.bar.querySelector('.exact-interval-caption').style.visibility='hidden';const outside=outsideNames.get(current.entry.item.id);if(outside)outside.hidden=true;}
   // A neighboring name must never masquerade as the current blob's own label.
   for(const [id,label] of outsideNames){if(label.hidden)continue;const owner=bars.get(id);if(!owner)continue;const rect={left:parseFloat(label.style.left),right:parseFloat(label.style.left)+label.nameWidth},row=owner.interval.rowId||owner.interval.id;const intrudes=[...bars.values()].some(other=>{if(other===owner||(other.interval.rowId||other.interval.id)!==row||other.queuePlaceholder)return false;const box={left:parseFloat(other.style.left),width:parseFloat(other.style.width)};box.right=box.left+box.width;return box.width>0&&rect.left<box.right&&rect.right>box.left;});if(intrudes&&!owner.queueRunning){label.hidden=true;owner.nameHidden=true;owner.querySelector('.exact-interval-caption').style.visibility='hidden';}}
   // Later sessions own contested label space within their row.
   const occupiedNames=new Map();for(const entry of [...layout].sort((x,y)=>Number(!!y.item.queueId&&y.item.queueIndex===0)-Number(!!x.item.queueId&&x.item.queueIndex===0)||y.a-x.a)){const outside=outsideNames.get(entry.item.id),bar=bars.get(entry.item.id),caption=bar?.querySelector('.exact-interval-caption');const node=outside&&!outside.hidden?outside:caption;if(!node||!bar||bar.nameHidden)continue;const nameLeft=node===outside?parseFloat(outside.style.left):Math.max(0,parseFloat(bar.style.left))+12,nameWidth=node===outside?outside.nameWidth:measureName(entry.item.name),rect={left:nameLeft,right:nameLeft+nameWidth,width:nameWidth};if(!rect.width||rect.right<=0||rect.left>=width)continue;const row=laneId(entry.item),previous=occupiedNames.get(row)||[];if(previous.some(r=>rect.left<r.right&&rect.right>r.left)){bar.nameHidden=true;if(node===outside)outside.hidden=true;else caption.style.visibility='hidden';}else previous.push(rect);occupiedNames.set(row,previous);}
   for(const [id,label] of outsideNames){if(label.hidden)continue;const entry=layout.find(x=>x.item.id===id);if(!entry)continue;const nameLeft=parseFloat(label.style.left),nameWidth=label.nameWidth,base=renderBaseColor,fills=layout.filter(x=>(x.item.rowId||x.item.id)===(entry.item.rowId||entry.item.id)).map(x=>bars.get(x.item.id)).filter(node=>node&&!node.queuePlaceholder).flatMap(node=>{const barLeft=parseFloat(node.style.left);if(node.interval.groupChildren)return [];if(node.fillStretches)return node.fillStretches.map(x=>({left:Math.max(0,barLeft+x.x0-nameLeft),right:Math.min(nameWidth,barLeft+x.x1-nameLeft),color:node.style.color||'#fff'}));return [{left:Math.max(0,barLeft-nameLeft),right:Math.min(nameWidth,barLeft+parseFloat(node.style.width)-nameLeft),color:node.style.color||'#fff'}];}).filter(x=>x.right>x.left).sort((a,b)=>a.left-b.left);const stops=[];let cursor=0;for(const fill of fills){const left=Math.max(cursor,fill.left);if(fill.right<=left)continue;stops.push(base+' '+cursor+'px',base+' '+left+'px',fill.color+' '+left+'px',fill.color+' '+fill.right+'px');cursor=fill.right;}stops.push(base+' '+cursor+'px',base+' '+nameWidth+'px');label.style.backgroundImage='linear-gradient(to right,'+stops.join(',')+')';}
   for(const [id,bar] of bars){if(!bar.querySelector('.exact-unlink'))continue;const label=outsideNames.get(id),barLeft=parseFloat(bar.style.left),barWidth=parseFloat(bar.style.width);let nameRight=barLeft;if(label&&!label.hidden&&!bar.nameHidden)nameRight=parseFloat(label.style.left)+label.nameWidth;else if(!bar.nameHidden)nameRight=Math.max(0,barLeft)+measureName(bar.interval.name)+36;bar.style.setProperty('--exact-end-control-left',Math.max(barWidth+5,nameRight-barLeft+5)+'px');}
   drawGroupConnectors(presented,exposed,width);
   let now=tracks.querySelector('.exact-now');if(!now){now=document.createElement('div');now.className='exact-now';tracks.append(now);}now.style.left=geometry.position(clockNow(),start,scale)+'px';
   rowExtent.style.height=Math.max(160,(laneCount+(draftIndex!==null?1:0))*ROW+40)+'px';
   if(hoveredRow!==null)showRowNav(hoveredRow);
   if(remainingLabel.classList.contains('is-visible')&&remainingLabel.classList.contains('is-elapsed')){const node=bars.get(remainingLabel.intervalId),left=node?parseFloat(node.style.left):Infinity,right=node?left+parseFloat(node.style.width):-Infinity,top=node?parseFloat(node.style.top):Infinity;if(right<=0||left>=width||top+42<=tracks.scrollTop||top>=tracks.scrollTop+tracks.clientHeight)hideRemaining();}
   const activeDayMarkers=new Set(),dayWidth=86400000*scale;if(dayWidth>60){const first=Math.floor((start+7*3600000)/86400000)*86400000-7*3600000;for(let day=first;day<=visibleEnd;day+=86400000){for(const [hour,emoji] of [[0,''],[6,'🌅'],[12,'☀️'],[18,'🌙']]){if(hour&&dayWidth<=240)continue;const time=day+hour*3600000,x=geometry.position(time,start,scale);if(x<0||x>(hour?width-104:width))continue;const key=String(time);activeDayMarkers.add(key);let marker=dayMarkers.get(key);if(!marker){marker=document.createElement('span');marker.className=hour?'exact-day-emoji':'exact-day-boundary';if(hour){const paths=hour===6?'<path d="M2 19h28M8 19a8 8 0 0 1 16 0"/>':hour===12?'<circle cx="16" cy="16" r="7"/><path d="M16 2v3m0 22v3M2 16h3m22 0h3M6 6l2 2m16 16 2 2M6 26l2-2M24 8l2-2"/>':'<path d="M23 4C11 1 3 13 7 22c3 7 13 8 21 5-12-2-17-13-5-23Z"/>';marker.innerHTML='<svg viewBox="0 0 32 32" fill="none" stroke="'+(hour===6?'#c05b54':hour===12?'#fff13b':'#8583d1')+'" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>';}marker.setAttribute('aria-hidden','true');element.append(marker);dayMarkers.set(key,marker);}marker.style.left=x+'px';if(!hour)marker.style.top=x<26?'101px':'24px';marker.style.opacity=String(hour?Math.max(0,Math.min(1,(dayWidth-240)/160)):Math.max(0,Math.min(1,(dayWidth-60)/60)));}}}for(const [key,marker] of dayMarkers)if(!activeDayMarkers.has(key)){marker.remove();dayMarkers.delete(key);}
   positionTimeLabels();positionQueueDelete();
   scheduleLayoutSave();element.dataset.viewportStart=String(start);element.dataset.pixelsPerMillisecond=String(scale);
  }
  // Finger motion is already continuous. Apply every delta immediately, but
  // paint only once per display frame instead of restarting wheel easing.
  let touchFrame=0;
  element.addEventListener('proxima:timeline-touch',event=>{
   if(resizing||deadlineResize||reordering||inlineEditor||timeEditor)return;
   const {deltaX=0,factor=1,x=0}=event.detail||{};
   if(!Number.isFinite(deltaX)||!Number.isFinite(factor)||factor<=0||!Number.isFinite(x))return;
   cancelAnimationFrame(animation);animation=0;goal=null;
   const next=geometry.zoom(start,scale,factor,x);start=next.start+deltaX/next.scale;scale=next.scale;
   if(!touchFrame)touchFrame=requestAnimationFrame(()=>{touchFrame=0;render();});
  });
  window.addEventListener('pagehide',()=>cancelAnimationFrame(touchFrame),{once:true});
  function availableViewport(){
   const box=element.getBoundingClientRect();let left=Math.max(box.left,0),right=Math.min(box.right,window.innerWidth);
   for(const pane of document.querySelectorAll('.blob-workspace-pane:not([hidden])')){
    const overlay=pane.getBoundingClientRect();if(overlay.bottom<=box.top||overlay.top>=box.bottom||overlay.right<=left||overlay.left>=right)continue;
    // Choose the larger exposed side if a floating pane crosses the timeline.
    if(Math.max(0,overlay.left-left)>=Math.max(0,right-overlay.right))right=Math.min(right,overlay.left);else left=Math.max(left,overlay.right);
   }
   return {left:Math.max(0,left-box.left),right:Math.max(0,right-box.left),width:Math.max(0,right-left)};
  }
  function availableCenter(){const view=availableViewport();return (view.left+view.right)/2;}
  function verticalScrollSide(pointer){const view=availableViewport();if(view.width<=0||pointer<view.left||pointer>view.right)return null;return pointer<view.left+view.width/8?'vertical-left':pointer>view.right-view.width/8?'vertical-right':null;}
  function returnToLive(){const nextScale=goal?.scale||scale;initialized=true;animate({start:clockNow()-availableCenter()/nextScale,scale:nextScale},null);}
  function animate(next,anchorX){
   cancelAnimationFrame(animation);const initial={start,scale},began=performance.now();goal=next;
   const anchor=anchorX==null?null:geometry.time(anchorX,start,scale);
   function frame(now){const fraction=Math.min(1,(now-began)/300),ease=1-Math.pow(1-fraction,3);scale=Math.exp(Math.log(initial.scale)+(Math.log(next.scale)-Math.log(initial.scale))*ease);start=anchor==null?initial.start+(next.start-initial.start)*ease:anchor-anchorX/scale;if(fraction===1){start=next.start;scale=next.scale;goal=null;}render();if(fraction<1)animation=requestAnimationFrame(frame);}
   if(matchMedia('(prefers-reduced-motion: reduce)').matches){start=next.start;scale=next.scale;goal=null;render();}else animation=requestAnimationFrame(frame);
  }
  function createRunningQueueBlob(){const node=document.createElement('div');node.className='exact-interval exact-running-queue';node.queueRunning=true;node.tabIndex=0;node.setAttribute('role','button');const caption=document.createElement('span');caption.className='exact-interval-caption';const end=document.createElement('span');end.className='exact-resize-edge exact-resize-end exact-running-end';end.setAttribute('aria-hidden','true');node.append(caption,end);node.addEventListener('pointermove',event=>showBlobName(node,event));node.addEventListener('pointerleave',()=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});node.addEventListener('pointerdown',event=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');beginReorder(event,node);});node.addEventListener('click',event=>{event.stopPropagation();if(performance.now()<ignoreClickUntil)return;selectRow(node.interval.id,event);});node.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();pickColor(node,event,true);});node.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();pickColor(node,event,true);}});return node;}
  function queueDividerAt(event){if(settings.readOnly)return null;let nearest=null,distance=13;for(const bar of bars.values()){if(!bar.queuePlaceholder||Number(bar.dataset.trueRight)>element.clientWidth||bar.querySelector('.exact-queue-boundary')?.hidden)continue;const box=bar.getBoundingClientRect(),delta=Math.abs(event.clientX-box.right);if(event.clientY>=box.top-4&&event.clientY<=box.bottom+4&&delta<distance){nearest=bar;distance=delta;}}return nearest;}
  element.addEventListener('pointerdown',event=>{if(event.button!==0)return;const bar=queueDividerAt(event);if(!bar)return;event.preventDefault();event.stopImmediatePropagation();blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');beginQueueBoundary(event,bar.interval.queueId,bar.interval.id,false);},true);
  element.addEventListener('pointermove',event=>{element.style.cursor=queueDividerAt(event)?'ew-resize':'';});
  function createQueuePlaceholder(item){
   const node=document.createElement('div');node.className='exact-queued-placeholder';node.queuePlaceholder=true;node.dataset.intervalId=item.id;node.tabIndex=0;node.setAttribute('role','button');const caption=document.createElement('span');caption.className='exact-interval-caption';node.append(caption);
   const seam=document.createElement('span');seam.className='exact-queue-boundary';seam.removeAttribute('title');seam.addEventListener('pointerdown',event=>{const entry=node.interval;const next=items().some(x=>x.queueId===entry.queueId&&x.queueIndex===entry.queueIndex+1);if(next)beginQueueBoundary(event,entry.queueId,entry.id,false);});node.append(seam);
   node.addEventListener('pointerdown',event=>{blobName.classList.remove('is-visible');if(event.target.closest('.exact-queue-boundary'))return;beginReorder(event,node);});node.addEventListener('pointermove',event=>{const minutes=Math.max(1,Math.round((Date.parse(node.interval.end)-Date.parse(node.interval.start))/60000)),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60,duration=[days?days+'d':'',hours?hours+'h':'',rest?rest+'m':''].filter(Boolean).join(' ');showBlobName({nameHidden:true,interval:{...node.interval,name:node.nameHidden?node.interval.name:''},popupTimes:{start:duration,end:''}},event);});node.addEventListener('pointerleave',()=>{blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');});
   node.addEventListener('click',event=>{event.stopPropagation();if(event.target.closest('.exact-queue-boundary')||performance.now()<ignoreClickUntil)return;selectRow(node.interval.id,event);});node.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();pickColor(node,event);});node.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();open(node.interval);}});return node;
  }
  function queues(){return (store.timelineRows?.()||[]).filter(row=>row.queue);}
  function queuePoint(event){const y=event.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop;return {index:Math.max(0,Math.min(laneCount,Math.floor((y-11)/ROW))),time:Math.round(geometry.time(event.clientX-element.getBoundingClientRect().left,start,scale))};}
  function cancelQueuePlacement(){placingQueue=false;queuePlacement=null;queueButton.classList.remove('is-active');element.classList.remove('exact-placing-queue');error.textContent='';drawQueues();}
  function drawQueues(){const live=new Set(),rows=ordered(),now=clockNow();const all=queues().map(row=>({row,index:rows.findIndex(x=>(x.rowId||x.id)===row.id),end:resizing?.queueRowId===row.id&&Number.isFinite(resizing.endTime)?resizing.endTime:Date.parse(row.queue.end),key:row.id}));if(queuePlacement)all.push({row:null,index:queuePlacement.index,end:queuePlacement.time,key:'preview'});for(const data of all){const {row,index,end,key}=data;if(row&&end<=now){expireQueue(row);continue;}live.add(key);let zone=queueZones.get(key);if(!zone){zone=document.createElement('div');zone.className='exact-queue-zone';const edge=document.createElement('button');edge.type='button';edge.className='exact-queue-end';edge.setAttribute('aria-label','Drag queue end');edge.title='Queue end';edge.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(zone.queueRow&&performance.now()>=ignoreClickUntil)editEdge(zone.queueRow.id,'end',event,zone.queueRow);});edge.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();if(zone.queueRow)confirmQueueDelete(zone.queueRow,event);});edge.addEventListener('pointerdown',event=>{if(!zone.queueRow)return;event.preventDefault();event.stopPropagation();beginQueueBoundary(event,zone.queueRow.id,null,true);});zone.append(edge);tracks.append(zone);queueZones.set(key,zone);}zone.queueRow=row;const viewport=element.clientWidth,zoneLeft=Math.max(-2,Math.min(viewport+2,geometry.position(Math.min(now,end),start,scale))),zoneRight=Math.max(-2,Math.min(viewport+2,geometry.position(Math.max(now,end),start,scale)));zone.style.left=zoneLeft+'px';zone.style.width=Math.max(0,zoneRight-zoneLeft)+'px';zone.firstChild.hidden=geometry.position(end,start,scale)<0||geometry.position(end,start,scale)>viewport;zone.classList.toggle('is-overdue',end<=now);zone.firstChild.style.left=end<=now?'-15px':'';zone.firstChild.style.right=end<=now?'auto':'-15px';zone.style.top=(20+index*ROW)+'px';zone.classList.toggle('has-waiting',!!row&&row.queue.ids.length>1);zone.classList.toggle('is-preview',key==='preview');zone.classList.toggle('is-invalid',end<=now||!!queueDrag?.blocked&&queueDrag.rowId===key);zone.classList.toggle('is-drop-target',queueDrag?.rowId===key&&!queueDrag.blocked);zone.firstChild.title=(end<=now?'Queue overdue — end ':'Queue end ')+new Date(end).toLocaleString('en-GB',{timeZone:'Asia/Ho_Chi_Minh'});zone.firstChild.disabled=key==='preview';}for(const [key,zone] of queueZones)if(!live.has(key)){zone.remove();queueZones.delete(key);}}
  async function expireQueue(row){if(settings.remoteReadOnly||globalThis.__proximaDevice)return;if(expiringQueues.has(row.id))return;expiringQueues.add(row.id);try{await globalThis.__proximaCaughtUp;const result=await store.command({type:'timeline-queue.delete',automatic:true,payload:{rowId:row.id,expired:true}});if(!result.ok){error.textContent=result.code==='QUEUE_RETURN_OVERLAP'?'Queue ended, but a waiting session cannot return because its original position now overlaps another session. Nothing was overwritten.':result.code;}else refresh();}finally{expiringQueues.delete(row.id);}}
  function positionQueueDelete(){const panel=queueDeletePrompt;if(!panel)return;const index=ordered().findIndex(x=>(x.rowId||x.id)===panel.anchorRowId);if(index<0){panel.remove();queueDeletePrompt=null;return;}const x=geometry.position(panel.anchorTime,start,scale),y=tracks.getBoundingClientRect().top-element.getBoundingClientRect().top+20+index*ROW+panel.anchorOffset-tracks.scrollTop;panel.style.left=(x-panel.offsetWidth/2)+'px';panel.style.top=(y-panel.offsetHeight-8)+'px';}
  function confirmQueueDelete(row,event,deadlineItem=null){queueDeletePrompt?.remove();const panel=document.createElement('div');panel.className='exact-queue-delete';panel.setAttribute('role','dialog');panel.setAttribute('aria-label',deadlineItem?'Delete deadline':'Delete queue edge');const label=document.createElement('span');label.textContent='Delete queue edge?';const remove=document.createElement('button'),cancel=document.createElement('button');remove.type=cancel.type='button';remove.innerHTML=deleteButton.innerHTML;remove.title=deadlineItem?'Delete deadline':'Delete queue edge';remove.setAttribute('aria-label',remove.title);cancel.textContent='×';cancel.title='Cancel';cancel.setAttribute('aria-label','Cancel');panel.append(remove);const origin=element.getBoundingClientRect();panel.anchorTime=geometry.time(event.clientX-origin.left,start,scale);panel.anchorRowId=deadlineItem?(deadlineItem.rowId||deadlineItem.id):row.id;const rowTop=ordered().findIndex(x=>(x.rowId||x.id)===panel.anchorRowId)*ROW+20;panel.anchorOffset=event.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop-rowTop;const close=()=>{panel.remove();if(queueDeletePrompt===panel)queueDeletePrompt=null;};remove.addEventListener('click',async()=>{remove.disabled=true;const result=await store.command(deadlineItem?{type:'timeline-interval.patch',ifRev:deadlineItem.rev,payload:{intervalId:deadlineItem.id,patch:{deadline:null}}}:{type:'timeline-queue.delete',payload:{rowId:row.id}});if(!result.ok){error.textContent=result.code;remove.disabled=false;return;}close();refresh();});cancel.addEventListener('click',close);panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('click',e=>e.stopPropagation());element.append(panel);panel.papersCancelEdit=close;queueDeletePrompt=panel;positionQueueDelete();remove.focus();}
  function beginQueueBoundary(event,rowId,intervalId,end){if(event.button!==0)return;const row=queues().find(x=>x.id===rowId),members=items().filter(x=>x.queueId===rowId).sort((a,b)=>a.queueIndex-b.queueIndex),index=members.findIndex(x=>x.id===intervalId),left=members[index],right=members[index+1];if(!end&&(index<1||!right))return;event.preventDefault();event.stopPropagation();const handle=event.currentTarget,origin=event.clientX,initial=end?Date.parse(row.queue.end):Date.parse(left.end);let time=initial,moved=false;handle.setPointerCapture?.(event.pointerId);resizing={queue:true,queueRowId:rowId};element.classList.add('is-queue-resizing');const preview=document.createElement('div');preview.className='exact-queue-boundary-preview';preview.style.top=(20+ordered().findIndex(x=>(x.rowId||x.id)===rowId)*ROW)+'px';tracks.append(preview);const move=e=>{if(!moved&&Math.abs(e.clientX-origin)<5)return;moved=true;const a=end?clockNow()+1:Date.parse(left.start)+1,b=end?Infinity:Date.parse(right.end)-1;time=Math.max(a,Math.min(b,initial+Math.round((e.clientX-origin)/scale)));preview.style.left=geometry.position(time,start,scale)+'px';if(!end){queueBoundaryPreview=new Map([[left.id,{start:Date.parse(left.start),end:time}],[right.id,{start:time,end:Date.parse(right.end)}]]);render();}else{resizing.endTime=time;const now=clockNow(),waiting=members.slice(1),total=waiting.reduce((sum,item)=>sum+(item.queueWeight||1),0)||1;let cursor=now;queueBoundaryPreview=new Map();waiting.forEach((item,index)=>{const finish=index===waiting.length-1?time:cursor+Math.max(0,time-now)*(item.queueWeight||1)/total;queueBoundaryPreview.set(item.id,{start:cursor,end:Math.max(cursor+1,finish)});cursor=finish;});render();}preview.textContent=new Date(time).toLocaleTimeString('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit'});};const finish=async e=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);try{handle.releasePointerCapture?.(event.pointerId);}catch{}const queueDropBoxes=new Map([...bars.values()].filter(x=>x.interval.queueId===rowId).map(node=>[node,node.getBoundingClientRect()]));resizing=null;queueBoundaryPreview=null;element.classList.remove('is-queue-resizing');preview.remove();if(!moved&&end&&e.type!=='pointercancel'){ignoreClickUntil=performance.now()+350;editEdge(row.id,'end',e,row);}if(moved){ignoreClickUntil=performance.now()+350;if(e.type!=='pointercancel'){const result=await store.command({type:'timeline-queue.resize',payload:{rowId,intervalId,end,time:new Date(time).toISOString()}});if(!result.ok)error.textContent=result.code;}}refresh();if(moved&&!matchMedia('(prefers-reduced-motion: reduce)').matches)for(const [node,box] of queueDropBoxes){if(!node.isConnected)continue;const next=node.getBoundingClientRect();node.animate([{left:(box.left-tracks.getBoundingClientRect().left)+'px',width:box.width+'px'},{left:node.style.left,width:node.style.width}],{duration:180,easing:'cubic-bezier(.22,.8,.25,1)'});}};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);}
  tracks.addEventListener('pointermove',event=>{if(!placingQueue)return;queuePlacement=queuePoint(event);drawQueues();});
  tracks.addEventListener('pointerdown',event=>{if(placingQueue&&event.button===0){event.preventDefault();event.stopImmediatePropagation();}},true);
  tracks.addEventListener('click',async event=>{if(!placingQueue)return;event.preventDefault();event.stopImmediatePropagation();const point=queuePoint(event);if(point.time<=clockNow()){error.textContent='Place the edge in the future.';return;}const row=ordered()[point.index];const result=await store.command({type:'timeline-queue.create',payload:{rowId:row?.rowId||row?.id,end:new Date(point.time).toISOString()}});if(!result.ok){error.textContent=result.code;return;}cancelQueuePlacement();refresh();},true);
  function beginResize(event,bar,edge){
   if(event.button!==0)return;event.preventDefault();event.stopPropagation();cancelAnimationFrame(animation);goal=null;
   const item=bar.interval;if(item.queueId){if(item.queueIndex===0)return;const members=items().filter(x=>x.queueId===item.queueId).sort((a,b)=>a.queueIndex-b.queueIndex);const left=edge==='start'?members[item.queueIndex-1]:item;return beginQueueBoundary(event,item.queueId,left?.id,edge==='end'&&item.queueIndex===members.length-1);}resizing={id:item.id,start:Date.parse(item.start),end:item.followNow?Math.max(Date.parse(item.start)+1,clockNow()):Date.parse(item.end),edge,rev:item.rev};const original={...resizing},originX=event.clientX;
   const handle=event.currentTarget;handle.setPointerCapture(event.pointerId);element.classList.add('exact-is-resizing');
   const move=e=>{const delta=Math.round((e.clientX-originX)/scale);if(edge==='start'){if(item.followNow)resizing.end=Math.max(resizing.start+1,clockNow());resizing.start=Math.min(resizing.end-1,original.start+delta);}else resizing.end=Math.max(original.start+1,original.end+delta);suppressClick=true;render();};
   const finish=async e=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);handle.releasePointerCapture?.(event.pointerId);element.classList.remove('exact-is-resizing');const changed=resizing;resizing=null;if(e.type!=='pointercancel'&&(changed.start!==original.start||changed.end!==original.end)){const result=await store.command({type:'timeline-interval.patch',ifRev:original.rev,payload:{intervalId:item.id,patch:{start:new Date(changed.start).toISOString(),end:new Date(changed.end).toISOString(),...(edge==='end'?{followNow:false}:{})}}});if(!result.ok){error.textContent=result.code||'Resize could not be saved.';}}refresh();};
   handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
  }
  function editEdge(id,edge,event,queueRow=null){
   if(inlineEditor||resizing||deadlineResize||reordering)return;timeEditor?.remove();const item=queueRow?{start:new Date().toISOString(),end:queueRow.queue.end}:items().find(x=>x.id===id);if(!item)return;if(item.queueId){error.textContent='Drag a shared edge to adjust the queue proportions.';return;}
   const value=edge==='end'&&item.followNow?clockNow():Date.parse(item[edge]),local=new Date(value+7*3600000);let selected=local.toISOString().slice(0,10),month=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1)),saving=false;
   const panel=document.createElement('div');panel.className='exact-edge-calendar';panel.setAttribute('role','dialog');panel.setAttribute('aria-label',edge+' date and time in Saigon');
   const header=document.createElement('div');header.className='exact-edge-calendar-head';const title=document.createElement('strong');
   for(const delta of [-1,1]){const button=document.createElement('button');button.type='button';button.textContent=delta<0?'‹':'›';button.setAttribute('aria-label',delta<0?'Previous month':'Next month');button.addEventListener('click',()=>{month=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+delta,1));draw();});header.append(button);}header.prepend(title);
   const grid=document.createElement('div');grid.className='exact-edge-calendar-grid';const clock=document.createElement('div');clock.className='exact-edge-calendar-clock';const hour=document.createElement('input'),minute=document.createElement('input');for(const [input,max,label,num] of [[hour,23,'Hour',local.getUTCHours()],[minute,59,'Minute',local.getUTCMinutes()]]){input.type='number';input.min=0;input.max=max;input.step=1;input.value=String(num).padStart(2,'0');input.setAttribute('aria-label',label);clock.append(input);}const separator=document.createElement('span');separator.textContent=':';clock.insertBefore(separator,minute);
   const actions=document.createElement('div');actions.className='exact-edge-calendar-actions';const cancelButton=document.createElement('button'),saveButton=document.createElement('button');cancelButton.type=saveButton.type='button';cancelButton.textContent='Cancel';saveButton.textContent='Save';actions.append(cancelButton,saveButton);
   const cancel=()=>{panel.remove();if(timeEditor===panel)timeEditor=null;};
   const save=async()=>{if(saving)return;if(!hour.checkValidity()||!minute.checkValidity()||hour.value===''||minute.value===''){error.textContent='Enter an hour from 0–23 and minute from 0–59.';return;}const stamp=Date.parse(selected+'T'+String(Number(hour.value)).padStart(2,'0')+':'+String(Number(minute.value)).padStart(2,'0')+':00+07:00');if((queueRow||edge==='deadline')&&stamp<=clockNow()){error.textContent='Deadline must be in the future.';return;}saving=true;const result=await store.command(queueRow?{type:'timeline-queue.resize',payload:{rowId:queueRow.id,end:true,time:new Date(stamp).toISOString()}}:{type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:id,patch:{[edge]:new Date(stamp).toISOString(),...(edge==='end'?{followNow:false}:{})}}});if(!result.ok){saving=false;error.textContent=result.code;return;}error.textContent='';cancel();refresh();};
   function draw(){title.textContent=month.toLocaleDateString('en-GB',{timeZone:'UTC',month:'long',year:'numeric'});grid.replaceChildren();for(const name of ['M','T','W','T','F','S','S']){const label=document.createElement('span');label.textContent=name;grid.append(label);}const first=new Date(month),offset=(first.getUTCDay()+6)%7;first.setUTCDate(1-offset);for(let n=0;n<42;n++){const date=new Date(first.getTime()+n*86400000),key=date.toISOString().slice(0,10),button=document.createElement('button');button.type='button';button.textContent=date.getUTCDate();button.classList.toggle('is-other-month',date.getUTCMonth()!==month.getUTCMonth());button.classList.toggle('is-selected',key===selected);button.setAttribute('aria-label',key);button.addEventListener('click',()=>{selected=key;draw();});grid.append(button);}}
   panel.papersCancelEdit=cancel;cancelButton.addEventListener('click',cancel);saveButton.addEventListener('click',save);panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('click',e=>e.stopPropagation());panel.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();cancel();}if(e.key==='Enter'){e.preventDefault();save();}});panel.append(header,grid,clock,actions);element.append(panel);timeEditor=panel;draw();panel.style.left=Math.max(0,Math.min(element.clientWidth-280,event.clientX-element.getBoundingClientRect().left-140))+'px';panel.style.top=Math.max(0,Math.min(element.clientHeight-310,event.clientY-element.getBoundingClientRect().top+10))+'px';panel.tabIndex=-1;panel.focus();
  }
  function beginDeadline(event,id){if(event.button!==0||inlineEditor)return;event.preventDefault();event.stopPropagation();closeColor();cancelAnimationFrame(animation);goal=null;const item=items().find(x=>x.id===id);if(!item)return;const original=Date.parse(item.deadline),origin=event.clientX,handle=event.currentTarget;deadlineResize={id,time:original};handle.setPointerCapture(event.pointerId);element.classList.add('exact-is-resizing');let moved=false;
   const move=e=>{if(!moved&&Math.abs(e.clientX-origin)<5)return;moved=true;deadlineResize.time=Math.max(clockNow()+1,Date.parse(item.start)+1,original+Math.round((e.clientX-origin)/scale));render();};
   const finish=async e=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);try{handle.releasePointerCapture(event.pointerId);}catch{}const time=deadlineResize.time;deadlineResize=null;element.classList.remove('exact-is-resizing');if(!moved&&e.type!=='pointercancel'){ignoreClickUntil=performance.now()+350;editEdge(item.id,'deadline',e);}if(moved){ignoreClickUntil=performance.now()+350;if(e.type!=='pointercancel'){const result=await store.command({type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:id,patch:{deadline:new Date(time).toISOString()}}});if(!result.ok)error.textContent=result.code;}}refresh();};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
  }
  function durableOrdered(){const rows=new Map(),visible=items();for(const row of store.timelineRows?.()||[])if(row.queue&&(!groupTrail.length&&!row.queue.ids.length||visible.some(x=>!x.groupChildren&&x.rowId===row.id)))rows.set(row.id,{id:row.id,rowId:row.id,name:'',rowOrder:row.rowOrder,queuePlaceholder:true});for(const item of visible.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))){const id=laneId(item);if(!rows.has(id)||rows.get(id).queuePlaceholder||item.id===id)rows.set(id,item);}return [...rows.values()].map((item,index)=>({item,order:Number.isFinite(item.viewOrder)?item.viewOrder:Number.isFinite(item.rowOrder)?item.rowOrder:index})).sort((a,b)=>a.order-b.order).map(x=>x.item);}
  let presentedRows=null;
  function ordered(){
   const rows=durableOrdered();
   // Freeze the projection for the whole gesture: targets must not slide away
   // while resizing, reordering, selecting, typing or previewing a Shift edit.
   const busy=resizing||deadlineResize||reordering||inlineEditor||timeEditor||placingQueue||shiftExtension||!marquee.hidden;
   if(busy&&presentedRows){const ids=new Set(presentedRows.map(laneId));return rows.filter(row=>ids.has(laneId(row)));}
   const view=availableViewport();
   presentedRows=occupiedLanes(rows,items(),start+view.left/scale,start+view.right/scale,new Set(),clockNow());
   return presentedRows;
  }
  function currentSession(row){const sessions=items().filter(x=>(x.rowId||x.id)===(row.rowId||row.id)).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));return sessions.find(x=>x.followNow)||sessions.filter(x=>Date.parse(x.start)<=clockNow()).at(-1)||sessions[0]||row;}
  function refresh(){items();renderCrumbs();showQueueNotice();renderSelectionActions();const data=ordered();laneCount=data.length;const ids=new Set(items().map(x=>x.id));/* a preview shows another state: it must not drop the real selection */if(!previewing)for(const id of selected)if(!ids.has(id))selected.delete(id);let maxEnd=-Infinity;layout=items().map(item=>({item,lane:data.findIndex(row=>laneId(row)===laneId(item)),a:Date.parse(item.start),b:item.followNow?Math.max(Date.parse(item.start)+1,clockNow()):Date.parse(item.end)})).sort((x,y)=>x.a-y.a);for(const entry of layout)entry.maxEnd=maxEnd=Math.max(maxEnd,entry.item.followNow?Infinity:entry.b);if(!initialized&&element.clientWidth){initialized=true;if(layout.length){const a=layout[0].a,b=Math.max(...layout.map(x=>x.b));scale=Math.max(1e-10,Math.min(1,(element.clientWidth-80)/(b-a)));start=a-40/scale;}else{scale=element.clientWidth/86400000;start=clockNow()-43200000;}}render();}
  function addSession(index,t){const row=ordered()[index];open(null,t,index,row.groupChildren?null:row.rowId||row.id);}
  function open(item,t,index=laneCount,rowId=null,followNow=false){if(previewing)return;
   if(inlineEditor){inlineEditor.focus();return;}error.textContent='';
   const input=document.createElement('input');input.className='exact-inline-name';input.maxLength=200;input.placeholder='Name';input.value=item?.name||'';const inputColor=item?.color||creationColor();const showNameField=!item||!!item.queueId&&item.queueIndex>0;input.style.backgroundColor=showNameField?inputColor:'transparent';input.style.borderColor=showNameField?'#91b7d3':'transparent';input.classList.toggle('is-new-blob',showNameField);const rgb=inputColor.slice(1);input.style.color=(.299*parseInt(rgb.slice(0,2),16)+.587*parseInt(rgb.slice(2,4),16)+.114*parseInt(rgb.slice(4,6),16))>145?'#17210d':'#fff';
   if(!item&&(!rowId||!ordered().some(row=>(row.rowId||row.id)===rowId))){draftIndex=index;render();}
   const lane=item?layout.find(x=>x.item.id===item.id)?.lane??0:index;const groupLabel=item?.groupChildren&&outsideNames.get(item.id),x=groupLabel&&!groupLabel.hidden?parseFloat(groupLabel.style.left):item?geometry.position(Date.parse(item.start),start,scale):geometry.position(t,start,scale);
   input.style.left=Math.max(0,Math.min(element.clientWidth-180,x))+'px';input.style.top=(20+lane*ROW)+'px';tracks.append(input);inlineEditor=input;input.intervalId=item?.id;if(item){bars.get(item.id)?.classList.add('is-renaming');outsideNames.get(item.id)?.classList.add('is-renaming');blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');}input.focus();input.select();let saving=false;
   const cancel=()=>{input.remove();inlineEditor=null;draftIndex=null;render();};const save=async()=>{if(saving)return;if(!input.value.trim()){cancel();return;}saving=true;input.disabled=true;const stamp=Math.round(t);const result=await store.command(item?{type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:item.id,patch:{name:input.value}}}:{type:'timeline-interval.create',payload:{parentGroupId:groupTrail.at(-1)||undefined,parentGroupRev:allItems().find(x=>x.id===groupTrail.at(-1))?.rev,color:creationColor(),rowId:rowId||undefined,name:input.value,followNow,start:new Date(stamp).toISOString(),end:new Date(followNow?Math.max(stamp+1,clockNow()):Math.min(stamp+Math.max(1,Math.round(160/scale)),...items().filter(x=>x.rowId===rowId&&Date.parse(x.start)>stamp).map(x=>Date.parse(x.start)))).toISOString(),beforeId:rowId?undefined:ordered()[index]?.id}});if(!result.ok){saving=false;input.disabled=false;error.textContent=result.code||'Could not save.';input.focus();return;}cancel();refresh();};
   input.papersCancelEdit=cancel;input.addEventListener('click',e=>e.stopPropagation());input.addEventListener('pointerdown',e=>e.stopPropagation());input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();save();}if(e.key==='Escape'){e.preventDefault();cancel();}});input.addEventListener('blur',save);
  }
  let shiftExtension=null,lastExtensionPointer=null;
  const extensionPreview=document.createElement('div');extensionPreview.className='exact-extension-preview';extensionPreview.hidden=true;tracks.append(extensionPreview);
  function clearExtension(){for(const node of tracks.querySelectorAll('.is-extension-source')){node.classList.remove('is-extension-source');node.style.transform='';}for(const node of tracks.querySelectorAll('.exact-extension-shift')){node.classList.remove('exact-extension-shift');node.style.transform='';}shiftExtension=null;extensionPreview.hidden=true;extensionPreview.replaceChildren();}
  function previewExtension(event){lastExtensionPointer=event;if(settings.readOnly||!event.shiftKey||!selected.size||resizing||reordering||inlineEditor){clearExtension();return;}const members=items().filter(x=>selected.has(x.id)).sort((a,b)=>(a.rowOrder||0)-(b.rowOrder||0)||Date.parse(a.start)-Date.parse(b.start));if(!members.length||members.some(x=>x.queueId)){clearExtension();return;}const time=geometry.time(event.clientX-element.getBoundingClientRect().left,start,scale),now=clockNow(),edge=extensionEdge(time,members.map(x=>({start:Date.parse(x.start),end:x.followNow?now:Date.parse(x.end)})));if(!edge){clearExtension();return;}const index=Math.max(0,Math.min(laneCount,Math.floor((event.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop-20)/ROW))),firstLane=layout.find(x=>x.item.id===members[0].id)?.lane||0,reorder=index!==firstLane;shiftExtension={intervalIds:members.map(x=>x.id),revisions:Object.fromEntries(members.map(x=>[x.id,x.rev])),time:new Date(Math.round(time)).toISOString(),edge,index,reorder};const partialRow=reorder&&members.some(a=>items().some(b=>!selected.has(b.id)&&b.rowId===a.rowId));const conflict=partialRow||members.some(a=>items().some(b=>!selected.has(b.id)&&b.rowId===a.rowId&&(edge==='start'?time:Date.parse(a.start))<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(edge==='end'?time:a.followNow?clockNow():Date.parse(a.end))))||members.some(a=>members.some(b=>a.id!==b.id&&a.rowId===b.rowId));const order=ordered(),movingRows=[...new Set(members.map(x=>x.rowId||x.id))],remaining=order.filter(row=>conflict?row.queue||items().some(x=>(x.rowId||x.id)===(row.rowId||row.id)&&!selected.has(x.id)):!movingRows.includes(row.rowId||row.id)),insert=Math.max(0,Math.min(remaining.length,index));shiftExtension.beforeRowId=remaining[insert]?.rowId||remaining[insert]?.id||null;for(const item of items()){if(selected.has(item.id))continue;const oldLane=order.findIndex(row=>(row.rowId||row.id)===(item.rowId||item.id)),remainingLane=remaining.findIndex(row=>(row.rowId||row.id)===(item.rowId||item.id)),nextLane=remainingLane+(remainingLane>=insert?(conflict?members.length:movingRows.length):0),shift=(conflict||reorder)?(nextLane-oldLane)*ROW:0;for(const node of [bars.get(item.id),outsideNames.get(item.id),deadlines.get(item.id)])if(node){node.classList.add('exact-extension-shift');node.style.transform='translateY('+shift+'px)';}}for(const item of members){bars.get(item.id)?.classList.add('is-extension-source');outsideNames.get(item.id)?.classList.add('is-extension-source');}extensionPreview.hidden=false;extensionPreview.replaceChildren();members.forEach((item,n)=>{const node=document.createElement('div'),a=edge==='start'?time:Date.parse(item.start),b=edge==='end'?time:item.followNow?clockNow():Date.parse(item.end),lane=(reorder||conflict)?insert+(conflict?n:movingRows.indexOf(item.rowId||item.id)):layout.find(x=>x.item.id===item.id)?.lane||0;node.style.left=Math.max(0,geometry.position(a,start,scale))+'px';node.style.width=Math.max(1,Math.min(element.clientWidth,geometry.position(b,start,scale))-Math.max(0,geometry.position(a,start,scale)))+'px';node.style.top=(20+lane*ROW)+'px';const sourceLane=layout.find(x=>x.item.id===item.id)?.lane||0;for(const source of [bars.get(item.id),outsideNames.get(item.id),deadlines.get(item.id)])if(source){source.classList.add('is-extension-source');source.style.transform='translateY('+((lane-sourceLane)*ROW)+'px)';}node.textContent=item.name;extensionPreview.append(node);});}
  element.addEventListener('pointermove',previewExtension);document.addEventListener('keyup',event=>{if(event.key==='Shift')clearExtension();});document.addEventListener('keydown',event=>{if(event.key==='Escape')clearExtension();if(event.key==='Shift'&&lastExtensionPointer)previewExtension({clientX:lastExtensionPointer.clientX,clientY:lastExtensionPointer.clientY,shiftKey:true});});element.addEventListener('pointerleave',clearExtension);
  element.addEventListener('pointerdown',async event=>{if(event.button!==0||!event.shiftKey||!shiftExtension)return;event.preventDefault();event.stopImmediatePropagation();const payload=shiftExtension;clearExtension();ignoreClickUntil=performance.now()+400;const result=await store.command({type:'timeline-queue.extend-selection',payload});if(!result.ok)error.textContent=result.code;refresh();},true);
  function renderSelectionActions(){
   const chosen=allItems().filter(item=>selected.has(item.id)),count=chosen.length;
   const primary=!count?'create':count===1&&chosen[0].groupChildren?'ungroup':'group';
   const queue=!count?'place':chosen.some(item=>item.groupChildren)?'group-queue':queueSelectionAction(chosen,store.timelineRows());
   const paths={create:'M12 5v14M5 12h14',group:'M3 3h6v6H3zM15 3h6v6h-6zM7 16h10v5H7zM6 11v2h12v-2M12 13v3',ungroup:'M7 3h10v5H7zM12 8v4M5 12h14M5 12v4M19 12v4M2 17h6v5H2zM16 17h6v5h-6z',place:'M17 3v18M4 12h10m-4-4 4 4-4 4',collapse:'M10 4v16M14 4v16M2 12h5m-3-3 3 3-3 3M22 12h-5m3-3-3 3 3 3',restore:'M10 4v16M14 4v16M7 12H2m3-3-3 3 3 3M17 12h5m-3-3 3 3-3 3',enqueue:'M15 3v18M20 3v18M2 12h10m-4-4 4 4-4 4','group-queue':'M3 3h6v6H3zM15 3h6v6h-6zM5 16h14M15 12l4 4-4 4'};
   const titles={create:'Create a new blob',group:'Combine '+count+' selected blob'+(count===1?'':'s')+' into a group',ungroup:'Ungroup selected group',place:'Place a queue end',collapse:'Collapse '+count+' selected blob'+(count===1?'':'s')+' into a queue',restore:'Restore selected blobs from their queue',enqueue:'Add selected blobs to their queue','group-queue':'Turn selected group into a queue'};
   for(const [button,mode] of [[addButton,primary],[queueButton,queue]]){if(button.dataset.action!==mode){button.dataset.action=mode;button.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[mode]+'"/></svg>';}button.title=titles[mode];button.setAttribute('aria-label',titles[mode]);}
   deleteButton.disabled=!count;deleteButton.title=count?'Delete '+count+' selected blob'+(count===1?'':'s'):'Delete selected blobs';deleteButton.setAttribute('aria-label',deleteButton.title);
  }
  function paintSelection(){for(const [id,node] of [...bars,...outsideNames])node.classList.toggle('is-selected',selected.has(id));renderSelectionActions();}
  function selectRow(id,event){if(!items().some(x=>x.id===id))return;if(!event.ctrlKey&&!event.metaKey)selected.clear();selected.add(id);paintSelection();}
  function beginReorder(event,bar){if(event.button!==0||event.target.closest('.exact-resize-edge,.exact-queue-boundary,input')||inlineEditor)return;closeColor();const session=bar.interval,selectionBefore=[...selected];if(!selected.has(session.id)){if(!event.ctrlKey&&!event.metaKey)selected.clear();selected.add(session.id);}const moving=items().filter(x=>selected.has(x.id)),origin={x:event.clientX,y:event.clientY},now=clockNow(),originals=new Map(moving.map(x=>[x.id,{start:Date.parse(x.start),end:x.followNow?Math.max(Date.parse(x.start)+1,now):Date.parse(x.end),top:parseFloat(bars.get(x.id)?.style.top)||20,labelTop:parseFloat(outsideNames.get(x.id)?.style.top)||0}]));const dragPayload=selectionPayload(),dragIndex=new Map(allItems().map(x=>[x.id,x])),dragIds=new Set();function collect(key){if(dragIds.has(key))return;dragIds.add(key);for(const child of dragIndex.get(key)?.groupChildren||[])collect(child);}for(const item of moving)collect(item.id);let groupDrop=null;let moved=false,axis=null,target=null,swap=null,delta=0,blocked=false;const sliding=new Set(),clearRowSlide=()=>{for(const node of sliding)node.style.transform='';sliding.clear();};const preview=document.createElement('div');preview.className='exact-reorder-preview';preview.hidden=true;tracks.append(preview);
   const move=e=>{if(e.pointerId!==event.pointerId)return;const dx=e.clientX-origin.x,dy=e.clientY-origin.y;if(!moved&&Math.hypot(dx,dy)<5)return;if(!moved){moved=true;axis=moving.some(x=>x.groupChildren)?'vertical':Math.abs(dx)>Math.abs(dy)?'horizontal':'vertical';try{bar.setPointerCapture(event.pointerId);}catch{}reordering=true;}ignoreClickUntil=performance.now()+500;const point=queuePoint(e),row=ordered()[point.index],queue=queues().find(x=>x.id===(row?.rowId||row?.id));target={rowId:row?.rowId||row?.id,newRow:!row,index:point.index};queueDrag=null;swap=null;blocked=false;groupDrop=null;for(const node of bars.values())node.classList.remove('exact-group-drop-target');const center=20+point.index*ROW+21,localY=e.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop,groupBar=row?.groupChildren?bars.get(row.id):null,groupRect=groupBar?.getBoundingClientRect();if(row?.groupChildren&&!dragIds.has(row.id)&&Math.abs(localY-center)<=12&&groupRect&&e.clientX>=groupRect.left-10&&e.clientX<=groupRect.right+10){groupDrop=row.id;groupBar.classList.add('exact-group-drop-target');preview.hidden=false;preview.classList.remove('is-refused');preview.style.top=(20+point.index*ROW)+'px';preview.textContent='Add to '+row.name;clearRowSlide();for(const item of moving)for(const node of [bars.get(item.id),outsideNames.get(item.id)])if(node){node.style.top=(node===outsideNames.get(item.id)?originals.get(item.id).labelTop:originals.get(item.id).top)+'px';node.style.transform='translate('+dx+'px,'+dy+'px)';}drawQueues();return;}if(row?.groupChildren&&Math.abs(localY-center)>12&&Math.abs(dy)>18)axis='vertical';for(const item of moving)for(const node of [bars.get(item.id),outsideNames.get(item.id)])if(node)node.style.transform='';clearRowSlide();
    if(queue&&!moving.some(x=>x.groupChildren)&&queue.id!==session.queueId&&point.time>=clockNow()&&point.time<=Date.parse(queue.queue.end)){queueDrag={rowId:queue.id,ids:moving.map(x=>x.id),blocked:moving.some(x=>x.deadline||x.queueId)};blocked=queueDrag.blocked;preview.hidden=false;preview.style.top=(20+point.index*ROW)+'px';preview.textContent=blocked?'Cannot queue these tasks':'Queue '+moving.length+' task'+(moving.length===1?'':'s');drawQueues();return;}
    drawQueues();preview.textContent='';if(session.queueId&&axis==='horizontal'){swap=items().find(x=>x.queueId===session.queueId&&x.id!==session.id&&point.time>=Date.parse(x.start)&&point.time<=Date.parse(x.end));for(const node of bars.values())node.classList.toggle('exact-queue-swap-target',node.interval.id===swap?.id);bar.style.transform='translateX('+dx+'px)';const label=outsideNames.get(session.id);if(label)label.style.transform='translateX('+dx+'px)';return;}
    if(axis==='horizontal'){delta=Math.round(dx/scale);let low=-Infinity,high=Infinity;for(const item of moving){const initial=originals.get(item.id),duration=initial.end-initial.start;for(const neighbor of items().filter(x=>!selected.has(x.id)&&(x.rowId||x.id)===(item.rowId||item.id))){const a=Date.parse(neighbor.start),b=neighbor.followNow?Infinity:Date.parse(neighbor.end);if(b<=initial.start)low=Math.max(low,b-initial.start);else if(a>=initial.end)high=Math.min(high,a-duration-initial.start);}}delta=Math.max(low,Math.min(high,delta));for(const item of moving){const node=bars.get(item.id),initial=originals.get(item.id);if(node){node.style.left=geometry.position(initial.start+delta,start,scale)+'px';const label=outsideNames.get(item.id);if(label)label.style.transform='translateX('+(delta*scale)+'px)';}}return;}
    const order=ordered(),available=order.map((item,index)=>({item,index})).filter(x=>!dragIds.has(x.item.id)),local=e.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop;
    const destination=available.reduce((best,x)=>!best||Math.abs(20+x.index*ROW+21-local)<Math.abs(20+best.index*ROW+21-local)?x:best,null);
    target=destination?{groupReorder:true,anchorId:destination.item.id,after:local>20+destination.index*ROW+21}:null;const sourceParents=[...new Set(moving.map(item=>[...dragIndex.values()].find(group=>group.groupChildren?.includes(item.id))?.id))];if(sourceParents.length===1&&sourceParents[0]&&expandedGroups.has(sourceParents[0])){const source=dragIndex.get(sourceParents[0]),members=new Set();const gather=key=>{if(members.has(key))return;members.add(key);for(const child of dragIndex.get(key)?.groupChildren||[])gather(child);};gather(source.id);const sourceRows=order.map((item,index)=>({item,index})).filter(x=>members.has(x.item.id)),first=Math.min(...sourceRows.map(x=>x.index)),last=Math.max(...sourceRows.map(x=>x.index));if((local<20+first*ROW-14||local>20+last*ROW+42+14)&&(!destination||members.has(destination.item.id)))target={groupReorder:true,anchorId:source.id,after:local>20+last*ROW+42,ungroup:true};}
    preview.hidden=!target;preview.classList.remove('is-refused');clearRowSlide();if(target){const at=order.findIndex(x=>x.id===target.anchorId);if(target.ungroup){preview.style.top=(20+at*ROW+(target.after?60:0))+'px';preview.textContent='Remove from group';}else{const movingLanes=new Set([...dragIds].map(id=>dragIndex.get(id)).filter(Boolean).map(x=>laneId(items().find(y=>y.id===x.id)||x))),movingRows=order.filter(x=>movingLanes.has(laneId(x))),remaining=order.filter(x=>!movingLanes.has(laneId(x))),anchor=remaining.findIndex(x=>x.id===target.anchorId),insert=Math.max(0,anchor+(target.after?1:0)),projected=[...remaining.slice(0,insert),...movingRows,...remaining.slice(insert)];for(const item of items()){if(dragIds.has(item.id)||movingLanes.has(laneId(item)))continue;const lane=laneId(item),from=order.findIndex(x=>laneId(x)===lane),to=projected.findIndex(x=>laneId(x)===lane);if(from<0||to<0||from===to)continue;for(const node of [bars.get(item.id),outsideNames.get(item.id),deadlines.get(item.id)])if(node){node.classList.add('exact-reorder-shift');node.style.transform='translateY('+(to-from)*ROW+'px)';sliding.add(node);}}preview.textContent='';preview.style.top=(20+insert*ROW)+'px';}}
    for(const item of moving)for(const node of [bars.get(item.id),outsideNames.get(item.id),deadlines.get(item.id)])if(node)node.style.top=((node===outsideNames.get(item.id)?originals.get(item.id).labelTop:originals.get(item.id).top)+dy)+'px';};
   const finish=async e=>{if(e.pointerId!==event.pointerId)return;if(moved&&e.type==='pointerup')move(e);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);try{bar.releasePointerCapture(event.pointerId);}catch{}preview.remove();const settling=moved&&e.type==='pointerup'&&axis==='vertical'&&(target?.reorderRows||target?.groupReorder&&!target.ungroup)&&!blocked,settlePositions=settling?new Map([...bars.values(),...outsideNames.values(),...deadlines.values()].map(node=>[node,node.getBoundingClientRect()])):null;if(!settling)for(const node of tracks.querySelectorAll('.exact-reorder-shift')){node.classList.remove('exact-reorder-shift');node.style.transform='';}for(const item of moving)for(const node of [bars.get(item.id),outsideNames.get(item.id),deadlines.get(item.id)])if(node)node.style.transform='';for(const node of bars.values())node.classList.remove('exact-queue-swap-target','exact-group-drop-target');for(const node of outsideNames.values()){node.classList.remove('exact-drag-label-hidden');if(!settling)node.style.transform='';}if(!moved){selected.clear();for(const id of selectionBefore)selected.add(id);}else{ignoreClickUntil=performance.now()+350;if(e.type!=='pointercancel'){let command;if(groupDrop)command={type:'timeline-group.add',payload:{...dragPayload,groupId:groupDrop}};else if(axis==='vertical'&&target?.groupReorder)command={type:'timeline-group.reorder',payload:{...dragPayload,anchorId:target.anchorId,after:target.after}};else if(queueDrag&&!blocked)command={type:'timeline-queue.enqueue',payload:{rowId:queueDrag.rowId,intervalIds:moving.map(x=>x.id),revisions:Object.fromEntries(moving.map(x=>[x.id,x.rev]))}};else if(session.queueId&&axis==='horizontal'&&swap)command={type:'timeline-queue.swap',payload:{rowId:session.queueId,intervalId:session.id,targetId:swap.id}};else if(axis==='vertical'&&target?.reorderRows&&!blocked)command={type:'timeline-queue.reorder-rows',payload:{rowIds:target.reorderRows,beforeRowId:target.beforeRowId}};else if(axis==='horizontal'&&!session.groupChildren&&!session.queueId&&!blocked)command={type:'timeline-interval.move-selection',payload:{intervalIds:moving.map(x=>x.id),revisions:Object.fromEntries(moving.map(x=>[x.id,x.rev])),...(axis==='vertical'?{rowId:target.rowId,newRow:target.newRow}:{times:moving.map(x=>{const initial=originals.get(x.id);return{id:x.id,start:new Date(initial.start+delta).toISOString(),end:new Date(initial.end+delta).toISOString()};})})}};if(blocked)error.textContent='INTERVAL_OVERLAP';else if(command){const result=await store.command(command);if(!result.ok)error.textContent=result.code;}}}queueDrag=null;reordering=false;for(const node of tracks.querySelectorAll('.exact-reorder-shift')){node.classList.remove('exact-reorder-shift');node.style.transform='';}refresh();if(settlePositions&&!matchMedia('(prefers-reduced-motion: reduce)').matches){for(const [node,before] of settlePositions){if(!node.isConnected)continue;const after=node.getBoundingClientRect(),dx=before.left-after.left,dy=before.top-after.top;if(Math.abs(dx)+Math.abs(dy)<.5)continue;node.animate([{transform:'translate('+dx+'px,'+dy+'px)'},{transform:'translate(0,0)'}],{duration:220,easing:'cubic-bezier(.22,.8,.25,1)'});}}};window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);
  }
  let colorPicker=null,pickerIds=new Set();function closeColor(){colorPicker?.remove();colorPicker=null;pickerIds.clear();for(const bar of bars.values())bar.classList.remove('is-color-editing');}
  document.addEventListener('pointerdown',event=>{if(event.button===0&&colorPicker&&!colorPicker.contains(event.target))closeColor();},true);
  addButton.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();pickColor({defaultCreation:true,interval:{color:creationColor()}},event);});
  function pickColor(bar,event,complete=false){let freezeOnPick=complete||!!bar.interval.followNow&&!!event.target.closest?.('.exact-resize-end');closeColor();if(bar.interval.id){pickerIds=new Set(!complete&&selected.has(bar.interval.id)?selected:[bar.interval.id]);for(const [id,node] of bars)node.classList.toggle('is-color-editing',pickerIds.has(id));}const panel=document.createElement('div');panel.className='exact-color-picker';panel.setAttribute('aria-label','Blob color');const defaults=['#a1cc43','#63cdd5','#0984e3','#a981d9','#ed7c9b','#e5ad50','#ffffff'];let presets=defaults;try{presets=[...new Set(JSON.parse(localStorage.getItem('proxima.timeline.colors')||'null')??defaults)].filter(x=>/^#[0-9a-f]{6}$/i.test(x));}catch{}
   const custom=document.createElement('input');custom.type='color';custom.value=bar.interval.color||'#a1cc43';custom.title='Choose color';
   const field=document.createElement('input');field.type='text';field.className='exact-color-hex';field.value=custom.value;field.maxLength=7;field.setAttribute('aria-label','Hex color');
   const spectrum=document.createElement('div');spectrum.className='exact-color-spectrum';spectrum.setAttribute('aria-label','Choose saturation and brightness');const cursor=document.createElement('span');spectrum.append(cursor);const hue=document.createElement('input');hue.type='range';hue.min=0;hue.max=360;hue.value=0;hue.className='exact-color-hue';hue.setAttribute('aria-label','Hue');let saturation=1,brightness=1;
   function syncHex(color){custom.value=color;field.value=color;const rgb=color.slice(1).match(/../g).map(x=>parseInt(x,16)/255),max=Math.max(...rgb),min=Math.min(...rgb),d=max-min;let h=0;if(d){h=max===rgb[0]?((rgb[1]-rgb[2])/d)%6:max===rgb[1]?(rgb[2]-rgb[0])/d+2:(rgb[0]-rgb[1])/d+4;h=(h*60+360)%360;}hue.value=h;saturation=max?d/max:0;brightness=max;spectrum.style.backgroundColor='hsl('+h+' 100% 50%)';cursor.style.left=(saturation*100)+'%';cursor.style.top=((1-brightness)*100)+'%';}
   function preview(){const h=Number(hue.value)/60,c=brightness*saturation,x=c*(1-Math.abs(h%2-1)),m=brightness-c,rgb=h<1?[c,x,0]:h<2?[x,c,0]:h<3?[0,c,x]:h<4?[0,x,c]:h<5?[x,0,c]:[c,0,x];const color='#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');custom.value=color;field.value=color;spectrum.style.backgroundColor='hsl('+hue.value+' 100% 50%)';cursor.style.left=(saturation*100)+'%';cursor.style.top=((1-brightness)*100)+'%';return color;}
   spectrum.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();spectrum.setPointerCapture(e.pointerId);const move=e=>{const rect=spectrum.getBoundingClientRect();saturation=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));brightness=1-Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height));preview();};move(e);const finish=e=>{spectrum.removeEventListener('pointermove',move);spectrum.removeEventListener('pointerup',finish);spectrum.removeEventListener('pointercancel',finish);if(e.type!=='pointercancel')apply(preview());};spectrum.addEventListener('pointermove',move);spectrum.addEventListener('pointerup',finish);spectrum.addEventListener('pointercancel',finish);});hue.addEventListener('input',preview);hue.addEventListener('change',()=>apply(preview()));field.addEventListener('change',()=>{if(/^#[0-9a-f]{6}$/i.test(field.value)){syncHex(field.value);apply(field.value);}else field.value=custom.value;});syncHex(custom.value);
   const apply=async color=>{if(bar.defaultCreation){localStorage.setItem('proxima.timeline.creation-color',color);bar.interval.color=color;return;}if(!freezeOnPick&&selected.has(bar.interval.id)&&selected.size>1){const members=items().filter(x=>selected.has(x.id));const result=await store.command({type:'timeline-queue.color-selection',payload:{intervalIds:members.map(x=>x.id),revisions:Object.fromEntries(members.map(x=>[x.id,x.rev])),color}});if(!result.ok)error.textContent=result.code;refresh();return;}const item=bar.interval,patch={color};if(freezeOnPick&&item.followNow){patch.followNow=false;patch.end=new Date(Math.max(Date.parse(item.start)+1,clockNow())).toISOString();}const result=await store.command(freezeOnPick&&item.queueId?{type:'timeline-queue.complete',payload:{intervalId:item.id,color,rev:item.rev}}:{type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:item.id,patch}});if(!result.ok)error.textContent=result.code;else{if(freezeOnPick&&item.queueId)closeColor();freezeOnPick=false;}refresh();};
   const swatches=document.createElement('div');swatches.className='exact-color-swatches';function swatch(color){const button=document.createElement('button');button.type='button';button.style.background=color;button.title=color;button.setAttribute('aria-label','Use '+color);button.addEventListener('click',()=>{syncHex(color);apply(color);});button.addEventListener('pointerdown',e=>{if(e.button===1)e.preventDefault();});button.addEventListener('auxclick',e=>{if(e.button!==1)return;e.preventDefault();e.stopPropagation();presets=presets.filter(x=>x!==color);localStorage.setItem('proxima.timeline.colors',JSON.stringify(presets));button.remove();});swatches.append(button);}presets.forEach(swatch);
   custom.addEventListener('change',()=>{syncHex(custom.value);apply(custom.value);});const add=document.createElement('button');add.type='button';add.textContent='+';add.title='Save color preset';add.addEventListener('click',()=>{if(!presets.includes(custom.value)){presets.push(custom.value);localStorage.setItem('proxima.timeline.colors',JSON.stringify(presets));swatch(custom.value);}});panel.append(spectrum,hue,swatches,custom,field,add);if(!bar.defaultCreation){const label=document.createElement('label');label.className='exact-picker-check';const check=document.createElement('input');check.type='checkbox';check.checked=!!bar.interval.checked;label.append(check,document.createTextNode('Completed'));check.addEventListener('change',async()=>{const item=items().find(x=>x.id===bar.interval.id);if(!item)return;const patch={checked:check.checked,...(check.checked&&item.followNow&&!item.queueId?{followNow:false,end:new Date(Math.max(Date.parse(item.start)+1,clockNow())).toISOString()}:{})};const result=await store.command({type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:item.id,patch}});if(!result.ok){error.textContent=result.code;check.checked=!!item.checked;}else{freezeOnPick=false;if(item.queueId&&check.checked)closeColor();}refresh();});panel.append(label);}panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('click',e=>e.stopPropagation());panel.addEventListener('keydown',e=>{if(e.key==='Escape')closeColor();});element.append(panel);colorPicker=panel;panel.style.left=Math.max(0,Math.min(element.clientWidth-220,event.clientX-element.getBoundingClientRect().left))+'px';panel.style.top=Math.max(0,Math.min(element.clientHeight-250,event.clientY-element.getBoundingClientRect().top+10))+'px';}
  async function toggleLive(event,bar){if(bar.interval.queueId){event.preventDefault();event.stopPropagation();return;}timeEditor?.remove();timeEditor=null;event.preventDefault();event.stopPropagation();const item=bar.interval;const result=await store.command({type:'timeline-interval.patch',ifRev:item.rev,payload:{intervalId:item.id,patch:{followNow:!item.followNow,...(!item.followNow?{checked:false}:{}),end:new Date(Math.max(Date.parse(item.start)+1,clockNow())).toISOString()}}});if(!result.ok)error.textContent=result.code;refresh();}
  const marquee=document.createElement('div');marquee.className='exact-marquee';marquee.hidden=true;document.body.append(marquee);let baseSelection=[],subtract=false,appendMarquee=false,contactMarquee=false,lastMarqueePointer=null,marqueeStartX=0,suppressContextUntil=0;
  const marqueeController=createMarqueeController({elements:{grid:tracks,marquee,explorer:{getBoundingClientRect:()=>({left:0,top:0})}},itemSelector:'.exact-selectable',itemsIntersectingMarquee:(tiles,rect)=>tiles.filter(x=>contactMarquee?x.right>=rect.left&&x.left<=rect.right&&x.bottom>=rect.top&&x.top<=rect.bottom:x.left>=rect.left&&x.right<=rect.right&&x.top>=rect.top&&x.bottom<=rect.bottom).map(x=>x.id),commands:{beginMarqueeSelection:()=>{baseSelection=[...selected];return [];},updateMarqueeSelection:ids=>{selected.clear();for(const id of subtract?baseSelection.filter(x=>!ids.includes(x)):appendMarquee?[...new Set([...baseSelection,...ids])]:ids)selected.add(id);paintSelection();},finishMarqueeSelection:()=>{}}});
  element.addEventListener('pointerdown',event=>{if(event.button!==2||event.target.closest('input,button:not(.exact-outside-name),.exact-resize-edge,.exact-queue-boundary,.exact-deadline-edge'))return;event.preventDefault();event.stopImmediatePropagation();marqueeStartX=event.clientX;subtract=event.shiftKey;appendMarquee=event.ctrlKey||event.metaKey;contactMarquee=false;lastMarqueePointer={pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY};marqueeController.start(event);},true);
  element.addEventListener('contextmenu',event=>{if(!lastMarqueePointer||!marqueeController.isActive(lastMarqueePointer.pointerId))return;event.preventDefault();event.stopImmediatePropagation();},true);
  window.addEventListener('pointermove',event=>{if(!marqueeController.isActive(event.pointerId))return;subtract=event.shiftKey;appendMarquee=event.ctrlKey||event.metaKey;contactMarquee=event.clientX<marqueeStartX;lastMarqueePointer={pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY};marquee.classList.toggle('deselecting',subtract);marqueeController.move(event);});
  for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{if(!lastMarqueePointer||!marqueeController.isActive(lastMarqueePointer.pointerId)||!['Shift','Control','Meta'].includes(event.key))return;subtract=event.shiftKey;appendMarquee=event.ctrlKey||event.metaKey;marquee.classList.toggle('deselecting',subtract);marqueeController.move(lastMarqueePointer);});
  window.addEventListener('pointerup',event=>{if(marqueeController.isActive(event.pointerId)&&marqueeController.finish(event.pointerId)){suppressContextUntil=performance.now()+400;event.preventDefault();event.stopPropagation();}});
  window.addEventListener('pointercancel',()=>{marqueeController.cancel();selected.clear();for(const id of baseSelection)selected.add(id);refresh();});
  document.addEventListener('contextmenu',event=>{if(lastMarqueePointer&&marqueeController.isActive(lastMarqueePointer.pointerId)){event.preventDefault();event.stopImmediatePropagation();return;}if(settings.readOnly||!element.getClientRects().length||!selected.size||event.target.closest?.('.exact-color-picker,input,textarea,select,[contenteditable]:not([contenteditable="false"])')||document.querySelector('dialog[open]')||groupGestureOwner(event.target))return;/* right-click on a group always expands/collapses it, selected or not */event.preventDefault();event.stopImmediatePropagation();if(performance.now()<suppressContextUntil||!marquee.hidden||lastMarqueePointer&&marqueeController.isActive(lastMarqueePointer.pointerId))return;const bar=[...bars.values()].find(node=>selected.has(node.interval.id));if(bar)pickColor(bar,{clientX:event.clientX,clientY:event.clientY,target:element});},true);
  element.addEventListener('contextmenu',event=>{if(performance.now()<suppressContextUntil||!marquee.hidden){event.preventDefault();event.stopImmediatePropagation();}},true);
  tracks.addEventListener('click',event=>{if(performance.now()<ignoreClickUntil||event.target.closest?.('.exact-selectable,.exact-outside-name,.exact-resize-edge,.exact-queue-boundary,.exact-deadline-edge,.exact-queue-end,.exact-color-picker,.exact-edge-calendar,.exact-queue-delete,input,button'))return;selected.clear();paintSelection();});
  tracks.addEventListener('dblclick',e=>{if(e.target.closest?.('.exact-interval,.exact-queued-placeholder,input,button,.exact-outside-name,.exact-deadline-edge')||inlineEditor||reordering||resizing||deadlineResize||timeEditor||performance.now()<ignoreClickUntil)return;e.preventDefault();closeColor();const y=e.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop,index=Math.max(0,Math.min(laneCount,Math.floor((y-11)/ROW)));const t=geometry.time(e.clientX-element.getBoundingClientRect().left,start,scale);if(index<laneCount)addSession(index,t);else open(null,t,index);});
  tracks.addEventListener('contextmenu',async e=>{if(e.target.closest?.('.exact-interval,.exact-queued-placeholder,input,.exact-outside-name,.exact-color-picker,.exact-deadline-edge'))return;e.preventDefault();closeColor();if(inlineEditor||resizing||reordering)return;const y=e.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop,index=Math.floor(y/ROW),t=geometry.time(e.clientX-element.getBoundingClientRect().left,start,scale),activity=ordered()[index],row=activity&&currentSession(activity);if(!row||y<20+index*ROW||y>62+index*ROW||t<=clockNow())return;const result=await store.command({type:'timeline-interval.patch',ifRev:row.rev,payload:{intervalId:row.id,patch:{followNow:true,deadline:new Date(Math.round(t)).toISOString(),end:new Date(Math.max(Date.parse(row.start)+1,clockNow())).toISOString()}}});if(!result.ok)error.textContent=result.code;refresh();});
  let verticalScrollTarget=null,verticalScrollReset=0;
  element.addEventListener('wheel',e=>{e.preventDefault();if(resizing||deadlineResize||reordering||inlineEditor||timeEditor)return;if((settings.readOnly||tracks.scrollHeight>tracks.clientHeight+1)&&!e.ctrlKey&&!e.metaKey&&e.target.closest('.exact-tracks,.exact-horizontal-schedule')&&!e.shiftKey&&!e.deltaX){const pointer=e.clientX-element.getBoundingClientRect().left;if(verticalScrollSide(pointer)){clearTimeout(verticalScrollReset);verticalScrollTarget=Math.max(0,Math.min(tracks.scrollHeight-tracks.clientHeight,(verticalScrollTarget??tracks.scrollTop)+e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?tracks.clientHeight:1)));tracks.scrollTo({top:verticalScrollTarget,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});verticalScrollReset=setTimeout(()=>verticalScrollTarget=null,500);return;}}const region=e.target.closest?.('.exact-current-year,.exact-year-divider')?'year':e.target.closest?.('.exact-month-strip,.exact-month-divider')?'month':e.target.closest?.('.exact-date-strip')?'day':null;const span=region==='year'?365.2425*86400000:region==='month'?30.436875*86400000:region==='day'?86400000:0;const potency=span?Math.max(1,span*scale/100):1;const delta=(e.deltaX||e.deltaY)*(e.deltaMode===1?16:e.deltaMode===2?element.clientWidth:1)*(e.ctrlKey?Math.max(1,Math.log2(1+potency)):potency);if(e.ctrlKey){const x=e.clientX-element.getBoundingClientRect().left;const nextScale=geometry.zoom(start,goal?.scale||scale,Math.exp(Math.max(-20,Math.min(20,-delta*.002))),x).scale;animate({start:geometry.time(x,start,scale)-x/nextScale,scale:nextScale},x);}else animate({start:(goal?.start||start)+delta/(goal?.scale||scale),scale:goal?.scale||scale},null);},{passive:false});
  element.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.key==='Enter'&&e.target===element){e.preventDefault();open(null,geometry.time(element.clientWidth/2,start,scale));}if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();start+=(e.key==='ArrowLeft'?-100:100)/scale;render();}});
  document.addEventListener('pointerdown',event=>{if(queueDeletePrompt&&!queueDeletePrompt.contains(event.target)){queueDeletePrompt.remove();queueDeletePrompt=null;}if(timeEditor&&!timeEditor.contains(event.target)){timeEditor.remove();timeEditor=null;}},true);
  document.addEventListener('keydown',async e=>{if(settings.remoteReadOnly&&e.key.toLowerCase()!=='f')return;if(queueDeletePrompt&&e.key==='Escape'){queueDeletePrompt.remove();queueDeletePrompt=null;e.preventDefault();return;}if(placingQueue&&e.key==='Escape'){e.preventDefault();cancelQueuePlacement();return;}if(timeEditor){if(e.key==='Escape'){e.preventDefault();timeEditor.remove();timeEditor=null;}return;}if(e.key==='Escape'&&element.getClientRects().length&&!e.target.closest?.('input,textarea')){marqueeController.cancel();selected.clear();suppressContextUntil=performance.now()+400;refresh();e.preventDefault();return;}if(!element.getClientRects().length||e.repeat||e.altKey||e.metaKey||e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')||document.querySelector('dialog[open]'))return;if(e.key==='Delete'){e.preventDefault();await deleteSelection();return;}const key=e.key.toLowerCase();if(key!=='z'&&key!=='y')return;e.preventDefault();if(resizing||deadlineResize||reordering||inlineEditor||timeEditor)return;const result=await store.command({type:key==='z'?'timeline.undo':'timeline.redo',payload:{}});if(!result.ok)error.textContent=result.code==='HISTORY_CONFLICT'?'This item changed elsewhere; undo was not applied.':result.code;else error.textContent='';refresh();});
  const remainingLabel=document.createElement('span');remainingLabel.className='exact-time-left';element.append(remainingLabel);
  function hideRemaining(){remainingLabel.classList.remove('is-visible');if(blobName.dataset.elapsedPopup){delete blobName.dataset.elapsedPopup;blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');}}
  function showRemaining(event,row){const activity=ordered()[row],now=clockNow(),t=geometry.time(event.clientX-element.getBoundingClientRect().left,start,scale);const sessions=activity?items().filter(x=>(x.rowId||x.id)===(activity.rowId||activity.id)).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)):[];const item=sessions.find(x=>(x.followNow?now:Date.parse(x.end))>t)||sessions.at(-1);if(!item||item.queueId&&item.queueIndex>0){hideRemaining();return;}const begin=Date.parse(item.start),finish=item.followNow?now:Date.parse(item.end),deadline=Date.parse(item.deadline),elapsed=t<finish;if(elapsed&&(finish<=start||begin>=start+element.clientWidth/scale||20+row*ROW+42<=tracks.scrollTop||20+row*ROW>=tracks.scrollTop+tracks.clientHeight)){hideRemaining();return;}let duration;if(elapsed){duration=Math.max(0,Math.min(now,finish)-begin);}else if(item.followNow&&Number.isFinite(deadline)&&deadline>now&&t>=now){duration=deadline-now;}else{hideRemaining();return;}const total=Math.ceil(duration/60000),days=Math.floor(total/1440),hours=Math.floor(total%1440/60),minutes=total%60;remainingLabel.textContent=[days?days+'d':'',hours?hours+'h':'',minutes?minutes+'m':''].filter(Boolean).join(' ')||'<1m';remainingLabel.classList.toggle('is-elapsed',elapsed);remainingLabel.setAttribute('aria-label',(elapsed?'Elapsed: ':'Time left: ')+remainingLabel.textContent);const pointer=event.clientX-element.getBoundingClientRect().left,edgeX=elapsed?0:element.clientWidth,labelWidth=remainingLabel.getBoundingClientRect().width;remainingLabel.style.left=Math.max(4,Math.min(element.clientWidth-labelWidth-4,(pointer+edgeX)/2-labelWidth/2))+'px';remainingLabel.style.top=(tracks.getBoundingClientRect().top-element.getBoundingClientRect().top+20+row*ROW-tracks.scrollTop+10)+'px';remainingLabel.intervalId=item.id;remainingLabel.classList.add('is-visible');const badge=remainingLabel.getBoundingClientRect();const conflicts=[...outsideNames.values(),...bars.values()].some(node=>{const label=node.classList.contains('exact-outside-name')?node:node.querySelector('.exact-interval-caption');if(!label||label.hidden||getComputedStyle(label).visibility==='hidden'||node.nameHidden)return false;const box=label.getBoundingClientRect();return badge.left<box.right+16&&badge.right>box.left-16&&badge.top<box.bottom&&badge.bottom>box.top;});if(conflicts){const text=remainingLabel.textContent;hideRemaining();showBlobName({nameHidden:true,interval:{name:text,color:item.color}},event);blobName.dataset.elapsedPopup='true';}else if(blobName.dataset.elapsedPopup){delete blobName.dataset.elapsedPopup;blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');}}
  let hoveredRow=null;
  const rowNav=document.createElement('div');rowNav.className='exact-row-nav';for(const edge of ['start','end']){const arrow=document.createElement('button');arrow.type='button';arrow.className='exact-row-arrow exact-row-arrow-'+edge;arrow.textContent=edge==='start'?'‹':'›';arrow.title=edge==='start'?'Go to row start':'Go to row end';arrow.setAttribute('aria-label',arrow.title);arrow.addEventListener('pointerdown',e=>e.stopPropagation());arrow.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const time=arrow.targetTime;if(!Number.isFinite(time))return;const nextScale=goal?.scale||scale;animate({start:time-element.clientWidth*.5/nextScale,scale:nextScale},null);});rowNav.append(arrow);}element.append(rowNav);
  function showRowNav(row){hoveredRow=row;const activity=row!==null?ordered()[row]:null,sessions=activity?items().filter(x=>(x.rowId||x.id)===(activity.rowId||activity.id)&&!(x.queueId&&x.queueIndex>0)):[],end=start+element.clientWidth/scale,visible=sessions.filter(x=>Date.parse(x.start)<end&&(x.followNow?clockNow():Date.parse(x.end))>start),item=visible.length===1?visible[0]:sessions.length===1?sessions[0]:null,queue=activity?queues().find(x=>x.id===(activity.rowId||activity.id)):null;let active=false;for(const arrow of rowNav.children){const left=arrow.classList.contains('exact-row-arrow-start'),a=item?Date.parse(item.start):NaN,b=!left&&queue?Date.parse(queue.queue.end):item?(item.followNow?clockNow():Date.parse(item.end)):NaN;const available=!!(item||!left&&queue)&&(left?a<start:b>end);arrow.hidden=!available;arrow.targetTime=available?(left?(b<start?b:a):(a>end?a:b)):null;arrow.title=left?'Go to blob’s left edge':'Go to blob’s right edge';arrow.setAttribute('aria-label',arrow.title);active||=available;}rowNav.classList.toggle('is-visible',active);if(row!==null)rowNav.style.top=(tracks.getBoundingClientRect().top-element.getBoundingClientRect().top+20+row*ROW-tracks.scrollTop)+'px';}

  const hoverRegions=new Map();
  function clearRegionHover(){hideRemaining();showRowNav(null);for(const overlay of hoverRegions.values())overlay.classList.remove('is-hovered');}
  element.addEventListener('pointermove',event=>{if(event.target.closest('.exact-name-check')){hideRemaining();blobName.classList.remove('is-visible');nameLeader.classList.remove('is-visible');clearRegionHover();return;}if(event.target.closest('.exact-horizontal-schedule')){clearRegionHover();return;}if(event.target.closest('.exact-row-arrow')){hideRemaining();return;}if(resizing||deadlineResize||reordering||event.target.closest('.exact-color-picker,.exact-edge-calendar,.exact-return-now')){clearRegionHover();return;}const target=event.target.closest('.exact-current-year,.exact-year-divider')||event.target.closest('.exact-month-strip')||event.target.closest('.exact-date-strip')||event.target.closest('.exact-ruler')||tracks;
   const pointer=event.clientX-element.getBoundingClientRect().left,verticalSide=(settings.readOnly||tracks.scrollHeight>tracks.clientHeight+1)&&target===tracks&&(verticalScrollSide(pointer));let sideKey=null;if(verticalSide){const key=verticalScrollSide(pointer);sideKey=key;let overlay=hoverRegions.get(key);if(!overlay){overlay=document.createElement('div');overlay.className='exact-scroll-hover';overlay.setAttribute('aria-hidden','true');element.append(overlay);hoverRegions.set(key,overlay);}const host=element.getBoundingClientRect(),rect=tracks.getBoundingClientRect();overlay.style.left=(key==='vertical-left'?availableViewport().left:availableViewport().right-availableViewport().width/8)+'px';overlay.style.top=(rect.top-host.top)+'px';overlay.style.width=(availableViewport().width/8)+'px';overlay.style.height=rect.height+'px';}if(far&&target===tracks){hideRemaining();showRowNav(null);for(const [key,node] of hoverRegions)node.classList.toggle('is-hovered',key===sideKey);return;}/* far zoom: no row band or duration label */const kind=target.matches('.exact-current-year,.exact-year-divider')?'year':target===monthStrip?'month':target===dateStrip?'day':target===ruler?'time':'body';const row=kind==='body'?Math.max(0,Math.floor((event.clientY-tracks.getBoundingClientRect().top+tracks.scrollTop-11)/ROW)):null;const regionKey=kind==='body'?'row-'+row:kind;showRowNav(kind==='body'?row:null);if(kind==='body'){const pointerX=event.clientX-element.getBoundingClientRect().left;if(pointerX<70||pointerX>element.clientWidth-70||event.target.closest('.exact-interval,.exact-queued-placeholder')?.nameHidden)hideRemaining();else showRemaining(event,row);}else hideRemaining();let overlay=hoverRegions.get(regionKey);if(!overlay){overlay=document.createElement('div');overlay.className='exact-scroll-hover';overlay.setAttribute('aria-hidden','true');element.append(overlay);hoverRegions.set(regionKey,overlay);}const host=element.getBoundingClientRect(),rect=target.getBoundingClientRect();overlay.style.left=(rect.left-host.left)+'px';overlay.style.top=(rect.top-host.top+(kind==='time'?78:kind==='body'?11+row*ROW-tracks.scrollTop:0))+'px';overlay.style.width=rect.width+'px';overlay.style.height=(kind==='time'?22:kind==='body'?60:rect.height)+'px';for(const [key,node] of hoverRegions)node.classList.toggle('is-hovered',key===regionKey||key===sideKey);
  });element.addEventListener('pointerleave',clearRegionHover);
  const returnNow=document.createElement('button');returnNow.type='button';returnNow.className='exact-return-now';returnNow.title='Return to current time';returnNow.setAttribute('aria-label','Return to current time');element.append(returnNow);returnNow.addEventListener('click',event=>{event.stopPropagation();closeColor();if(resizing||deadlineResize||reordering||inlineEditor||timeEditor)return;returnToLive();});
  new ResizeObserver(refresh).observe(element);
  let paneTimeAnchor=null;
  function capturePaneTimeAnchor(event){
   paneTimeAnchor=null;
   if(!element.getClientRects().length)return;
   const view=availableViewport(),x=geometry.position(clockNow(),start,scale);
   if(view.width>0&&x>=view.left&&x<=view.right)
    paneTimeAnchor={fraction:(x-view.left)/view.width,visible:event.detail.visible};
  }
  function paneLayoutChanged(){
   const visible=!!document.querySelector('.blob-workspace-pane:not([hidden])');
   if(paneTimeAnchor&&paneTimeAnchor.visible===visible){
    const view=availableViewport();
    if(view.width>0){
     cancelAnimationFrame(animation);goal=null;
     start=clockNow()-(view.left+paneTimeAnchor.fraction*view.width)/scale;
    }
    paneTimeAnchor=null;
   }
   render();
  }
  window.addEventListener('proxima:blob-pane-toggle',capturePaneTimeAnchor);
  window.addEventListener('proxima:blob-pane-geometry',paneLayoutChanged);
  window.addEventListener('pagehide',()=>{window.removeEventListener('proxima:blob-pane-toggle',capturePaneTimeAnchor);window.removeEventListener('proxima:blob-pane-geometry',paneLayoutChanged);},{once:true});
  // Live edges follow the clock, but redrawing every second costs a whole timeline render (heavy on the
  // phone): redraw only once "now" has moved at least a pixel, and never on a hidden page.
  let liveDrawnAt=0;
  const timer=setInterval(()=>{if(document.hidden)return;if((!options.isActive||options.isActive())&&element.getClientRects().length){const now=tracks.querySelector('.exact-now');if(now)now.style.left=geometry.position(clockNow(),start,scale)+'px';for(const ring of tracks.querySelectorAll('.exact-task-ring')){const item=ring.parentElement.interval,task=item?.tasks?.find(task=>!task.completedAt);if(task)updateTaskRing(ring,item,task);}if(!reordering&&!resizing&&Math.abs(clockNow()-liveDrawnAt)*scale>=1){if(queues().length||layout.some(x=>x.item.sourceLive)){liveDrawnAt=clockNow();refresh();}else if(layout.some(({item})=>item.followNow||item.groupLive||item.tasks?.some(task=>!task.completedAt))){liveDrawnAt=clockNow();render();}}}},1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  scheduleBand.addEventListener('scroll',scheduleLayoutSave);tracks.addEventListener('scroll',()=>{scheduleLayoutSave();render();showRowNav(null);hideRemaining();});
  element.dataset.proximaBack='true';
  element.papersPhoneBack=()=>{
   if(inlineEditor?.papersCancelEdit){inlineEditor.papersCancelEdit();return true;}
   if(timeEditor?.papersCancelEdit){timeEditor.papersCancelEdit();return true;}
   if(queueDeletePrompt?.papersCancelEdit){queueDeletePrompt.papersCancelEdit();return true;}
   if(colorPicker){closeColor();return true;}
   if(placingQueue){placingQueue=false;queueButton.classList.remove('is-active');element.classList.remove('exact-placing-queue');render();return true;}
   if(shiftExtension){clearExtension();return true;}
   if(selected.size){selected.clear();paintSelection();return true;}
   if(groupTrail.length){leaveTo(groupTrail.length-1);return true;}
   return false;
  };
  const api={refresh,returnToLive,getViewport:()=>({start,scale}),configure(next){if(next.layoutKey)options.layoutKey=next.layoutKey;const changesMode=typeof next.readOnly==='boolean'&&!!next.readOnly!==!!settings.readOnly;if(changesMode)saveScheduleState();Object.assign(settings,next);if(changesMode){scheduleDay=scheduleStates[settings.readOnly?'preview':'main'];scheduleToggle.setAttribute('aria-expanded',String(scheduleDay!==null));render();}},animateViewport(view){initialized=true;animate(view,null);},setViewport(view){if(Number.isFinite(view.start)&&Number.isFinite(view.scale)&&view.scale>0){start=view.start;scale=view.scale;initialized=true;render();scheduleLayoutSave();}}};instances.set(element,api);refresh();if(savedLayout){tracks.scrollTop=Math.max(0,savedLayout.scrollTop||0);scheduleBand.scrollTop=Math.max(0,savedLayout.scheduleScrollTop||0);}scheduleToggle.setAttribute('aria-expanded',String(scheduleDay!==null));return api;
 }
 root.ExactTimeline={geometry,mount,queueSelectionAction,extensionEdge,occupiedLanes,firstFreeRow,taskFillShape,taskLineStops};
})(globalThis);
