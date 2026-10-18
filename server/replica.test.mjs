import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createEngine} from './dist/main.mjs';
const context=vm.createContext({structuredClone});
vm.runInContext(await readFile(new URL('../public/sync-core.js',import.meta.url),'utf8'),context);
const core=context.ProximaSyncCore,plain=v=>JSON.parse(JSON.stringify(v));
test('durable relay retains original stamps and can supply a new device after restarting',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'papers-relay-'));
 try{
  const e=await createEngine(root),probe=await e.exchange({protocol:2,probe:true,vv:{},changes:[]});
  const stamps=new Map();let n=0;const state={tasks:[{id:'task-one',name:'original human action'}]};
  core.bootstrap(stamps,state,()=>({h:core.tick(null,123,'pc'),o:'pc',n:++n,c:{},u:1,action:{type:'task.create',id:'original-command'}}));
  const changes=plain(core.changesSince(state,stamps,{}));
  await e.exchange({protocol:2,vv:{pc:n},changes});await e.flush();
  const restarted=await createEngine(root),reply=await restarted.exchange({protocol:2,vv:{},changes:[]});
  assert.equal(reply.node,probe.node);assert.deepEqual(plain(reply.changes),changes);
  assert.deepEqual(plain(reply.vv),{pc:n});
  assert.equal(reply.changes[0].fields.name.action.id,'original-command');
  const duplicate=await restarted.exchange({protocol:2,vv:{pc:n},changes});
  assert.deepEqual(plain(duplicate.changes),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('workspace records missing bytes remain pending and survive restart',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'papers-workspace-relay-'));
 try{
  const source=await createEngine(path.join(root,'source')),destination=await createEngine(path.join(root,'destination'));
  const file=path.join(root,'source.txt');await writeFile(file,'retained version');
  const imported=await source.replica.importFile('w',file,'source.txt','file-one');
  const doc=await source.replica.load('w');
  doc.state.shortcuts.push({id:'shortcut-one',name:'source.txt',workspaceFileId:imported.workspaceFileId,workspaceFilename:'source.txt',placements:[{id:'placement-one',parentId:'root'}]});
  await source.replica.save('w',doc.state,doc.revision);
  const packet=await source.exchange({workspaceProtocol:1,vv:{},changes:[],acks:{}});
  const response=await destination.exchange(packet);
  assert.equal(response.needed.length,1);
  const restarted=await createEngine(path.join(root,'destination'));
  const again=await restarted.exchange({workspaceProtocol:1,vv:{},changes:[],acks:{}});
  assert.equal(again.needed[0].hash,response.needed[0].hash);
  assert.equal((await restarted.replica.entry('w','file-one')).item.workspaceAvailability,'pending');
  await source.flush();await destination.flush();await restarted.flush();
 }finally{await rm(root,{recursive:true,force:true});}
});
