import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context=vm.createContext({structuredClone});
for(const file of ['sync-core','workspace-domain'])vm.runInContext(await readFile(new URL('./public/'+file+'.js',import.meta.url),'utf8'),context);
const W=context.ProximaWorkspaceDomain,S=W.core;
const plain=value=>JSON.parse(JSON.stringify(value));
const bytes=value=>value.repeat(64);
const version=(id,hash,parents=[],kind='content')=>({id,workspaceId:'workspace-one',entryId:'drawing',parents,kind,...kind==='content'?{hash:bytes(hash),size:123}:{}});

// The same core used by Proxima, with crash/restart checkpoints. This fixture is
// not evidence of real Papers transfer, Android scheduling or disk publication.
function replica(node,checkpoint=null){
  const d=checkpoint?JSON.parse(checkpoint):{node,state:{workspaceEntries:[],workspaceVersions:[]},stamps:[],n:0,vv:{},clock:null,wall:1000};
  d.stamps=new Map(d.stamps);
  d.edit=change=>{const next=change(structuredClone(d.state));S.stampChanges(d.stamps,S.diff(d.state,next),()=>{const c={...d.vv};d.n++;d.vv[node]=d.n;d.clock=S.tick(d.clock,d.wall,node);return {h:d.clock,o:node,n:d.n,c,u:1,action:{type:'fixture.edit',id:node+'-'+d.n}};});d.state=next;};
  d.checkpoint=()=>JSON.stringify({node,state:d.state,stamps:[...d.stamps],n:d.n,vv:d.vv,clock:d.clock,wall:d.wall});
  return d;
}
function send(from,to){
  const changes=plain(S.changesSince(from.state,from.stamps,to.vv));
  const result=W.merge(to.state,to.stamps,changes);to.state=result.state;to.vv=S.joinVectors(to.vv,from.vv);
  for(const value of to.stamps.values())to.clock=S.witness(to.clock,value.h);
}
function converge(...devices){for(let round=0;round<3;round++)for(const from of devices)for(const to of devices)if(from!==to)send(from,to);}
const inspect=d=>W.inspect(d.state,'workspace-one','drawing');

test('offline file branches survive restart, a skewed phone and duplicate relay through a future server',()=>{
  let pc=replica('SlopTop'),laptop=replica('LapDog'),phone=replica('Poordroid'),server=replica('Server');
  pc.edit(state=>W.appendVersion(state,version('A','a')));converge(pc,laptop,phone,server);
  pc.edit(state=>W.appendVersion(state,version('B','b',['A'])));
  phone.wall=9999999999999;phone.edit(state=>W.appendVersion(state,version('C','c',['A'])));
  pc=replica('SlopTop',pc.checkpoint());phone=replica('Poordroid',phone.checkpoint());
  send(pc,server);send(phone,laptop);send(server,laptop);send(laptop,server);send(server,phone);converge(pc,laptop,phone,server);
  for(const device of [pc,laptop,phone,server]){assert.equal(inspect(device).conflict,true);assert.deepEqual(plain(inspect(device).heads.map(value=>value.id)),['B','C']);assert.equal(device.state.workspaceVersions.length,3);}
  // A relay is not another author, even though it supplies the durable history.
  for(const value of server.stamps.values())assert.notEqual(value.o,'Server');
  phone.edit(state=>W.resolve(state,{workspaceId:'workspace-one',entryId:'drawing',id:'resolved',hash:bytes('b'),size:123}));
  converge(pc,laptop,phone,server);
  for(const device of [pc,laptop,phone,server]){assert.equal(inspect(device).conflict,false);assert.deepEqual(plain(inspect(device).heads.map(value=>value.id)),['resolved']);assert.equal(device.state.workspaceVersions.length,4);}
});

test('delete/edit conflict, Bin state and explicit restoration replicate from the first milestone',()=>{
  const pc=replica('SlopTop'),phone=replica('Poordroid'),laptop=replica('LapDog');
  pc.edit(state=>W.appendVersion(state,version('A','a')));converge(pc,phone,laptop);
  pc.edit(state=>W.appendVersion(state,version('deleted',null,['A'],'delete')));
  phone.edit(state=>W.appendVersion(state,version('edited','b',['A'])));converge(pc,phone,laptop);
  for(const device of [pc,phone,laptop]){assert.equal(inspect(device).bin,true);assert.equal(inspect(device).deleted,false);assert.equal(inspect(device).conflict,true);}
  laptop.edit(state=>W.resolve(state,{workspaceId:'workspace-one',entryId:'drawing',id:'restored',hash:bytes('b'),size:123}));converge(pc,phone,laptop);
  for(const device of [pc,phone,laptop]){assert.equal(inspect(device).bin,false);assert.equal(inspect(device).conflict,false);assert.equal(device.state.workspaceVersions.some(value=>value.id==='deleted'),true);}
});

