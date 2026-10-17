import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
const context=vm.createContext({structuredClone,crypto:{randomUUID}});
for(const name of ['sync-core','workspace-domain','workspace-replica'])vm.runInContext(await readFile(new URL('./public/'+name+'.js',import.meta.url),'utf8'),context);
const replicas=new Map(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),plain=value=>JSON.parse(JSON.stringify(value));
function device(id,previous=null){
  const d=previous||{id,journal:null,revision:0,content:new Map(),bindings:new Map(),working:new Map(),originals:new Map()};
  d.files=async p=>{
    if(p.operation==='content-root')return {path:id+'-content'};
    if(p.operation==='content-check')return {available:d.content.has(p.hash),path:id+'-content/'+p.hash,size:d.content.get(p.hash)?.length};
    const key=p.workspaceId+'/'+p.entryId,path=id+'/'+key+'/'+p.name,b=d.bindings.get(key);
    if(p.operation==='import'){
      const bytes=b?d.working.get(path):d.originals.get(p.path);if(bytes==null)throw Error('Missing original');const h=hash(bytes);d.content.set(h,bytes);if(!b){d.working.set(path,bytes);d.bindings.set(key,{hash:h,versionId:null});}
      return {path,hash:h,size:bytes.length,baseHash:b?.hash??null,baseVersion:b?.versionId??null};
    }
    if(p.operation==='path')return {path,available:d.working.has(path),hash:b?.hash??null,versionId:b?.versionId??null};
    if(p.operation==='capture'){const bytes=d.working.get(path);if(bytes==null)throw Error('Missing working file');const h=hash(bytes);d.content.set(h,bytes);return {path,hash:h,size:bytes.length,baseHash:b?.hash??null,baseVersion:b?.versionId??null};}
    if(p.operation==='publish'){
      if(!d.content.has(p.hash))throw Error('Missing content');
      if(d.working.has(path)&&hash(d.working.get(path))!==b?.hash&&hash(d.working.get(path))!==p.hash)return {ok:false,localChange:{hash:hash(d.working.get(path))}};
      d.working.set(path,d.content.get(p.hash));d.bindings.set(key,{hash:p.hash,versionId:p.versionId});return {ok:true,path};
    }
    if(p.operation==='delete'){d.working.delete(path);d.bindings.set(key,{hash:null,versionId:p.versionId});return {ok:true};}
    throw Error('Unknown file fixture operation '+p.operation);
  };
  d.replica=context.ProximaWorkspaceReplica.create({uuid:randomUUID,storage:{load:async()=>({state:structuredClone(d.journal),revision:d.revision}),save:async(value,revision)=>{if(revision!==d.revision)return {ok:false,code:'STALE_REVISION'};d.journal=structuredClone(value);d.revision++;return {ok:true};}},files:d.files,copy:async(paths,destination)=>{
    for(const source of paths){const remote=/^\\\\papers~([^\\]+)\\([^\\]+)-content\\([a-f0-9]{64})$/.exec(source);
      if(remote){const peer=replicas.get(remote[1]);d.content.set(remote[3],peer.content.get(remote[3]));continue;}
      const target=/^\\\\papers~([^\\]+)\\([^\\]+)-content$/.exec(destination),h=source.split('/').at(-1);if(!target||!d.content.has(h))throw Error('Invalid fixture copy');replicas.get(target[1]).content.set(h,d.content.get(h));
    }
  }});
  replicas.set(id,d);return d;
}
async function link(d){d.originals.set('original','drawing A');const file=await d.replica.importFile('w','original','drawing.dwg','file-one'),loaded=await d.replica.load('w');
  const state={schemaVersion:1,groups:[],shortcuts:[{id:'shortcut-one',name:'drawing.dwg',target:file.target,workspaceFileId:file.workspaceFileId,placements:[{id:'placement-one',parentId:'root',order:0}]}]};
  assert.equal((await d.replica.save('w',state,loaded.revision)).ok,true);return file;
}
async function sync(a,b){await a.replica.syncWith({id:b.id,name:b.id},message=>b.replica.exchange(plain(message)));}

