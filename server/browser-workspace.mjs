import path from 'node:path';
import {open,readFile,writeFile,rename,mkdir,copyFile,rm,readdir,access,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {embeddedPreview,embeddedPreviewExtensions} from './preview-extract.mjs';

// Transport for the existing As you Go blob pane. Native paths never become
// browser capabilities: every file effect resolves a managed workspace identity.
// Bump when the way BOP makes or serves a derived preview changes: browsers keep each address forever.
const RENDER='?r=2';
export function createBrowserWorkspace(engine,{store,uploads,receipts,atomic,derived}){
 // A picture stored inside a Revit, AutoCAD or SketchUp file, made once per file version and kept by the
 // version's hash (the bytes behind a hash never change, so neither does its picture).
 const making=new Map();
 // A DWG made into MLight CAD's offline drawing viewer (pan, zoom, layers, measuring) by its converter (C:\PapersServer\Tools\mlightcad beside the app folders),
 // one at a time, in the background; the first opening shows the embedded picture meanwhile.
 const converterRoot=process.env.PAPERS_MLIGHTCAD_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','Tools','mlightcad');
 const cli=path.join(converterRoot,'node_modules','@mlightcad','cad-simple-viewer-cli','dist','cli.js'),script=path.join(converterRoot,'node_modules','@mlightcad','cad-simple-viewer-cli','examples','export-html.scr');
 let converting=Promise.resolve();const queued=new Set();
 const exists=file=>access(file).then(()=>true,()=>false);
 async function drawingViewer(hash,contentPath){
  const target=path.join(derived,hash+'.drawing.html');
  if(await exists(target))return 'drawing.html';
  const failedAt=await stat(path.join(derived,hash+'.drawing.failed')).then(s=>s.mtimeMs,()=>0);
  if(queued.has(hash)||Date.now()-failedAt<6*3600*1000||!await exists(cli))return null; // a failure is retried after 6 hours
  queued.add(hash);
  converting=converting.then(async()=>{
   const work=path.join(derived,'work-'+hash.slice(0,16));
   try{
    await mkdir(work,{recursive:true});const input=path.join(work,'drawing.dwg');await copyFile(contentPath,input);
    await new Promise((resolve,reject)=>execFile(process.execPath,[cli,'-i',input,'-s',script,'-o',work,'--mode','read','--open-view-mode','extents'],{windowsHide:true,timeout:240000,maxBuffer:4*1024*1024,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(converterRoot,'..','ms-playwright')}},error=>error?reject(error):resolve()));
    const html=(await readdir(work)).find(name=>name.toLowerCase().endsWith('.html'));if(!html)throw Error('no viewer');
    await rename(path.join(work,html),target);
   }catch(error){console.error('DWG viewer failed for '+hash.slice(0,12)+': '+error.message);await writeFile(path.join(derived,hash+'.drawing.failed'),String(error.message)).catch(()=>{});}
   finally{queued.delete(hash);await rm(work,{recursive:true,force:true}).catch(()=>{});}
  });
  return null;
 }
 async function derivedThumbnail(hash,contentPath,ext){
  for(const suffix of ['png','bmp']){try{await open(path.join(derived,hash+'.thumb.'+suffix),'r').then(f=>f.close());return {name:'thumb.'+suffix,mime:'image/'+suffix};}catch{}}
  try{await open(path.join(derived,hash+'.none'),'r').then(f=>f.close());return null;}catch{}
  if(!making.has(hash))making.set(hash,(async()=>{
   const file=await open(contentPath,'r');let result;try{const size=(await file.stat()).size;result=await embeddedPreview(ext,async(offset,length)=>{const b=Buffer.alloc(length);const {bytesRead}=await file.read(b,0,length,offset);return new Uint8Array(b.buffer,b.byteOffset,bytesRead);},size);}finally{await file.close();}
   await mkdir(derived,{recursive:true});
   if(!result){await writeFile(path.join(derived,hash+'.none'),'');return null;}
   const suffix=result.mime==='image/png'?'png':'bmp',target=path.join(derived,hash+'.thumb.'+suffix),temp=target+'.'+process.pid+'.tmp';
   await writeFile(temp,result.bytes);await rename(temp,target);return {name:'thumb.'+suffix,mime:result.mime};
  })().finally(()=>making.delete(hash)));
  return making.get(hash);
 }
 const fail=message=>Object.assign(Error(message),{status:409});
 const virtual=item=>'P:\\Proxima\\'+item.workspaceFileId+'\\'+(item.workspaceFilename||item.name).replace(/[\\/]/g,'_');
 function browser(document){const doc=structuredClone(document);for(const item of doc.shortcuts||[])if(item.workspaceFileId){item.target=virtual(item);item.fileTarget={...item.fileTarget,path:item.target,id:item.workspaceFileId};}return doc;}
 async function load(ws){const result=await engine.replica.load(ws);return {...result,state:browser(result.state)};}
 // One file is looked up alone (its id is in its virtual path); only an unknown path reads the whole workspace.
 async function found(ws,detail){const id=detail.targetId||/^P:\\Proxima\\([^\\]+)\\/.exec(detail.path||'')?.[1]||detail.id,one=id?await engine.replica.entry(ws,id):null;let item,history;
  if(one&&(!detail.path||detail.path===virtual(one.item))){item=one.item;history=one.history;}
  else{const doc=(await engine.replica.load(ws)).state;item=doc.shortcuts.find(x=>x.workspaceFileId&&(detail.targetId===x.workspaceFileId||detail.path===virtual(x)||detail.id===x.id));if(!item)throw fail('This file is not in the workspace.');history=await engine.replica.history(ws,item.workspaceFileId);}
  const head=history.heads.length===1?history.heads[0]:null;return {item,history,head,target:{targetId:item.workspaceFileId,id:item.workspaceFileId,path:virtual(item),name:item.name,kind:'file',revision:history.versions.length+1,status:history.deleted?'deleted':item.workspaceAvailability==='local'&&!history.conflict?'present':'unavailable'}};}
 async function restoreLatest(ws,id){const history=await engine.replica.history(ws,id),byId=new Map(history.versions.map(x=>[x.id,x])),queue=history.heads.flatMap(x=>x.parents);let version;while(queue.length&&!version){const v=byId.get(queue.shift());if(v?.kind==='content')version=v;else if(v)queue.push(...v.parents);}if(!version)throw fail('No recoverable content version is available.');await engine.replica.restore(ws,id,version.id);}
 async function save(ws,args){
  const current=await engine.replica.load(ws);if(current.revision!==args[1])return {ok:false,code:'STALE_REVISION'};
  const doc=typeof args[0]==='string'?JSON.parse(args[0]):structuredClone(args[0]);if(!Array.isArray(doc.groups)||!Array.isArray(doc.shortcuts))throw fail('Invalid workspace document.');
  const imported=[];
  for(const item of doc.shortcuts){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.id||''))throw fail('Invalid entry identity.');
   const pending=/^web-upload:([a-f0-9]{32})$/.exec(item.target||'');
   if(pending){
    let receipt;try{receipt=JSON.parse(await readFile(path.join(receipts,pending[1]+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(receipt?.browserWorkspace&&receipt.entryId===item.id&&receipt.workspaceId===ws){item.workspaceFileId=item.id;item.workspaceFilename=receipt.name;item.target=virtual(item);continue;}
    if(current.state.shortcuts.some(x=>x.id===item.id))throw fail('An upload cannot replace an existing entry.');
    const upload=await store.getUpload(pending[1]);if(upload.offset!==upload.size||upload.metadata?.workspaceId!==ws)throw fail('This upload is incomplete or belongs to another workspace.');
    const file=await engine.replica.importFile(ws,path.join(uploads,pending[1]),upload.metadata.name,item.id);item.workspaceFileId=file.workspaceFileId;item.workspaceFilename=upload.metadata.name;item.target=virtual(item);imported.push({id:pending[1],entryId:item.id,name:upload.metadata.name,size:upload.size});
   }else if(item.workspaceFileId){
    if(!current.state.shortcuts.some(x=>x.workspaceFileId===item.workspaceFileId))throw fail('This managed file is no longer in the workspace.');
   }else if(!/^https?:\/\//i.test(item.target||''))throw fail('Upload files through the file chooser first.');
  }
  const baseline=await engine.replica.load(ws);if(baseline.entryRevision!==current.entryRevision)return {ok:false,code:'STALE_REVISION'};
  const result=await engine.replica.save(ws,doc,baseline.revision,args[2]||{});if(!result.ok)return result;
  if(!args[2]?.automatic)for(const item of doc.shortcuts){if(item.workspaceFileId&&item.placements?.some(p=>!p.bin)&&(await engine.replica.history(ws,item.workspaceFileId)).deleted)await restoreLatest(ws,item.workspaceFileId);}
  await engine.replica.reconcile();for(const item of imported){await atomic(path.join(receipts,item.id+'.json'),{...item,workspaceId:ws,browserWorkspace:true});await store.remove(item.id).catch(()=>{});}
  const saved=await load(ws);return {...result,revision:saved.revision,serialized:JSON.stringify(saved.state)};
 }
 async function file(ws,operation,detail={}){
  if(operation==='providers')return {ok:true,providers:{}};
  if(['icon','thumbnail'].includes(operation))return {ok:true,icon:null};
  if(operation==='preview-release'||operation.endsWith('-hide')||operation.endsWith('-close')||operation.endsWith('-visible'))return {ok:true};
  if(operation==='file-target-track'||operation==='file-target-resolve'||operation==='stat'){const f=await found(ws,detail);return {ok:true,target:f.target,entry:{...f.target,size:f.head?.size||0,extension:path.extname(f.item.name).slice(1),modifiedAt:0}};}
  if(operation==='file-target-delete'||operation==='file-target-restore'){
   const f=await found(ws,detail);if(detail.expectedRevision!==undefined&&detail.expectedRevision!==f.target.revision)throw fail('This file changed before the action.');
   if(operation==='file-target-delete')await engine.replica.remove(ws,f.item.workspaceFileId);else await restoreLatest(ws,f.item.workspaceFileId);
   await engine.replica.reconcile();return {ok:true,target:(await found(ws,detail)).target};
  }
  if(operation==='workspace-download')return {ok:true,target:(await found(ws,detail)).target};
  if(operation==='preview'||operation==='preview-text-chunk'){
   const f=await found(ws,detail);if(f.target.status!=='present')return {ok:false,message:f.history.conflict?'Choose a file version to resolve its conflict.':'This file has not reached BOP yet.'};
   const ext=path.extname(f.item.name).toLowerCase(),entry={...f.target,size:f.head.size,extension:ext.slice(1),modifiedAt:0};
   if(operation==='preview-text-chunk'||/\.(txt|md|markdown|csv|json|log|js|css|xml|yml|yaml|tex|py|ts|html)$/.test(ext)){
    const content=await engine.native.call('bp-7f977e43-e48d-44f7-9e02-df6bf7ee4349',{operation:'content-check',hash:f.head.hash});if(!content.available)throw fail('This file has not reached BOP yet.');
    const handle=await open(content.path,'r'),buffer=Buffer.alloc(65536),offset=Number.isSafeInteger(detail.offset)&&detail.offset>=0?detail.offset:0;let read;try{read=await handle.read(buffer,0,buffer.length,offset);}finally{await handle.close();}const text=buffer.subarray(0,read.bytesRead).toString('utf8'),value={text,nextOffset:offset+read.bytesRead,eof:offset+read.bytesRead>=f.head.size};return operation==='preview-text-chunk'?{ok:true,...value}:{ok:true,entry,preview:{kind:'text',...value}};
   }
   if(embeddedPreviewExtensions.includes(ext)){
    const content=await engine.native.call('bp-7f977e43-e48d-44f7-9e02-df6bf7ee4349',{operation:'content-check',hash:f.head.hash});
    if(content.available&&ext==='.dwg'){const viewer=await drawingViewer(f.head.hash,content.path).catch(()=>null);if(viewer)return {ok:true,entry,preview:{kind:'cad-html',derived:f.head.hash+'/'+viewer+RENDER,hash:f.head.hash,mime:'text/html'}};}
    const thumb=content.available?await derivedThumbnail(f.head.hash,content.path,ext).catch(()=>null):null;
    if(thumb)return {ok:true,entry,preview:{kind:'image',derived:f.head.hash+'/'+thumb.name+RENDER,hash:f.head.hash,mime:thumb.mime}};
   }
   const kind=/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(ext)?'image':ext==='.pdf'?'pdf':/\.(mp3|wav|ogg|m4a)$/.test(ext)?'audio':/\.(mp4|webm|mov)$/.test(ext)?'video':'binary';
   return {ok:true,entry,preview:{kind,entryId:f.item.workspaceFileId,workspaceId:ws,hash:f.head.hash}};
  }
  return {ok:false,code:'BROWSER_UNAVAILABLE',message:'This action needs the installed Papers app.'};
 }
 async function call(ws,method,args=[]){
  if(method==='load')return load(ws);if(method==='save')return save(ws,args);
  if(method==='flush'){await engine.replica.flush();return {ok:true};}
  if(method==='folders')return engine.replica.folders(ws);
  if(method==='ensureFolder')return engine.replica.ensureFolder(ws,...args);
  if(method==='status')return engine.replica.status(ws);
  if(method==='conflicts')return engine.replica.conflicts(ws);
  if(method==='resolveMetadata')return engine.replica.resolveMetadata(ws,...args);
  if(method==='restore')return engine.replica.restore(ws,...args);
  if(method==='file')return file(ws,args[0],args[1]);
  if(method==='entry'){const one=await engine.replica.entry(ws,args[0].id);if(one)return browser({shortcuts:[(await found(ws,{targetId:one.item.workspaceFileId})).item]}).shortcuts[0];const doc=(await engine.replica.load(ws)).state,item=doc.shortcuts.find(x=>x.id===args[0].id);if(item&&!item.workspaceFileId&&/^https?:\/\//i.test(item.target))return item;return browser({shortcuts:[(await found(ws,args[0])).item]}).shortcuts[0];}
  throw fail('Unknown workspace action.');
 }
 return {call};
}
