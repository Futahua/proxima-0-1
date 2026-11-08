import {randomUUID} from 'node:crypto';
// Public adapters use the same causal writer and checked workspace writer as devices.
export function createWebDomain(engine){
 const refuse=message=>Object.assign(Error(message),{status:409});
 async function conflicts(input){return engine.withFacts(async(journal,core)=>{
  const stamps=new Map(journal.stamps),all=core.conflictsOf(journal.state,stamps);
  if(!input)return {conflicts:all,names:{...journal.names,[journal.node]:'BOP'},self:journal.node};
  const current=all.find(c=>c.key===input.conflict?.key&&c.field===input.conflict?.field&&c.kind===input.conflict?.kind);
  if(!current||JSON.stringify(current)!==JSON.stringify(input.conflict))throw refuse('This conflict changed. Review the current choices.');
  const nextStamp=()=>{const c={...journal.vv};let clock=journal.clock;for(const s of stamps.values())clock=core.witness(clock,s.h);journal.clock=core.tick(clock,Date.now(),journal.node);const n=(journal.vv[journal.node]||0)+1;journal.vv[journal.node]=n;return {h:journal.clock,o:journal.node,n,c,u:1,action:{type:'sync.resolve',id:randomUUID()}};};
  const [collection,...parts]=current.key.split('/'),id=parts.join('/'),list=journal.state[collection],index=Array.isArray(list)?list.findIndex(x=>String(x.id)===id):-1;
  if(index<0)throw refuse('This record is no longer available.');
  if(current.kind==='field'){
   if(![current.shown,...current.others].some(c=>JSON.stringify(c.v)===JSON.stringify(input.choice?.value)))throw refuse('Choose a retained value.');
   if(input.choice.value===undefined)delete list[index][current.field];else list[index][current.field]=structuredClone(input.choice.value);
   stamps.set(current.key+'#'+current.field,nextStamp());
  }else if(input.choice?.keep===true){for(const field of Object.keys(list[index]))if(field!=='rev'&&stamps.has(current.key+'#'+field))stamps.set(current.key+'#'+field,nextStamp());}
  else if(input.choice?.keep===false){const record=list[index];list.splice(index,1);core.stampChanges(stamps,[{key:current.key,fields:[],deleted:true,record}],nextStamp);}
  else throw refuse('Choose whether to keep this record.');
  journal.state.seq=(journal.state.seq||0)+1;journal.stamps=[...stamps];return {ok:true};
 });}
 async function workspace(ws,input){
  const loaded=await engine.replica.load(ws),doc=loaded.state;
  if(!input)return loaded;
  if(input.revision!==loaded.revision)throw refuse('This folder changed. Refresh it before trying again.');
  const groups=new Map(doc.groups.map(g=>[g.id,g]));
  const live=id=>{const seen=new Set();while(id&&id!=='root'){const g=groups.get(id);if(!g||g.bin||seen.has(id))return false;seen.add(id);id=g.parentId;}return id==='root';};
  const name=()=>{const value=String(input.name||'').trim();if(!value||value.length>200)throw refuse('Enter a name up to 200 characters.');return value;};
  const folder=input.folderId||'root';
  if(['create-folder','create-link','move'].includes(input.action)&&!live(folder))throw refuse('That destination folder is unavailable.');
  const item=input.kind==='folder'?groups.get(input.id):doc.shortcuts.find(x=>x.id===input.id);
  if(!['create-folder','create-link','empty-bin'].includes(input.action)&&!item)throw refuse('This entry is unavailable.');
  if(input.action==='create-folder')doc.groups.push({id:randomUUID(),name:name(),parentId:folder,order:doc.groups.length});
  else if(input.action==='create-link'){let url;try{url=new URL(input.url);}catch{}if(!url||!['https:','http:'].includes(url.protocol))throw refuse('Enter an HTTP or HTTPS link.');doc.shortcuts.push({id:randomUUID(),name:name(),target:url.href,kind:'url',placements:[{id:randomUUID(),parentId:folder,order:doc.shortcuts.length}]});}
  else if(input.action==='rename')item.name=name();
  else if(input.action==='icon'){if(input.icon!==null&&(!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(input.icon)||input.icon.length>350000))throw refuse('Choose a small PNG, JPEG or WebP picture.');item.icon=input.icon;}
  else if(input.action==='move'){
   if(input.kind==='folder'){let parent=folder;while(parent&&parent!=='root'){if(parent===item.id)throw refuse('A folder cannot contain itself.');parent=groups.get(parent)?.parentId;}item.parentId=folder;}
   else{const placement=item.placements.find(p=>p.id===input.placementId&&!p.bin);if(!placement)throw refuse('This file moved. Refresh and retry.');placement.parentId=folder;}
  }else if(input.action==='bin'){
   if(input.kind==='folder')item.bin={parentId:item.parentId,order:item.order||0,binnedAt:new Date().toISOString()};
   else{const placement=item.placements.find(p=>p.id===input.placementId);if(!placement)throw refuse('This file moved.');placement.bin={parentId:placement.parentId,order:placement.order||0,binnedAt:new Date().toISOString()};}
  }else if(input.action==='restore'){
   if(input.kind==='folder'){if(!live(item.parentId))item.parentId='root';delete item.bin;}
   else for(const placement of item.placements){if(input.placementId&&placement.id!==input.placementId)continue;if(!live(placement.parentId))placement.parentId='root';delete placement.bin;}
  }else if(input.action==='empty-bin'){
   const dead=new Set(doc.groups.filter(g=>!live(g.id)).map(g=>g.id));
   doc.groups=doc.groups.filter(g=>!dead.has(g.id));
   for(const entry of doc.shortcuts)entry.placements=entry.placements.filter(p=>!p.bin&&!dead.has(p.parentId));
   doc.shortcuts=doc.shortcuts.filter(e=>e.placements.length);
  }else throw refuse('Unknown workspace action.');
  const result=await engine.replica.save(ws,doc,loaded.revision);if(!result.ok)throw refuse('The workspace changed before saving. Refresh and retry.');
  if(input.action==='restore'&&item?.workspaceFileId){const history=await engine.replica.history(ws,item.workspaceFileId);if(history.deleted){const version=history.versions.filter(v=>v.kind==='content').at(-1);if(version)await engine.replica.restore(ws,item.workspaceFileId,version.id);}}
  await engine.replica.reconcile();return {ok:true};
 }
 return {conflicts,workspace};
}
