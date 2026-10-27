/* Flow embed bridge: answers native Flow's portable file-embed requests through the
 * existing workspace replica, which owns managed copies, content hashes, versions,
 * conflicts, device transfer and the cache. Papers' flow-embed-exchange capability
 * only carries the requests and answers; this module stores no file content and
 * keeps no second sync record. Embedded files live in the internal "flow-embeds"
 * workspace (like "blob-documents"), so they sync to every device as usual.
 * Interactive embeds save their own data explicitly as one JSON document each,
 * through the replica's checked document store (never raw browser storage). */
(function(root){
 'use strict';
 const WORKSPACE='flow-embeds',IMPORTS_KEY='proxima.flow.embed-imports.v1',MAX_REMEMBERED=200;
 const fileName=path=>String(path).split(/[\\/]/).filter(Boolean).pop()||'file';
 // Every step has a time limit: one call that never settles must not leave Flow
 // waiting silently or stop this bridge answering (each batch waits on the last).
 const LIMITS={call:15000,store:120000,download:900000,batch:300000};
 function within(promise,ms,what){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(what+' did not finish in time; retrying.')),ms);})]).finally(()=>clearTimeout(timer));
 }

 function create({workspaces,exchange,device,storage=null,uuid=()=>crypto.randomUUID(),limits=LIMITS}){
  // Answers already given survive a page reload, so a request Flow has not yet
  // collected is never imported twice.
  let remembered={};
  const recall=()=>{try{remembered=JSON.parse(storage?.getItem(IMPORTS_KEY)||'{}')||{};}catch{remembered={};}};
  recall();
  const downloads=new Map(),docAnswers=new Map(),importing=new Map();
  const remember=()=>{try{storage?.setItem(IMPORTS_KEY,JSON.stringify(remembered));}catch{}};

  async function importOne(request,origin){
   try{
    const name=fileName(request.path),entryId=request.requestId;
    if(typeof entryId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entryId))throw Error('Invalid embed request identity.');
    // receiveFile already reuses an existing entry with the same content.
    await within(workspaces.receiveFile(WORKSPACE,request.path,name,'root',entryId,uuid()),limits.store,'Storing the file');
    return {ok:true,workspaceId:WORKSPACE,entryId,name,origin};
   }catch(error){return {ok:false,message:error?.message||'The file could not be stored.'};}
  }

  async function resolveOne(want){
   const key=want.workspaceId+'/'+want.entryId,retry=want.retry;
   let found;
   // observe: a changed managed copy becomes a new version under the same ID.
   try{found=await within(workspaces.entry(want.workspaceId,want.entryId,{observe:true}),limits.call,'Checking the file');}
   catch(error){return {status:'error',message:error?.message||'The file could not be checked.',retry};}
   if(!found)return {status:'missing',message:'This embed has not synced to this device yet.',retry};
   const {item,history}=found,name=item.workspaceFilename||item.name;
   if(history.deleted)return {status:'deleted',name,message:'This file was deleted from Proxima.',retry};
   if(item.workspaceAvailability==='local'){
    const hash=found.binding?.hash||undefined;
    return history.conflict
     ?{status:'conflict',path:item.target,name,hash,message:'Edited on two devices. Both versions are kept in Proxima.',retry}
     :{status:'ready',path:item.target,name,hash,retry};
   }
   let task=downloads.get(key);
   if(!task||(task.done&&task.retry!==retry))task=download(want.workspaceId,want.entryId,retry);
   if(!task.done)return {status:'downloading',name,message:'Downloading…',retry};
   return {status:'waiting',name,message:task.error?.message||'No connected device has this file yet.',retry};
  }

  // The existing download path: BOP first, then any connected peer, verified by hash.
  // Flow's requests and prefetch share it, so a file is never fetched twice at once.
  function download(workspaceId,entryId,retry){
   const task={retry,done:false,error:null};
   task.promise=within(Promise.resolve().then(()=>workspaces.frameCall(workspaceId,'file',['workspace-download',{targetId:entryId}])),limits.download,'The download')
    .catch(error=>{task.error=error;}).finally(()=>{task.done=true;});
   downloads.set(workspaceId+'/'+entryId,task);
   return task;
  }

  async function answerDocument(doc){
   try{
    if(doc.op==='load'){
     const value=await within(workspaces.readDocument(doc.documentId),limits.call,'Loading the saved data');
     return {ok:true,content:value.content,revision:value.revision,...(value.conflicts?.length?{code:'DOCUMENT_CONFLICT',message:'Saved on two devices at once; the newest is shown.'}:{})};
    }
    const saved=await within(workspaces.saveDocument(doc.documentId,doc.content,doc.revision??null),limits.call,'Saving');
    // A save retried after it already landed (leadership moved mid-answer) is a success.
    if(saved.ok||JSON.stringify(saved.content)===JSON.stringify(doc.content))return {ok:true,content:saved.content,revision:saved.revision};
    return {ok:false,code:saved.code||'DOCUMENT_CHANGED',content:saved.content,revision:saved.revision,message:'This was saved from another device first.'};
   }catch(error){return {ok:false,code:'ERROR',message:error?.message||'The data could not be saved.'};}
  }

  /** Answers one batch of Flow requests ({imports, wants, docs}). The desktop page
   * gets them from the host mailbox; the phone's owner page from FlowEmbedServer. */
  async function answer(request){
   // Phone file/import/document requests may overlap. Reply membership belongs
   // to this batch, never a shared map another request can prune.
   const files=new Map();
   // Another Proxima page may have answered since the last batch (leadership can move).
   recall();
   const origin=await device();
   const imports={},wantedImports=new Set();
   for(const item of request.imports||[]){
    wantedImports.add(item.requestId);
    if(!remembered[item.requestId]){
     // A batch that ran out of time leaves its import running; join it, never start another.
     let pending=importing.get(item.requestId);
     if(!pending){
      pending=importOne(item,origin).then(result=>{remembered[item.requestId]=result;remember();}).finally(()=>importing.delete(item.requestId));
      importing.set(item.requestId,pending);
     }
     await pending;
    }
    imports[item.requestId]=remembered[item.requestId];
   }
   // Forget answers Flow has collected (it removes the request once applied).
   const stale=Object.keys(remembered).filter(id=>!wantedImports.has(id));
   if(stale.length){for(const id of stale)delete remembered[id];remember();}
   const keys=Object.keys(remembered);if(keys.length>MAX_REMEMBERED){for(const id of keys.slice(0,keys.length-MAX_REMEMBERED))delete remembered[id];remember();}
   const wanted=new Set();
   for(const want of request.wants||[]){const key=want.workspaceId+'/'+want.entryId;wanted.add(key);files.set(key,await resolveOne(want));}
   for(const key of [...files.keys()])if(!wanted.has(key))files.delete(key);
   for(const [key,task] of downloads)if(!wanted.has(key)&&task.done)downloads.delete(key);
   const docs={},wantedDocs=new Set();
   for(const doc of request.docs||[]){
    wantedDocs.add(doc.requestId);
    if(!docAnswers.has(doc.requestId))docAnswers.set(doc.requestId,await answerDocument(doc));
    docs[doc.requestId]=docAnswers.get(doc.requestId);
   }
   for(const id of [...docAnswers.keys()])if(!wantedDocs.has(id))docAnswers.delete(id);
   // A page whose newest version has not reached this device can still carry an old
   // machine path; Flow then asks for the embedded file by its name.
   const lookups={};
   if((request.lookups||[]).length){
    let shortcuts=[];
    try{shortcuts=(await within(workspaces.load(WORKSPACE),limits.call,'Listing embedded files')).state?.shortcuts||[];}catch{}
    for(const name of request.lookups){
     if(typeof name!=='string'||!name)continue;
     const match=shortcuts.filter(item=>item.workspaceFileId&&(item.workspaceFilename||item.name)===name&&!(item.placements||[]).some(p=>p.bin)).pop();
     lookups[name]=match?{workspaceId:WORKSPACE,entryId:match.workspaceFileId,name}:null;
    }
   }
   return {device:origin,imports,files:Object.fromEntries(files),docs,lookups};
  }

  // Embedded files are fetched as soon as they sync, not when a page first asks:
  // opening the page on another device then shows the file at once.
  const PREFETCH_EVERY=20000,PREFETCH_BACKOFF=120000,failedAt=new Map();
  let prefetching=false,lastPrefetch=0;
  async function prefetch(now=Date.now()){
   if(prefetching||now-lastPrefetch<PREFETCH_EVERY)return 0;
   prefetching=true;lastPrefetch=now;let started=0;
   try{
    const doc=(await within(workspaces.load(WORKSPACE),limits.call,'Listing embedded files')).state;
    for(const item of doc?.shortcuts||[]){
     if(!item.workspaceFileId||item.workspaceAvailability==='local'||(item.placements||[]).some(p=>p.bin))continue;
     const key=WORKSPACE+'/'+item.workspaceFileId;
     if(downloads.get(key)?.done===false||now-(failedAt.get(key)||0)<PREFETCH_BACKOFF)continue;
     started++;
     // One at a time, through the same verified download path Flow's requests use.
     const task=download(WORKSPACE,item.workspaceFileId,downloads.get(key)?.retry??0);
     await task.promise;
     if(task.error)failedAt.set(key,Date.now());else failedAt.delete(key);
    }
   }finally{prefetching=false;}
   return started;
  }

  let busy=false;
  async function tick(){
   if(busy)return false;busy=true;
   try{
    const request=await within(exchange({action:'take'}),limits.call,'Reading Flow requests');
    if(!request?.ok)return false;
    const resolutions=await within(answer(request),limits.batch,'Answering Flow');
    await within(exchange({action:'publish',resolutions}),limits.call,'Sending answers to Flow');
    void prefetch().catch(()=>{});
    return true;
   }finally{busy=false;}
  }
  return Object.freeze({tick,answer,prefetch,downloads});
 }

 root.ProximaFlowEmbedBridge=Object.freeze({create,WORKSPACE,LIMITS,within});

 // Only the desktop Proxima page hosted by Papers answers Flow (not the phone or a device copy).
 if(typeof location==='undefined'||location.protocol!=='papers-backpack:'||root.__proximaDevice||new URL(location.href).searchParams.has('papers-phone')||!root.ProximaWorkspaces)return;
 let deviceName='',started=false;
 const bridge=create({
  workspaces:root.ProximaWorkspaces,
  exchange:detail=>root.ProximaWorkspaces.call('flow-embed-exchange',detail),
  device:async()=>{if(!deviceName)deviceName=await root.__proximaDeviceCopy?.devices?.().then(list=>list?.self?.name||'',()=>'')||'';return deviceName;},
  storage:root.localStorage,
 });
 let reported='';
 // Log each new kind of failure once, so a recurring stall is visible without flooding.
 const run=()=>void bridge.tick().then(()=>{reported='';},error=>{if(reported!==error.message){console.warn('Flow embeds:',error.message);reported=error.message;}});
 // Several Papers pages can host Proxima at once; exactly one answers Flow, or two
 // pages would import the same request (seen as duplicate flow-embeds entries).
 // The first page to take this lock keeps it for its lifetime; when it closes the
 // lock passes to the next waiting page. Runs while hidden: Flow may be in use
 // while Proxima is behind it.
 function lead(){
  if(started)return;started=true;
  const timer=setInterval(run,3000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});run();
 }
 if(root.navigator?.locks?.request)root.navigator.locks.request('proxima-flow-embed-bridge',()=>new Promise(()=>lead())).catch(()=>{});
 else lead();
})(globalThis);
