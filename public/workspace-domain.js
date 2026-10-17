/* Managed workspace records. Uses Proxima's existing causal merge rules.
 * File bytes, physical paths, scheduling and checked publication belong to Papers.
 * Immutable version records are retained; a delete is a version, not lost history. */
(function(root){
  'use strict';
  const collections=['workspaceEntries','workspaceVersions'];
  const core=root.ProximaSyncCore.createDomain({collections,singletons:[],localFields:{'*':new Set(['rev'])},revised:[]});
  const id=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
  function validateVersion(value){
    if(!value||!id(value.id)||!id(value.workspaceId)||!id(value.entryId)||!Array.isArray(value.parents)||new Set(value.parents).size!==value.parents.length||value.parents.some(parent=>!id(parent)||parent===value.id))throw Error('Invalid workspace version identity or ancestry.');
    if(!['content','delete'].includes(value.kind))throw Error('Invalid workspace version kind.');
    if(value.kind==='content'&&(typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)||!Number.isSafeInteger(value.size)||value.size<0))throw Error('Invalid workspace content.');
    if(value.kind==='delete'&&(value.hash!==undefined||value.size!==undefined))throw Error('A deletion cannot carry file bytes.');
    if(Object.keys(value).some(key=>!['id','workspaceId','entryId','parents','kind','hash','size'].includes(key)))throw Error('Unapproved workspace version field.');
    return value;
  }
  const signature=value=>JSON.stringify([value.id,value.workspaceId,value.entryId,value.kind,[...value.parents].sort(),value.hash??null,value.size??null]);
  function versionsFor(state,workspaceId,entryId){
    if(!id(workspaceId)||!id(entryId))throw Error('Invalid workspace entry.');
    const versions=new Map();
    for(const value of state.workspaceVersions||[]){
      if(value.workspaceId!==workspaceId||value.entryId!==entryId)continue;
      validateVersion(value);
      const prior=versions.get(value.id);
      if(prior&&signature(prior)!==signature(value))throw Error('A workspace version identity was reused.');
      versions.set(value.id,value);
    }
    return versions;
  }
  function inspect(state,workspaceId,entryId){
    const versions=versionsFor(state,workspaceId,entryId),referenced=new Set(),missing=new Set(),visiting=new Set(),visited=new Set();
    for(const key of versions.keys()){
      const stack=[[key,false]];
      while(stack.length){
        const [current,leaving]=stack.pop();
        if(leaving){visiting.delete(current);visited.add(current);continue;}
        if(visiting.has(current))throw Error('Workspace version ancestry contains a cycle.');
        if(visited.has(current))continue;
        const value=versions.get(current);if(!value){missing.add(current);continue;}
        visiting.add(current);stack.push([current,true]);
        for(const parent of value.parents){referenced.add(parent);stack.push([parent,false]);}
      }
    }
    const heads=[...versions.values()].filter(value=>!referenced.has(value.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const content=heads.filter(value=>value.kind==='content'),deletions=heads.filter(value=>value.kind==='delete');
    // Equal bytes may share storage, but concurrent operations still need acknowledgement.
    const distinct=new Set(content.map(value=>value.hash+':'+value.size));
    return {heads,content,deletions,missing:[...missing].sort(),conflict:distinct.size>1||content.length>0&&deletions.length>0,bin:deletions.length>0,deleted:heads.length>0&&content.length===0&&missing.size===0};
  }
  function appendVersion(state,value){
    validateVersion(value);
    const existing=(state.workspaceVersions||[]).find(version=>version.id===value.id);
    if(existing){if(signature(existing)!==signature(value))throw Error('A workspace version is immutable.');return state;}
    const known=versionsFor(state,value.workspaceId,value.entryId);
    if(value.parents.some(parent=>!known.has(parent)))throw Error('Cannot author an edit without its parent versions.');
    const next={...state,workspaceVersions:[...(state.workspaceVersions||[]),structuredClone(value)]};
    inspect(next,value.workspaceId,value.entryId);
    return next;
  }
  function resolve(state,{workspaceId,entryId,id:versionId,hash,size}){
    const current=inspect(state,workspaceId,entryId);
    if(current.missing.length)throw Error('Wait for missing history before resolving this entry.');
    return appendVersion(state,{id:versionId,workspaceId,entryId,parents:current.heads.map(value=>value.id),kind:'content',hash,size});
  }
  function merge(state,stamps,incoming){
    // Validate on a private candidate first. An invalid payload must not partly
    // mutate the local stamps or erase immutable content/version history.
    if(!Array.isArray(incoming)||incoming.some(change=>!collections.includes(change.key?.split('/')[0])||change.key.startsWith('workspaceVersions/')&&change.tomb))throw Error('Invalid workspace sync changes.');
    const previous=new Map((state.workspaceVersions||[]).map(value=>[value.id,value]));
    for(const change of incoming){
      if(!change.key.startsWith('workspaceVersions/'))continue;
      const value=Object.fromEntries(Object.entries(change.fields||{}).filter(([,stamp])=>'v' in stamp).map(([field,stamp])=>[field,stamp.v]));
      validateVersion(value);
      if(change.key!=='workspaceVersions/'+value.id||previous.has(value.id)&&signature(previous.get(value.id))!==signature(value))throw Error('A workspace version is immutable.');
      for(const [field,stamp] of Object.entries(change.fields||{}))if(stamp.alt?.some(alt=>JSON.stringify(alt.v)!==JSON.stringify(value[field])))throw Error('A workspace version has conflicting immutable fields.');
    }
    const candidateStamps=new Map(structuredClone([...stamps]));
    const result=core.merge(state,candidateStamps,incoming);
    const seen=new Set(),entries=new Map();
    for(const value of result.state.workspaceVersions||[]){
      validateVersion(value);
      if(seen.has(value.id))throw Error('Duplicate workspace version identity.');
      seen.add(value.id);
      if(previous.has(value.id)&&signature(previous.get(value.id))!==signature(value))throw Error('A workspace version is immutable.');
      entries.set(value.workspaceId+'/'+value.entryId,[value.workspaceId,value.entryId]);
    }
    for(const args of entries.values())inspect(result.state,...args);
    stamps.clear();for(const [key,value] of candidateStamps)stamps.set(key,value);
    return result;
  }
  function status({localDurable=false,available=false,pendingPublication=false,conflict=false,error=null,requiredDevices=[],acknowledgedDevices=[]}={}){
    if(error)return {kind:'error',label:'Sync needs attention',detail:String(error)};
    if(conflict)return {kind:'conflict',label:'Conflict — both versions kept'};
    if(!localDurable)return {kind:'saving',label:'Saving locally…'};
    if(pendingPublication)return {kind:'pending-publication',label:'Waiting to apply file changes'};
    if(!available)return {kind:'pending-content',label:'Waiting for file contents'};
    const acknowledged=new Set(acknowledgedDevices),waiting=[...new Set(requiredDevices)].filter(device=>!acknowledged.has(device));
    if(waiting.length)return {kind:'waiting',label:'Saved locally · waiting for '+waiting.join(', '),waiting};
    // No configured target set is not evidence of replication to three devices.
    return requiredDevices.length?{kind:'synced',label:'Synced to all devices'}:{kind:'local',label:'Saved locally'};
  }
  root.ProximaWorkspaceDomain=Object.freeze({core,validateVersion,inspect,appendVersion,resolve,merge,status});
})(globalThis);
