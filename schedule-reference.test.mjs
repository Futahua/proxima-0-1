import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context=vm.createContext({window:{}});
vm.runInContext(await readFile(new URL('./public/schedule-fixture.js',import.meta.url),'utf8'),context);
vm.runInContext(await readFile(new URL('./public/schedule-projection.js',import.meta.url),'utf8'),context);
const events=context.window.PROXIMA_SCHEDULE_FIXTURE.events;
const byKey=suffix=>events.find(e=>e.sourceKey.endsWith(suffix));
const local=date=>new Date(new Date(date).getTime()+7*3600000).toISOString();
test('registered sociology class is Wednesday/Saturday morning with the correct room and teacher',()=>{
 const regular=byKey('gnctm'),extra=byKey('jxpzs');
 assert.equal(local(regular.start),'2026-10-28T06:55:00.000Z');
 assert.equal(local(regular.deadline),'2026-10-28T09:20:00.000Z');
 assert.equal(local(extra.start),'2026-12-12T06:55:00.000Z');
 for(const event of [regular,extra]) {assert.match(event.note,/CT4103_24ĐH 3/);assert.match(event.note,/Phan Minh Tuấn/);assert.match(event.note,/M-M13.06/);assert.equal(event.until,'2026-12-20');}
});
test('methodology is Wednesday and Saturday, matching the registration table',()=>{
 assert.equal(new Date(local(byKey('r25mw').start)).getUTCDay(),3);
 assert.equal(new Date(local(byKey('37q7j').start)).getUTCDay(),6);
 assert.equal(local(byKey('r25mw').start).slice(11,16),'14:40');
 assert.equal(local(byKey('r25mw').deadline).slice(11,16),'17:05');
});
test('Saturday construction and Friday planning continue through their source end dates',()=>{
 assert.equal(byKey('gdbpm').until,'2026-11-22');
 assert.equal(byKey('c5vfg').until,'2026-10-11');
 const event=byKey('gdbpm');
 const occurrences=context.ProximaScheduleProjection.occurrences({...event,recurrence:{frequency:'weekly',interval:1,until:event.until}}, {start:new Date('2026-11-16'),end:new Date('2026-11-23')});
 assert.equal(occurrences.length,1);
 assert.equal(local(occurrences[0].start).slice(0,10),'2026-11-21');
});
test('imported period ranges match the supplied bell chart',()=>{
 const times={'1-3':['06:55','09:20'],'4-6':['09:30','11:55'],'7-9':['12:05','14:30'],'8-12':['12:55','17:05'],'10-12':['14:40','17:05']};
 for(const event of events){const range=event.note.match(/tiết ([0-9-]+)/)?.[1]; if(!times[range])continue;assert.deepEqual([local(event.start).slice(11,16),local(event.deadline).slice(11,16)],times[range],event.name);}
});
