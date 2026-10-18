/* Host and transport adapter for the optional blob workspace. No UI writer or
 * transport is created inside the AYG pane. */
(function(root){
  'use strict';
  const params=new URL(location.href).searchParams;
  const pending=new Map(),phone=params.has('papers-phone');
  addEventListener('message',event=>{
    const value=event.data;if(event.source!==(phone?parent:window)||value?.type!=='papers:host:result')return;
    const task=pending.get(value.requestId);if(!task)return;pending.delete(value.requestId);clearTimeout(task.timer);value.ok?task.resolve(value):task.reject(Error(value.error||'Papers refused the workspace request.'));
  });
  function request(type,detail={}){
    return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Workspace operation timed out; pending work is retained.'));},180000);pending.set(requestId,{resolve,reject,timer});(phone?parent:window).postMessage({type,requestId,...detail},location.origin);});
  }
  async function call(operation,detail={}){
    if(root.__proximaWorkspaceNative)return root.__proximaWorkspaceNative(operation,detail);
    const response=(await request('papers:project:file-capability',{operation,params:detail})).fileCapability;
    if(response?.ok===false)throw Object.assign(Error(response.message||response.code||'Workspace file operation failed.'),{code:response.code});
    return response?.result??response;
  }
  const files=detail=>call('workspace-files',detail);
  const updates=typeof BroadcastChannel==='function'?new BroadcastChannel('proxima-workspace-updates'):null;
  updates?.addEventListener('message',event=>{dispatchEvent(new Event('proxima:workspace-changed'));if(event.data?.records)dispatchEvent(new Event('proxima-sync:local-change'));});
  const replica=root.ProximaWorkspaceReplica.create({storage:{load:()=>files({operation:'journal-load'}),save:(state,revision)=>files({operation:'journal-save',state,revision})},files,copy:(paths,destination)=>call('copy',{paths,destination}),changed:change=>{updates?.postMessage(change);dispatchEvent(new Event('proxima:workspace-changed'));if(change?.records)dispatchEvent(new Event('proxima-sync:local-change'));}});
  let reconciling=null;
  function reconcile(){return reconciling??=(replica.reconcile().then(issues=>{if(issues.length)errors.set('local',{message:issues[0].message});else errors.delete('local');return issues;}).finally(()=>{reconciling=null;}));}
  const errors=new Map();
  async function syncWith(peer,send){try{await replica.syncWith(peer,send);errors.delete(peer.id);}catch(error){errors.set(peer.id,{name:peer.name,message:error.message});throw error;}}
  // Pictures in the synced root travel to every device inside its records and are only shown as
  // small icons, so a large pasted image is stored at most 128 px. One that cannot be read is kept.
  const shrunk=new Map();
  async function shrinkImage(url){
    if(url.length<24000)return url;
    if(shrunk.has(url))return shrunk.get(url);
    let out=url;
    try{
      // Decoded directly: the page's content policy may not allow fetching data: addresses.
      const [head,body='']=url.split(','),type=(/^data:([^;,]+)/.exec(head)||[])[1]||'image/png',bytes=head.includes(';base64')?Uint8Array.from(atob(body),c=>c.charCodeAt(0)):new TextEncoder().encode(decodeURIComponent(body));
      const bitmap=await createImageBitmap(new Blob([bytes],{type})),scale=Math.min(1,128/Math.max(bitmap.width,bitmap.height)),w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
      const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(w,h):Object.assign(root.document.createElement('canvas'),{width:w,height:h});
      canvas.getContext('2d').drawImage(bitmap,0,0,w,h);bitmap.close?.();
      const small=canvas.convertToBlob?await canvas.convertToBlob({type:'image/webp',quality:.85}):await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.85));
      const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(small);});
      if(typeof encoded==='string'&&encoded.length<url.length)out=encoded;
    }catch{/* keep the original */}
    shrunk.set(url,out);return out;
  }
  async function shrinkPictures(doc){
    const visit=async value=>{
      if(typeof value==='string')return value.startsWith('data:image/')?shrinkImage(value):value;
      if(Array.isArray(value)){for(let i=0;i<value.length;i++)value[i]=await visit(value[i]);return value;}
      if(value&&typeof value==='object')for(const key of Object.keys(value))value[key]=await visit(value[key]);
      return value;
    };
    for(const item of [...(doc.groups||[]),...(doc.shortcuts||[])])if(item.icon)item.icon=await visit(item.icon);
    return doc;
  }
  async function prepareDocument(workspaceId,raw){
    const document=typeof raw==='string'?JSON.parse(raw):structuredClone(raw);
    const previous=(await replica.load(workspaceId)).state;
    const additions=[],removed=new Set();let importedCount=0;
    async function materialize(path){
      if(/^\\\\papers~(?!phone\\)/i.test(path)){const staging=await files({operation:'incoming-root'}),result=await call('copy',{paths:[path],destination:staging.path});if(!result.paths?.[0])throw Error('The transfer did not confirm a local workspace copy.');return result.paths[0];}
      return path;
    }
    async function folder(path,parentId,name,depth=0){
      if(depth>64||importedCount>10000)throw Error('This folder tree is too large for one import.');
      const groupId=crypto.randomUUID(),listing=await files({operation:'enumerate',path});document.groups??=[];document.groups.push({id:groupId,parentId,name,order:document.groups.length,icon:null});
      for(const entry of listing.entries||[]){importedCount++;if(entry.kind==='folder')await folder(entry.path,groupId,entry.name,depth+1);else{const itemId=crypto.randomUUID(),file=await replica.importFile(workspaceId,entry.path,entry.name,itemId);additions.push({id:itemId,name:entry.name,description:'',target:file.target,workspaceFileId:itemId,workspaceFilename:entry.name,icon:null,placements:[{id:crypto.randomUUID(),parentId:groupId,order:additions.length}]});}}
    }
    for(const item of document.shortcuts||[]){
      if(/^https?:\/\//i.test(item.target||''))continue;
      const old=previous.shortcuts.find(value=>value.id===item.id);
      // A managed file's location belongs to this workspace, not to the pane: a pane may report it
      // in another form, which must never refuse the save (that refusal blocked Papers' reload).
      if(old?.workspaceFileId){item.workspaceFileId=old.workspaceFileId;item.workspaceFilename=old.workspaceFilename;item.target=old.target;continue;}
      const source=await materialize(item.target),description=await files({operation:'enumerate',path:source});
      if(description.kind==='folder'){for(const placement of item.placements||[])await folder(source,placement.parentId,item.name);removed.add(item.id);continue;}
      const imported=await replica.importFile(workspaceId,source,description.name,item.id);item.workspaceFileId=imported.workspaceFileId;item.workspaceFilename=description.name;item.target=imported.target;
    }
    document.shortcuts=[...document.shortcuts.filter(item=>!removed.has(item.id)),...additions];
    return document;
  }
  // A file known by its id is looked up alone; only a bare path needs the whole workspace.
  async function find(workspaceId,detail){
    if(detail.targetId){const found=await replica.entry(workspaceId,detail.targetId);if(found)return found;}
    const doc=(await replica.load(workspaceId)).state;
    const item=doc.shortcuts.find(item=>item.workspaceFileId&&(detail.targetId===item.workspaceFileId||detail.path===item.target));
    return item?{item,history:await replica.history(workspaceId,item.workspaceFileId)}:null;
  }
  async function target(workspaceId,detail){
    let found=await find(workspaceId,detail);
    if(!found)throw Error('This file has not been imported into this workspace.');
    const available=await files({operation:'path',workspaceId,entryId:found.item.workspaceFileId,name:found.item.workspaceFilename||found.item.name});
    if(available.available&&await replica.capture(workspaceId,found.item.workspaceFileId,found.item.workspaceFilename||found.item.name))found=await find(workspaceId,{targetId:found.item.workspaceFileId});
    const {item,history}=found;
    return {item,target:{targetId:item.workspaceFileId,id:item.workspaceFileId,path:item.target,name:item.name,kind:'file',revision:history.versions.length+1,status:available.available&&item.workspaceAvailability==='local'?'present':history.deleted?'deleted':'unavailable'}};
  }
  // The newest content version before a deletion: what a restore from the Bin brings back.
  async function restoreLatest(workspaceId,entryId){
    const history=await replica.history(workspaceId,entryId),byId=new Map(history.versions.map(v=>[v.id,v])),queue=history.heads.flatMap(v=>v.parents);let content;
    while(queue.length&&!content){const value=byId.get(queue.shift());if(value?.kind==='content')content=value;else if(value)queue.push(...value.parents);}
    if(!content)throw Error('Choose a retained content version before restoring this entry.');
    await replica.restore(workspaceId,entryId,content.id);
  }
  // Restoring an entry from the Bin restores its file on every device.
  async function restoreUnbinned(workspaceId,document){
    for(const item of document.shortcuts||[]){
      if(!item.workspaceFileId||!(item.placements||[]).length||item.placements.some(p=>p.bin))continue;
      if((await replica.history(workspaceId,item.workspaceFileId)).deleted)await restoreLatest(workspaceId,item.workspaceFileId);
    }
  }
  async function frameCall(workspaceId,method,args=[]){
    if(method==='load')return replica.load(workspaceId);
    if(method==='save'){
      const current=await replica.load(workspaceId);if(current.revision!==args[1])return {ok:false,code:'STALE_REVISION'};
      const document=args[2]?.automatic?(typeof args[0]==='string'?JSON.parse(args[0]):structuredClone(args[0])):await prepareDocument(workspaceId,args[0]);
      await shrinkPictures(document);
      // Importing files changes only the version collection. Read its new
      // checked revision before committing this same serialized local action.
      const baseline=await replica.load(workspaceId);if(baseline.entryRevision!==current.entryRevision)return {ok:false,code:'STALE_REVISION'};
      const saved=await replica.save(workspaceId,document,baseline.revision,args[2]);
      if(!saved.ok||args[2]?.automatic)return saved;
      await restoreUnbinned(workspaceId,document);
      return {ok:true,revision:(await replica.load(workspaceId)).revision};
    }
    if(method==='flush'){await replica.flush();return {ok:true};}
    if(method==='launch'||method==='reveal'){
      const item=(await replica.entry(workspaceId,args[0]))?.item||(await replica.load(workspaceId)).state.shortcuts.find(item=>item.id===args[0]);if(!item)throw Error('That workspace entry is unavailable.');
      if(item.workspaceAvailability==='pending')throw Error('This file is waiting to download to this device.');
      return call(method==='launch'?'open':'reveal',{path:item.target});
    }
    // Dropped File objects lose their disk paths crossing from the pane into this page, and Papers then
    // never answers; give up after 5 seconds so a drop reports instead of waiting silently.
    if(method==='resolve-dropped')return Promise.race([request('papers:project:resolve-dropped-targets',{files:args[0]}).then(r=>r.targets),new Promise(resolve=>setTimeout(()=>resolve([]),5000))]);
    // A slow page must not hold up saving the link: after 8 seconds it is saved under its host name.
    if(method==='resolve-web-icon')return Promise.race([request('papers:project:resolve-web-link-icon',{url:String(args[0]||'')}).then(({type,requestId,ok,...result})=>result),new Promise(resolve=>setTimeout(()=>resolve({}),8000))]);
    if(method==='pick-target')return (await request('papers:project:as-you-go-pick-target',{kind:args[0]})).target;
    if(method==='pick-phone')return (await request('papers:phone:pick-files')).picked;
    if(method==='file'){
      const [operation,detail={}]=args;
      if(operation.startsWith('file-target-')){
        const found=await target(workspaceId,detail);
        if(operation==='file-target-delete'){
          if(detail.expectedRevision!==found.target.revision)throw Error('This workspace file changed before deletion.');
          await replica.remove(workspaceId,found.item.workspaceFileId);await reconcile();const result=await files({operation:'path',workspaceId,entryId:found.item.workspaceFileId,name:found.item.workspaceFilename||found.item.name});if(result.available)throw Error('This file changed before deletion. Both versions were retained.');return {ok:true,target:{...found.target,status:'deleted',revision:found.target.revision+1}};
        }
        if(operation==='file-target-restore'){
          if(detail.expectedRevision!==undefined&&detail.expectedRevision!==found.target.revision)throw Error('This workspace file changed before restoration.');
          await restoreLatest(workspaceId,found.item.workspaceFileId);return {ok:true,target:{...found.target,status:'present',revision:found.target.revision+1}};
        }
        return {ok:true,target:found.target};
      }
      if(operation==='delete'){
        // Killing a managed file is a recoverable deletion that reaches every device's Bin.
        const doc=(await replica.load(workspaceId)).state,items=(detail.paths||[]).map(path=>doc.shortcuts.find(item=>item.workspaceFileId&&item.target===path));
        if(!items.length||items.some(item=>!item))throw Error('Only files in this workspace can be killed here.');
        for(const item of items)await replica.remove(workspaceId,item.workspaceFileId);
        await reconcile();return {ok:true,targets:[]};
      }
      if(['move','rename','workspace-files'].includes(operation))throw Error('Change managed files through their workspace entries.');
      return call(operation,detail);
    }
    throw Error('That operation is not available in a blob file pane.');
  }
  root.ProximaWorkspaces=Object.freeze({...replica,exchange:replica.exchange,syncWith,frameCall,request,call,reconcile,errors});
  const timer=setInterval(()=>void reconcile().catch(error=>errors.set('local',{message:error.message})),5000);
  addEventListener('focus',()=>void reconcile().catch(()=>{}));addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})(globalThis);
