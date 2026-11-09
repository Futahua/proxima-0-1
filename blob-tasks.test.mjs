import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const domainCode=await readFile(new URL('./public/remote-domain.js',import.meta.url),'utf8');
const storeCode=domainCode+'\n'+await readFile(new URL('./public/store.js',import.meta.url),'utf8');
function makeStore(clock){const memory=new Map();const RealDate=Date;class FakeDate extends RealDate{constructor(...a){super(...(a.length?a:[clock.now]));}static now(){return clock.now;}}
 const c=vm.createContext({Date:FakeDate,location:{search:'',protocol:'file:',hostname:'',port:''},localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},URLSearchParams,structuredClone,crypto:webcrypto,console,setTimeout,clearTimeout});
 vm.runInContext(storeCode+'\nglobalThis.store=Store;',c);return c.store;}
const T0=Date.parse('2026-11-08T10:00:00Z'),MIN=60000;
test('a running fill grows from the current attempt and becomes a completed fill',async()=>{
 const code=await readFile(new URL('./public/blob-tasks.js',import.meta.url),'utf8');
 const context=vm.createContext({addEventListener(){},document:{createElement:()=>({}),head:{append(){}}}});
 vm.runInContext(code,context);
 const {runningFill,fills}=context.ProximaBlobTasks;
 const clock={now:T0},store=makeStore(clock),id=await blob(store,clock);
 const item=()=>store.timelineIntervals().find(x=>x.id===id);
 const run=payload=>store.command({type:'timeline-interval.task',payload:{intervalId:id,...payload}});
 const started=await run({action:'start',name:'Read',durationMs:10*MIN});
 assert.equal(started.ok,true,started.code);
 clock.now+=2*MIN;
 assert.deepEqual({...runningFill(item(),clock.now)},{start:T0,end:clock.now});
 clock.now+=10*MIN;
 const span={start:T0+10*MIN,end:clock.now};
 assert.deepEqual({...runningFill(item(),clock.now)},span);
 assert.equal((await run({action:'complete',taskId:started.value.task.id})).ok,true);
 assert.equal(runningFill(item(),clock.now),null);
 assert.deepEqual(Array.from(fills(item()),fill=>({...fill})),[span]);
});
async function blob(store,clock){const r=await store.command({type:'timeline-interval.create',payload:{name:'Blob',start:new Date(T0-3600000).toISOString(),end:new Date(T0+3600000).toISOString()}});assert.equal(r.ok,true,r.code);return r.value.id;}
test('a task completes from its attempt start, and a missed countdown restarts on its own',async()=>{
 const clock={now:T0};const store=makeStore(clock);const id=await blob(store,clock);
 let r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'start',name:'Draft plan',durationMs:30*MIN}});assert.equal(r.ok,true,r.code);const taskId=r.value.task.id;
 r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'start',name:'Other',durationMs:30*MIN}});assert.equal(r.code,'TASK_RUNNING');
 clock.now=T0+70*MIN; // two misses; third attempt began at +60
 r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'complete',taskId}});assert.equal(r.ok,true,r.code);
 const task=store.timelineIntervals().find(x=>x.id===id).tasks[0];
 assert.equal(task.startedAt,new Date(T0+60*MIN).toISOString());assert.equal(task.completedAt,new Date(T0+70*MIN).toISOString());
 assert.equal(store.timelineIntervals().find(x=>x.id===id).taskDurationMs,30*MIN);
});
test('changing the countdown keeps the current attempt start; abandon removes the running task',async()=>{
 const clock={now:T0};const store=makeStore(clock);const id=await blob(store,clock);
 let r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'start',name:'Read',durationMs:10*MIN}});const taskId=r.value.task.id;
 clock.now=T0+25*MIN;r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'duration',taskId,durationMs:60*MIN}});assert.equal(r.ok,true,r.code);
 assert.equal(store.timelineIntervals().find(x=>x.id===id).tasks[0].startedAt,new Date(T0+20*MIN).toISOString());
 r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'abandon',taskId}});assert.equal(r.ok,true);
 assert.deepEqual([...store.timelineIntervals().find(x=>x.id===id).tasks],[]);
 r=await store.command({type:'timeline-interval.task',payload:{intervalId:id,action:'start',name:'x',durationMs:5}});assert.equal(r.code,'PAYLOAD_INVALID');
});

test('deleting a completed entry preserves other tasks and supports undo',async()=>{
 const clock={now:T0},store=makeStore(clock),id=await blob(store,clock);
 const run=payload=>store.command({type:'timeline-interval.task',payload:{intervalId:id,...payload}});
 const first=(await run({action:'start',name:'First',durationMs:25*MIN})).value.task.id;
 clock.now+=MIN;await run({action:'complete',taskId:first});
 const second=(await run({action:'start',name:'Second',durationMs:25*MIN})).value.task.id;
 const result=await run({action:'delete',taskId:first});assert.equal(result.ok,true);
 assert.deepEqual(Array.from(store.timelineIntervals().find(x=>x.id===id).tasks,t=>t.id),[second]);
 const undo=await store.command({type:'timeline.undo',payload:{}});assert.equal(undo.ok,true,undo.code);
 assert.deepEqual(Array.from(store.timelineIntervals().find(x=>x.id===id).tasks,t=>t.id),[first,second]);
});
