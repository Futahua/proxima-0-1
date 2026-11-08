// Only the host transport changes. As you Go owns presentation and document editing.
(()=>{
 const base=new URL('../',location.href),ws=new URL(location.href).searchParams.get('papers-blob-workspace'),local=new Map(),uploads=new Map(),known=new WeakMap();
 window.ProximaWebPlatform={touch:new URL(location.href).searchParams.has('papers-phone')};const style=document.createElement('style');style.textContent='html body button.phone-mouse-button{margin-bottom:env(safe-area-inset-bottom,0px)}';document.head.append(style);
 const note=text=>{const el=document.getElementById('status');if(el)el.textContent=text;};
 // BOP restarting (no connection, a 502/503/504 from the tunnel, or an empty reply) is waited out for
 // a short interruption instead of immediately freezing the pane in its conflict state.
 async function api(route,body){
  for(let attempt=0;;attempt++){
   let response,result;
   try{response=await fetch(new URL(route,base),{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Proxima-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});
    if(![502,503,504].includes(response.status))result=await response.json();}catch{}
   if(result!==undefined){if(!response.ok)throw Error(result.error||'BOP could not complete this action.');return result;}
   if(attempt>=7)throw Error('BOP is not answering. Your change was not saved; try again in a moment.');
   if(attempt===1)note('Reconnecting to BOP…');
   await new Promise(resolve=>setTimeout(resolve,Math.min(4000,500*2**attempt)));
  }
 }
 // The coordinator reports its lifecycle explicitly. Never reload away an unsaved user edit.
 let reloading=false;
 const currentFolder=()=>window.__papersBlobCurrentFolder?.()||null;
 function roleChanged({role,hasUnsavedConflict=true}){if(role!=='conflict')return;if(hasUnsavedConflict){note('This change is not saved. Your pending version is kept; use the conflict controls to retry.');return;}if(reloading)return;reloading=true;note('Reconnecting the file pane to BOP…');setTimeout(()=>{const folder=currentFolder();if(folder){const url=new URL(location.href);url.searchParams.set('as-you-go-folder',folder);history.replaceState(null,'',url);}location.reload();},1500);}
 const register=file=>{let target=known.get(file);if(!target){target='P:\\Uploads\\'+crypto.randomUUID()+'\\'+file.name;known.set(file,target);local.set(target,file);}return {target,name:file.name,kind:'file'};};
 function pick(){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.style.display='none';document.body.append(input);input.onchange=()=>{resolve([...input.files].map(register));input.remove();};input.addEventListener('cancel',()=>{resolve([]);input.remove();},{once:true});input.click();});}
 function upload(token){if(uploads.has(token))return uploads.get(token);const file=local.get(token);if(!file)throw Error('Choose this file again; it is no longer held by this browser.');const job=new Promise((resolve,reject)=>{const task=new tus.Upload(file,{endpoint:new URL('uploads',base).href,chunkSize:5*1024**2,retryDelays:[0,1000,3000,5000,10000,20000],headers:{'X-Proxima-Request':'1'},metadata:{workspaceId:ws,folderId:'root',name:file.name},removeFingerprintOnSuccess:true,fingerprint:async()=>base.href+'|'+ws+'|ayg|'+file.name+'|'+file.size+'|'+file.lastModified,onProgress(sent,total){note('Uploading '+file.name+' · '+Math.round(sent/Math.max(1,total)*100)+'%');},onError(error){note('Upload not saved · '+error.message);uploads.delete(token);reject(error);},onSuccess(){resolve('web-upload:'+new URL(task.url).pathname.split('/').at(-1));}});void task.findPreviousUploads().then(previous=>{if(previous.length)task.resumeFromPreviousUpload(previous[0]);task.start();}).catch(()=>task.start());});uploads.set(token,job);return job;}
 const content=(id,download=false)=>new URL('api/'+(download?'download':'content')+'/'+encodeURIComponent(ws)+'/'+encodeURIComponent(id),base).href;
 function launch(item){const a=document.createElement('a');if(item.workspaceFileId){a.href=content(item.workspaceFileId,true);a.download=item.name;}else if(/^https?:\/\//i.test(item.target)){a.href=item.target;a.target='_blank';a.rel='noopener noreferrer';}else throw Error('This file is not available in the workspace.');document.body.append(a);a.click();a.remove();return {ok:true};}
 async function blobRequest(workspaceId,method,args=[]){
  if(workspaceId!==ws)throw Error('This pane belongs to another workspace.');
  if(method==='pick-phone')return pick();
  if(method==='pick-target'){if(args[0]==='folder')throw Error('Create a workspace folder with the folder button, then add files to it.');return (await pick())[0]||null;}
  if(method==='resolve-dropped')return args[0].filter(file=>file instanceof File).map(register);
  if(method==='resolve-web-icon')return {};
  if(method==='launch'||method==='reveal')return launch(await api('api/workspace/frame',{workspaceId:ws,method:'entry',args:[{id:args[0]}]}));
  if(method==='save'){
   const doc=typeof args[0]==='string'?JSON.parse(args[0]):structuredClone(args[0]);for(const item of doc.shortcuts||[])if(local.has(item.target))item.target=await upload(item.target);
   const result=await api('api/workspace/frame',{workspaceId:ws,method,args:[doc,args[1],args[2]]});note(result.ok?'Saved on BOP':'The folder changed; checking its latest version…');return result;
  }
  // A file dropped or picked in this browser is only here until its save uploads it: answer for it here
  // (BOP has never seen it), so the drop goes on to the save instead of failing.
  const pendingPath=method==='file'&&args[1]&&typeof args[1].path==='string'&&local.get(args[1].path);
  if(pendingPath){const name=pendingPath.name,dot=name.lastIndexOf('.');if(args[0]==='stat')return {ok:true,entry:{path:args[1].path,name,kind:'file',size:pendingPath.size,extension:dot>0?name.slice(dot+1).toLowerCase():'',modifiedAt:pendingPath.lastModified}};return {ok:false,code:'UPLOAD_PENDING',message:'This file uploads when it is saved.'};}
  // Other devices' files need the installed Papers app; answer here instead of asking BOP every poll.
  if(method==='file'&&args[0]==='remote-files')return {ok:false,code:'BROWSER_UNAVAILABLE',message:'Other devices are reachable from the installed Papers app.'};
  if(method==='file'&&['open','reveal'].includes(args[0]))return launch(await api('api/workspace/frame',{workspaceId:ws,method:'entry',args:[args[1]]}));
  const result=await api('api/workspace/frame',{workspaceId:ws,method,args});
  // Addresses that name the file version can be kept by the browser for good (BOP marks them so).
  if(method==='file'&&result.preview?.derived)result.preview.url=new URL('api/derived/'+result.preview.derived,base).href;
  else if(method==='file'&&result.preview?.entryId)result.preview.url=content(result.preview.entryId)+(result.preview.hash?'?v='+result.preview.hash:'');
  return result;
 }
 window.ProximaBrowserHost={blobRequest,roleChanged,async request(type,detail={}){
  if(type==='papers:project:copy-text'){await navigator.clipboard.writeText(detail.text);return {ok:true};}
  if(type==='papers:project:open-web-link')return launch({target:detail.url});
  if(type==='papers:project:as-you-go-shortcut-icon')return null;
  if(type==='papers:project:resolve-web-link-icon')return {};
  if(type==='papers:project:file-capability')return blobRequest(ws,'file',[detail.operation,detail.params]);
  return {ok:false,outcome:'unavailable',snapshot:null,candidates:[],message:'This action needs the installed Papers app.'};
 },renderWebPreview(container,url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open in browser ↗';link.className='file-capability-action';const frame=document.createElement('iframe');frame.src=url;frame.title='Link preview';frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');frame.className='file-capability-preview-frame';container.append(link,frame);}};
 // Drag/drop, folder targeting and pictures stay with AYG's existing command handlers.
 // The save adapter above only transports their imported files and checked document.
})();
