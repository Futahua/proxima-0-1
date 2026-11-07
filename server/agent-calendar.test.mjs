import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngine } from './dist/main.mjs';
import { createCalendar } from './dist/calendar.mjs';
import { createAgentCalendar } from './dist/agent-calendar.mjs';

async function fixture(work){const root=await mkdtemp(path.join(tmpdir(),'proxima-agent-'));const engine=await createEngine(root);const calendar=await createCalendar(engine);const owner=await createAgentCalendar(calendar,root,{});try{await work({engine,calendar,owner,root});}finally{await engine.flush();await rm(root,{recursive:true,force:true});}}
const create=name=>({type:'timeline-interval.create',payload:{name,start:'2026-11-01T00:00:00Z',end:'2026-11-01T01:00:00Z'}});

test('preview persists no facts; invalid later batch step rolls back every earlier command',()=>fixture(async({calendar,owner})=>{
  const initial=await calendar();
  const p=await owner.preview({commands:[create('Preview')]});assert(p.preview_id);
  assert.equal((await calendar()).state.seq,initial.state.seq);
  assert.equal((await calendar()).state.timelineIntervals.length,0);
  const refused=await owner.preview({commands:[create('First'),{type:'task.create',payload:{}}]});
  assert.equal(refused.ok,false);assert.equal((await calendar()).state.timelineIntervals.length,0);
}));

test('batch replay after lost receipt creates one object; owner catalogue and projection are real',()=>fixture(async({calendar,owner,root})=>{
  const p=await owner.preview({commands:[create('Actual')]});const r=await owner.apply(p.preview_id);assert(r.applied);
  assert.equal((await owner.apply(p.preview_id)).receipt_id,r.receipt_id);
  await unlink(path.join(root,'agent-workflows',p.preview_id+'.receipt.json'));
  assert.equal((await owner.apply(p.preview_id)).results[0].replayed,true);
  const state=await calendar(null,{catalog:true});assert.equal(state.state.timelineIntervals.length,1);assert(state.catalog.some(x=>x.type==='task.create'));
  assert.equal(state.projection.timeline[0].name,'Actual');
}));

test('referenced project/task creation is atomic; targeted reversal protects new human dependants',()=>fixture(async({calendar,owner})=>{
  const p=await owner.preview({commands:[{type:'project.create',payload:{name:'Agent project'}},{type:'task.create',payload:{name:'Agent task',project:{$ref:'0.value.id'}}}]});
  const r=await owner.apply(p.preview_id);assert(r.applied);const project=r.results[0].value.id,task=r.results[1].value.id;
  assert.equal((await calendar()).state.tasks.find(x=>x.id===task).project,project);
  const cannot=await owner.preview({commands:[{type:'history.revert',payload:{commandId:r.undo_command_ids[0]}}]});assert.equal(cannot.ok,false);
  const reverseTask=await owner.preview({commands:[{type:'history.revert',payload:{commandId:r.undo_command_ids[1]}}]});assert(reverseTask.preview_id);await owner.apply(reverseTask.preview_id);
  assert.equal((await calendar()).state.tasks.length,0);
  const state=(await calendar()).state;await calendar({type:'task.create',payload:{name:'Human task',project},commandId:'human-dependent',expectedSeq:state.seq});
  assert.equal((await owner.preview({commands:[{type:'history.revert',payload:{commandId:r.undo_command_ids[0]}}]})).ok,false);
}));

test('targeted reversal preserves unrelated human changes and refuses an intervening edit',()=>fixture(async({calendar,owner})=>{
  const made=await owner.apply((await owner.preview({commands:[create('Original')]})).preview_id);const id=made.results[0].value.id;
  const changed=await owner.apply((await owner.preview({commands:[{type:'timeline-interval.patch',payload:{intervalId:id,patch:{name:'Agent change'}}}]})).preview_id);
  const state=(await calendar()).state;
  await calendar({...create('Human other'),commandId:'human-other',expectedSeq:state.seq});
  const revert=await owner.preview({commands:[{type:'history.revert',payload:{commandId:changed.undo_command_ids[0]}}]});assert(revert.preview_id);
  await owner.apply(revert.preview_id);
  const after=(await calendar()).state;assert.equal(after.timelineIntervals.find(x=>x.id===id).name,'Original');assert(after.timelineIntervals.some(x=>x.name==='Human other'));
  const p=await owner.preview({commands:[{type:'timeline-interval.patch',payload:{intervalId:id,patch:{name:'Second agent'}}}]});const second=await owner.apply(p.preview_id);
  const current=(await calendar()).state;
  await calendar({type:'timeline-interval.patch',payload:{intervalId:id,patch:{name:'Human latest'}},commandId:'human-latest',expectedSeq:current.seq});
  const blocked=await owner.preview({commands:[{type:'history.revert',payload:{commandId:second.undo_command_ids[0]}}]});assert.equal(blocked.ok,false);
  assert.equal((await calendar()).state.timelineIntervals.find(x=>x.id===id).name,'Human latest');
}));
