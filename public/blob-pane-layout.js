/* Blob composition uses the same native coordinator and tab/edge UI as Papers Files.
 * Proxima owns template bindings; Papers owns the durable groups, geometry and moves. */
(function(root){
 'use strict';
 let controller=null,viewport=null,panel=null,enabled=false,loading=null,pane=null;
 const listeners=new Set();let externalDrag=false,dragTransfer=null,menu=null;
 document.addEventListener('dragstart',event=>{if(enabled&&[...event.dataTransfer.types].some(t=>/application\/x-papers-(native-pane-tab|preview-tab|pane-group|pane-transfer)/.test(t))){externalDrag=event.shiftKey;try{dragTransfer=JSON.parse(event.dataTransfer.getData('application/x-papers-pane-transfer')||'null')?.transferId;}catch{}document.documentElement.classList.add('blob-layout-dragging');}});
 document.addEventListener('dragover',event=>{if(!enabled||!dragTransfer||externalDrag===event.shiftKey)return;externalDrag=event.shiftKey;void root.ProximaWorkspaces.call('pane-transfer-overlay',{active:true,transferId:dragTransfer,local:!externalDrag}).catch(status);},true);
 const finishDrag=()=>{document.documentElement.classList.remove('blob-layout-dragging');dragTransfer=null;externalDrag=false;};
 for(const type of ['dragend','drop'])document.addEventListener(type,finishDrag,true);
 const status=error=>{if(pane){pane.parts.status.hidden=false;pane.parts.status.textContent=error.message||String(error);}};
 addEventListener('message',event=>{if(event.source===window&&event.data?.type==='papers:project:pane-layout')for(const cb of listeners)cb(event.data.snapshot);});
 function pickTemplates(groupId,header){
  menu?.remove();menu=document.createElement('div');menu.className='blob-template-picker';menu.setAttribute('role','menu');
  controller.setOverlay(true);
  const close=()=>{menu?.remove();menu=null;document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);controller.setOverlay(pane.hidden);};
  const outside=event=>{if(!menu?.contains(event.target))close();},key=event=>{if(event.key==='Escape'){event.preventDefault();close();}};
  for(const option of pane.parts.select.options){if(!option.value)continue;const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=option.textContent;button.onclick=()=>{close();void root.ProximaBlobWorkspaces.chooseTemplate(option.value).catch(status);};menu.append(button);}
  const box=header.getBoundingClientRect();Object.assign(menu.style,{left:box.left+'px',top:box.bottom+'px'});document.body.append(menu);
  setTimeout(()=>{if(menu){document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);}},0);
 }
 async function ensure(node,entry){
  pane=node;enabled=true;
  if(!controller){
   if(!loading)loading=(async()=>{
    const {installCoordinatedWindowSlices}=await import('./blob-pane-coordinator.js');
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./blob-pane-native.css',location.href).href;document.head.append(link);
    viewport=document.createElement('div');viewport.className='blob-native-viewport';node.parts.body.append(viewport);
    panel=document.createElement('div');panel.className='blob-native-files';panel.hidden=true;document.body.append(panel);
    const host={fileCapability:(op,detail)=>root.ProximaWorkspaces.call(op,op==='pane-transfer-overlay'?{...detail,local:!externalDrag}:detail),onPaneLayout:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},
     windowCandidates:detail=>root.ProximaWorkspaces.request('papers:project:window-candidates',detail),
     bindWindowCandidate:candidateId=>root.ProximaWorkspaces.request('papers:project:window-bind-candidate',{candidateId}),
     openNewSurface:(url,detail)=>root.ProximaWorkspaces.request('papers:project:open-new-surface',{url,...detail})};
    controller=installCoordinatedWindowSlices({document,host,root:{element:viewport,replaceNativeTabs(){},restoreWindows(){throw Error('Update Papers to use template splits.');}},
     panels:[{id:'blob-files',name:'Go',icon:new URL('./template-icons/go.png',location.href).href,panel:{element:panel}}],onStatus:status,rootBoundary:true,onTemplatePick:pickTemplates,nativeTabPresentation:tab=>/^AppFlowy(?:$| ·)/i.test(tab.title||'')?{...tab,title:'Flow',icon:new URL('./template-icons/flow.png',location.href).href}:tab,
     onDragState:active=>{if(!active)finishDrag();},
     onOuterEdge:rect=>{if(!enabled||node.hidden)return;const border=node.getBoundingClientRect().width-viewport.getBoundingClientRect().width;const width=Math.round(rect.width+border);if(Math.abs(node.getBoundingClientRect().width-width)>1){node.classList.remove('blob-pane-full');node.style.width=width+'px';try{localStorage.setItem('proxima.blobPane.width',String(width));localStorage.removeItem('proxima.blobPane.full');}catch{}}},
     headerActions:tools=>{const close=document.createElement('button');close.type='button';close.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 5 7 7-7 7m7-14 7 7-7 7"/></svg>';close.title='Collapse blob workspace';close.setAttribute('aria-label','Collapse blob workspace');close.onclick=()=>{node.hidden=true;};tools.append(close);},
     onSelection:tabId=>dispatchEvent(new CustomEvent('proxima:blob-template-selected',{detail:{kind:tabId==='preview:blob-files'?'as-you-go':'appflowy'}}))});
    new MutationObserver(()=>{if(!enabled)return;viewport.hidden=node.hidden;controller.setOverlay(node.hidden);controller.refresh();}).observe(node,{attributes:true,attributeFilter:['hidden']});
    await controller.restore();
   })().catch(error=>{loading=null;throw error;});
   await loading;
  }
  viewport.hidden=false;node.classList.add('blob-shared-layout');node.parts.status.textContent='';node.parts.status.hidden=true;controller.setOverlay(false);controller.refresh();
  // A new iframe must start in a presented panel; Chromium can otherwise leave it blank.
  if(!panel.querySelector('iframe'))await controller.selectPanel('blob-files');return true;
 }
 function disable(){enabled=false;if(viewport)viewport.hidden=true;if(panel)panel.hidden=true;controller?.setOverlay(true);controller?.refresh();pane?.classList.remove('blob-shared-layout');}
 root.ProximaBlobLayout=Object.freeze({ensure,disable,active:()=>enabled&&!!controller,panel:()=>panel,
  accept:reply=>{if(reply?.snapshot)controller?.acceptSnapshot(reply.snapshot);},selectFiles:()=>controller.selectPanel('blob-files')});
 const style=document.createElement('style');style.textContent=`
 .blob-shared-layout,.blob-native-files,.window-slices-region{--surface-raised:var(--panel,#242b33);--surface-soft:#2c343f;--surface:#343f4b;--border-strong:#536272;--border-subtle:#53627280;--text:#e6e9ef;--text-muted:#a6b0bd;--accent:#a8c98d;color:var(--text);font:12px system-ui}
 .blob-layout-dragging .blob-native-files iframe{pointer-events:none}
 .blob-native-viewport{position:absolute;inset:0;pointer-events:none}.blob-native-viewport[hidden]{display:none}
 .blob-native-files{position:fixed;z-index:1101;box-sizing:border-box;background:var(--panel,#242b33);overflow:hidden}
 .blob-native-files[hidden]{display:none!important}.blob-native-files iframe{display:block;width:100%;height:100%;border:0}
 .blob-shared-layout>div{position:relative;padding:0}.blob-shared-layout>header{display:none!important}
 .blob-template-picker{position:fixed;z-index:100100;display:grid;gap:2px;padding:5px;background:#242b33;border:1px solid #536272;border-radius:6px;box-shadow:0 5px 20px #0008;color:#e6e9ef}
 .blob-template-picker button{padding:7px 12px;border:0;background:transparent;color:inherit;text-align:left;font:12px system-ui}.blob-template-picker button:hover{background:#ffffff18}
 .blob-shared-layout .full-appflowy-surface{pointer-events:none}
 .blob-shared-layout .blob-workspace-loading{z-index:1200}
 `;document.head.append(style);
})(globalThis);
