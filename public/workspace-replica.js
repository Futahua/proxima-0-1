/* One checked journal contains records, original causal stamps and delivery state.
 * This adapter reuses Proxima's merge rules. The native host owns actual bytes. */
(function(root){
  'use strict';
  function create({storage,files,copy,uuid=()=>crypto.randomUUID(),now=()=>Date.now(),changed=()=>{}}){
    const W=root.ProximaWorkspaceDomain,S=W.core;let tail=Promise.resolve();
    const fresh=()=>({version:1,node:uuid(),n:0,clock:null,vv:{},stamps:[],state:{workspaceEntries:[],workspaceVersions:[]},peers:{},views:{}});
    function serial(work){const next=tail.catch(()=>{}).then(work);tail=next;return next;}
    async function transaction(work){return serial(async()=>{
      for(let attempt=0;attempt<6;attempt++){
        const loaded=await storage.load(),journal=loaded.state||fresh();if(journal.version!==1)throw Error('Unsupported workspace journal.');
        const stamps=new Map(journal.stamps),before=JSON.stringify(journal),beforeRecords=JSON.stringify([journal.state,journal.stamps]),result=await work(journal,stamps);
        journal.stamps=[...stamps];if(JSON.stringify(journal)===before)return result;
        const saved=await storage.save(journal,loaded.revision);if(saved.ok){changed({records:beforeRecords!==JSON.stringify([journal.state,journal.stamps])});return result;}if(saved.code!=='STALE_REVISION')throw Error(saved.message||'Workspace save failed.');
      }
      throw Error('The workspace changed repeatedly; your change was not saved.');
    });}
    function nextStamp(journal,origin='human'){const c={...journal.vv};journal.n++;journal.vv[journal.node]=journal.n;journal.clock=S.tick(journal.clock,now(),journal.node);return {h:journal.clock,o:journal.node,n:journal.n,c,...(origin==='human'?{u:1}:{a:1}),action:{type:'workspace.'+origin,id:uuid()}};}
    function author(journal,stamps,next,origin='human'){
      const changes=S.diff(journal.state,next);
      S.stampChanges(stamps,changes,()=>nextStamp(journal,origin));
      journal.state=next;
    }
    const recordKey=(workspaceId,kind,id)=>workspaceId+':'+kind+':'+id;
    function encode(workspaceId,document){
      const records=[];
      for(const [collection,kind] of [['groups','group'],['shortcuts','shortcut']])for(const raw of document[collection]||[]){
        const value=structuredClone(raw),originalId=value.id;delete value.id;
        if(value.workspaceProjectedParentId===value.parentId&&value.workspaceStructureIssue)value.parentId=value.workspaceOriginalParentId;
        delete value.workspaceProjectedParentId;delete value.workspaceOriginalParentId;delete value.workspaceStructureIssue;
        if(kind==='shortcut'){
          const placements=value.placements||[];delete value.placements;delete value.fileTarget;delete value.__asYouGoUnresolvedTarget;delete value.workspaceAvailability;delete value.workspaceConflict;
          if(!/^https?:\/\//i.test(value.target||'')){if(!value.workspaceFileId)throw Error('Import this file as a workspace copy first.');delete value.target;}
          for(const rawPlacement of placements){const placement=structuredClone(rawPlacement);if(placement.workspaceStructureIssue&&placement.workspaceProjectedParentId===placement.parentId)placement.parentId=placement.workspaceOriginalParentId;delete placement.workspaceStructureIssue;delete placement.workspaceProjectedParentId;delete placement.workspaceOriginalParentId;records.push({...placement,id:recordKey(workspaceId,'placement',placement.id),recordId:placement.id,workspaceId,kind:'placement',shortcutId:originalId});}
        }
        records.push({...value,id:recordKey(workspaceId,kind,originalId),recordId:originalId,workspaceId,kind});
      }
      for(const field of ['graphPositions','graphRestPositions','itemSets','iconSize'])if(document.view?.[field]!==undefined)records.push({id:recordKey(workspaceId,'view',field),recordId:field,workspaceId,kind:'view',value:structuredClone(document.view[field])});
      return records;
    }
    async function document(journal,workspaceId){
      const records=(journal.state.workspaceEntries||[]).filter(value=>value.workspaceId===workspaceId),groups=[],shortcuts=[];
      for(const value of records){
        if(!['group','shortcut'].includes(value.kind))continue;
        const {workspaceId:_w,kind,id,recordId,...item}=structuredClone(value);item.id=recordId;
        if(kind==='group'){groups.push(item);continue;}
        item.placements=records.filter(p=>p.kind==='placement'&&p.shortcutId===recordId).map(({workspaceId,kind,id,recordId,shortcutId,...p})=>({...p,id:recordId}));
        if(item.workspaceFileId){
          const binding=await files({operation:'path',workspaceId,entryId:item.workspaceFileId,name:item.workspaceFilename||item.name});item.target=binding.path;
          const inspection=W.inspect(journal.state,workspaceId,item.workspaceFileId);
          item.workspaceAvailability=binding.available&&(inspection.conflict||inspection.heads.some(v=>v.id===binding.versionId&&v.kind==='content'))?'local':'pending';item.workspaceConflict=inspection.conflict;
          // The same recoverable deletion appears in every replica's ordinary AYG Bin.
          if(inspection.deleted)for(const placement of item.placements)placement.bin??={parentId:placement.parentId,order:placement.order??0,binnedAt:'1970-01-01T00:00:00.000Z'};
        }
        shortcuts.push(item);
      }
      const view={...(journal.views[workspaceId]||{preferences:{theme:'dark',workspaceNavigatorMode:'list'}})};for(const record of records)if(record.kind==='view')view[record.recordId]=structuredClone(record.value);
      // Keep a concurrent cycle or orphan visible without rewriting human records.
      const byId=new Map(groups.map(g=>[g.id,g]));
      for(const item of [...groups,...shortcuts.flatMap(s=>s.placements)]){
        const visited=new Set([item.id]);let current=item.parentId,issue=null;
        while(current&&current!=='root'){if(visited.has(current)){issue='Conflicting folder moves';break;}visited.add(current);const parent=byId.get(current);if(!parent){issue='The parent folder was removed';break;}current=parent.parentId;}
        if(issue){item.workspaceStructureIssue=issue;item.workspaceOriginalParentId=item.parentId;item.workspaceProjectedParentId='root';item.parentId='root';}
      }
      return {schemaVersion:1,groups,shortcuts,view};
    }
    const entryRevision=(journal,workspaceId)=>JSON.stringify(journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId).map(e=>JSON.stringify(e)).sort());
    async function load(workspaceId){return transaction(async journal=>({state:await document(journal,workspaceId),revision:String(journal.n)+':'+JSON.stringify(journal.vv),entryRevision:entryRevision(journal,workspaceId)}));}
    async function save(workspaceId,raw,revision,metadata={}){return transaction(async(journal,stamps)=>{
      if(revision!==String(journal.n)+':'+JSON.stringify(journal.vv))return {ok:false,code:'STALE_REVISION'};
      const doc=typeof raw==='string'?JSON.parse(raw):raw;let records=encode(workspaceId,doc);
      if(metadata.automatic){
        // Automatic layout persistence cannot author names, moves, imports or Bin actions.
        const old=journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId),views=records.filter(e=>e.kind==='view');
        records=old.map(e=>e.kind==='view'&&!stamps.get('workspaceEntries/'+e.id+'#value')?.u?(views.find(v=>v.id===e.id)||e):e);
        records.push(...views.filter(v=>!old.some(e=>e.id===v.id)));
      }
      // Only entries in the kill bin can leave. Emptying the kill bin recycles their files: each gets
      // a deletion version, so every device recycles its copy while the bytes stay in history.
      const entries=journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId),groups=new Map(entries.filter(e=>e.kind==='group').map(e=>[e.recordId,e]));
      const binnedUnder=id=>{const seen=new Set();for(let g=groups.get(id);g&&!seen.has(g.recordId);g=groups.get(g.parentId)){seen.add(g.recordId);if(g.bin)return true;}return false;};
      const inKillBin=old=>old.kind==='group'?binnedUnder(old.recordId):entries.filter(e=>e.kind==='placement'&&e.shortcutId===old.recordId).every(p=>p.bin||binnedUnder(p.parentId));
      const removed=entries.filter(e=>['group','shortcut'].includes(e.kind)&&!records.some(r=>r.id===e.id));
      if(removed.length&&metadata.automatic)throw Error('Only the creator empties the kill bin.');
      for(const old of removed)if(!inKillBin(old))throw Error('Kill it first: only entries in the kill bin can be emptied.');
      let next={...journal.state,workspaceEntries:[...journal.state.workspaceEntries.filter(record=>record.workspaceId!==workspaceId),...records]};
      for(const old of removed){
        if(old.kind!=='shortcut'||!old.workspaceFileId)continue;
        const state=W.inspect(next,workspaceId,old.workspaceFileId);
        if(state.missing.length)throw Error('Wait for this file’s history to sync before emptying it.');
        if(state.heads.length&&!state.deleted)next=W.appendVersion(next,{id:uuid(),workspaceId,entryId:old.workspaceFileId,kind:'delete',parents:state.heads.map(v=>v.id)});
      }
      author(journal,stamps,next,metadata.automatic?'automatic':'human');
      journal.views[workspaceId]=doc.view||{};
      return {ok:true,revision:String(journal.n)+':'+JSON.stringify(journal.vv)};
    });}
    async function importFile(workspaceId,path,name,entryId=uuid()){
      const captured=await files({operation:'import',workspaceId,entryId,name,path});
      if(captured.baseVersion&&captured.hash===captured.baseHash)return {target:captured.path,name,workspaceFileId:entryId,kind:'file'};
      const proposed=uuid(),versionId=await transaction(async(journal,stamps)=>{const known=journal.state.workspaceVersions.find(v=>v.workspaceId===workspaceId&&v.entryId===entryId&&v.hash===captured.hash&&!v.parents.length);if(known)return known.id;author(journal,stamps,W.appendVersion(journal.state,{id:proposed,workspaceId,entryId,parents:[],kind:'content',hash:captured.hash,size:captured.size}));return proposed;});
      await files({operation:'publish',workspaceId,entryId,name,hash:captured.hash,versionId});
      return {target:captured.path,name,workspaceFileId:entryId,kind:'file'};
    }
    async function capture(workspaceId,entryId,name){
      const observed=await files({operation:'capture',workspaceId,entryId,name});if(observed.hash===observed.baseHash)return;
      const proposed=uuid(),versionId=await transaction(async(journal,stamps)=>{const parents=observed.baseVersion?[observed.baseVersion]:[],known=journal.state.workspaceVersions.find(v=>v.workspaceId===workspaceId&&v.entryId===entryId&&v.hash===observed.hash&&JSON.stringify(v.parents)===JSON.stringify(parents));if(known)return known.id;author(journal,stamps,W.appendVersion(journal.state,{id:proposed,workspaceId,entryId,parents,kind:'content',hash:observed.hash,size:observed.size}),'observed');return proposed;});
      await files({operation:'publish',workspaceId,entryId,name,hash:observed.hash,versionId});
    }
    // A blob's folder in the synced root. Missing means not created or not yet synced here;
    // binned (or inside a binned folder) means deleted, which leaves the blob without a template.
    function folderOf(journal,workspaceId,folderId){
      const groups=new Map(journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId&&e.kind==='group').map(e=>[e.recordId,e]));
      const record=groups.get(folderId);if(!record)return {exists:false,binned:false};
      let binned=false;const seen=new Set();for(let g=record;g&&!seen.has(g.recordId);g=groups.get(g.parentId)){seen.add(g.recordId);if(g.bin)binned=true;}
      return {exists:true,binned,name:record.name,icon:record.icon??null};
    }
    async function folder(workspaceId,folderId){return transaction(async journal=>structuredClone(folderOf(journal,workspaceId,folderId)));}
    async function folders(workspaceId){return transaction(async journal=>Object.fromEntries(journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId&&e.kind==='group').map(e=>[e.recordId,structuredClone(folderOf(journal,workspaceId,e.recordId))])));}
    /** Creates the blob's folder at the synced root, or renames it to follow the blob. Both are the
     * creator's own actions (choosing a template, renaming the blob), so they are human-authored. */
    async function ensureFolder(workspaceId,folderId,name){return transaction(async(journal,stamps)=>{
      const key=recordKey(workspaceId,'group',folderId),current=journal.state.workspaceEntries.find(e=>e.id===key);
      if(current?.bin||current&&current.name===name)return folderOf(journal,workspaceId,folderId);
      const order=journal.state.workspaceEntries.filter(e=>e.workspaceId===workspaceId&&e.kind==='group'&&e.parentId==='root').length;
      const next=current?{...current,name}:{id:key,recordId:folderId,workspaceId,kind:'group',parentId:'root',order,name,icon:null};
      author(journal,stamps,{...journal.state,workspaceEntries:[...journal.state.workspaceEntries.filter(e=>e.id!==key),next]});
      return folderOf(journal,workspaceId,folderId);
    });}
    async function entries(){return transaction(async journal=>structuredClone(journal.state.workspaceEntries.filter(record=>record.kind==='shortcut'&&record.workspaceFileId)));}
    let tidiedAt=0;
    async function reconcile(){
      const errors=[];
      // Clear duplicate content copies left when two devices pushed the same file at once (at most
      // once a minute; a device whose Papers predates this simply skips it).
      if(now()-tidiedAt>60000){tidiedAt=now();await files({operation:'content-tidy'}).catch(()=>{});}
      for(const entry of await entries())try{
        const filename=entry.workspaceFilename||entry.name;
        const binding=await files({operation:'path',workspaceId:entry.workspaceId,entryId:entry.workspaceFileId,name:filename});
        if(binding.available)await capture(entry.workspaceId,entry.workspaceFileId,filename);
        const inspection=await transaction(async journal=>W.inspect(journal.state,entry.workspaceId,entry.workspaceFileId));
        if(inspection.conflict||inspection.missing.length||!inspection.heads.length)continue;
        const head=inspection.heads[0];
        if(head.id===binding.versionId)continue;
        if(head.kind==='content'&&!(await files({operation:'content-check',hash:head.hash})).available)continue;
        const applied=await files({operation:head.kind==='delete'?'delete':'publish',workspaceId:entry.workspaceId,entryId:entry.workspaceFileId,name:filename,versionId:head.id,...head.kind==='content'?{hash:head.hash}:{}});
        if(applied.localChange)await capture(entry.workspaceId,entry.workspaceFileId,filename);
      }catch(error){errors.push({entryId:entry.recordId,message:error.message});}
      // Files whose entries were emptied from the kill bin: recycle this device's copy. A copy edited
      // here meanwhile is captured instead, so the edit survives as a conflict with the deletion.
      const named=new Set((await entries()).map(e=>e.workspaceId+'/'+e.workspaceFileId));
      const emptied=await transaction(async journal=>{const out=new Map();for(const v of journal.state.workspaceVersions){const key=v.workspaceId+'/'+v.entryId;if(!named.has(key))out.set(key,[v.workspaceId,v.entryId]);}return [...out.values()];});
      for(const [workspaceId,entryId] of emptied)try{
        const inspection=await transaction(async journal=>W.inspect(journal.state,workspaceId,entryId));
        if(!inspection.deleted)continue;const head=inspection.deletions[0];
        const binding=await files({operation:'path',workspaceId,entryId,name:'recycled'});if(binding.versionId===head.id||!binding.available&&!binding.hash)continue;
        const applied=await files({operation:'delete',workspaceId,entryId,name:'recycled',versionId:head.id});
        if(applied.localChange)await capture(workspaceId,entryId,'recycled');
      }catch(error){errors.push({entryId,message:error.message});}
      return errors;
    }
    async function remove(workspaceId,entryId){
      const versionId=uuid();return transaction(async(journal,stamps)=>{const inspection=W.inspect(journal.state,workspaceId,entryId);if(inspection.missing.length)throw Error('Wait for missing history before deleting this file.');author(journal,stamps,W.appendVersion(journal.state,{id:versionId,workspaceId,entryId,kind:'delete',parents:inspection.heads.map(value=>value.id)}));return {ok:true};});
    }
    async function restore(workspaceId,entryId,versionId){
      const newId=uuid();await transaction(async(journal,stamps)=>{const version=journal.state.workspaceVersions.find(v=>v.id===versionId&&v.workspaceId===workspaceId&&v.entryId===entryId&&v.kind==='content');if(!version)throw Error('That recoverable version is unavailable.');author(journal,stamps,W.resolve(journal.state,{workspaceId,entryId,id:newId,hash:version.hash,size:version.size}));});await reconcile();return {ok:true};
    }
    async function needed(journal){const out=[];for(const value of journal.state.workspaceVersions)if(value.kind==='content'&&!out.some(x=>x.hash===value.hash)&&!(await files({operation:'content-check',hash:value.hash})).available)out.push({hash:value.hash,size:value.size});return out;}
    async function publications(journal,workspaceId=null){const out=[];for(const entry of journal.state.workspaceEntries){if(entry.kind!=='shortcut'||!entry.workspaceFileId||workspaceId&&entry.workspaceId!==workspaceId)continue;const inspection=W.inspect(journal.state,entry.workspaceId,entry.workspaceFileId);if(inspection.conflict||inspection.heads.length!==1)continue;const binding=await files({operation:'path',workspaceId:entry.workspaceId,entryId:entry.workspaceFileId,name:entry.workspaceFilename||entry.name});if(binding.versionId!==inspection.heads[0].id)out.push(entry.id);}return out;}
    // What each device has confirmed, as known here. Exchanges carry it on, so a device that cannot
    // reach another directly (the phone only over SlopTop's cable) still learns that it caught up.
    function mergeAcks(journal,acks){
      if(!acks||typeof acks!=='object')return;
      for(const [id,ack] of Object.entries(acks)){
        if(!ack||typeof ack!=='object'||!ack.vv||typeof ack.vv!=='object')continue;
        const known=journal.peers[id],newer=(ack.at||0)>(known?.at||0);
        journal.peers[id]={name:known?.name||ack.name,node:known?.node||ack.node,vv:S.joinVectors(known?.vv||{},ack.vv),at:Math.max(known?.at||0,ack.at||0),waiting:newer?ack.waiting||0:known.waiting||0};
      }
    }
    async function exchange(message){
      if(message?.workspaceProtocol!==1||!message.vv||!Array.isArray(message.changes))throw Error('Unsupported workspace exchange.');
      const reply=await transaction(async(journal,stamps)=>{
        const result=W.merge(journal.state,stamps,message.changes);journal.state=result.state;journal.vv=S.joinVectors(journal.vv,message.vv);mergeAcks(journal,message.acks);
        for(const stamp of stamps.values())journal.clock=S.witness(journal.clock,stamp.h);
        return {workspaceProtocol:1,node:journal.node,vv:structuredClone(journal.vv),acks:structuredClone(journal.peers),changes:S.changesSince(journal.state,stamps,message.vv),needed:await needed(journal),contentRoot:(await files({operation:'content-root'})).transportPath??(await files({operation:'content-root'})).path};
      });
      // Reply first, then apply the received changes to files: on the phone that work can take far
      // longer than the asking device waits (re-checking or copying hundreds of MB).
      reply.pending=(await transaction(journal=>publications(journal))).length;
      void reconcile().catch(()=>{});
      return reply;
    }
    async function runLimited(jobs,limit){
      const failures=[];let next=0;
      await Promise.all(Array.from({length:Math.min(limit,jobs.length)},async()=>{while(next<jobs.length){const job=jobs[next++];try{await job();}catch(error){failures.push(error);}}}));
      return failures;
    }
    async function syncWith(peer,send){
      await reconcile();const message=await transaction(async(journal,stamps)=>({workspaceProtocol:1,vv:structuredClone(journal.vv),acks:structuredClone(journal.peers),changes:S.changesSince(journal.state,stamps,journal.peers[peer.id]?.vv||{})}));
      const reply=await send(message);if(reply?.workspaceProtocol!==1)throw Error('Update the other device to sync blob workspaces.');
      await exchange(reply);
      const ownRoot=await files({operation:'content-root'});
      const localNeeded=await transaction(needed);
      const remoteRoot='\\\\papers~'+peer.id+'\\'+reply.contentRoot;
      // File contents copy up to three at a time in each direction, so one large file does not hold
      // up small ones in other folders. A failed copy does not stop the others; it is reported after.
      const pulls=localNeeded.filter(item=>!(reply.needed||[]).some(missing=>missing.hash===item.hash)).map(item=>()=>copy([remoteRoot+'\\'+item.hash],ownRoot.path));
      const pushes=(reply.needed||[]).map(item=>async()=>{const source=await files({operation:'content-check',hash:item.hash});if(source.available)await copy([source.path],remoteRoot);});
      const failures=(await Promise.all([runLimited(pulls,3),runLimited(pushes,3)])).flat();
      if(failures.length)throw failures[0];
      const confirmed=await send({workspaceProtocol:1,vv:reply.vv,changes:[],acks:await transaction(async journal=>structuredClone(journal.peers))});
      await transaction(async journal=>{journal.peers[peer.id]={name:peer.name,node:confirmed.node,vv:confirmed.vv,at:now(),waiting:(confirmed.needed?.length||0)+(confirmed.pending||0)};mergeAcks(journal,confirmed.acks);});
      await reconcile();return {ok:true};
    }
    async function status(workspaceId,devices=[]){return transaction(async(journal,stamps)=>{
      const versions=journal.state.workspaceVersions.filter(v=>v.workspaceId===workspaceId),conflict=versions.some(v=>W.inspect(journal.state,workspaceId,v.entryId).conflict)||S.conflictsOf(journal.state,stamps).some(c=>c.key.startsWith('workspaceEntries/'+workspaceId+':'));
      const missing=(await needed(journal)).filter(item=>versions.some(v=>v.hash===item.hash));
      const waiting=devices.filter(peer=>!journal.peers[peer.id]||journal.peers[peer.id].waiting||Object.entries(journal.vv).some(([id,n])=>(journal.peers[peer.id].vv[id]||0)<n)).map(peer=>peer.name);
      return W.status({localDurable:true,available:!missing.length,pendingPublication:!missing.length&&(await publications(journal,workspaceId)).length>0,conflict,requiredDevices:devices.map(peer=>peer.name),acknowledgedDevices:devices.filter(peer=>!waiting.includes(peer.name)).map(peer=>peer.name)});
    });}
    async function history(workspaceId,entryId){return transaction(async journal=>({versions:structuredClone(journal.state.workspaceVersions.filter(v=>v.workspaceId===workspaceId&&v.entryId===entryId)),...W.inspect(journal.state,workspaceId,entryId)}));}
    async function conflicts(workspaceId){return transaction(async(journal,stamps)=>[...S.conflictsOf(journal.state,stamps).filter(c=>c.key.startsWith('workspaceEntries/'+workspaceId+':')).map(c=>({...c,type:'metadata',name:journal.state.workspaceEntries.find(e=>'workspaceEntries/'+e.id===c.key)?.name||c.field||'Workspace entry'})),...journal.state.workspaceEntries.filter(e=>e.kind==='shortcut'&&e.workspaceId===workspaceId&&e.workspaceFileId).flatMap(entry=>{const state=W.inspect(journal.state,workspaceId,entry.workspaceFileId);return state.conflict?[{entryId:entry.workspaceFileId,name:entry.name,versions:state.heads.map(v=>({...v,device:stamps.get('workspaceVersions/'+v.id+'#kind')?.o===journal.node?'This device':Object.values(journal.peers).find(peer=>peer.node===stamps.get('workspaceVersions/'+v.id+'#kind')?.o)?.name||'Another device'}))}]:[];})]);}
    async function resolveMetadata(workspaceId,conflict,value){return transaction(async(journal,stamps)=>{
      if(!conflict.key?.startsWith('workspaceEntries/'+workspaceId+':'))throw Error('This conflict belongs to another workspace.');
      const current=S.conflictsOf(journal.state,stamps).find(c=>c.key===conflict.key&&c.field===conflict.field&&c.kind===conflict.kind);
      if(JSON.stringify(current)!==JSON.stringify(conflict))throw Error('The conflict changed. Review its current choices.');
      const record=journal.state.workspaceEntries.find(e=>'workspaceEntries/'+e.id===conflict.key);if(!record)throw Error('This entry is unavailable.');
      if(conflict.kind==='field'){
        if(![current.shown,...current.others].some(c=>JSON.stringify(c.v)===JSON.stringify(value)))throw Error('Choose a retained field value.');
        if(value===undefined)delete record[conflict.field];else record[conflict.field]=structuredClone(value);
        stamps.set(conflict.key+'#'+conflict.field,nextStamp(journal));
      }else for(const field of Object.keys(record))stamps.set(conflict.key+'#'+field,nextStamp(journal));
      return {ok:true};
    });}
    return Object.freeze({load,save,importFile,capture,reconcile,exchange,syncWith,remove,restore,status,history,conflicts,resolveMetadata,folder,folders,ensureFolder,flush:()=>tail});
  }
  root.ProximaWorkspaceReplica=Object.freeze({create});
})(globalThis);
