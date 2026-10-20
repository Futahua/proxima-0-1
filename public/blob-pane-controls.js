/* Blob pane controls (creator, 2026-10-20):
 * - the pane's left edge drags to resize it; the width is remembered on this device;
 * - inline fullscreen: the pane fills the whole page (Shift+Tab, double-click the edge, or
 *   drag the edge to the far left); remembered too, and dragging the edge back leaves it;
 * - Tab on the timeline (not while typing) collapses the open blob pane, and Tab again
 *   reopens the blob pane last visited.
 * Works on the pane blob-workspaces.js builds; does not change how panes open or close. */
(function(root){
 'use strict';
 const WIDTH_KEY='proxima.blobPane.width',FULL_KEY='proxima.blobPane.full',LAST_KEY='proxima.blobPane.last';
 const MIN=320,EDGE=8,SNAP=48;
 const coarse=()=>matchMedia('(pointer:coarse)').matches;
 const projectPage=()=>document.documentElement.classList.contains('blob-project-page');
 const pane=()=>document.querySelector('.blob-workspace-pane');
 const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
 const write=(key,value)=>{try{if(value==null)localStorage.removeItem(key);else localStorage.setItem(key,String(value));}catch{}};
 let lastBlob=read(LAST_KEY),handle=null,scheduled=false;

 const maxWidth=()=>Math.max(MIN,innerWidth-24);
 const savedWidth=()=>{const v=Number(read(WIDTH_KEY));return Number.isFinite(v)&&v>=MIN?v:null;};
 const isFull=(node=pane())=>!!node&&node.classList.contains('blob-pane-full');
 function setFull(full,node=pane()){
  if(!node)return;
  node.classList.toggle('blob-pane-full',full);write(FULL_KEY,full?'1':null);schedule();
 }
 function applySaved(node=pane()){
  if(!node||coarse()||projectPage())return;
  const width=savedWidth();if(width)node.style.width=Math.min(width,maxWidth())+'px';
  node.classList.toggle('blob-pane-full',read(FULL_KEY)==='1');
 }
 // The grab strip sits just outside the pane's left edge, so a program window docked over
 // the pane's body never covers it.
 function placeHandle(){
  scheduled=false;const node=pane();
  if(!handle)return;
  if(!node||node.hidden||coarse()||projectPage()){handle.hidden=true;return;}
  const r=node.getBoundingClientRect();
  Object.assign(handle.style,{left:Math.max(0,Math.round(r.left-EDGE/2))+'px',top:Math.round(r.top)+'px',height:Math.round(r.height)+'px'});
  handle.title=isFull(node)?'Drag to narrow · double-click to leave fullscreen':'Drag to resize · double-click for fullscreen';
  handle.hidden=false;
 }
 const schedule=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(placeHandle);};
 function buildHandle(){
  if(handle)return;
  handle=document.createElement('div');handle.className='blob-pane-resize';handle.hidden=true;
  handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Resize blob contents');
  handle.addEventListener('pointerdown',event=>{
   const node=pane();if(!node||event.button!==0)return;
   event.preventDefault();try{handle.setPointerCapture(event.pointerId);}catch{}document.documentElement.classList.add('blob-pane-resizing');
   const right=innerWidth-node.getBoundingClientRect().right,startX=event.clientX;let moved=false;
   const move=e=>{
    if(!moved&&Math.abs(e.clientX-startX)<3)return;moved=true;
    // Dragging all the way left is fullscreen; anywhere else is a width.
    if(e.clientX<SNAP){node.classList.add('blob-pane-full');schedule();return;}
    node.classList.remove('blob-pane-full');
    node.style.width=Math.round(Math.min(maxWidth(),Math.max(MIN,innerWidth-right-e.clientX)))+'px';schedule();
   };
   const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
    document.documentElement.classList.remove('blob-pane-resizing');if(!moved)return;
    if(isFull(node))write(FULL_KEY,'1');else{write(FULL_KEY,null);write(WIDTH_KEY,Math.round(node.getBoundingClientRect().width));}};
   handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  });
  handle.addEventListener('dblclick',()=>setFull(!isFull()));
  document.body.append(handle);
 }
 function watch(node){
  if(node.__blobPaneControls)return;node.__blobPaneControls=true;
  applySaved(node);
  new ResizeObserver(schedule).observe(node);
  new MutationObserver(schedule).observe(node,{attributes:true,attributeFilter:['hidden','style','class']});
  schedule();
 }
 new MutationObserver(()=>{const node=pane();if(node)watch(node);}).observe(document.body,{childList:true});
 addEventListener('resize',()=>{const node=pane();if(node&&!coarse()&&!projectPage()){const width=savedWidth();if(width)node.style.width=Math.min(width,maxWidth())+'px';}schedule();});

 // Remember which blob was opened last.
 addEventListener('proxima:blob-open',event=>{if(!event.detail?.id)return;lastBlob=event.detail.id;write(LAST_KEY,lastBlob);});
 const typing=target=>target instanceof Element&&!!target.closest('input,textarea,select,[contenteditable=""],[contenteditable=true]');
 // Capture phase: the timeline stops Tab key events before they reach the window.
 addEventListener('keydown',event=>{
  if(event.key!=='Tab'||event.ctrlKey||event.altKey||event.metaKey)return;
  if(typing(event.target)||projectPage()||document.querySelector('dialog[open],[role=dialog]:not([hidden])'))return;
  const node=pane(),open=node&&!node.hidden;
  if(event.shiftKey){
   // Shift+Tab: inline fullscreen for the open pane (or open the last blob in fullscreen).
   if(open){event.preventDefault();event.stopPropagation();setFull(!isFull(node));return;}
   if(lastBlob&&root.ProximaBlobWorkspaces&&Store.timelineIntervals().some(x=>x.id===lastBlob)){event.preventDefault();event.stopPropagation();write(FULL_KEY,'1');if(node)node.classList.add('blob-pane-full');root.ProximaBlobWorkspaces.open(lastBlob);}
   return;
  }
  if(open){event.preventDefault();event.stopPropagation();const close=node.querySelector("header>button[aria-label='Close blob contents']");if(close)close.click();else node.hidden=true;return;}
  if(lastBlob&&root.ProximaBlobWorkspaces&&Store.timelineIntervals().some(x=>x.id===lastBlob)){event.preventDefault();event.stopPropagation();root.ProximaBlobWorkspaces.open(lastBlob);}
 },true);

 // Template tabs look and drag like Papers' own tab strip; their order is remembered per blob.
 const ORDER_KEY=id=>'proxima.blobPane.tabOrder.'+id;
 const tabsOf=nav=>[...nav.querySelectorAll(':scope>button')];
 const label=tab=>tab.textContent.trim();
 function applyOrder(nav){
  if(!lastBlob)return;let order;try{order=JSON.parse(read(ORDER_KEY(lastBlob))||'null');}catch{order=null;}
  if(!Array.isArray(order))return;
  const tabs=tabsOf(nav),rank=tab=>{const i=order.indexOf(label(tab));return i<0?order.length:i;};
  const sorted=[...tabs].sort((a,b)=>rank(a)-rank(b));
  if(sorted.some((tab,i)=>tab!==tabs[i]))nav.append(...sorted);
 }
 function enableTabDrag(nav){
  if(nav.__blobTabDrag)return;nav.__blobTabDrag=true;
  new MutationObserver(()=>applyOrder(nav)).observe(nav,{childList:true});applyOrder(nav);
  let suppressClick=false;
  nav.addEventListener('click',event=>{if(suppressClick){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);
  nav.addEventListener('pointerdown',event=>{
   const tab=event.target.closest('.blob-template-tabs>button');if(!tab||event.button!==0)return;
   const startX=event.clientX;let dragging=false;
   const move=e=>{
    if(!dragging){if(Math.abs(e.clientX-startX)<5)return;dragging=true;tab.classList.add('is-dragging');try{tab.setPointerCapture(e.pointerId);}catch{}}
    // Swap with a neighbour once the pointer passes that neighbour's middle.
    const tabs=tabsOf(nav),i=tabs.indexOf(tab);
    const prev=tabs[i-1],next=tabs[i+1];
    if(prev&&e.clientX<prev.getBoundingClientRect().left+prev.offsetWidth/2)nav.insertBefore(tab,prev);
    else if(next&&e.clientX>next.getBoundingClientRect().left+next.offsetWidth/2)nav.insertBefore(next,tab);
   };
   const end=()=>{removeEventListener('pointermove',move,true);removeEventListener('pointerup',end,true);removeEventListener('pointercancel',end,true);
    if(!dragging)return;tab.classList.remove('is-dragging');suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    if(lastBlob)write(ORDER_KEY(lastBlob),JSON.stringify(tabsOf(nav).map(label)));};
   addEventListener('pointermove',move,true);addEventListener('pointerup',end,true);addEventListener('pointercancel',end,true);
  });
 }
 new MutationObserver(()=>{const nav=pane()?.querySelector('.blob-template-tabs');if(nav)enableTabDrag(nav);}).observe(document.body,{childList:true,subtree:true});

 const style=document.createElement('style');
 style.textContent='.blob-pane-resize{position:fixed;z-index:901;width:'+EDGE+'px;cursor:ew-resize;touch-action:none}.blob-pane-resize[hidden]{display:none}.blob-pane-resize:hover,.blob-pane-resizing .blob-pane-resize{background:#a8c98d55}.blob-pane-resizing,.blob-pane-resizing *{cursor:ew-resize!important;user-select:none}.blob-pane-resizing iframe{pointer-events:none}'
  +'@media(pointer:fine){.blob-workspace-pane.blob-pane-full{left:12px;width:auto!important}}'
  // Papers group tabs: compact rounded-top tabs on a dark strip; the open one is lifted and outlined.
  +'.blob-workspace-pane header .blob-template-tabs{gap:2px;align-items:flex-end;align-self:stretch;padding-top:4px}'
  +'.blob-workspace-pane header .blob-template-tabs button{display:flex;align-items:center;min-width:92px;max-width:180px;padding:6px 12px;font:11px system-ui;text-align:left;color:#c3ccd6;background:#ffffff08;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;cursor:default;user-select:none;touch-action:none}'
  +'.blob-workspace-pane header .blob-template-tabs button:hover{background:#ffffff14;color:#e6e9ef}'
  +'.blob-workspace-pane header .blob-template-tabs button[aria-pressed=true]{background:#3a4757;color:#fff;border-color:#9ebc84;border-bottom-color:transparent}'
  +'.blob-workspace-pane header .blob-template-tabs button.is-dragging{opacity:.75;outline:1px dashed #9ebc84}';
 document.head.append(style);
 buildHandle();const existing=pane();if(existing)watch(existing);
})(globalThis);
