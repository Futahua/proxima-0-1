import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('./public/sync-core.js',import.meta.url),'utf8');
const context={structuredClone};vm.runInNewContext(code,context);
const S=context.ProximaSyncCore;

// A device: its data, its stamps, its clock and what it has seen.
function device(node,state,wall){
  const d={node,state:structuredClone(state),stamps:new Map(),clock:null,n:0,vv:{},wall,conflicts:[]};
  // Each stamp records what this device had seen before making the edit.
  d.next=()=>{const c={...d.vv};d.clock=S.tick(d.clock,d.wall(),node);d.n++;d.vv[node]=d.n;return {h:d.clock,o:node,n:d.n,c};};
  S.bootstrap(d.stamps,d.state,d.next);
  d.edit=change=>{const next=structuredClone(d.state);change(next);S.stampChanges(d.stamps,S.diff(d.state,next),d.next);d.state=next;};
  // An automatic change (a queue freezing when its time is up): stamped `a`, as proxima-sync does.
  d.auto=change=>{const next=structuredClone(d.state);change(next);S.stampChanges(d.stamps,S.diff(d.state,next),()=>({...d.next(),a:1}));d.state=next;};
  return d;
}
// One exchange: `from` sends what `to` has not seen; `to` merges and repairs (repairs are its own edits).
function send(from,to){
  const changes=S.changesSince(from.state,from.stamps,to.vv);
  for(const change of changes)for(const s of [change.tomb,...Object.values(change.fields)])if(s)to.clock=S.witness(to.clock,s.h);
  const merged=S.merge(to.state,to.stamps,changes);
  to.vv=S.joinVectors(to.vv,from.vv);
  if(merged.changed){const repaired=S.repair(merged.state).state;S.stampChanges(to.stamps,S.diff(merged.state,repaired),()=>({...to.next(),a:1}));to.state=repaired;}
}
const sync=(a,b)=>{send(a,b);send(b,a);send(a,b);};
const sorted=value=>Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]));
const visible=d=>JSON.stringify(Object.fromEntries([...S.recordsOf(d.state)].sort(([a],[b])=>a<b?-1:1).map(([key,record])=>[key,sorted(record)])));
const base={projects:[],tasks:[],scheduleEvents:[],importedRuns:[],run:null,
  timelineRows:[{id:'r1',name:'Study',color:'#a1cc43',rowOrder:0},{id:'r2',name:'Gym',color:'#5577aa',rowOrder:1}],
  timelineIntervals:[{id:'x',name:'Chapter 1',rowId:'r1',start:'2026-10-14T08:00:00.000Z',end:'2026-10-14T09:00:00.000Z',rev:1},
    {id:'z',name:'Warm-up',rowId:'r2',start:'2026-10-14T07:00:00.000Z',end:'2026-10-14T07:30:00.000Z',rev:1}],
  events:[{seq:1}],seq:1};

test('the island: phone and PC edit apart, and both keep everything when they meet',()=>{
  let t=1000;const pc=device('pc',base,()=>t),phone=device('phone',base,()=>t);sync(pc,phone);
  t=2000;phone.edit(s=>{s.timelineIntervals.find(x=>x.id==='x').name='Chapter 1 (done)';s.timelineIntervals.push({id:'y',name:'Chapter 2',rowId:'r1',start:'2026-10-14T10:00:00.000Z',end:'2026-10-14T11:00:00.000Z'});});
  t=2500;pc.edit(s=>{s.timelineIntervals.find(x=>x.id==='x').color='#ff0000';s.timelineIntervals=s.timelineIntervals.filter(x=>x.id!=='z');});
  sync(pc,phone);
  assert.equal(visible(pc),visible(phone));
  const x=pc.state.timelineIntervals.find(i=>i.id==='x');
  assert.equal(x.name,'Chapter 1 (done)');assert.equal(x.color,'#ff0000');
  assert.ok(pc.state.timelineIntervals.some(i=>i.id==='y'));
  assert.ok(!phone.state.timelineIntervals.some(i=>i.id==='z'));
  assert.deepEqual(pc.state.events,[{seq:1}],'the local event log is not synced');
});

test('the same field on two devices: the later edit wins, whichever arrives first',()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);
  t=3000;b.edit(s=>{s.timelineRows[0].name='Later';});t=2000;a.edit(s=>{s.timelineRows[0].name='Earlier';});
  send(b,a);send(a,b);
  assert.equal(a.state.timelineRows[0].name,'Later');assert.equal(visible(a),visible(b));
});

test('a phone whose clock is behind still orders its own edits after what it has seen',()=>{
  let pcTime=10_000,phoneTime=1_000;const pc=device('pc',base,()=>pcTime),phone=device('phone',base,()=>phoneTime);
  pc.edit(s=>{s.timelineRows[0].name='From PC';});sync(pc,phone);
  phone.edit(s=>{s.timelineRows[0].name='From phone, later';});sync(pc,phone);
  assert.equal(pc.state.timelineRows[0].name,'From phone, later');
});

