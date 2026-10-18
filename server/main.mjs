import {readFile,mkdir,open,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {createPortal} from './portal.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const {WorkspaceFiles,RemoteDeviceService}=createRequire(import.meta.url)('./host.cjs');
const project='bp-7f977e43-e48d-44f7-9e02-df6bf7ee4349';

// Peer exchanges retain original causal stamps. Explicit public user commands use
// the existing command owner and originate their own deliberate-edit stamps.
export async function createEngine(directory){
  const native=new WorkspaceFiles(path.join(directory,'workspace'));
  const context=vm.createContext({structuredClone,crypto:{randomUUID},Date,console});
  for(const name of ['sync-core','workspace-domain','workspace-replica'])vm.runInContext(await readFile(path.join(here,name+'.js'),'utf8'),context,{filename:name+'.js'});
  // Peers address the granted share name, not the server's private disk path.
  const call=async params=>{const result=await native.call(project,params);return params.operation==='content-root'?{...result,transportPath:'Replica content'}:result;},core=context.ProximaSyncCore;
  const replica=context.ProximaWorkspaceReplica.create({storage:{load:()=>call({operation:'journal-load'}),save:(state,revision)=>call({operation:'journal-save',state,revision})},files:call,deferReconcile:false,allowCachePolicy:false,copy:()=>{throw Error('Passive replica does not originate transfers.');}});
  let tail=Promise.resolve();
  function withFacts(work){const next=tail.catch(()=>{}).then(async()=>{for(let attempt=0;attempt<6;attempt++){const loaded=await native.call('proxima-relay',{operation:'journal-load'}),journal=loaded.state||{version:1,node:randomUUID(),vv:{},state:{version:1,seq:0},stamps:[],receipts:0};journal.state.seq??=journal.receipts||0;const before=JSON.stringify(journal),result=await work(journal,core);if(before===JSON.stringify(journal))return result;const saved=await native.call('proxima-relay',{operation:'journal-save',revision:loaded.revision,state:journal});if(saved.ok)return result;if(saved.code!=='STALE_REVISION')throw Error('Replica persistence failed.');}throw Error('Replica changed repeatedly.');});tail=next;return next;}
  async function exchange(message){
    if(message?.workspaceProtocol===1)return replica.exchange(message);
    const work=tail.catch(()=>{}).then(async()=>{
      if(message?.protocol!==2||!message.vv||!Array.isArray(message.changes))throw Error('Unsupported sync protocol.');
      for(const [node,n] of Object.entries(message.vv))if(!node||!Number.isSafeInteger(n)||n<0)throw Error('Invalid sync vector.');
      for(let attempt=0;attempt<6;attempt++){
        const loaded=await native.call('proxima-relay',{operation:'journal-load'});
        const journal=loaded.state||{version:1,node:randomUUID(),vv:{},state:{},stamps:[],receipts:0};
        if(journal.version!==1)throw Error('Unsupported replica journal.');
        if(message.probe){
          if(!loaded.state){const saved=await native.call('proxima-relay',{operation:'journal-save',revision:loaded.revision,state:journal});if(!saved.ok)continue;}
          return {protocol:2,node:journal.node,vv:journal.vv,changes:[],notes:[]};
        }
        const stamps=new Map(journal.stamps),merged=core.merge(journal.state,stamps,message.changes);
        journal.state={...merged.state,seq:(journal.state.seq||journal.receipts||0)+(merged.changed?1:0)};journal.stamps=[...stamps];journal.vv=core.joinVectors(journal.vv,message.vv);journal.receipts++;
        journal.history=[...(journal.history||[]),...merged.overwritten.map(value=>({...value,receivedAt:new Date().toISOString()}))];
        const saved=await native.call('proxima-relay',{operation:'journal-save',revision:loaded.revision,state:journal});
        if(saved.ok)return {protocol:2,node:journal.node,vv:journal.vv,changes:core.changesSince(journal.state,stamps,message.vv),notes:[]};
        if(saved.code!=='STALE_REVISION')throw Error('Replica persistence failed.');
      }
      throw Error('Replica changed repeatedly.');
    });tail=work;return work;
  }
  return {exchange,native,replica,withFacts,flush:async()=>{await tail;await replica.flush();}};
}

export async function serve(directory){
  await mkdir(directory,{recursive:true});
  // An OS-owned local socket prevents duplicate instances and is released on crash.
  const guard=createServer(socket=>socket.end());
  await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(48241,'127.0.0.1',resolve);});
  const lockPath=path.join(directory,'server.lock');
  const lock=await open(lockPath,'w');
  await lock.writeFile(String(process.pid));await lock.sync();
  let service,healthTimer,starting=false;
  const engine=await createEngine(directory);
  let portal;try{portal=await createPortal(engine,directory);}catch(error){console.error('Public portal: '+error.message);await writeFile(path.join(directory,'portal-status.json'),JSON.stringify({ready:false,at:new Date().toISOString(),error:error.message}));}
  async function start(){
    if(starting)return;starting=true;
    try{
    const next=new RemoteDeviceService(path.join(directory,'device'));
    const content=await engine.native.call(project,{operation:'content-root'}),incoming=await engine.native.call(project,{operation:'incoming-root'});
    const share={id:'8dbd3f33-c613-469b-adea-c631598b8d02',projectId:project,name:'BOP durable replica',kind:'proxima'};
    next.defaultGrant=async()=>({canWrite:true,shares:[{id:'a5bb8174-e5e6-48e7-a64f-b87baa024494',name:'Replica content',directory:content.path},{id:'790f8bcc-8c81-44e1-9dd4-cd2add52ccab',name:'Incoming content',directory:incoming.path}],backpacks:[share]});
    next.replaceBackpack=async(_share,payload)=>{
      if(!payload.proximaSync)throw Error('This server accepts sync exchanges, not whole-copy replacement.');
      return {proximaSync:await engine.exchange(payload.proximaSync)};
    };
    await next.initialize();
    const status=next.snapshot();
    await writeFile(path.join(directory,'status.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,owner:status.owner,ready:!!status.address,error:status.error}));
    if(status.address){service=next;console.log('Replica listening on its private Tailscale interface.');}
    else await next.close();
    }finally{starting=false;}
  }
  try{await start();}catch(error){console.error(error.message);}
  healthTimer=setInterval(()=>{if(!service)void start().catch(error=>console.error(error.message));},15000);
  const close=async()=>{clearInterval(healthTimer);await portal?.close();await service?.close();await engine.flush();await lock.close();await unlink(lockPath);await new Promise(resolve=>guard.close(resolve));};
  return {engine,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw Error('Pass a dedicated absolute data directory.');
  if(!path.isAbsolute(process.argv[2]))throw Error('Data directory must be absolute.');
  const server=await serve(process.argv[2]);
  let closing=false;const shutdown=()=>{if(closing)return;closing=true;server.close().then(()=>process.exit(0),()=>process.exit(1));};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
