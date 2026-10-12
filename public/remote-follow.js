/* Follow policy produces plans; Store.command remains the only mutation owner. */
(function(root){
 const domain=()=>root.ProximaRemoteDomain;
 const anchor=(kind,item)=>kind==='importedRuns'&&item.sourceLineage?.kind==='run'?{kind:'run',id:item.sourceLineage.id}:{kind,id:item.sourceLineage?.id};
 function sourceRecord(projection,kind,id){return kind==='run'?(projection.records.run?.lockedAt===id?projection.records.run:null):(projection.records[kind]||[]).find(item=>item.id===id)||null;}
 function sourceSemantic(kind,item){return domain().semantic(kind==='run'?'importedRuns':kind,kind==='run'&&item?{...item,id:item.lockedAt}:item);}
 function sameOwner(a,b){return a?.ownerId===b?.ownerId&&a?.backpackId===b?.backpackId;}
 function create(candidate,projection,receiver,binding){
  if(!receiver||typeof receiver.ownerId!=='string'||typeof receiver.backpackId!=='string'||!binding||typeof binding.resourceId!=='string')throw Error('A followed copy needs its receiving owner and source connection.');
  if(sameOwner(receiver,projection.source))throw Error('A Proxima cannot follow its own data.');
  for(const maps of Object.values(projection.provenance||{}))for(const origins of Object.values(maps))if(origins.some(origin=>sameOwner(origin,receiver)))throw Error('This data already originated here. Make an independent copy to avoid a follow loop.');
  const entries=[];for(const kind of domain().kinds)for(const item of candidate.records[kind]){const source=anchor(kind,item),raw=sourceRecord(projection,source.kind,source.id);entries.push({kind,localId:item.id,sourceKind:source.kind,sourceId:source.id,sourceBase:sourceSemantic(source.kind,raw),localBase:domain().semantic(kind,item),deleted:false,conflict:null});}
  return {enabled:true,receiver:structuredClone(receiver),binding:{ownerId:projection.source.ownerId,resourceId:binding.resourceId},sourceSeq:projection.source.seq,snapshot:structuredClone(projection),entries};
 }
 function subset(full,entries){
  const selected=new Map(domain().kinds.map(kind=>[kind,new Set()]));let run=null;for(const entry of entries){const raw=sourceRecord(full,entry.sourceKind,entry.sourceId);if(!raw)continue;if(entry.sourceKind==='run')run=raw;else selected.get(entry.sourceKind).add(entry.sourceId);}
  const add=(kind,id)=>{if(id&&!selected.get(kind).has(id)){if(!sourceRecord(full,kind,id))throw Error('A source relationship is missing.');selected.get(kind).add(id);return true;}return false;};
  let changed=true;while(changed){changed=false;for(const kind of ['tasks','scheduleEvents'])for(const id of selected.get(kind))changed=add('projects',sourceRecord(full,kind,id).project)||changed;for(const id of selected.get('timelineIntervals'))changed=add('timelineRows',sourceRecord(full,'timelineIntervals',id).rowId)||changed;for(const id of selected.get('timelineRows'))for(const member of sourceRecord(full,'timelineRows',id).queue?.ids||[])changed=add('timelineIntervals',member)||changed;for(const r of [run,...[...selected.get('importedRuns')].map(id=>sourceRecord(full,'importedRuns',id))].filter(Boolean))for(const member of r.members||[])if(sourceRecord(full,'tasks',member.id))changed=add('tasks',member.id)||changed;}
  const records={};for(const kind of domain().kinds)records[kind]=(full.records[kind]||[]).filter(item=>selected.get(kind).has(item.id));records.run=run;const provenance={};for(const kind of domain().kinds){provenance[kind]={};for(const id of selected.get(kind))if(full.provenance?.[kind]?.[id])provenance[kind][id]=full.provenance[kind][id];}
  return {...structuredClone(full),records:structuredClone(records),provenance,effectiveIntervals:full.effectiveIntervals.filter(item=>selected.get('timelineIntervals').has(item.id))};
 }
 function plan(state,receipt,input){
  const follow=receipt.follow,full=domain().validateProjection(input);
  if(!follow?.enabled)throw Error('This copy is independent.');if(!sameOwner(full.source,receipt.value.source))throw Error('The source identity changed.');if(full.source.seq<follow.sourceSeq)throw Error('Source history moved backwards. Review its restored state before following.');
  const active=follow.entries.filter(entry=>!entry.independent),projected=subset(full,active),candidate=domain().prepareImport(projected,receipt.id),known=new Set(follow.entries.map(entry=>entry.kind+':'+entry.localId));
  const extras=domain().kinds.flatMap(kind=>candidate.records[kind].filter(item=>!known.has(kind+':'+item.id)).map(item=>({kind,item})));
  if(extras.length)return {full,projected,candidate,updates:[],changes:active.map(entry=>({entry,status:'dependencies',localBase:domain().semantic(entry.kind,(state[entry.kind]||[]).find(item=>item.id===entry.localId)),incoming:null})),extras};
  const updates=[],changes=[];
  for(const entry of active){const local=(state[entry.kind]||[]).find(item=>item.id===entry.localId),raw=sourceRecord(full,entry.sourceKind,entry.sourceId),incoming=candidate.records[entry.kind].find(item=>item.id===entry.localId),sourceBase=sourceSemantic(entry.sourceKind,raw),localBase=domain().semantic(entry.kind,local);
   if(!raw){if(!entry.deleted)changes.push({entry,status:'deleted',localBase,incoming:null});continue;}
   if(sourceBase===entry.sourceBase&&!entry.deleted)continue;
   const timeline=entry.kind==='timelineRows'||entry.kind==='timelineIntervals';let dirty=localBase!==entry.localBase;
   if(timeline){const rowId=entry.kind==='timelineRows'?entry.localId:local?.rowId;dirty=dirty||follow.entries.filter(other=>other.kind==='timelineRows'&&other.localId===rowId||other.kind==='timelineIntervals'&&(state.timelineIntervals||[]).find(item=>item.id===other.localId)?.rowId===rowId).some(other=>domain().semantic(other.kind,(state[other.kind]||[]).find(item=>item.id===other.localId))!==other.localBase);}
   if(dirty||entry.conflict)changes.push({entry,status:'modified',localBase,incoming:incoming?structuredClone(incoming):null,sourceBase});
   else if(incoming)updates.push({entry,value:structuredClone(incoming),sourceBase});
  }
  return {full,projected,candidate,updates,changes,extras};
 }
 root.ProximaRemoteFollow=Object.freeze({create,plan,subset,sourceRecord,sourceSemantic});
})(globalThis);