test('full replica journals and byte delivery preserve independent originals through edit, restart and sync',async()=>{
  const a=device('pc'),b=device('phone');const imported=await link(a);await sync(a,b);
  assert.equal((await b.replica.load('w')).state.shortcuts.length,1);const path=(await b.replica.load('w')).state.shortcuts[0].target;
  assert.equal(b.working.get(path),'drawing A');b.working.set(path,'offline phone edit');await b.replica.reconcile();
  const restarted=device('phone',b);await sync(restarted,a);await sync(a,restarted);
  assert.equal(a.working.get(imported.target),'offline phone edit');assert.equal(a.originals.get('original'),'drawing A');
  assert.equal((await a.replica.history('w','file-one')).conflict,false);
});
test('competing offline saves preserve both byte versions and resolution converges',async()=>{
  const a=device('pc'),b=device('phone');const imported=await link(a);await sync(a,b);const phonePath=(await b.replica.load('w')).state.shortcuts[0].target;
  a.working.set(imported.target,'PC work');b.working.set(phonePath,'Phone work');await a.replica.reconcile();await b.replica.reconcile();await sync(a,b);await sync(b,a);
  const versions=await a.replica.history('w','file-one');assert.equal(versions.conflict,true);assert.equal(versions.content.length,2);
  for(const head of versions.content){assert.ok(a.content.has(head.hash));assert.ok(b.content.has(head.hash));}
  const chosen=versions.content.find(v=>a.content.get(v.hash)==='Phone work');await a.replica.restore('w','file-one',chosen.id);await sync(a,b);await sync(b,a);
  assert.equal((await b.replica.history('w','file-one')).conflict,false);assert.equal(b.working.get(phonePath),'Phone work');
});
test('recoverable deletion appears in both AYGs and a restore survives a relay restart',async()=>{
  const a=device('pc'),b=device('phone'),hub=device('server');await link(a);await sync(a,b);await sync(a,hub);
  await a.replica.remove('w','file-one');await sync(a,b);await sync(a,hub);
  for(const d of [a,b,hub]){assert.equal((await d.replica.history('w','file-one')).deleted,true);assert.ok((await d.replica.load('w')).state.shortcuts[0].placements[0].bin);}
  const restarted=device('server',hub),history=await b.replica.history('w','file-one');await b.replica.restore('w','file-one',history.versions.find(v=>v.kind==='content').id);await sync(b,restarted);await sync(restarted,a);
  assert.equal((await a.replica.history('w','file-one')).deleted,false);assert.equal(a.working.size,1);
});
test('a stale pane cannot overwrite a received workspace organization change',async()=>{
  const a=device('pc'),b=device('phone');await link(a);await sync(a,b);const stale=await a.replica.load('w'),edit=await b.replica.load('w');edit.state.shortcuts[0].name='Human name';await b.replica.save('w',edit.state,edit.revision);await sync(b,a);
  stale.state.shortcuts[0].name='Stale';assert.equal((await a.replica.save('w',stale.state,stale.revision)).ok,false);assert.equal((await a.replica.load('w')).state.shortcuts[0].name,'Human name');
});
test('a blob folder is created once in the synced root, follows the blob name, and reads as deleted everywhere once binned',async()=>{
  const a=device('pc'),b=device('phone');
  assert.deepEqual(plain(await a.replica.folder('w','blob-1')),{exists:false,binned:false});
  await a.replica.ensureFolder('w','blob-1','Essay');await a.replica.ensureFolder('w','blob-1','Essay');
  const groups=(await a.replica.load('w')).state.groups;assert.equal(groups.length,1);assert.equal(groups[0].id,'blob-1');assert.equal(groups[0].parentId,'root');
  await a.replica.ensureFolder('w','blob-1','Essay, renamed');await sync(a,b);
  assert.equal((await b.replica.folder('w','blob-1')).name,'Essay, renamed');
  // Deleting the folder in the phone's As you Go bins it; every device then reads it as deleted.
  const loaded=await b.replica.load('w');loaded.state.groups[0].bin={parentId:'root',order:0,binnedAt:'2026-10-17T00:00:00.000Z'};
  assert.equal((await b.replica.save('w',loaded.state,loaded.revision)).ok,true);await sync(b,a);
  assert.equal((await a.replica.folder('w','blob-1')).binned,true);
  // A binned folder is not recreated or renamed by the blob.
  assert.equal((await a.replica.ensureFolder('w','blob-1','Essay')).binned,true);
  assert.equal((await a.replica.folders('w'))['blob-1'].binned,true);
});
