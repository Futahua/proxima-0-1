import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
// The same command owner as the installed cockpit, with durable CAS and causal stamps.
export async function createCalendar(engine){
 const sources=await Promise.all(['remote-domain','remote-follow','store'].map(name=>readFile(path.join(here,'public',name+'.js'),'utf8')));
 return async function calendar(envelope){return engine.withFacts(async(journal,core)=>{
  const memory=new Map(),state=()=>({...journal.state,version:1,seq:journal.state.seq||0});
  const persistence={device:{ownerId:'BOP'},initialRaw:JSON.stringify(state()),ready:Promise.resolve(),read:async()=>structuredClone(state()),write:async(next,intent={})=>{
   const before=state(),changes=core.diff(before,next),stamps=new Map(journal.stamps);let clock=journal.clock||null;
   for(const stamp of stamps.values())clock=core.witness(clock,stamp.h);let n=journal.vv[journal.node]||0;
   const automatic=intent.origin!=='human';
   if(!automatic&&intent.type==='timeline-interval.patch'&&intent.intervalId&&intent.fields?.length){const key='timelineIntervals/'+intent.intervalId,record=core.recordsOf(next).get(key);if(record){let change=changes.find(x=>x.key===key);if(!change){change={key,fields:[],deleted:false};changes.push(change);}for(const field of intent.fields)if(['name','start','end','followNow','color','deadline','checked'].includes(field)&&!change.fields.includes(field))change.fields.push(field);}}
   if(automatic&&intent.type!=='timeline-queue.delete'&&changes.some(change=>change.deleted?[...stamps].some(([key,s])=>key.startsWith(change.key+'#')&&s.u):change.fields.some(field=>stamps.get(change.key+'#'+field)?.u)))throw Error('An automatic update cannot replace a deliberate edit.');
   core.stampChanges(stamps,changes,(key,field)=>{const c={...journal.vv},prior=key&&stamps.get(key+'#'+field),basis=automatic&&intent.type==='timeline-queue.delete'?(field==='~'?[...stamps].filter(([k])=>k.startsWith(key+'#')).map(([,s])=>s):prior?[prior]:[]):[];clock=core.tick(clock,Date.now(),journal.node);n++;journal.vv[journal.node]=n;return {h:clock,o:journal.node,n,c,...automatic?{a:1}:{u:1},...basis.length?{b:basis.map(s=>({o:s.o,n:s.n}))}:{},action:{type:intent.type||'public-edit',id:intent.commandId||null}};});
   journal.state=structuredClone(next);journal.stamps=[...stamps];journal.clock=clock;
  }};
  const context=vm.createContext({console,structuredClone,crypto:{randomUUID},Date,URLSearchParams,location:{search:'?client=public',protocol:'https:',hostname:'BOP'},localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)},ProximaPersistence:persistence,__proximaOwnerEngine:true});context.window=context;
  sources.forEach((source,index)=>vm.runInContext(source,context,{filename:['remote-domain.js','remote-follow.js','store.js'][index]}));
  const Store=vm.runInContext('Store',context);let command=null;
  if(envelope){if(!/^(?:task|project|run|remote|schedule-event|timeline-interval|timeline-queue|timeline-group)\.[a-z.-]+$|^timeline\.(?:undo|redo)$/.test(envelope.type||'')||typeof envelope.commandId!=='string'||!envelope.commandId||envelope.commandId.length>256||!Number.isSafeInteger(envelope.expectedSeq))throw Error('Invalid command.');command=await Store.command({...envelope,actor:'public-link',client:'web-portal'});}
  await Store.refreshReadSnapshot();const snapshot=Store.snapshot();
  // The browser runs the whole cockpit. History, events and import receipts are
  // part of its domain document, not a cut-down projection of calendar bars.
  return {command,state:snapshot};
 });};
}