test('deleting, then editing later on another device, brings the record back everywhere',()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);
  t=2000;a.edit(s=>{s.timelineIntervals=s.timelineIntervals.filter(x=>x.id!=='x');});
  t=3000;b.edit(s=>{s.timelineIntervals.find(x=>x.id==='x').name='Still needed';});
  sync(a,b);
  assert.equal(a.state.timelineIntervals.find(x=>x.id==='x')?.name,'Still needed');assert.equal(visible(a),visible(b));
  t=4000;b.edit(s=>{s.timelineIntervals=s.timelineIntervals.filter(x=>x.id!=='x');});sync(a,b);
  assert.ok(!a.state.timelineIntervals.some(x=>x.id==='x'));
});

test('a merged record gets a new local revision; the revision itself never syncs',()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);
  t=2000;b.edit(s=>{s.timelineIntervals[0].name='Renamed';s.timelineIntervals[0].rev=7;});send(b,a);
  assert.equal(a.state.timelineIntervals[0].rev,2);
});

test('nothing is resent once devices are up to date',()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);
  assert.equal(S.changesSince(a.state,a.stamps,b.vv).length,0);assert.equal(S.changesSince(b.state,b.stamps,a.vv).length,0);
});

test('repair: one live session per row, queues without deleted sessions, one row order',()=>{
  const state={...structuredClone(base),timelineRows:[{id:'r1',name:'Study',rowOrder:0,queue:{end:'2026-10-15T00:00:00.000Z',ids:['x','gone']}},{id:'r2',name:'Gym',rowOrder:0}],
    timelineIntervals:[{id:'x',rowId:'r1',start:'2026-10-14T08:00:00.000Z',end:'2026-10-14T08:00:00.001Z',followNow:true},{id:'w',rowId:'r1',start:'2026-10-14T09:00:00.000Z',end:'2026-10-14T09:00:00.001Z',followNow:true}]};
  const {state:out,notes}=S.repair(state);
  assert.equal(out.timelineIntervals.find(i=>i.id==='x').followNow,false);assert.equal(out.timelineIntervals.find(i=>i.id==='x').end,'2026-10-14T09:00:00.000Z');
  assert.equal(out.timelineIntervals.find(i=>i.id==='w').followNow,true);
  assert.deepEqual([...out.timelineRows[0].queue.ids],['x']);
  assert.deepEqual(out.timelineRows.map(r=>r.rowOrder),[0,1]);
  assert.equal(notes.length,3);
  assert.equal(S.repair(out).notes.length,0,'repaired data needs no further repair');
});

test('three devices, random edits and random meetings, always end up identical',()=>{
  let seed=7;const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  for(let round=0;round<120;round++){
    let t=1000;const devices=['pc','laptop','phone'].map(node=>device(node,base,()=>t));
    for(let i=0;i<10;i++)for(let j=0;j<10;j++)if(i!==j&&i<3&&j<3)send(devices[i],devices[j]);
    for(let step=0;step<60;step++){
      t+=Math.floor(random()*50);const d=devices[Math.floor(random()*3)],r=random();
      if(r<0.45)d.edit(s=>{const list=s.timelineIntervals;if(!list.length)return;const item=list[Math.floor(random()*list.length)];item[random()<0.5?'name':'color']='v'+step+d.node;});
      else if(r<0.6)d.edit(s=>{s.timelineIntervals.push({id:'n'+step+d.node,name:'new',rowId:random()<0.5?'r1':'r2',start:new Date(t).toISOString(),end:new Date(t+1000).toISOString(),followNow:random()<0.3});});
      else if(r<0.75)d.edit(s=>{if(s.timelineIntervals.length)s.timelineIntervals.splice(Math.floor(random()*s.timelineIntervals.length),1);});
      else if(r<0.85)d.edit(s=>{const row=s.timelineRows[Math.floor(random()*s.timelineRows.length)];row.rowOrder=Math.floor(random()*2);});
      else{const a=devices[Math.floor(random()*3)],b=devices[Math.floor(random()*3)];if(a!==b)send(a,b);}
    }
    for(let k=0;k<3;k++)for(const a of devices)for(const b of devices)if(a!==b)send(a,b);
    assert.equal(visible(devices[0]),visible(devices[1]),'round '+round);assert.equal(visible(devices[1]),visible(devices[2]),'round '+round);
    assert.equal(S.repair(devices[0].state).notes.length,0,'converged data is consistent, round '+round);
    const conflicts=d=>JSON.stringify(S.conflictsOf(d.state,d.stamps).map(c=>[c.kind,c.key,c.field||'',c.others?.length||0]).sort());
    assert.equal(conflicts(devices[0]),conflicts(devices[1]),'same open conflicts, round '+round);assert.equal(conflicts(devices[1]),conflicts(devices[2]),'same open conflicts, round '+round);
  }
});

