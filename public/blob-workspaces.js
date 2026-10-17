(function(root){
 'use strict';
 let pane,frame,selected,scope,origin,chain=Promise.resolve();const flushes=new Map();
 function build(){if(pane)return;
  pane=document.createElement('section');pane.className='blob-workspace-pane';pane.hidden=true;pane.setAttribute('aria-label','Blob contents');
  const head=document.createElement('header'),title=document.createElement('strong'),select=document.createElement('select'),close=document.createElement('button'),status=document.createElement('p'),body=document.createElement('div'),conflicts=document.createElement('aside');
  for(const [value,label] of [['','No template'],['as-you-go','As you Go']]){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}select.setAttribute('aria-label','Blob template');close.textContent='×';close.setAttribute('aria-label','Close blob contents');status.setAttribute('role','status');
  head.append(title,select,close);conflicts.hidden=true;conflicts.className='blob-workspace-conflicts';pane.append(head,status,conflicts,body);pane.parts={title,select,status,body,conflicts};document.body.append(pane);close.onclick=()=>{pane.hidden=true;};
  select.onchange=async()=>{select.disabled=true;try{await flush();const item=Store.timelineIntervals().find(x=>x.id===selected);const r=await Store.command({type:'timeline-interval.template',ifRev:item.rev,payload:{intervalId:item.id,template:select.value||null}});if(!r.ok)throw Error('The blob changed before its template could be saved.');await mount(selected);document.querySelectorAll('.exact-timeline').forEach(node=>root.ExactTimeline.mount(node,Store).refresh());}catch(e){status.textContent=e.message;}finally{select.disabled=false;}};
  setInterval(()=>{if(!pane.hidden&&scope)void report();},3000);
 }
 async function flush(){if(!frame||!scope)return;const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{flushes.delete(requestId);reject(Error('The file pane has not confirmed saving yet.'));},15000);flushes.set(requestId,{resolve,reject,timer});frame.contentWindow.postMessage({type:'proxima:workspace:flush',workspaceId:scope,requestId},origin);});}
 async function report(){try{const workspaceId=scope,peers=(await root.__proximaDeviceCopy?.devices())?.others||[],state=await root.ProximaWorkspaces.status(workspaceId,peers),errors=[...root.ProximaWorkspaces.errors.values()];if(scope!==workspaceId)return;pane.parts.status.textContent=state.label+(errors.length?' · '+errors[0].message:'');pane.parts.status.dataset.state=errors.length?'error':state.kind;
  const conflicts=await root.ProximaWorkspaces.conflicts(workspaceId);if(scope!==workspaceId)return;const area=pane.parts.conflicts;area.replaceChildren();area.hidden=!conflicts.length;
  for(const conflict of conflicts){const row=document.createElement('div'),title=document.createElement('strong');title.textContent=conflict.name+' — both versions kept';row.append(title);for(const version of conflict.versions){if(version.kind!=='content')continue;const button=document.createElement('button');button.type='button';button.textContent='Keep '+version.device+' · '+version.hash.slice(0,7);button.onclick=async()=>{button.disabled=true;try{await root.ProximaWorkspaces.restore(workspaceId,conflict.entryId,version.id);await report();}catch(error){pane.parts.status.textContent=error.message;button.disabled=false;}};row.append(button);}area.append(row);}
 }catch(e){pane.parts.status.textContent=e.message;}}
 async function mount(id){build();const item=Store.timelineIntervals().find(x=>x.id===id);if(!item)throw Error('This blob no longer exists.');pane.hidden=false;selected=id;pane.parts.title.textContent=item.name;pane.parts.select.value=item.template?.kind||'';
  const next=item.template?.workspaceId||null;if(scope===next&&frame)return;await flush();frame?.remove();frame=null;scope=next;
  if(!scope){pane.parts.body.textContent='Choose a template to add content to this blob.';pane.parts.status.textContent='Saved locally';return;}
  const phone=new URL(location.href).searchParams.has('papers-phone'),entry=phone?{url:new URL('../ayg/workspace-20260730b.html',location.href).href}:(await root.ProximaWorkspaces.request('papers:project:workspace-template')).template;if(!entry?.url)throw Error('As you Go is unavailable on this device.');
  const url=new URL(entry.url);url.searchParams.set('papers-blob-workspace',scope);url.searchParams.set('papers-blob-parent-origin',location.origin==='null'?location.protocol+'//'+location.host:location.origin);url.searchParams.set('papers-embedded-surface','proxima-blob');url.searchParams.set('papers-inline-device','1');if(phone)url.searchParams.set('papers-phone','1');origin=url.origin==='null'?url.protocol+'//'+url.host:url.origin;
  frame=document.createElement('iframe');frame.title=item.name+' · As you Go';frame.src=url.href;pane.parts.body.replaceChildren(frame);await report();
 }
 function open(id){chain=chain.catch(()=>{}).then(()=>mount(id)).catch(e=>{build();pane.hidden=false;pane.parts.status.textContent=e.message;});return chain;}
 addEventListener('message',event=>{if(!frame||event.source!==frame.contentWindow||event.origin!==origin||event.data?.workspaceId!==scope)return;const v=event.data;
  if(v.type==='proxima:workspace:flushed'){const t=flushes.get(v.requestId);if(t){flushes.delete(v.requestId);clearTimeout(t.timer);v.ok?t.resolve():t.reject(Error(v.error));}return;}
  if(v.type!=='proxima:workspace:request'||typeof v.requestId!=='string'||!Array.isArray(v.args))return;
  const source=event.source,target=origin,workspaceId=scope;Promise.resolve(root.ProximaWorkspaces.frameCall(scope,v.method,v.args)).then(result=>source.postMessage({type:'proxima:workspace:result',requestId:v.requestId,workspaceId,ok:true,result},target),error=>source.postMessage({type:'proxima:workspace:result',requestId:v.requestId,workspaceId,ok:false,error:error.message},target));
 });
 addEventListener('proxima:blob-open',event=>void open(event.detail.id));
 document.addEventListener('dblclick',event=>{if(event.target.closest('input,button,.exact-resize-edge,.exact-queue-boundary'))return;const node=event.target.closest('.exact-selectable,.exact-outside-name');if(!node?.interval?.template)return;event.preventDefault();event.stopImmediatePropagation();void open(node.interval.id);},true);
 root.ProximaBlobWorkspaces=Object.freeze({open,flush});
 const previousFlush=root.__papersFlushBeforeClose;root.__papersFlushBeforeClose=async()=>{await flush();await previousFlush?.();await root.ProximaWorkspaces.flush();return {ok:true};};
})(globalThis);
