import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const text=await readFile(new URL('./public/exact-timeline.js',import.meta.url),'utf8');
test('a cursor drag ignores the real L-button finger, including its release',()=>{
 const listeners=new Map(),removed=[],session={id:'fixture',start:'2026-10-15T00:00:00Z',end:'2026-10-15T01:00:00Z'},bar={interval:session,style:{top:'20'},setPointerCapture(){}},preview={className:'',hidden:true};
 const c=vm.createContext({selected:new Set(),items:()=>[session],allItems:()=>[session],selectionPayload:()=>({intervalIds:[],revisions:{}}),inlineEditor:null,closeColor(){},clockNow:()=>0,bars:new Map([[session.id,bar]]),outsideNames:new Map(),document:{createElement:()=>preview},tracks:{append(){}},window:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>removed.push(k)},performance:{now:()=>0},queuePoint:()=>{throw Error('own pointer reached drag geometry');}});
 const a=text.indexOf('  function beginReorder'),b=text.indexOf('  let colorPicker',a);vm.runInContext(text.slice(a,b)+';globalThis.begin=beginReorder;',c);
 c.begin({button:0,pointerId:9001,clientX:200,clientY:200,target:{closest:()=>false}},bar);
 for(const type of ['pointermove','pointerup','pointercancel'])listeners.get(type)({type,pointerId:4,clientX:30,clientY:800});
 assert.deepEqual(removed,[]);assert.equal(bar.style.top,'20');
 assert.throws(()=>listeners.get('pointermove')({pointerId:9001,clientX:220,clientY:200}),/own pointer/);
});
