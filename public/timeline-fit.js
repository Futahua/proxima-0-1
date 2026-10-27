/* The timeline reaches exactly to the bottom of the pane, whatever sits above it (header height,
   page zoom, pane size), instead of a fixed guess of the header's height. */
(function(root){
  if(new URLSearchParams(root.location.search).has('papers-phone'))return; // the phone lays itself out
  let frame=0;
  const fit=()=>{frame=0;const timeline=root.document.getElementById('exactTimeline');if(!timeline||!timeline.isConnected)return;
    if(timeline.closest('#calendarTimelinePeek')){timeline.style.removeProperty('--exact-fit-height');return;}
    const main=root.document.querySelector('main'),below=main?parseFloat(getComputedStyle(main).paddingBottom)||0:0;
    const panels=timeline.closest('.tk-panels'),gap=panels?parseFloat(getComputedStyle(panels).paddingBottom)||0:0;
    const height=Math.max(220,Math.floor(root.innerHeight-timeline.getBoundingClientRect().top-below-gap-2));
    if(timeline.style.getPropertyValue('--exact-fit-height')!==height+'px')timeline.style.setProperty('--exact-fit-height',height+'px');};
  const schedule=()=>{if(!frame)frame=root.requestAnimationFrame(fit);};
  root.addEventListener('resize',schedule);root.addEventListener('scroll',schedule,{passive:true});
  new ResizeObserver(schedule).observe(root.document.documentElement);
  new MutationObserver(schedule).observe(root.document.body,{subtree:true,attributes:true,attributeFilter:['hidden']});
  const watchHead=()=>{const head=root.document.querySelector('.schedule-head');if(head)new ResizeObserver(schedule).observe(head);};if(root.document.readyState==='loading')root.addEventListener('DOMContentLoaded',watchHead,{once:true});else watchHead();
  schedule();
})(window);
