import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const domainCode=await readFile(new URL('./public/remote-domain.js',import.meta.url),'utf8');
const storeCode=await readFile(new URL('./public/store.js',import.meta.url),'utf8');
const owner={ownerId:'desktop',backpackId:'proxima'},now=Date.parse('2026-10-12T12:00:00.000Z');
function fixture(seed){
 const state={version:1,seq:9,projects:[{id:'p',name:'Project α',description:'Exact\nnotes',projectType:'task',createdAt:'2026-01-01T00:00:00.000Z',archivedAt:null,rev:2,windowHandles:[100],token:'private'}],tasks:[{id:'t',name:'Task',note:'Keep byte values',project:'p',status:'backlog',weight:2,start:'2026-10-12',deadline:'2026-10-14',createdAt:'2026-01-01T00:00:00.000Z',rev:3,ganttRow:20,order:7},{id:'other',name:'Other',project:'p',status:'backlog',weight:1,start:'2026-10-12',deadline:'',createdAt:'2026-01-01T00:00:00.000Z',rev:1}],scheduleEvents:[],timelineRows:[{id:'row',name:'Shared activity',color:'#a0a597',rowOrder:9,queue:{end:'2026-10-13T12:00:00.000Z',ids:['live','waiting']},queueReturn:{privateUndo:true}}],timelineIntervals:[{id:'live',rowId:'row',name:'Active',start:'2026-10-12T10:00:00.000Z',end:'2026-10-12T10:00:00.001Z',followNow:true,rev:1},{id:'waiting',rowId:'row',name:'Waiting',start:'2026-10-12T11:00:00.000Z',end:'2026-10-12T11:00:00.001Z',followNow:false,queueWeight:2,rev:1}],run:null,events:[{seq:9,privateBefore:'secret'}],commands:{private:'secret'},timelineHistory:{undo:['private']},views:{zoom:42},native:{HWND:200}};
 const memory=new Map([['proxima.store.v1',JSON.stringify(seed||state)]]),Clock=class extends Date{static now(){return now;}};
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
test('one import commits exact approved values, relationships and receipt without replacing local work',async()=>{
 const source=fixture(),receiver=fixture(),before=plain(receiver.store.snapshot()),importId=webcrypto.randomUUID();const projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]);
 const preview=receiver.store.previewImport(projection,importId);assert.equal(preview.ok,true);const result=await receiver.store.command({type:'remote.import',commandId:importId,payload:{projection,importId,mode:'independent'}});assert.equal(result.ok,true);assert.equal(result.changed,true);
 const state=plain(receiver.store.snapshot());assert.deepEqual(state.projects.find(item=>item.id==='p'),before.projects.find(item=>item.id==='p'));assert.deepEqual(state.tasks.find(item=>item.id==='t'),before.tasks.find(item=>item.id==='t'));assert.equal(state.events.length,before.events.length+1);assert.equal(state.events.at(-1).type,'remote.import');assert.equal(state.remoteImports.length,1);
 const imported=state.tasks.find(item=>item.id===result.value.ids.tasks[0]);assert.equal(imported.name,'Task');assert.equal(imported.note,'Keep byte values');assert.equal(imported.start,'2026-10-12');assert.equal(imported.deadline,'2026-10-14');assert.equal(imported.weight,2);assert.equal(imported.project,result.value.ids.projects[0]);assert.equal(imported.rev,1);assert.equal(imported.sourceLineage.rev,3);assert.equal(state.projects.find(item=>item.id===imported.project).token,undefined);assert.equal(imported.id,preview.candidate.records.tasks[0].id);
 const saved=JSON.parse(receiver.memory.get('proxima.store.v1'));assert.equal(saved.remoteImports.length,1);assert.equal(saved.tasks.length,state.tasks.length);
});
test('import identity remains deduplicated after reload and command-memory pruning; separate acts can copy independently',async()=>{
 const source=fixture(),receiver=fixture(),projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]),importId=webcrypto.randomUUID();const payload={projection,importId,mode:'independent'};
 await receiver.store.command({type:'remote.import',commandId:importId,payload});const saved=JSON.parse(receiver.memory.get('proxima.store.v1'));saved.commands={};const reopened=fixture(saved);
 const repeated=await reopened.store.command({type:'remote.import',commandId:webcrypto.randomUUID(),payload});assert.equal(repeated.ok,true);assert.equal(repeated.changed,false);assert.equal(reopened.store.snapshot().tasks.length,saved.tasks.length);assert.equal(reopened.store.snapshot().remoteImports.length,1);
 const changed=structuredClone(projection);changed.records.tasks[0].name='Changed source';const conflict=await reopened.store.command({type:'remote.import',payload:{...payload,projection:changed}});assert.equal(conflict.code,'IMPORT_ID_CONFLICT');
 const second=await reopened.store.command({type:'remote.import',payload:{...payload,importId:webcrypto.randomUUID()}});assert.equal(second.ok,true);assert.equal(second.changed,true);assert.notEqual(second.value.ids.tasks[0],repeated.value.ids.tasks[0]);assert.equal(reopened.store.snapshot().remoteImports.length,2);
});
test('invalid projections and collisions refuse the whole graph before writing',async()=>{
 const source=fixture(),receiver=fixture(),projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]),importId=webcrypto.randomUUID(),before=JSON.stringify(receiver.store.snapshot());
 for(const invalid of [()=>{const p=structuredClone(projection);p.records.projects[0].token='Do not import';return p;},()=>{const p=structuredClone(projection);p.records.tasks[0].project='missing';return p;},()=>{const p=structuredClone(projection);p.records.tasks[0].deadline='2026-02-30';return p;},()=>{const p=structuredClone(projection);p.records.tasks.push(p.records.tasks[0]);return p;}]){const result=await receiver.store.command({type:'remote.import',payload:{projection:invalid(),importId,mode:'independent'}});assert.equal(result.code,'IMPORT_INVALID');assert.equal(JSON.stringify(receiver.store.snapshot()),before);}
 const candidate=receiver.store.previewImport(projection,importId).candidate,seed=plain(receiver.store.snapshot());seed.projects.push(candidate.records.projects[0]);seed.tasks.push({...candidate.records.tasks[0],name:'Keep this local edit'});const occupied=fixture(seed),collision=await occupied.store.command({type:'remote.import',payload:{projection,importId,mode:'independent'}});assert.equal(collision.code,'IMPORT_COLLISION');assert.equal(occupied.store.tasks().find(item=>item.id===candidate.records.tasks[0].id).name,'Keep this local edit');assert.equal(occupied.store.imports().length,0);
});
test('durable write failure rolls back every imported record, event and receipt; same request can retry',async()=>{
 const source=fixture(),receiver=fixture(),projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]),importId=webcrypto.randomUUID();let durable=plain(receiver.store.snapshot()),fail=true;
 receiver.context.ProximaPersistence={ready:Promise.resolve(),read:async()=>structuredClone(durable),write:async state=>{if(fail){const error=new Error('No space');error.name='QuotaExceededError';throw error;}durable=plain(state);}};
 const before=JSON.stringify(durable),request={type:'remote.import',commandId:importId,payload:{projection,importId,mode:'independent'}};const failed=await receiver.store.command(request);assert.equal(failed.code,'WRITE_FAILED');assert.equal(JSON.stringify(durable),before);assert.equal(JSON.stringify(receiver.store.snapshot()),before);
 fail=false;const retried=await receiver.store.command(request);assert.equal(retried.ok,true);assert.equal(durable.remoteImports.length,1);assert.equal(durable.tasks.filter(item=>item.id===retried.value.ids.tasks[0]).length,1);
});
test('import resolves only after its persistence owner confirms the transaction',async()=>{
 const source=fixture(),receiver=fixture(),projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]),importId=webcrypto.randomUUID();let durable=plain(receiver.store.snapshot()),release,confirmed=false;const gate=new Promise(resolve=>{release=resolve;});
 receiver.context.ProximaPersistence={ready:Promise.resolve(),read:async()=>structuredClone(durable),write:async state=>{await gate;durable=plain(state);}};
 const pending=receiver.store.command({type:'remote.import',payload:{projection,importId,mode:'independent'}}).then(result=>{confirmed=true;return result;});await new Promise(resolve=>setImmediate(resolve));assert.equal(confirmed,false);assert.equal((durable.remoteImports||[]).length,0);release();const result=await pending;assert.equal(result.ok,true);assert.equal(durable.remoteImports.length,1);
});
test('queue sessions freeze with independent colors, and source runs archive without replacing the active local run',async()=>{
 const source=fixture(),receiver=fixture();const sourceSeed=plain(source.store.snapshot());sourceSeed.timelineIntervals[0].color='#ff0000';sourceSeed.timelineIntervals[1].color='#00ff00';sourceSeed.timelineRows[0].independentColors=false;sourceSeed.run={lockedAt:'2026-10-12T10:00:00.000Z',target:'2026-10-13T10:00:00.000Z',rev:4,total:86400000,members:[{id:'t',name:'Frozen task',weight:2,duration:86400000,startsAt:Date.parse('2026-10-12T10:00:00Z'),endsAt:Date.parse('2026-10-13T10:00:00Z')}]};
 const actualSource=fixture(sourceSeed),projection=await actualSource.store.remoteProjection(owner),importId=webcrypto.randomUUID();const localSeed=plain(receiver.store.snapshot());localSeed.run={lockedAt:'2026-10-12T09:00:00.000Z',target:'2026-10-14T09:00:00.000Z',rev:2,total:1,members:[]};const actualReceiver=fixture(localSeed),result=await actualReceiver.store.command({type:'remote.import',payload:{projection,importId,mode:'independent'}});assert.equal(result.ok,true);assert.deepEqual(plain(actualReceiver.store.run()),localSeed.run);assert.equal(actualReceiver.store.importedRuns().length,1);assert.equal(actualReceiver.store.importedRuns()[0].sourceLineage.rev,4);
 const imported=actualReceiver.store.timelineIntervals().filter(item=>result.value.ids.timelineIntervals.includes(item.id));assert.ok(imported.every(item=>!item.followNow));assert.deepEqual(plain(imported.map(item=>item.color)),['#ff0000','#00ff00']);assert.equal(imported[0].end,new Date(now).toISOString());assert.equal(imported[1].start,new Date(now).toISOString());assert.ok(actualReceiver.store.timelineRows().filter(row=>result.value.ids.timelineRows.includes(row.id)).every(row=>!row.queue));
});
test('approved copy request survives restart and cannot be replaced before or after its atomic commit',async()=>{
 const source=fixture(),receiver=fixture(),projection=await source.store.remoteProjection(owner,[{kind:'tasks',id:'t'}]),importId=webcrypto.randomUUID();const staged=await receiver.store.command({type:'remote.import-stage',commandId:importId+':stage',payload:{projection,importId,label:'Desktop'}});assert.equal(staged.ok,true);assert.equal(receiver.store.tasks().length,2);assert.equal(receiver.store.pendingImports().length,1);
 const restarted=fixture(JSON.parse(receiver.memory.get('proxima.store.v1')));const saved=restarted.store.pendingImports()[0];assert.equal(saved.id,importId);const changed=structuredClone(saved.projection);changed.records.tasks[0].note='Not approved';const replaced=await restarted.store.command({type:'remote.import',payload:{projection:changed,importId,mode:'independent'}});assert.equal(replaced.code,'IMPORT_ID_CONFLICT');
 const copied=await restarted.store.command({type:'remote.import',commandId:importId,payload:{projection:saved.projection,importId,mode:'independent'}});assert.equal(copied.ok,true);assert.equal(restarted.store.pendingImports().length,0);assert.equal(restarted.store.imports().length,1);
 const changedStage=await restarted.store.command({type:'remote.import-stage',payload:{projection:changed,importId}});assert.equal(changedStage.code,'IMPORT_ID_CONFLICT');
});
