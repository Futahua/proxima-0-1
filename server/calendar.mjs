import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
// The same command owner as the installed cockpit, with durable CAS and causal stamps.
export async function createCalendar(engine){
 const names=['remote-domain','remote-follow','agent-context','store','schedule-projection'];
 const sources=await Promise.all(names.map(name=>readFile(path.join(here,'public',name+'.js'),'utf8')));
 return async function calendar(envelope,options={}){return engine.withFacts(async(journal,core)=>{
  const original=structuredClone(journal),reset=()=>{for(const key of Object.keys(journal))delete journal[key];Object.assign(journal,structuredClone(original));};
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
  sources.forEach((source,index)=>vm.runInContext(source,context,{filename:names[index]+'.js'}));
  const Store=vm.runInContext('Store',context);let command=null;
  const validType=type=>/^(?:task|project|run|remote|schedule-event|timeline-interval|timeline-queue|timeline-group)\.[a-z.-]+$|^timeline\.(?:undo|redo)$|^history\.revert$/.test(type||'');
  let batch;
  if(options.batch){
    const input=options.batch,commands=input.commands;
    if(!Array.isArray(commands)||!commands.length||commands.length>25||!Number.isSafeInteger(input.expectedSeq))throw Error('A batch requires 1–25 commands and expectedSeq.');
    const snapshot=Store.snapshot(),replay=commands.every(item=>snapshot.commands?.[item.commandId]);
    if(input.expectedSeq!==snapshot.seq&&!replay)return {batch:{ok:false,code:'SOURCE_CHANGED',applied:false},state:snapshot};
    const results=[];
    const resolve=value=>{
      if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.$ref==='string'){
        const match=/^(\d+)\.value(?:\.([a-zA-Z0-9_.]+))?$/.exec(value.$ref);if(!match||Number(match[1])>=results.length)throw Error('Invalid batch reference.');
        let result=results[Number(match[1])].value;for(const key of (match[2]||'').split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid reference key.');result=result?.[key];}if(result===undefined)throw Error('Unresolved batch reference.');return result;
      }
      if(Array.isArray(value))return value.map(resolve);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item)]));
      return value;
    };
    try{
      for(const item of commands){
        if(!validType(item.type)||item.type==='timeline.undo'||item.type==='timeline.redo'||!item.commandId||typeof item.commandId!=='string'||item.commandId.length>256)throw Error('Invalid batch command.');
        const result=await Store.command({...item,payload:resolve(item.payload||{}),expectedSeq:Store.snapshot().seq,actor:'agent-connector',client:'agent-workflow'});
        results.push(result);if(!result.ok){reset();return {batch:{ok:false,applied:false,failed_step:results.length-1,results},state:original.state};}
      }
      batch={ok:true,applied:!options.dryRun,provisional_ids:!!options.dryRun,results};
    }catch(error){reset();throw error;}
  }else if(envelope){if(!validType(envelope.type)||typeof envelope.commandId!=='string'||!envelope.commandId||envelope.commandId.length>256||!Number.isSafeInteger(envelope.expectedSeq))throw Error('Invalid command.');command=await Store.command({...envelope,actor:'public-link',client:'web-portal'});}
  await Store.refreshReadSnapshot();const snapshot=Store.snapshot();
  // The browser runs the whole cockpit. History, events and import receipts are
  // part of its domain document, not a cut-down projection of calendar bars.
  const now=Date.now(),timeline=Store.timelineIntervals().map(item=>({...item,effective_end:item.followNow?new Date(Math.max(Date.parse(item.start)+1,now)).toISOString():item.end}));
  let occurrences;
  if(options.range){const from=Date.parse(options.range.from),to=Date.parse(options.range.to);if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>366*86400000)throw Error('Choose a valid occurrence range up to 366 days.');occurrences=snapshot.scheduleEvents.flatMap(item=>context.ProximaScheduleProjection.occurrences(item,{start:new Date(from),end:new Date(to)}));if(occurrences.length>10000)throw Error('Too many schedule occurrences.');}
  const result={command,...(batch?{batch}:{}),state:snapshot,projection:{observed_at:new Date(now).toISOString(),timeline},...(options.catalog?{catalog:Store.commandCatalog()}:{}),...(occurrences?{occurrences}: {})};
  if(options.query)result.query=context.ProximaAgentContext.query({state:snapshot,timeline,observedAt:now,occurrences},options.query);
  if(options.dryRun)reset();
  return result;
 });};
}
