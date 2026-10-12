import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const domainCode=await readFile(new URL('./public/remote-domain.js',import.meta.url),'utf8');
const storeCode=await readFile(new URL('./public/store.js',import.meta.url),'utf8');
const owner={ownerId:'desktop',backpackId:'proxima'},now=Date.parse('2026-10-12T12:00:00.000Z');
function fixture(){
 const state={version:1,seq:9,projects:[{id:'p',name:'Project α',description:'Exact\nnotes',projectType:'task',createdAt:'2026-01-01T00:00:00.000Z',archivedAt:null,rev:2,windowHandles:[100],token:'private'}],tasks:[{id:'t',name:'Task',note:'Keep byte values',project:'p',status:'backlog',weight:2,start:'2026-10-12',deadline:'2026-10-14',createdAt:'2026-01-01T00:00:00.000Z',rev:3,ganttRow:20,order:7},{id:'other',name:'Other',project:'p',status:'backlog',weight:1,start:'2026-10-12',deadline:'',createdAt:'2026-01-01T00:00:00.000Z',rev:1}],scheduleEvents:[],timelineRows:[{id:'row',name:'Shared activity',color:'#a0a597',rowOrder:9,queue:{end:'2026-10-13T12:00:00.000Z',ids:['live','waiting']},queueReturn:{privateUndo:true}}],timelineIntervals:[{id:'live',rowId:'row',name:'Active',start:'2026-10-12T10:00:00.000Z',end:'2026-10-12T10:00:00.001Z',followNow:true,rev:1},{id:'waiting',rowId:'row',name:'Waiting',start:'2026-10-12T11:00:00.000Z',end:'2026-10-12T11:00:00.001Z',followNow:false,queueWeight:2,rev:1}],run:null,events:[{seq:9,privateBefore:'secret'}],commands:{private:'secret'},timelineHistory:{undo:['private']},views:{zoom:42},native:{HWND:200}};
 const memory=new Map([['proxima.store.v1',JSON.stringify(state)]]),Clock=class extends Date{static now(){return now;}};
 const context=vm.createContext({Date:Clock,location:{search:'',protocol:'file:',hostname:'',port:''},localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)},URLSearchParams,structuredClone,crypto:webcrypto,console,setTimeout,clearTimeout});
 vm.runInContext(domainCode+'\n'+storeCode+'\nglobalThis.store=Store;',context);
 return {state,memory,context,store:context.store,domain:context.ProximaRemoteDomain};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('selected task exports exact approved values and project dependency without copying its siblings or private fields',async()=>{
 const f=fixture(),before=f.memory.get('proxima.store.v1');const projection=await f.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]);
 assert.deepEqual(plain(projection.records.tasks.map(item=>item.id)),['t']);assert.equal(projection.records.projects.length,1);assert.equal(projection.records.projects[0].description,'Exact\nnotes');assert.equal(projection.records.tasks[0].start,'2026-10-12');
 const text=JSON.stringify(projection);for(const forbidden of ['privateUndo','privateBefore','windowHandles','token','ganttRow','rowOrder','timelineHistory','commands','views','HWND'])assert.ok(!text.includes(forbidden),forbidden);
 assert.equal(f.memory.get('proxima.store.v1'),before);
});
test('selecting a project includes its entries; selecting a queue member includes all required members',async()=>{
 const f=fixture();const project=await f.store.remoteProjection(owner,[{kind:'projects',id:'p'}]);assert.equal(project.records.tasks.length,2);
 const queue=await f.store.remoteProjection(owner,[{kind:'timelineIntervals',id:'waiting'}]);assert.deepEqual(plain(queue.records.timelineIntervals.map(item=>item.id)),['live','waiting']);assert.deepEqual(plain(queue.records.timelineRows[0].queue.ids),['live','waiting']);assert.equal(queue.source.seq,9);
});
test('independent queue copies freeze owner-calculated times and qualify every relationship by origin',async()=>{
 const f=fixture(),projection=await f.store.remoteProjection(owner,[{kind:'timelineIntervals',id:'waiting'}]),before=JSON.stringify(projection),candidate=f.domain.independentCandidate(projection);
 assert.equal(candidate.records.timelineIntervals[0].end,new Date(now).toISOString());assert.equal(candidate.records.timelineIntervals[1].start,new Date(now).toISOString());assert.equal(candidate.records.timelineIntervals[1].end,'2026-10-13T12:00:00.000Z');assert.ok(candidate.records.timelineIntervals.every(item=>!item.followNow));assert.equal(candidate.records.timelineRows[0].queue,undefined);assert.equal(candidate.records.timelineIntervals[0].rowId,candidate.records.timelineRows[0].id);assert.deepEqual(plain(candidate.records.timelineRows[0].sourceLineage.queue.ids),['live','waiting']);assert.equal(JSON.stringify(projection),before);
 assert.notEqual(f.domain.qualified(owner,'tasks','same'),f.domain.qualified({...owner,ownerId:'laptop'},'tasks','same'));assert.notEqual(f.domain.qualified(owner,'tasks','a:b'),f.domain.qualified(owner,'tasks','a%3Ab'));
});
test('ordinary live intervals freeze at the same source checkpoint without starting a second timer',async()=>{
 const f=fixture();const created=await f.store.command({type:'timeline-interval.create',payload:{name:'Independent active',start:'2026-10-12T11:00:00Z',end:'2026-10-12T11:00:00.001Z',followNow:true}});assert.equal(created.ok,true);const projection=await f.store.remoteProjection(owner,[{kind:'timelineIntervals',id:created.value.id}]),candidate=f.domain.independentCandidate(projection);assert.equal(candidate.records.timelineIntervals[0].end,new Date(now).toISOString());assert.equal(candidate.records.timelineIntervals[0].followNow,false);
});
test('projection queues behind pending durable writes and refuses missing or invalid selected dependencies',async()=>{
 const f=fixture();const write=f.store.command({type:'task.patch',payload:{taskId:'t',patch:{note:'Committed first'}}});const projection=f.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]);await write;assert.equal((await projection).records.tasks[0].note,'Committed first');
 await assert.rejects(()=>f.store.remoteProjection(owner,[{kind:'tasks',id:'gone'}]),/Missing tasks/);await assert.rejects(()=>f.store.remoteProjection(owner,[{kind:'__proto__',id:'t'}]),/Missing/);
 const broken=structuredClone(f.state);broken.timelineRows[0].queue.ids.push('gone');assert.throws(()=>f.domain.project(broken,owner,null,now),/Missing timelineIntervals/);
});
test('projection reads the latest durable checkpoint through the existing persistence owner without writing',async()=>{
 const f=fixture(),latest=structuredClone(f.state);latest.seq=12;latest.tasks[0].note='Another surface committed this';let reads=0;
 f.context.ProximaPersistence={ready:Promise.resolve(),read:async()=>{reads++;return latest;},write:()=>assert.fail('Read projection must not write')};
 const projection=await f.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]);assert.equal(reads,1);assert.equal(projection.source.seq,12);assert.equal(projection.records.tasks[0].note,'Another surface committed this');
});