test('a stale replica cannot resurrect a deletion simply by returning online',()=>{
  const pc=replica('SlopTop'),phone=replica('Poordroid'),server=replica('Server');
  pc.edit(state=>W.appendVersion(state,version('A','a')));converge(pc,phone,server);
  pc.edit(state=>W.appendVersion(state,version('deleted',null,['A'],'delete')));send(pc,server);
  send(phone,server);send(server,phone);assert.equal(inspect(phone).deleted,true);assert.equal(inspect(phone).bin,true);
});

test('missing version ancestry blocks definitive deletion and local resolution',()=>{
  const partial={workspaceVersions:[version('delete',null,['not-yet-received'],'delete')]};
  assert.equal(W.inspect(partial,'workspace-one','drawing').deleted,false);
  assert.throws(()=>W.resolve(partial,{workspaceId:'workspace-one',entryId:'drawing',id:'resolve',hash:bytes('a'),size:123}),/missing history/);
});

test('version identities are immutable and malformed incoming ancestry cannot partly alter stamps',()=>{
  const pc=replica('SlopTop'),phone=replica('Poordroid');pc.edit(state=>W.appendVersion(state,version('A','a')));send(pc,phone);
  assert.throws(()=>W.appendVersion(pc.state,version('A','b')),/immutable/);
  const before=phone.checkpoint(),changes=plain(S.changesSince(pc.state,pc.stamps,{}));
  for(const change of changes)if(change.key==='workspaceVersions/A'){change.fields.hash.v=bytes('b');change.fields.hash.n+=100;change.fields.hash.c={...phone.vv};change.fields.hash.h=S.stamp(999999,0,'SlopTop');}
  assert.throws(()=>W.merge(phone.state,phone.stamps,changes),/immutable/);assert.equal(phone.checkpoint(),before);
  const invalid={workspaceVersions:[version('A','a',['B']),version('B','b',['A'])]};assert.throws(()=>W.inspect(invalid,'workspace-one','drawing'),/cycle/);
});

test('same-byte concurrent edits deduplicate content without losing either operation',()=>{
  const pc=replica('SlopTop'),phone=replica('Poordroid');pc.edit(state=>W.appendVersion(state,version('A','a')));send(pc,phone);
  pc.edit(state=>W.appendVersion(state,version('B','b',['A'])));phone.edit(state=>W.appendVersion(state,version('C','b',['A'])));converge(pc,phone);
  assert.equal(inspect(pc).conflict,false);assert.equal(inspect(pc).heads.length,2);assert.equal(pc.state.workspaceVersions.length,3);
});

test('status distinguishes local persistence, missing bytes, per-device acknowledgements and errors',()=>{
  assert.equal(W.status().kind,'saving');
  assert.equal(W.status({localDurable:true}).kind,'pending-content');
  assert.equal(W.status({localDurable:true,available:true}).kind,'local');
  const targets={localDurable:true,available:true,requiredDevices:['SlopTop','LapDog','Poordroid']};
  assert.equal(W.status({...targets,acknowledgedDevices:['SlopTop','LapDog','Server']}).kind,'waiting');
  assert.equal(W.status({...targets,acknowledgedDevices:targets.requiredDevices}).kind,'synced');
  assert.equal(W.status({...targets,conflict:true}).kind,'conflict');
  assert.equal(W.status({...targets,error:'Disk full'}).kind,'error');
});

test('a future server can restart and catch up a returning phone while SlopTop is absent',()=>{
  const laptop=replica('LapDog');let phone=replica('Poordroid'),server=replica('Server');
  laptop.edit(state=>W.appendVersion(state,version('A','a')));converge(laptop,phone,server);
  phone=replica('Poordroid',phone.checkpoint());
  laptop.edit(state=>W.appendVersion(state,version('B','b',['A'])));send(laptop,server);
  server=replica('Server',server.checkpoint());send(server,phone);send(phone,server);
  assert.deepEqual(plain(inspect(phone).heads.map(value=>value.id)),['B']);
  assert.equal(phone.state.workspaceVersions.length,2);assert.equal(server.n,0);
  for(const value of phone.stamps.values())assert.equal(value.o,'LapDog');
});

test('a long file history does not exhaust the JavaScript call stack',()=>{
  const state={workspaceVersions:Array.from({length:12000},(_,index)=>version('v'+index,'a',index?['v'+(index-1)]:[])).reverse()};
  assert.deepEqual(plain(W.inspect(state,'workspace-one','drawing').heads.map(value=>value.id)),['v11999']);
});
