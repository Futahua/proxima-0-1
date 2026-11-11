/* Blob tasks: the Task tab of a blob, and the first thing a blob opens to.
 * You name a task and its countdown starts. Proof (text and pictures) goes in the box beside the ring;
 * ✓ is available once there is some proof. Completing fills the blob on the timeline from that attempt's
 * start to the moment of ✓. A countdown that runs out restarts on its own (worked out from the stored
 * start, never written per tick), and history lists finished tasks newest first with their proof.
 *
 * Owners: task times are the blob record's `tasks` field, changed only through Store.command
 * ('timeline-interval.task'), so they sync like any blob field. Proof is a synced workspace document per
 * task ('blob-task-proof.<taskId>', the same document store Flow embeds use); pictures are shrunk and kept
 * inside it. The look follows AppFlowy's dark editor; AppFlowy's own web editor is not used because its
 * image block only shows pictures from a web address and cannot take a pasted or dropped picture. */
(function(root){
 'use strict';
 const ZONE='Asia/Ho_Chi_Minh',MIN=60000,DEFAULT_MS=25*MIN,PICTURE_EDGE=1600,DOC_LIMIT=1900000;
 const proofId=taskId=>'blob-task-proof.'+taskId;
 // Desktop and phone pages hold the replica (readDocument/saveDocument); BOP's web page reaches the same documents
 // through its workspace frame call.
 const docs={read:id=>{const W=root.ProximaWorkspaces;return W.readDocument?W.readDocument(id):W.frameCall('ayg-root','document-load',[id]);},save:(id,content,revision)=>{const W=root.ProximaWorkspaces;return W.saveDocument?W.saveDocument(id,content,revision):W.frameCall('ayg-root','document-save',[id,content,revision]);}};
 const blobOf=id=>Store.timelineIntervals().find(x=>x.id===id)||null;
 const tasksOf=item=>Array.isArray(item?.tasks)?item.tasks.filter(t=>t&&typeof t.id==='string'&&Number.isFinite(Date.parse(t.startedAt))&&Number.isSafeInteger(t.durationMs)&&t.durationMs>0):[];
 const runningOf=item=>tasksOf(item).find(t=>!t.completedAt)||null;
 function attempt(task,now=Date.now()){const s=Date.parse(task.startedAt),d=task.durationMs;if(now<=s)return {start:s,end:s+d,index:1};const k=Math.floor((now-s)/d);return {start:s+k*d,end:s+(k+1)*d,index:k+1};}
 /** Filled stretches of a blob: one per completed task, from its attempt start to ✓. */
 function fills(item){return tasksOf(item).filter(t=>t.completedAt&&Number.isFinite(Date.parse(t.completedAt))).map(t=>({start:Date.parse(t.startedAt),end:Date.parse(t.completedAt)})).filter(x=>x.end>x.start);}
 function runningFill(item,now){
  const task=runningOf(item);
  if(!task||now<Date.parse(task.startedAt))return null;
  const start=item.taskBlob?Date.parse(task.startedAt):attempt(task,now).start;
  return {start,end:Math.max(start+1,now)};
 }
 const clockText=ms=>{const total=Math.max(0,Math.ceil(ms/1000)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60,two=n=>String(n).padStart(2,'0');return h?h+' : '+two(m)+' : '+two(s):m+' : '+two(s);};
 const timeText=ms=>new Date(ms).toLocaleTimeString('en-GB',{timeZone:ZONE,hour:'2-digit',minute:'2-digit'});
 const dayText=ms=>new Date(ms).toLocaleDateString('en-GB',{timeZone:ZONE,day:'numeric',month:'short'});
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};

 // ── Proof documents ──
 const emptyProof=()=>({blocks:[{type:'text',text:''}]});
 const hasProof=doc=>!!doc?.blocks?.some(b=>b.type==='image'&&b.src||b.type==='text'&&String(b.text||'').trim());
 async function readProof(taskId){const v=await docs.read(proofId(taskId));const c=v?.content;return {content:c&&Array.isArray(c.blocks)?c:emptyProof(),revision:v?.revision??null,conflicts:v?.conflicts||[]};}
 async function shrinkPicture(file){
  const bitmap=await createImageBitmap(file),scale=Math.min(1,PICTURE_EDGE/Math.max(bitmap.width,bitmap.height)),w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=Object.assign(document.createElement('canvas'),{width:w,height:h});canvas.getContext('2d').drawImage(bitmap,0,0,w,h);bitmap.close?.();
  let quality=.82,url=canvas.toDataURL('image/webp',quality);while(url.length>600000&&quality>.4){quality-=.12;url=canvas.toDataURL('image/webp',quality);}
  return {src:url,width:w,height:h};
 }

 const style=document.createElement('style');style.textContent=`
 .blob-task{position:absolute;inset:0;overflow:auto;scrollbar-gutter:stable;padding:22px 26px 40px;box-sizing:border-box;background:var(--panel,#242b33);color:#e6e9ef;font:14px system-ui;display:flex;flex-direction:column;gap:22px}
 .blob-task[hidden]{display:none}
 .blob-task-title{display:flex;align-items:center;gap:8px}
 .blob-task-title input{flex:1;min-width:0;font:500 22px system-ui;color:#e6e9ef;background:transparent;border:0;border-bottom:1px solid transparent;padding:4px 0;outline:none}
 .blob-task-title input:focus{border-bottom-color:#536272}.blob-task-title input::placeholder{color:#8d97a3}
 .blob-task-title .pen{opacity:.6;font-size:16px}
 .blob-task-title button{font:12px system-ui;color:#c3ccd6;background:transparent;border:1px solid #536272;border-radius:6px;padding:4px 9px;cursor:pointer}
 .blob-task-main{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap}
 .blob-task-ring{position:relative;width:240px;height:240px;flex:none}
 .blob-task-ring>svg{position:absolute;inset:0;transform:rotate(-90deg)}
 .blob-task-ring .track{stroke:#ffffff10}.blob-task-ring .arc{stroke:#8fb0e0}
 .blob-task-ring.is-idle .arc{stroke:#8fb0e055}
 .blob-task-dial{max-width:100%;flex:none}
 .blob-task-clock{position:static;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
 .blob-task-ring>.exact-timer-crank{position:absolute;top:50%;left:50%;width:48%;transform:translate(-50%,-50%)}
 .blob-task-clock button{font:300 44px system-ui;letter-spacing:1px;color:#e6e9ef;background:transparent;border:0;cursor:pointer;padding:0 6px;border-radius:8px}
 .blob-task-clock button:hover{background:#ffffff0c}
 .blob-task-clock input{width:110px;font:300 36px system-ui;text-align:center;color:#e6e9ef;background:#ffffff0c;border:1px solid #536272;border-radius:8px}
 .blob-task-clock small{font-size:12px;color:#a6b0bd;min-height:15px}
 .blob-task-proof-side{flex:1;min-width:180px;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
 .blob-task-proof{align-self:stretch;min-height:200px;max-height:46vh;overflow:auto;border:1px solid #6b7887;border-radius:6px;padding:10px 14px;background:#1f252c;cursor:text}
 .blob-task-proof.is-disabled{opacity:.45;pointer-events:none}
 .blob-task-proof.is-dragging{border-color:#8fb0e0;background:#8fb0e012}
 .blob-task-proof .text{min-height:1.6em;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;outline:none;padding:2px 0}
 .blob-task-proof .text:empty::before{content:attr(data-placeholder);color:#77818d}
 .blob-task-proof figure{position:relative;margin:6px 0}.blob-task-proof img{display:block;max-width:100%;border-radius:4px}
 .blob-task-proof figure button{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:5px;background:#000a;color:#fff;cursor:pointer;opacity:0}
 .blob-task-proof figure:hover button,.blob-task-proof figure:focus-within button{opacity:1}
 .blob-task-proof-tools{align-self:stretch;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:#a6b0bd}
 .blob-task-proof-tools label{cursor:pointer;border:1px solid #536272;border-radius:5px;padding:3px 8px}
 .blob-task-done{width:54px;height:44px;font-size:30px;line-height:1;color:#e6e9ef;background:transparent;border:0;cursor:pointer;border-radius:8px}
 .blob-task-done:hover:not(:disabled){background:#a8c98d26;color:#a8c98d}.blob-task-done:disabled{opacity:.25;cursor:default}
 .blob-task-history h3{font:500 20px system-ui;margin:0 0 8px}
 .blob-task-history li{display:grid;grid-template-columns:minmax(0,1fr) 28px;align-items:start}
 .blob-task-history li>.task-delete{width:28px;height:34px;padding:0;display:grid;place-items:center;align-self:start;color:#a6b0bd;opacity:0;pointer-events:none}.blob-task-history li:hover>.task-delete,.blob-task-history li:focus-within>.task-delete{opacity:1;pointer-events:auto}.blob-task-history li>.task-delete:hover{color:#efaaa6}
 .blob-task-history ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
 .blob-task-history li>button{width:100%;display:flex;gap:12px;align-items:center;text-align:left;font:13px/20px system-ui;color:#e6e9ef;background:transparent;border:0;border-radius:6px;padding:7px 8px;cursor:pointer}
 .blob-task-history li>button:hover{background:#ffffff0a}.blob-task-history li>button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .blob-task-history li>button time{color:#a6b0bd;font-size:12px;white-space:nowrap}
 .blob-task-history .proof-view{grid-column:1/-1;margin:2px 8px 10px;padding:10px 14px;border-left:2px solid #536272;color:#d4dae2}
 .blob-task-history .proof-view .text{white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere}
 .blob-task-history .proof-view img{display:block;max-width:100%;margin:6px 0;border-radius:4px}
 .blob-task-history .empty{color:#8d97a3;font-size:13px;text-align:left;padding:7px 8px}
 .blob-task-status{font-size:12px;color:#e9b88f;min-height:0}.blob-task-status:empty{display:none}
 @media(pointer:coarse){.blob-task{padding:16px}.blob-task-ring{width:210px;height:210px;margin:0 auto}.blob-task-main{flex-direction:column;align-items:stretch}.blob-task-proof-side{min-width:0}}
 `;document.head.append(style);

 let view=null; // {node,intervalId,parts,taskId,doc,revision,saving,dirty,timer}
 function build(container){
  const node=el('section','blob-task');node.setAttribute('aria-label','Current task');
  const title=el('div','blob-task-title'),name=el('input');name.placeholder='Current task';name.maxLength=300;name.setAttribute('aria-label','Task name');const stop=el('button',null,'Give up');stop.type='button';stop.title='Drop the running task without recording it';title.append(name,stop);
  const main=el('div','blob-task-main'),ring=el('div','blob-task-ring');const R=108,C=2*Math.PI*R;ring.innerHTML=`<svg viewBox="0 0 240 240"><circle class="track" cx="120" cy="120" r="${R}" fill="none" stroke-width="5"/><circle class="arc" cx="120" cy="120" r="${R}" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`;
  const clock=el('div','blob-task-clock'),time=el('button');time.type='button';time.title='Set the countdown';const note=el('small');clock.append(time,note);
  const dial=el('div','blob-task-dial');dial.append(ring,clock);
  let dragTarget=null;
  const crank=root.ExactTimeline.createTimerCrank({
   getMinutes:()=>{const item=blobOf(view?.intervalId);return (runningOf(item)?.durationMs??durationOf(item))/MIN;},
   onGrab:()=>{dragTarget=view?.intervalId;},
   getElapsedMinutes:()=>{
    const item=blobOf(view?.intervalId),running=runningOf(item);
    if(!running)return 0;
    const now=Date.now(),current=attempt(running,now);
    return item.taskBlob&&current.index>1?running.durationMs/MIN:Math.max(0,now-current.start)/MIN;
   },
   onTurn:(minutes,elapsed)=>{
    time.textContent=clockText((minutes-elapsed)*MIN);
    ring.querySelector('.arc').style.strokeDashoffset=String(C*Math.min(1,elapsed/minutes));
   },
   onCommit:async minutes=>{
    if(!dragTarget||view?.intervalId!==dragTarget)return;
    const item=blobOf(dragTarget),running=runningOf(item),durationMs=minutes*MIN;
    if(!item||item.taskBlob&&!running)return;
    const previous=running?.durationMs??durationOf(item);
    if(durationMs===previous){render(true);return;}
    await command(running?{action:'duration',taskId:running.id,durationMs}:{action:'default-duration',durationMs});
   },
   onRelease:()=>{dragTarget=null;render();}
  });
  ring.append(crank.element);
  const side=el('div','blob-task-proof-side'),proof=el('div','blob-task-proof');proof.setAttribute('aria-label','Proof of completion');
  const tools=el('div','blob-task-proof-tools'),saved=el('span'),pick=el('label',null),file=el('input');pick.title='Add picture';pick.setAttribute('aria-label','Add picture');pick.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M15 3H4a1 1 0 0 0-1 1v16h17V10M16 5h6m-3-3v6M3 17l5-5 4 4 3-3 5 5"/><circle cx="8" cy="7" r="1"/></svg>';pick.tabIndex=0;pick.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();file.click();}};file.type='file';file.accept='image/*';file.multiple=true;file.hidden=true;pick.append(file);tools.append(saved,pick);
  const done=el('button','blob-task-done','✓');done.type='button';done.title='Done: needs some proof first';done.setAttribute('aria-label','Mark task done');side.append(proof,tools,done);
  main.append(dial,side);
  const status=el('p','blob-task-status');status.setAttribute('role','status');
  const history=el('section','blob-task-history'),heading=el('h3',null),list=el('ol');heading.title='Task history';heading.setAttribute('aria-label','Task history');heading.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6m3-4v6l4 2"/></svg>';history.append(heading,list);
  node.append(title,status,main,history);container.append(node);
  return {node,parts:{name,stop,ring,crank,arc:ring.querySelector('.arc'),C,time,note,proof,saved,file,done,status,list}};
 }

 function mount(container,intervalId){
  if(view&&view.node.parentElement!==container){void flushProof();view.node.remove();clearInterval(view.timer);cancelAnimationFrame(view.crankFrame);view=null;}
  if(!view){view={...build(container),intervalId:null,taskId:null,doc:null,revision:null,dirty:false,saving:null,saveTimer:0,editingTime:false,openHistory:new Set(),lastKey:''};wire();view.timer=setInterval(tick,1000);}
  view.node.hidden=false;
  if(view.intervalId!==intervalId){void flushProof();view.intervalId=intervalId;view.taskId=null;view.doc=null;view.openHistory.clear();view.lastKey='';view.parts.name.value='';}
  render(true);
 }
 function hide(){if(!view)return;void flushProof();view.node.hidden=true;cancelAnimationFrame(view.crankFrame);view.crankFrame=0;}

 async function command(payload){const r=await Store.command({type:'timeline-interval.task',payload:{intervalId:view.intervalId,...payload}});if(!r.ok){view.parts.status.textContent=r.code==='TASK_RUNNING'?'A task is already running on this blob.':'Not saved: '+(r.code||'refused');}else view.parts.status.textContent='';refreshTimelines();render(true);return r;}
 function refreshTimelines(){document.querySelectorAll('.exact-timeline').forEach(node=>root.ExactTimeline?.mount(node,Store)?.refresh());}
 const durationOf=item=>Number.isSafeInteger(item?.taskDurationMs)&&item.taskDurationMs>=MIN?item.taskDurationMs:DEFAULT_MS;

 function wire(){
  const p=view.parts;
  const start=async()=>{const value=p.name.value.trim(),item=blobOf(view.intervalId);if(!value||!item)return;const running=runningOf(item);
   if(running){if(value!==running.name)await command({action:'rename',taskId:running.id,name:value});return;}
   await command({action:'start',name:value,durationMs:durationOf(item)});};
  p.name.taskKey=(e=>{if(e.key==='Enter'){e.preventDefault();p.name.blur();}if(e.key==='Escape'){const r=runningOf(blobOf(view.intervalId));p.name.value=r?.name||'';p.name.blur();}});
  p.name.addEventListener('blur',()=>void start());
  p.stop.onclick=async()=>{const r=runningOf(blobOf(view.intervalId));if(!r)return;await command({action:'abandon',taskId:r.id});p.name.value='';};
  p.time.onclick=()=>{const item=blobOf(view.intervalId);if(!item)return;const r=runningOf(item),current=r?r.durationMs:durationOf(item);const input=el('input');input.type='number';input.min='1';input.max='1440';input.step='1';input.value=String(Math.round(current/MIN));input.title='Minutes';view.editingTime=true;p.time.replaceWith(input);input.focus();input.select();
   let finished=false;const finish=async keep=>{if(finished)return;finished=true;view.editingTime=false;input.replaceWith(p.time);const minutes=Math.round(Number(input.value));if(!keep||!Number.isFinite(minutes)||minutes<1||minutes>1440){render(true);return;}const ms=minutes*MIN,running=runningOf(blobOf(view.intervalId));
    if(running)await command({action:'duration',taskId:running.id,durationMs:ms});
    else{const it=blobOf(view.intervalId);if(it&&ms!==durationOf(it))await command({action:'default-duration',durationMs:ms});}};
   input.taskKey=(e=>{if(e.key==='Enter')void finish(true);if(e.key==='Escape')void finish(false);});input.addEventListener('blur',()=>void finish(true));};
  p.done.onclick=async()=>{const r=runningOf(blobOf(view.intervalId));if(!r||!hasProof(view.doc))return;p.done.disabled=true;try{await flushProof();if(view.dirty){p.status.textContent='The proof has not saved yet; try again.';return;}const result=await command({action:'complete',taskId:r.id});if(result.ok){p.name.value='';view.taskId=null;view.doc=null;render(true);}}finally{render();}};
  // Proof editing
  const proof=p.proof;
  proof.taskKey=(e=>{const block=e.target.closest?.('.text');if(!block)return;
   if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const rest=splitAtCaret(block);const next=textBlock(rest);block.after(next);focusStart(next);changed();}
   else if(e.key==='Backspace'&&caretAtStart(block)){const prev=block.previousElementSibling;if(prev?.classList.contains('text')){e.preventDefault();const at=prev.textContent.length;prev.textContent+=block.textContent;block.remove();focusAt(prev,at);changed();}else if(prev?.tagName==='FIGURE'&&!block.textContent){e.preventDefault();prev.remove();changed();}}});
  proof.addEventListener('input',()=>changed());
  proof.addEventListener('paste',e=>{e.stopPropagation();const files=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith('image/'));if(files.length){e.preventDefault();void addPictures(files,e.target.closest?.('.text'));return;}const text=e.clipboardData?.getData('text/plain');if(text!=null&&e.target.closest?.('.text')){e.preventDefault();document.execCommand('insertText',false,text);}});
  proof.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();proof.classList.add('is-dragging');}});
  proof.addEventListener('dragleave',()=>proof.classList.remove('is-dragging'));
  proof.addEventListener('drop',e=>{proof.classList.remove('is-dragging');const files=[...(e.dataTransfer?.files||[])].filter(f=>f.type.startsWith('image/'));if(!files.length)return;e.preventDefault();void addPictures(files,e.target.closest?.('.text'));});
  proof.addEventListener('click',e=>{if(e.target===proof){const last=proof.lastElementChild;if(last?.classList.contains('text'))focusAt(last,last.textContent.length);else{const t=textBlock('');proof.append(t);focusStart(t);}}});
  p.file.addEventListener('change',()=>{const files=[...p.file.files];p.file.value='';if(files.length)void addPictures(files,null);});
 }
 function textBlock(text){const d=el('div','text');d.contentEditable='plaintext-only';if(d.contentEditable!=='plaintext-only')d.contentEditable='true';d.textContent=text;d.dataset.placeholder='Type, paste or drop a picture';return d;}
 function figureBlock(b){const f=el('figure');f.tabIndex=-1;const img=el('img');img.src=b.src;img.alt='Proof picture';f.block=b;const x=el('button',null,'×');x.type='button';x.title='Remove picture';x.onclick=()=>{f.remove();ensureTrailingText();changed();};f.append(img,x);return f;}
 function caretAtStart(block){const s=getSelection();if(!s.rangeCount||!s.isCollapsed)return false;const r=s.getRangeAt(0),pre=document.createRange();pre.selectNodeContents(block);pre.setEnd(r.startContainer,r.startOffset);return pre.toString().length===0;}
 function splitAtCaret(block){const s=getSelection();if(!s.rangeCount)return '';const r=s.getRangeAt(0);r.deleteContents();const tail=document.createRange();tail.selectNodeContents(block);tail.setStart(r.endContainer,r.endOffset);const rest=tail.toString();tail.deleteContents();return rest;}
 function focusStart(node){focusAt(node,0);}
 function focusAt(node,offset){node.focus();const s=getSelection(),r=document.createRange();const t=node.firstChild;if(t&&t.nodeType===3){r.setStart(t,Math.min(offset,t.length));}else r.setStart(node,0);r.collapse(true);s.removeAllRanges();s.addRange(r);}
 function ensureTrailingText(){const proof=view.parts.proof;if(!proof.lastElementChild||!proof.lastElementChild.classList.contains('text'))proof.append(textBlock(''));}
 function readEditor(){const blocks=[];for(const n of view.parts.proof.children){if(n.classList.contains('text'))blocks.push({type:'text',text:n.textContent});else if(n.tagName==='FIGURE'&&n.block)blocks.push({type:'image',src:n.block.src,width:n.block.width,height:n.block.height});}return {blocks:blocks.length?blocks:emptyProof().blocks};}
 function paintEditor(doc){const proof=view.parts.proof;proof.replaceChildren(...doc.blocks.map(b=>b.type==='image'?figureBlock(b):textBlock(b.text||'')));ensureTrailingText();}
 async function addPictures(files,after){view.parts.saved.textContent='Adding picture…';try{let anchor=after;for(const file of files){const b=await shrinkPicture(file);const fig=figureBlock({type:'image',...b});if(anchor)anchor.after(fig);else{const last=view.parts.proof.lastElementChild;if(last?.classList.contains('text')&&!last.textContent)last.before(fig);else view.parts.proof.append(fig);}anchor=fig;}ensureTrailingText();changed();}catch(e){view.parts.saved.textContent='Could not add the picture: '+e.message;}}
 function changed(){if(!view.taskId)return;view.doc=readEditor();if(JSON.stringify(view.doc).length>DOC_LIMIT){view.parts.saved.textContent='Too much for one proof: remove a picture.';return;}view.dirty=true;view.parts.saved.textContent='Saving…';clearTimeout(view.saveTimer);view.saveTimer=setTimeout(()=>void flushProof(),600);renderDone();}
 function flushProof(){const owner=view;if(!owner)return Promise.resolve();clearTimeout(owner.saveTimer);const {taskId,doc,revision}=owner;if(!owner.dirty||!taskId)return owner.saving||Promise.resolve();owner.dirty=false;
  const run=async()=>{
   try{let r=await docs.save(proofId(taskId),doc,owner.taskId===taskId?owner.revision:revision);
    // Another device saved this proof meanwhile: it is the same person, so the newest typing wins.
    if(!r.ok&&r.code==='DOCUMENT_CHANGED'&&!(r.conflicts||[]).length)r=await docs.save(proofId(taskId),doc,r.revision??null);
    if(!r.ok)throw Error(r.conflicts?.length?'two devices changed this proof at once':'it changed elsewhere');
    if(owner.taskId===taskId)owner.revision=r.revision;if(owner.taskId===taskId&&!owner.dirty)owner.parts.saved.textContent='Saved';}
   catch(e){if(owner.taskId===taskId){if(owner.doc===doc)owner.dirty=true;owner.parts.saved.textContent='Not saved: '+e.message;}}};
  return owner.saving=(owner.saving||Promise.resolve()).then(run,run);}

 async function loadProof(taskId){view.taskId=taskId;view.doc=emptyProof();view.revision=null;view.dirty=false;paintEditor(view.doc);view.parts.saved.textContent='';
  try{const v=await readProof(taskId);if(view.taskId!==taskId||view.dirty)return;view.doc=v.content;view.revision=v.revision;paintEditor(v.content);if(v.conflicts.length)view.parts.saved.textContent='Two devices changed this proof at once; the newest is shown.';}catch(e){view.parts.saved.textContent='Could not open the proof: '+e.message;}renderDone();}
 function renderDone(){const p=view.parts,running=view.taskId&&hasProof(view.doc);p.done.disabled=!running;p.done.title=running?'Done: fill this stretch of the blob':'Done: needs some proof first';}

 function tick(){if(view&&!view.node.hidden)render();}
 function updateLiveCrank(owner,running,standalone){
  owner.crankTask=running;
  owner.crankStandalone=standalone;
  if(!running||owner.node.hidden){
   cancelAnimationFrame(owner.crankFrame);
   owner.crankFrame=0;
   return;
  }
  if(owner.crankFrame)return;
  function frame(){
   owner.crankFrame=0;
   const task=owner.crankTask;
   if(!task||owner.node.hidden||!owner.node.isConnected)return;
   if(!owner.parts.crank.dragging()){
    const now=Date.now(),current=attempt(task,now);
    const left=owner.crankStandalone&&current.index>1?0:current.end-now;
    owner.parts.crank.paint(left/MIN);
    owner.parts.arc.style.strokeDashoffset=String(owner.parts.C*(1-left/task.durationMs));
   }
   owner.crankFrame=requestAnimationFrame(frame);
  }
  owner.crankFrame=requestAnimationFrame(frame);
 }
 function render(force){
  if(!view)return;const p=view.parts,item=blobOf(view.intervalId);
  if(p.crank.dragging())return;
  if(!item){updateLiveCrank(view,null,false);p.status.textContent='This blob no longer exists.';view.blobMissing=true;return;}
  if(view.blobMissing){p.status.textContent='';view.blobMissing=false;}
  p.name.placeholder=item.name||'Task';
  const running=runningOf(item),now=Date.now();
  updateLiveCrank(view,running,!!item.taskBlob);
  p.crank.element.hidden=!!item.taskBlob&&!running;
  if(!running)p.crank.paint(durationOf(item)/MIN);
  if(running&&view.taskId!==running.id)void loadProof(running.id);
  if(!running&&view.taskId){void flushProof();view.taskId=null;view.doc=null;paintEditor(emptyProof());}
  if(document.activeElement!==p.name)p.name.value=running?running.name:p.name.value&&!force?p.name.value:'';
  p.name.disabled=!!item.taskBlob&&!running;p.stop.hidden=!running;p.proof.classList.toggle('is-disabled',!running);if(!running)p.saved.textContent='';p.list.parentElement.hidden=!!item.taskBlob;
  p.ring.classList.toggle('is-idle',!running);
  if(running){const a=attempt(running,now),left=item.taskBlob&&a.index>1?0:a.end-now;p.crank.paint(left/MIN);p.time.textContent=clockText(left);p.arc.style.strokeDashoffset=String(p.C*(1-left/running.durationMs));p.note.textContent='🔔 '+timeText(a.end)+(a.index>1?' · restarted':'');if(item.taskBlob&&a.index>1){p.time.textContent=clockText(0);p.note.textContent='Time is up';}}
  else if(item.taskBlob){const t=tasksOf(item)[0];p.time.textContent=t?clockText(Date.parse(t.completedAt)-Date.parse(t.startedAt)):'';p.arc.style.strokeDashoffset='0';p.note.textContent=t?'Done '+timeText(Date.parse(t.completedAt)):'';}
  else{const ms=durationOf(item);p.time.textContent=clockText(ms);p.arc.style.strokeDashoffset='0';p.note.textContent='Name a task to start';}
  renderDone();
  const done=tasksOf(item).filter(t=>t.completedAt).sort((a,b)=>Date.parse(b.completedAt)-Date.parse(a.completedAt)),key=JSON.stringify(done.map(t=>[t.id,t.name,t.completedAt]));
  if(key===view.lastKey&&!force)return;view.lastKey=key;
  if(!done.length){p.list.replaceChildren(el('li','empty','Finished tasks appear here, newest first.'));return;}
  p.list.replaceChildren(...done.map(t=>{const li=el('li'),b=el('button'),name=el('span',null,t.name),when=el('time',null,timeText(Date.parse(t.startedAt))+'–'+timeText(Date.parse(t.completedAt))+' · '+dayText(Date.parse(t.completedAt)));b.type='button';b.append(name,when);b.setAttribute('aria-expanded',String(view.openHistory.has(t.id)));
   b.onclick=()=>{if(view.openHistory.has(t.id))view.openHistory.delete(t.id);else view.openHistory.add(t.id);view.lastKey='';render();};const remove=el('button','task-delete');remove.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/></svg>';remove.type='button';remove.title='Delete task';remove.setAttribute('aria-label','Delete '+t.name);remove.onclick=async()=>{remove.disabled=true;try{const result=await command({action:'delete',taskId:t.id});if(result.ok)view.openHistory.delete(t.id);}finally{remove.disabled=false;}};li.append(b,remove);
   if(view.openHistory.has(t.id)){const box=el('div','proof-view',' ');li.append(box);void readProof(t.id).then(v=>{box.replaceChildren(...v.content.blocks.map(x=>{if(x.type==='image'){const img=el('img');img.src=x.src;img.alt='Proof picture';return img;}return el('div','text',x.text||'');}));if(!hasProof(v.content))box.textContent='No proof has reached this device yet.';}).catch(e=>{box.textContent='Could not open the proof: '+e.message;});}
   return li;}));
 }
 // Typing in the task screen never reaches Proxima's keyboard shortcuts (Z, F, A, Tab…): window capture runs before
 // every document-level shortcut, hands the key to the field's own handler, then stops it going any further.
 addEventListener('keydown',e=>{const t=e.target;if(!(t instanceof Element)||!t.closest('.blob-task'))return;const editable=t.closest('input,textarea,[contenteditable]');if(!editable)return;
  let owner=t;while(owner&&!owner.taskKey&&!owner.classList?.contains('blob-task'))owner=owner.parentElement;try{owner?.taskKey?.(e);}finally{e.stopImmediatePropagation();}},true);
 addEventListener('proxima:remote-imported',()=>{if(view&&!view.node.hidden)render(true);});
 addEventListener('proxima-sync:local-change',()=>{if(view&&!view.node.hidden)render();});
 root.ProximaBlobTasks=Object.freeze({mount,hide,fills,attempt,runningFill,flush:()=>flushProof(),running:id=>runningOf(blobOf(id)),current:()=>view?{container:view.node.parentElement,intervalId:view.intervalId,hidden:view.node.hidden}:null});
})(globalThis);
