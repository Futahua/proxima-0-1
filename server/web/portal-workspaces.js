// Transport for the original blob-workspaces.js; no separate file drawer.
(()=>{
 const P=globalThis.ProximaPortal,ws='ayg-root',call=(method,args=[])=>P.api('api/workspace/frame',{workspaceId:ws,method,args});
 globalThis.ProximaWorkspaces={errors:new Map(),folders:()=>call('folders'),ensureFolder:(workspaceId,...args)=>P.api('api/workspace/frame',{workspaceId,method:'ensureFolder',args}),status:()=>call('status'),conflicts:()=>call('conflicts'),restore:(workspaceId,...args)=>P.api('api/workspace/frame',{workspaceId,method:'restore',args}),flush:()=>call('flush'),frameCall:(workspaceId,method,args)=>P.api('api/workspace/frame',{workspaceId,method,args}),request:async()=>({template:{url:new URL('ayg/workspace-20260730b.html',P.base).href}})};
 addEventListener('proxima:blob-open',()=>globalThis.__phoneMouse?.stop?.());
 addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.type!=='papers:phone:proxima')return;const pane=document.querySelector('.blob-workspace-pane');if(pane?.querySelector('iframe')?.contentWindow===event.source)pane.hidden=true;});
})();
