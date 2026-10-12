/* Approved Proxima facts only. Hosting, authentication and transport stay with Papers. */
(function(root){
  const fields={
    projects:['id','name','description','projectType','createdAt','archivedAt','rev'],
    tasks:['id','name','note','project','status','weight','start','deadline','createdAt','rev'],
    scheduleEvents:['id','name','note','project','start','deadline','recurrence','exceptions','sourceKey','color','createdAt','rev'],
    timelineRows:['id','name','color','independentColors','queue'],
    timelineIntervals:['id','name','rowId','start','end','followNow','deadline','color','checked','queueWeight','createdAt','rev'],
  };
  function pick(record,keys){const result={};for(const key of keys)if(Object.hasOwn(record,key))result[key]=structuredClone(record[key]);return result;}
  function identity(source){if(!source||typeof source.ownerId!=='string'||!source.ownerId||source.ownerId.length>256||typeof source.backpackId!=='string'||!source.backpackId||source.backpackId.length>256)throw Error('A projection needs its owning device and Backpack identity.');return {ownerId:source.ownerId,backpackId:source.backpackId};}
  function project(state,source,selection=null,now=Date.now(),effectiveIntervals=[]){
    const owner=identity(source);if(!Number.isSafeInteger(state.seq)||state.seq<0||!Number.isFinite(now))throw Error('Invalid source checkpoint.');
    const indexes={},chosen={};for(const kind of Object.keys(fields)){indexes[kind]=new Map();chosen[kind]=new Set();for(const item of state[kind]||[]){if(!item||typeof item.id!=='string'||!item.id||indexes[kind].has(item.id))throw Error('Invalid or duplicate '+kind+' identity.');indexes[kind].set(item.id,item);}}
    function include(kind,id){if(!Object.hasOwn(indexes,kind)||!indexes[kind].has(id))throw Error('Missing '+kind+' dependency: '+id);chosen[kind].add(id);}
    const explicitProjects=new Set();
    if(selection===null){for(const kind of Object.keys(fields))for(const id of indexes[kind].keys())include(kind,id);}
    else{if(!Array.isArray(selection))throw Error('Choose explicit source records.');for(const selected of selection){if(selected.kind==='run'){if(!state.run)throw Error('The selected run no longer exists.');continue;}include(selected.kind,selected.id);if(selected.kind==='projects')explicitProjects.add(selected.id);}}
    for(const kind of ['tasks','scheduleEvents'])for(const item of indexes[kind].values())if(explicitProjects.has(item.project))include(kind,item.id);
    const includeRun=!!state.run&&(selection===null||selection.some(item=>item.kind==='run'));
    const standaloneRunMembers=[];
    if(includeRun)for(const member of state.run.members||[]){if(indexes.tasks.has(member.id))include('tasks',member.id);else standaloneRunMembers.push(member.id);}
    let changed=true;
    while(changed){const before=Object.values(chosen).reduce((sum,set)=>sum+set.size,0);
      for(const kind of ['tasks','scheduleEvents'])for(const id of chosen[kind]){const item=indexes[kind].get(id);if(item.project)include('projects',item.project);}
      for(const id of chosen.timelineIntervals){const item=indexes.timelineIntervals.get(id);if(item.rowId)include('timelineRows',item.rowId);}
      for(const id of chosen.timelineRows){const row=indexes.timelineRows.get(id);if(row.queue){if(!Array.isArray(row.queue.ids)||new Set(row.queue.ids).size!==row.queue.ids.length)throw Error('Invalid queue membership.');for(const memberId of row.queue.ids){include('timelineIntervals',memberId);if(indexes.timelineIntervals.get(memberId).rowId!==id)throw Error('Queue member belongs to another activity.');}}if(selection===null||selection.some(item=>item.kind==='timelineRows'&&item.id===id))for(const item of indexes.timelineIntervals.values())if(item.rowId===id)include('timelineIntervals',item.id);}
      changed=before!==Object.values(chosen).reduce((sum,set)=>sum+set.size,0);
    }
    const records={};for(const kind of Object.keys(fields))records[kind]=[...indexes[kind].values()].filter(item=>chosen[kind].has(item.id)).map(item=>{const value=pick(item,fields[kind]);if(kind==='timelineRows'&&value.queue)value.queue=pick(value.queue,['end','ids']);if(kind==='scheduleEvents'){if(value.recurrence)value.recurrence=pick(value.recurrence,['frequency','interval','count','until','weekdays','unit']);if(value.exceptions)value.exceptions=value.exceptions.map(exception=>pick(exception,['key','start','deadline','name','note','color','cancelled','detached']));}return value;});
    records.run=includeRun?{...pick(state.run,['lockedAt','target','total','rev']),members:(state.run.members||[]).map(member=>pick(member,['id','name','weight','duration','startsAt','endsAt']))}:null;
    const effective=effectiveIntervals.filter(item=>chosen.timelineIntervals.has(item.id)).map(item=>pick(item,['id','start','end','followNow','color','queueId','queueIndex','queueEnd']));
    return {version:1,source:{...owner,seq:state.seq,observedAt:new Date(now).toISOString()},records,effectiveIntervals:effective,standaloneRunMembers};
  }
  function qualified(source,kind,id){const owner=identity(source);return 'import:'+encodeURIComponent(owner.ownerId)+':'+encodeURIComponent(owner.backpackId)+':'+kind+':'+encodeURIComponent(id);}
  function independentCandidate(projection){
    if(projection?.version!==1)throw Error('Unsupported Proxima projection.');const source=identity(projection.source),records=structuredClone(projection.records),frozen=new Map((projection.effectiveIntervals||[]).map(item=>[item.id,item]));
    function lineage(kind,item){return {ownerId:source.ownerId,backpackId:source.backpackId,kind,id:item.id,rev:item.rev??null,seq:projection.source.seq,mode:'independent'};}
    for(const kind of Object.keys(fields))for(const item of records[kind]){item.sourceLineage=lineage(kind,item);item.id=qualified(source,kind,item.id);if(item.project)item.project=qualified(source,'projects',item.project);if(item.rowId)item.rowId=qualified(source,'timelineRows',item.rowId);if(kind==='timelineRows'&&item.queue){item.sourceLineage.queue=structuredClone(item.queue);delete item.queue;}if(kind==='timelineIntervals'){const effective=frozen.get(item.sourceLineage.id);if(item.followNow||effective?.queueId){if(!effective)throw Error('A live source needs an owner-calculated snapshot before independent copy.');item.sourceLineage.liveSnapshot={followNow:item.followNow===true,queueId:effective.queueId??null};item.start=effective.start;item.end=effective.end;}item.followNow=false;}}
    if(records.run){records.run.sourceLineage={...source,kind:'run',id:records.run.lockedAt,rev:records.run.rev,seq:projection.source.seq,mode:'independent'};records.run.members.forEach(member=>{member.id=qualified(source,'tasks',member.id);});}
    return {version:1,source:structuredClone(projection.source),records,notices:['Independent copies freeze live sessions and retain source queue relationships as lineage.']};
  }
  root.ProximaRemoteDomain=Object.freeze({project,qualified,independentCandidate});
})(globalThis);
