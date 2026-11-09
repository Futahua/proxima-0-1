import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {webcrypto} from 'node:crypto';
// Squiggles in a collapsed row: drawn by whichever stretch overlaps them; only the owner's own drag takes one back.
const code=await readFile(new URL('./public/remote-domain.js',import.meta.url),'utf8')+'\n'+await readFile(new URL('./public/store.js',import.meta.url),'utf8')+'\nglobalThis.store=Store;';
const H=3600000,base=Date.parse('2026-10-15T00:00:00.000Z'),iso=t=>new Date(t).toISOString();
function fixture(saved){const now=base+10*H;class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}const memory=new Map(saved?[['proxima.store.v1',saved]]:[]),c=vm.createContext({Date:Clock,location:{search:'',protocol:'file:',hostname:'',port:''},localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},URLSearchParams,structuredClone,crypto:webcrypto,console,setTimeout,clearTimeout});vm.runInContext(code,c);return {store:c.store,memory};}
async function collapsed(){
 let h=fixture();const make=async(name,a,b)=>(await h.store.command({type:'timeline-interval.create',payload:{name,start:iso(a),end:iso(b)}})).value;
 const a=await make('A',base,base+2*H),b=await make('B',base,base+3*H);
 const state=JSON.parse(h.memory.get('proxima.store.v1'));const task={id:'task-b',name:'t',startedAt:iso(base+.5*H),durationMs:H,completedAt:iso(base+H)};
 state.timelineIntervals.find(x=>x.id===b.id).tasks=[task];h=fixture(JSON.stringify(state));
 const result=await h.store.command({type:'timeline-queue.collapse',payload:{intervalIds:[a.id,b.id]}});assert.equal(result.ok,true,result.code);
 const row=()=>h.store.timelineRows().find(r=>r.id===result.value.rowId),get=id=>h.store.timelineIntervals().find(x=>x.id===id);
 const patch=(id,p)=>h.store.command({type:'timeline-interval.patch',payload:{intervalId:id,patch:p}});
 return {h,a:a.id,b:b.id,row,get,patch};
}
test('collapse hands a squiggle to the stretch that now covers it, task record unchanged',async()=>{const s=await collapsed();assert.equal(s.get(s.b).start,iso(base+2*H));assert.deepEqual({...s.row().queueTaskLines},{'task-b':s.a});assert.equal(s.get(s.b).tasks[0].startedAt,iso(base+.5*H));});
test('dragging the owner over its squiggle reclaims it for good',async()=>{const s=await collapsed();
 assert.equal((await s.patch(s.a,{end:iso(base+.25*H)})).ok,true);assert.deepEqual({...s.row().queueTaskLines},{'task-b':s.a},'moving the other line does not move it');
 assert.equal((await s.patch(s.b,{start:iso(base+.25*H)})).ok,true);assert.deepEqual({...s.row().queueTaskLines},{},'owner took it back');
 assert.equal((await s.patch(s.b,{start:iso(base+2*H)})).ok,true);assert.equal((await s.patch(s.a,{end:iso(base+2*H)})).ok,true);assert.deepEqual({...s.row().queueTaskLines},{},'never handed back');});
test('restore drops the squiggle map',async()=>{const s=await collapsed();const r=await s.h.store.command({type:'timeline-queue.restore',payload:{intervalIds:[s.a,s.b]}});assert.equal(r.ok,true,r.code);for(const row of s.h.store.timelineRows())assert.equal(row.queueTaskLines,undefined);});
