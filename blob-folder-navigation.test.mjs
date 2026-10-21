import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const source=await readFile(new URL('./public/blob-workspaces.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
 const listeners=new Map(),frames=[],timers=new Map();let serial=0,finishTemplate,templateRequests=0;
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.hidden=false;this.classList={add(){},remove(){}};if(tag==='iframe'){this.sent=[];this.contentWindow={postMessage:value=>this.sent.push(value)};frames.push(this);}}
  append(...nodes){this.children.push(...nodes);}prepend(node){this.children.unshift(node);}setAttribute(){}addEventListener(){}
  querySelector(selector){return selector==='.blob-workspace-note'?this.children.find(x=>x.className==='blob-workspace-note')||null:null;}
 }
 const document={createElement:tag=>new Element(tag),body:new Element('body'),querySelectorAll:()=>[],addEventListener(){}};
 const items=['a','b','c'].map(id=>({id,name:id,template:{kind:'as-you-go',version:2,folderId:'folder-'+id}}));
 const template=new Promise(resolve=>{finishTemplate=()=>resolve({template:{url:'https://example.test/ayg/index.html'}});});
 const context=vm.createContext({document,crypto:webcrypto,URL,console,location:{href:'https://example.test/proxima/index.html',origin:'https://example.test'},
  setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},
  addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
  Store:{timelineIntervals:()=>items,command:async()=>({ok:true})},
  ProximaWorkspaces:{errors:new Map(),folders:async()=>Object.fromEntries(items.map(x=>[x.template.folderId,{exists:true}])),ensureFolder:async()=>({exists:true}),status:async()=>({label:'Saved',kind:'local'}),conflicts:async()=>[],request:()=>{templateRequests++;return template;},flush:async()=>{}}
 });
 vm.runInContext(source,context);
 const message=value=>{for(const fn of listeners.get('message')||[])fn({source:frames[0].contentWindow,origin:'https://example.test',data:{workspaceId:'ayg-root',...value}});};
 return {api:context.ProximaBlobWorkspaces,frames,timers,finishTemplate,message,get templateRequests(){return templateRequests;}};
}

test('prewarming prepares the template without a hidden frame; opening waits for its folder acknowledgement',async()=>{
 const f=fixture();await tick();f.api.prewarm();assert.equal(f.frames.length,0);const opening=f.api.open('b');await tick();assert.equal(f.templateRequests,1);
 f.finishTemplate();await tick();assert.equal(f.frames.length,1);const frame=f.frames[0];assert.equal(frame.style.pointerEvents,'none');
 let done=false;opening.then(()=>{done=true;});f.message({type:'proxima:workspace:ready',folderId:'folder-a',navigationProtocol:1});await tick();
 const request=frame.sent.at(-1);assert.equal(request.folderId,'folder-b');assert.equal(done,false);
 f.message({type:'proxima:workspace:folder-opened',folderId:'folder-a',requestId:request.requestId});await tick();assert.equal(done,false);
 f.message({type:'proxima:workspace:folder-opened',folderId:'folder-b',requestId:'stale-request'});await tick();assert.equal(done,false);
 f.message({type:'proxima:workspace:folder-opened',folderId:'folder-b',requestId:request.requestId});await opening;assert.equal(frame.style.pointerEvents,'');
});

test('rapid blob switches ignore the previous acknowledgement and keep one frame',async()=>{
 const f=fixture();await tick();f.finishTemplate();const first=f.api.open('a');await tick();const frame=f.frames[0];f.message({type:'proxima:workspace:ready',folderId:'folder-a',navigationProtocol:1});await tick();let request=frame.sent.at(-1);f.message({type:'proxima:workspace:folder-opened',folderId:'folder-a',requestId:request.requestId});await first;
 const b=f.api.open('b');await tick();const old=frame.sent.at(-1);const c=f.api.open('c');await tick();request=frame.sent.at(-1);assert.equal(request.folderId,'folder-c');
 let done=false;c.then(()=>{done=true;});f.message({type:'proxima:workspace:folder-opened',folderId:'folder-b',requestId:old.requestId});await tick();assert.equal(done,false);
 f.message({type:'proxima:workspace:folder-opened',folderId:'folder-c',requestId:request.requestId});await Promise.all([b,c]);assert.equal(f.frames.length,1);assert.equal(frame.title,'c · As you Go');
});