// ── Concurrency: the holiday scenario ──
const open=d=>S.conflictsOf(d.state,d.stamps);

test('holiday: the phone keeps every offline edit; a stray PC edit to the same field becomes a conflict, not a loss',()=>{
  let t=1000;const pc=device('pc',base,()=>t),phone=device('phone',base,()=>t);sync(pc,phone);pc.conflicts=[];phone.conflicts=[];
  // On holiday, offline: many phone edits over days.
  t=2000;phone.edit(s=>{s.timelineIntervals.find(x=>x.id==='x').name='Thesis draft';s.timelineRows[0].color='#ff8800';s.timelineIntervals.push({id:'y',name:'Field notes',rowId:'r1',start:'2026-10-14T10:00:00.000Z',end:'2026-10-14T11:00:00.000Z'});});
  // Later, at home, a stray edit on the PC to the same session name.
  t=9000;pc.edit(s=>{s.timelineIntervals.find(x=>x.id==='x').name='oops';});
  sync(pc,phone);
  assert.equal(visible(pc),visible(phone),'both devices agree');
  assert.equal(pc.state.timelineIntervals.find(x=>x.id==='x').name,'oops','the later edit shows');
  assert.equal(pc.state.timelineRows[0].color,'#ff8800','an edit to another field just applies');
  assert.ok(pc.state.timelineIntervals.some(x=>x.id==='y'),'new records arrive');
  for(const d of [pc,phone]){const [c]=open(d).filter(c=>c.kind==='field');assert.equal(c.key,'timelineIntervals/x');assert.equal(c.field,'name');assert.equal(c.shown.v,'oops');assert.equal(c.others[0].v,'Thesis draft','the phone value is kept, not lost');}
});

test('holiday: a stray delete on the PC does not erase a record the phone edited offline',()=>{
  let t=1000;const pc=device('pc',base,()=>t),phone=device('phone',base,()=>t);sync(pc,phone);pc.conflicts=[];phone.conflicts=[];
  t=2000;phone.edit(s=>{s.timelineIntervals.find(x=>x.id==='z').name='Warm-up, then stretch';});
  t=9000;pc.edit(s=>{s.timelineIntervals=s.timelineIntervals.filter(x=>x.id!=='z');});
  sync(pc,phone);
  assert.equal(visible(pc),visible(phone));
  assert.equal(pc.state.timelineIntervals.find(x=>x.id==='z')?.name,'Warm-up, then stretch','the unseen delete loses to the edit');
  assert.ok(open(pc).some(c=>c.kind==='delete'&&c.key==='timelineIntervals/z'),'the delete is offered for confirmation');
});

test('a delete made after seeing every edit still deletes, with no conflict',()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);a.conflicts=[];b.conflicts=[];
  t=2000;b.edit(s=>{s.timelineIntervals.find(x=>x.id==='z').name='edited';});sync(a,b);
  t=3000;a.edit(s=>{s.timelineIntervals=s.timelineIntervals.filter(x=>x.id!=='z');});sync(a,b);
  assert.ok(!b.state.timelineIntervals.some(x=>x.id==='z'));assert.equal(open(a).length+open(b).length,0);
});

test('one-after-another edits never conflict, even with a phone clock far behind',()=>{
  let pcTime=10_000,phoneTime=1_000;const pc=device('pc',base,()=>pcTime),phone=device('phone',base,()=>phoneTime);sync(pc,phone);pc.conflicts=[];phone.conflicts=[];
  pc.edit(s=>{s.timelineRows[0].name='A';});sync(pc,phone);phone.edit(s=>{s.timelineRows[0].name='B';});sync(pc,phone);pc.edit(s=>{s.timelineRows[0].name='C';});sync(pc,phone);
  assert.equal(phone.state.timelineRows[0].name,'C');assert.equal(open(pc).length+open(phone).length,0);
});

test('choosing a side settles the conflict on every device, either way',()=>{
  for(const pick of ['other','shown']){
    let t=1000;const pc=device('pc',base,()=>t),phone=device('phone',base,()=>t);sync(pc,phone);pc.conflicts=[];phone.conflicts=[];
    t=2000;phone.edit(s=>{s.timelineRows[0].name='Phone name';});t=3000;pc.edit(s=>{s.timelineRows[0].name='PC name';});sync(pc,phone);
    const [c]=open(phone);const chosen=pick==='shown'?c.shown.v:c.others[0].v;t=4000;
    // Resolving restamps the field with everything this device has seen, even when the value stays.
    phone.edit(s=>{s.timelineRows[0].name=chosen;});phone.stamps.set(c.key+'#'+c.field,phone.next());
    sync(pc,phone);
    assert.equal(pc.state.timelineRows[0].name,chosen,pick);assert.equal(open(pc).length,0,pick+' settled on the PC');assert.equal(open(phone).length,0,pick+' settled on the phone');
  }
});

