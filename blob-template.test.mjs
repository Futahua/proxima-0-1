import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const source=(await Promise.all(['remote-domain','store'].map(name=>readFile(new URL('./public/'+name+'.js',import.meta.url),'utf8')))).join('\n');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(memory=new Map()){
  const context=vm.createContext({location:{search:'',protocol:'file:',hostname:'',port:''},localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)},URLSearchParams,structuredClone,crypto:webcrypto,console,setTimeout,clearTimeout});
  vm.runInContext(source+'\nglobalThis.testStore=Store;',context);
  return {store:context.testStore,domain:context.ProximaRemoteDomain,memory};
}
async function create(store,name='Drawing'){
  return store.command({type:'timeline-interval.create',payload:{name,start:'2026-10-17T00:00:00Z',end:'2026-10-17T01:00:00Z'}});
}
test('choosing/removing a template is durable, idempotent and participates only in blob history',async()=>{
  let {store,memory}=fixture();const {value:blob}=await create(store);
  const request={type:'timeline-interval.template',commandId:'choose-ayg',ifRev:blob.rev,payload:{intervalId:blob.id,template:'as-you-go'}};
  const first=await store.command(request);assert.equal(first.ok,true);const binding=plain(first.value.template);
  assert.equal(binding.kind,'as-you-go');assert.ok(binding.workspaceId);assert.equal((await store.command(request)).value.template.workspaceId,binding.workspaceId);
  assert.equal((await store.command({type:'timeline-interval.template',payload:{intervalId:blob.id,template:'as-you-go'}})).changed,false);
  ({store}=fixture(memory));assert.deepEqual(plain(store.timelineIntervals()[0].template),binding);
  await store.command({type:'timeline-interval.template',payload:{intervalId:blob.id,template:null}});assert.equal(store.timelineIntervals()[0].template,null);
  assert.equal((await store.command({type:'timeline.undo'})).ok,true);assert.deepEqual(plain(store.timelineIntervals()[0].template),binding);
  await store.command({type:'timeline.undo'});assert.equal(store.timelineIntervals()[0].template,undefined);
  await store.command({type:'timeline.redo'});assert.deepEqual(plain(store.timelineIntervals()[0].template),binding);
});
test('workspace bindings stay with the session on rename/reorder and separate blobs have separate identities',async()=>{
  const {store}=fixture();const a=await create(store,'A'),b=await create(store,'B');
  for(const blob of [a,b])assert.equal((await store.command({type:'timeline-interval.template',payload:{intervalId:blob.value.id,template:'as-you-go'}})).ok,true);
  const before=store.timelineIntervals().find(item=>item.id===a.value.id).template.workspaceId;
  assert.notEqual(before,store.timelineIntervals().find(item=>item.id===b.value.id).template.workspaceId);
  await store.command({type:'timeline-interval.patch',payload:{intervalId:a.value.id,patch:{name:'Renamed'}}});
  await store.command({type:'timeline-interval.reorder',payload:{intervalId:a.value.id}});
  assert.equal(store.timelineIntervals().find(item=>item.id===a.value.id).template.workspaceId,before);
  assert.equal((await store.command({type:'timeline-interval.template',ifRev:1,payload:{intervalId:a.value.id,template:null}})).ok,false);
});
test('remote projections retain validated template references without exporting local native paths',async()=>{
  const {store,domain}=fixture(),a=await create(store);
  await store.command({type:'timeline-interval.template',payload:{intervalId:a.value.id,template:'as-you-go'}});
  const projection=await store.remoteProjection({ownerId:'SlopTop',backpackId:'Proxima'});
  assert.equal(domain.validateProjection(projection).records.timelineIntervals[0].template.kind,'as-you-go');
  assert.throws(()=>domain.independentCandidate(projection),/Independent copying/);
  const bad=plain(projection);bad.records.timelineIntervals[0].template.path='C:/private';assert.throws(()=>domain.validateProjection(bad),/Unapproved/);
  assert.equal(JSON.stringify(projection).includes('C:/private'),false);
});
