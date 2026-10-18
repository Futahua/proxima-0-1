// Only the host transport changes. As you Go owns presentation and document editing.
(()=>{
 const base=new URL('../',location.href),ws=new URL(location.href).searchParams.get('papers-blob-workspace'),local=new Map(),uploads=new Map(),known=new WeakMap();
 window.ProximaWebPlatform={touch:new URL(location.href).searchParams.has('papers-phone')};const style=document.createElement('style');style.textContent='html body button.phone-mouse-button{margin-bottom:env(safe-area-inset-bottom,0px)}';document.head.append(style);
 const note=text=>{const el=document.getElementById('status');if(el)el.textContent=text;};
 async function api(route,body){const response=await fetch(new URL(route,base),{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Proxima-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});const result=await response.json();if(!response.ok)throw Error(result.error||'BOP could not complete this action.');return result;}
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
  // Other devices' files need the installed Papers app; answer here instead of asking BOP every poll.
  if(method==='file'&&args[0]==='remote-files')return {ok:false,code:'BROWSER_UNAVAILABLE',message:'Other devices are reachable from the installed Papers app.'};
  if(method==='file'&&['open','reveal'].includes(args[0]))return launch(await api('api/workspace/frame',{workspaceId:ws,method:'entry',args:[args[1]]}));
  const result=await api('api/workspace/frame',{workspaceId:ws,method,args});
  if(method==='file'&&result.preview?.entryId)result.preview.url=content(result.preview.entryId);
  return result;
 }
 window.ProximaBrowserHost={blobRequest,async request(type,detail={}){
  if(type==='papers:project:copy-text'){await navigator.clipboard.writeText(detail.text);return {ok:true};}
  if(type==='papers:project:open-web-link')return launch({target:detail.url});
  if(type==='papers:project:as-you-go-shortcut-icon')return null;
  if(type==='papers:project:resolve-web-link-icon')return {};
  if(type==='papers:project:file-capability')return blobRequest(ws,'file',[detail.operation,detail.params]);
  return {ok:false,outcome:'unavailable',snapshot:null,candidates:[],message:'This action needs the installed Papers app.'};
 },renderWebPreview(container,url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open in browser ↗';link.className='file-capability-action';const frame=document.createElement('iframe');frame.src=url;frame.title='Link preview';frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');frame.className='file-capability-preview-frame';container.append(link,frame);}};
})();
