(function(root){
 'use strict';let signature='',busy=false;
 async function publish(){
  if(busy||document.hidden||location.protocol!=='papers-backpack:'||root.__proximaDevice)return;
  busy=true;
  try{
   await Store.flushCommands?.();
   const all=Store.timelineIntervals(),byId=new Map(all.map(item=>[item.id,item]));
   const cache=JSON.parse(localStorage.getItem('proxima.flow.confirmed-pages.v1')||'{}');
   const live=(item,seen=new Set())=>{if(!item||seen.has(item.id))return false;const next=new Set([...seen,item.id]);return !!item.followNow||(item.groupChildren||[]).some(id=>live(byId.get(id),next));};
   const projected=new Map();
   for(const item of all)for(const binding of item.templates||(item.template?[item.template]:[])){
    if(binding.kind!=='appflowy')continue;const page=cache[binding.documentId];if(!page?.viewId||!page.workspaceId)continue;
    const key=page.workspaceId+'/'+page.viewId,previous=projected.get(key);
    projected.set(key,{workspaceId:page.workspaceId,viewId:page.viewId,live:live(item)||!!previous?.live});
   }
   const pages=[...projected.values()].sort((a,b)=>a.viewId.localeCompare(b.viewId)),text=JSON.stringify(pages);
   if(signature===text)return;
   const result=await root.ProximaWorkspaces.call('program-window-follow',{template:'appflowy',pages});
   if(result?.ok!==false)signature=text;
  }catch(error){if(!root.__flowFollowReported){console.warn('Flow space follow:',error.message);root.__flowFollowReported=true;}}
  finally{busy=false;}
 }
 const timer=setInterval(publish,3000);document.addEventListener('visibilitychange',publish);addEventListener('pagehide',()=>clearInterval(timer),{once:true});void publish();
})(globalThis);
