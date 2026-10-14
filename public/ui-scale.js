/* Ctrl+wheel over the header (calendar, clock, device name) or the month/day strip scales the whole
   Proxima view with Papers' real page zoom, so layout, viewport heights and pointer positions stay
   consistent. The size is remembered per device; Ctrl+wheel over the blobs keeps its own meaning. */
(function(root){
  if(new URLSearchParams(root.location.search).has('papers-phone'))return; // the phone pinches instead
  const KEY='proxima.pageZoom',MIN=0.6,MAX=2;
  const zone='.schedule-head,.exact-month-strip,.exact-date-strip,.exact-current-year';
  const read=()=>{try{const value=Number(root.localStorage.getItem(KEY));return Number.isFinite(value)&&value>=MIN&&value<=MAX?value:1;}catch{return 1;}};
  let scale=read();
  const apply=()=>root.postMessage({type:'papers:project:page-zoom',factor:scale},'*');
  try{root.localStorage.removeItem('proxima.uiScale');}catch{/* the earlier CSS-zoom setting is retired */}
  apply(); // also clears a zoom Chromium kept for this origin
  root.addEventListener('wheel',event=>{
    if(!(event.ctrlKey||event.metaKey)||!event.target?.closest?.(zone))return;
    event.preventDefault();event.stopImmediatePropagation();
    const next=Math.round(Math.max(MIN,Math.min(MAX,scale*(event.deltaY>0?1/1.1:1.1)))*100)/100;
    if(next===scale)return;
    scale=Math.abs(next-1)<0.04?1:next;apply();
    try{root.localStorage.setItem(KEY,String(scale));}catch{/* the size still applies until reload */}
  },{capture:true,passive:false});
})(window);