test("a session's copy of its row order stays on each device",()=>{
  let t=1000;const a=device('a',base,()=>t),b=device('b',base,()=>t);sync(a,b);
  t=2000;a.edit(s=>{s.timelineIntervals[0].rowOrder=7;});
  assert.equal(S.changesSince(a.state,a.stamps,b.vv).length,0,'nothing to send');
  t=3000;b.edit(s=>{s.timelineIntervals[0].name='renamed';});send(b,a);
  assert.equal(a.state.timelineIntervals[0].rowOrder,7,'a merge keeps the local copy');
});

test('a device opened late redoes an automatic change from its old copy: the creator\'s edit shows, nothing to choose', () => {
  let t = 1000; const pc = device('pc', base, () => t), lap = device('lap', base, () => t); sync(pc, lap);
  t = 2000; pc.edit(s => { s.timelineIntervals.find(x => x.id === 'x').end = '2026-10-14T08:38:00.000Z'; });
  t = 3000; lap.auto(s => { s.timelineIntervals.find(x => x.id === 'x').end = '2026-10-14T09:04:00.000Z'; });
  sync(lap, pc);
  assert.equal(visible(pc), visible(lap));
  assert.equal(pc.state.timelineIntervals.find(x => x.id === 'x').end, '2026-10-14T08:38:00.000Z');
  assert.deepEqual([S.conflictsOf(pc.state, pc.stamps).length, S.conflictsOf(lap.state, lap.stamps).length], [0, 0]);
});
test('two devices both doing the same automatic change at different times: the later shows, nothing to choose', () => {
  let t = 1000; const pc = device('pc', base, () => t), lap = device('lap', base, () => t); sync(pc, lap);
  t = 2000; pc.auto(s => { const x = s.timelineIntervals.find(i => i.id === 'x'); x.start = '2026-10-14T08:38:00.000Z'; });
  t = 3000; lap.auto(s => { const x = s.timelineIntervals.find(i => i.id === 'x'); x.start = '2026-10-14T09:04:00.000Z'; });
  sync(pc, lap);
  assert.equal(visible(pc), visible(lap));
  assert.equal(lap.state.timelineIntervals.find(x => x.id === 'x').start, '2026-10-14T09:04:00.000Z');
  assert.deepEqual([S.conflictsOf(pc.state, pc.stamps).length, S.conflictsOf(lap.state, lap.stamps).length], [0, 0]);
});
test('an automatic delete that missed an edit keeps the record without asking', () => {
  let t = 1000; const pc = device('pc', base, () => t), lap = device('lap', base, () => t); sync(pc, lap);
  t = 2000; pc.edit(s => { s.timelineIntervals.find(x => x.id === 'z').name = 'Stretch'; });
  t = 3000; lap.auto(s => { s.timelineIntervals = s.timelineIntervals.filter(x => x.id !== 'z'); });
  sync(pc, lap);
  assert.equal(visible(pc), visible(lap));
  assert.equal(pc.state.timelineIntervals.find(x => x.id === 'z')?.name, 'Stretch');
  assert.deepEqual([S.conflictsOf(pc.state, pc.stamps).length, S.conflictsOf(lap.state, lap.stamps).length], [0, 0]);
});
test('two of the creator\'s own edits still ask, even next to an automatic one', () => {
  let t = 1000; const pc = device('pc', base, () => t), lap = device('lap', base, () => t), phone = device('phone', base, () => t); sync(pc, lap); sync(lap, phone); sync(pc, phone);
  t = 2000; pc.edit(s => { s.timelineIntervals.find(x => x.id === 'x').name = 'From PC'; });
  t = 2500; phone.edit(s => { s.timelineIntervals.find(x => x.id === 'x').name = 'From phone'; });
  t = 3000; lap.auto(s => { s.timelineIntervals.find(x => x.id === 'x').name = 'Automatic'; });
  for (let i = 0; i < 2; i++) { sync(pc, lap); sync(lap, phone); sync(pc, phone); }
  assert.equal(visible(pc), visible(phone)); assert.equal(visible(pc), visible(lap));
  assert.equal(pc.state.timelineIntervals.find(x => x.id === 'x').name, 'From phone');
  const conflicts = S.conflictsOf(lap.state, lap.stamps);
  assert.equal(conflicts.length, 1);
  assert.equal(JSON.stringify(conflicts[0].others.map(o => o.v)), JSON.stringify(['From PC']));
});
