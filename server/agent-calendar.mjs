import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const failure = message => Object.assign(new Error(message), { status: 409 });
export function factChanges(before, after) {
  const changes=[];
  for(const collection of ['tasks','projects','scheduleEvents','timelineRows','timelineIntervals']) {
    const a=new Map((before[collection]||[]).map(item=>[item.id,item])),b=new Map((after[collection]||[]).map(item=>[item.id,item]));
    for(const id of new Set([...a.keys(),...b.keys()]))if(JSON.stringify(a.get(id))!==JSON.stringify(b.get(id)))changes.push({collection,id,before:a.get(id)||null,after:b.get(id)||null});
  }
  if(JSON.stringify(before.run)!==JSON.stringify(after.run))changes.push({collection:'run',before:before.run||null,after:after.run||null});
  return changes;
}

export async function createAgentCalendar(calendar, directory, config) {
  const root=path.join(directory,'agent-workflows');await mkdir(root,{recursive:true});
  const file=(id,suffix)=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw failure('Invalid preview ID.');return path.join(root,id+'.'+suffix+'.json');};
  async function save(target,value){const temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{flag:'wx'});await rename(temp,target);}
  function authorized(commands){
    if(config.agent?.writes===false)throw failure('Agent writes are disabled by the owner.');
    const allowed=config.agent?.allowedCommands;
    if(commands.some(item=>!/^((task|project|run|schedule-event|timeline-interval|timeline-queue|timeline-group)\.[a-z.-]+|history\.revert)$/.test(item.type)||allowed&&!allowed.includes(item.type)))throw failure('Command is outside the agent capability.');
  }
  async function preview(input){
    if(!Array.isArray(input.commands)||!input.commands.length||input.commands.length>25)throw failure('Choose 1–25 commands.');
    authorized(input.commands);
    const current=(await calendar()).state,id=randomUUID(),commands=input.commands.map((item,index)=>({type:item.type,payload:item.payload||{},...(item.ifRev!==undefined?{ifRev:item.ifRev}:{}),commandId:id+':'+index}));
    const batch={expectedSeq:input.expectedSeq??current.seq,commands};
    const result=await calendar(null,{batch,dryRun:true});
    if(!result.batch?.ok)return {preview:false,...result.batch};
    const plan={id,batch,created:Date.now(),expires:Date.now()+15*60000};
    // Bound abandoned previews; completed receipts are retained independently.
    const existing=(await readdir(root)).filter(name=>name.endsWith('.preview.json'));
    for(const name of existing){try{const old=JSON.parse(await readFile(path.join(root,name),'utf8'));if(old.expires<Date.now())await unlink(path.join(root,name));}catch{}}
    if((await readdir(root)).filter(name=>name.endsWith('.preview.json')).length>=256)throw failure('Too many pending previews.');
    await save(file(id,'preview'),plan);
    return {preview_id:id,expected_seq:batch.expectedSeq,expires_at:new Date(plan.expires).toISOString(),commands:result.batch.results,changes:factChanges(current,result.state),provisional_ids:true,business_changes:false,scope:'Proxima facts only; Flow/Go bytes/native actions are separate owners'};
  }
  async function apply(id){
    try{return {...JSON.parse(await readFile(file(id,'receipt'),'utf8')),replay:true};}catch(error){if(error.code!=='ENOENT')throw error;}
    let plan;try{plan=JSON.parse(await readFile(file(id,'preview'),'utf8'));}catch{throw failure('Preview unavailable.');}
    if(plan.expires<Date.now())throw failure('Preview expired.');authorized(plan.batch.commands);
    const result=await calendar(null,{batch:plan.batch});
    if(!result.batch?.ok)return result.batch;
    const reversible=type=>/^(timeline-|task\.(create|patch)$|project\.(create|archive|restore)$|schedule-event\.(create|patch)$|run\.lock$)/.test(type);
    const receipt={receipt_id:id,applied:true,results:result.batch.results,seq:result.state.seq,at:new Date().toISOString(),undo_command_ids:plan.batch.commands.filter((item,index)=>reversible(item.type)&&result.batch.results[index].changed).map(item=>item.commandId),not_reversible:plan.batch.commands.filter(item=>!reversible(item.type)).map(item=>({command_id:item.commandId,type:item.type}))};
    await save(file(id,'receipt'),receipt);return receipt;
  }
  return {preview,apply};
}
