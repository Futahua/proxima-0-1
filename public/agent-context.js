/* Read-only Proxima context projections. Facts and Store's displayed timeline
 * remain authoritative; connectors only transport these results. */
(function(root){
  const bindings=item=>item.templates??(item.template?[item.template]:[]);
  function blobContext(state,timeline,{id,name}){
    let blob=id?(state.timelineIntervals||[]).find(item=>item.id===id):null;
    if(!blob&&!id){const q=String(name||'').toLocaleLowerCase(),matches=(state.timelineIntervals||[]).filter(item=>q&&(item.name||'').toLocaleLowerCase().includes(q));if(matches.length!==1)return {selection_required:true,candidates:matches.map(item=>({id:item.id,name:item.name,row_id:item.rowId}))};blob=matches[0];}
    if(!blob)throw Error('Blob not found');
    const chosen=new Set([blob.id]);function descend(item){for(const key of item.groupChildren||[]){if(chosen.has(key))continue;chosen.add(key);const child=state.timelineIntervals.find(item=>item.id===key);if(child)descend(child);}}descend(blob);
    const rows=new Set(state.timelineIntervals.filter(item=>chosen.has(item.id)&&!item.groupChildren).map(item=>item.rowId));
    const sessions=timeline.filter(item=>chosen.has(item.id)||rows.has(item.rowId)&&!item.groupChildren);
    const go=[],flow=[],seen=new Set();
    for(const shown of sessions){const item=(state.timelineIntervals||[]).find(x=>x.id===shown.id)||shown;for(const binding of bindings(item)){
      const key=JSON.stringify(binding);if(seen.has(key))continue;seen.add(key);
      if(binding.kind==='as-you-go')go.push({workspace_id:binding.workspaceId,folder_id:binding.version===2?binding.folderId:'root',blob_id:item.id});
      if(binding.kind==='appflowy')flow.push({document_id:binding.documentId,workspace_id:binding.appflowyWorkspaceId||null,page_id:binding.appflowyPageId||null,blob_id:item.id,status:binding.appflowyPageId?'confirmed_synced_reference':'page_reference_not_yet_confirmed'});
    }}
    return {blob,sessions,go,flow,deadlines:sessions.filter(item=>item.deadline).map(item=>({blob_id:item.id,name:item.name,deadline:item.deadline})),seq:state.seq,scope:'Selected blob, descendants, and sessions in their authored activity rows; no name-inferred schedule links'};
  }
  function relations(state,id){const out=[];for(const collection of ['projects','tasks','timelineIntervals','scheduleEvents'])for(const item of state[collection]||[]){if(item.id===id||item.project===id||item.rowId===id||item.groupChildren?.includes(id)||bindings(item).some(t=>t.documentId===id||t.folderId===id||t.appflowyPageId===id))out.push({collection,id:item.id,record:item});}return {relations:out,seq:state.seq,source:'Proxima stored references, including synced Flow page and Go folder identities'};}
  function projectContext(state,timeline,id){const project=(state.projects||[]).find(item=>item.id===id);if(!project)return blobContext(state,timeline,{id});const tasks=(state.tasks||[]).filter(item=>item.project===id);return {project,tasks,schedule:(state.scheduleEvents||[]).filter(item=>item.project===id),sessions:timeline.filter(item=>item.project===id||item.projectId===id||item.taskId&&tasks.some(task=>task.id===item.taskId)),seq:state.seq,run:state.run?.members?.some(member=>tasks.some(task=>task.id===member.id))?state.run:null,scope:'Explicit project links; use blob context for blob-owned work'};}
  function conflicts(occurrences,limit){const sorted=occurrences.map(item=>({event_id:item.item.id,name:item.exception?.name||item.item.name,occurrence_key:item.occurrenceKey,start:item.start,end:item.end,a:Date.parse(item.start),b:Date.parse(item.end)})).filter(item=>Number.isFinite(item.a)&&item.b>item.a).sort((a,b)=>a.a-b.a||a.event_id.localeCompare(b.event_id));let total=0;const result=[];for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].a<sorted[i].b;j++){const a=sorted[i],b=sorted[j];total++;if(result.length<limit){const clean=({a,b,...item})=>item;result.push({left:clean(a),right:clean(b),overlap_ms:Math.min(a.b,b.b)-Math.max(a.a,b.a)});}}return {conflicts:result,total,truncated:total>limit,semantics:'Half-open owner-expanded occurrence ranges; touching endpoints do not conflict'};}
  function query({state,timeline,observedAt,occurrences},input){
    if(input.kind==='blob-context')return blobContext(state,timeline,input);
    if(input.kind==='project-context')return projectContext(state,timeline,input.id);
    if(input.kind==='relations')return relations(state,input.id);
    if(input.kind==='schedule-conflicts')return conflicts(occurrences||[],Math.min(1000,Math.max(1,Number(input.limit)||200)));
    if(input.kind==='changes'){const cursor=Number(input.after_seq)||0,limit=Math.min(200,Math.max(1,Number(input.limit)||100));if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid event cursor');const events=[...(state.events||[])].sort((a,b)=>a.seq-b.seq),selected=events.filter(item=>item.seq>cursor).slice(0,limit),oldest=events[0]?.seq;return {events:selected,next_cursor:selected.at(-1)?.seq??cursor,current_seq:state.seq,reset_required:cursor>state.seq||(oldest!==undefined&&cursor<oldest-1)||(!events.length&&state.seq>cursor),has_more:events.some(item=>item.seq>(selected.at(-1)?.seq??cursor))};}
    if(input.kind==='activity'){const from=Date.parse(input.from),to=Date.parse(input.to);if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>366*86400000)throw Error('Choose a valid range up to 366 days');const sessions=timeline.filter(item=>!item.groupChildren).flatMap(item=>{const start=Math.max(from,Date.parse(item.start)),end=Math.min(to,Date.parse(item.effective_end||item.end));return end>start?[{id:item.id,row_id:item.rowId,name:item.name,elapsed_ms:end-start,live:!!item.followNow}]:[];});return {from:input.from,to:input.to,observed_at:new Date(observedAt).toISOString(),sessions,total_session_ms:sessions.reduce((sum,item)=>sum+item.elapsed_ms,0),semantics:'Clipped owner-projected sessions; parallel activities count separately',projection:'Store.timelineIntervals'};}
    throw Error('Unknown context query');
  }
  root.ProximaAgentContext=Object.freeze({query});
})(globalThis);
