import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./public/exact-timeline.js',import.meta.url),'utf8');
function handler(prefix){const line=source.split('\n').find(x=>x.includes(prefix));return '(function()'+line.slice(line.indexOf('event=>')+7,line.lastIndexOf(',true)'))+')()';}
test('RMB claims marquee before descendants and context menu cannot interrupt before first move',()=>{
 let started=0,prevented=0,stopped=0;
 const context=vm.createContext({event:{button:2,target:{closest:()=>null},pointerId:4,clientX:20,clientY:30,preventDefault(){prevented++},stopImmediatePropagation(){stopped++}},marqueeController:{start(){started++},isActive:()=>true},marqueeStartX:0,subtract:false,appendMarquee:false,contactMarquee:false,lastMarqueePointer:null});
 vm.runInContext(handler("if(event.button!==2||event.target.closest"),context);
 assert.equal(started,1);assert.equal(prevented,1);assert.equal(stopped,1);
 vm.runInContext(handler("element.addEventListener('contextmenu',event=>{if(!lastMarqueePointer"),context);
 assert.equal(prevented,2);assert.equal(stopped,2);
});
test('left drag does not start marquee',()=>{
 let started=0;const context=vm.createContext({event:{button:0},marqueeController:{start(){started++}}});
 vm.runInContext(handler("if(event.button!==2||event.target.closest"),context);assert.equal(started,0);
});
