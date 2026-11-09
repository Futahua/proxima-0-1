import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./public/appflowy-workspace.js',import.meta.url),'utf8');
test('native Flow resumes from Task without reopening its page or native window',async()=>{
 const calls=[],binding={documentId:'doc',appflowyWorkspaceId:'11111111-1111-1111-1111-111111111111',appflowyPageId:'22222222-2222-2222-2222-222222222222'};
 const pane={hidden:false,querySelector:()=>({hidden:true,textContent:''})};
 const body={append(n){n.parentElement=this;n.isConnected=true;},closest:()=>pane};
 const surface=()=>({hidden:true,isConnected:true,parentElement:null,closest:()=>pane,querySelector:()=>null,replaceChildren(){},getBoundingClientRect:()=>({x:0,y:0,width:600,height:700})});
 const document={hidden:false,createElement:surface,addEventListener(){}};
 const cache={doc:{documentId:'doc',workspaceId:binding.appflowyWorkspaceId,viewId:binding.appflowyPageId}};
 const context=vm.createContext({document,location:{protocol:'papers-backpack:'},window:{},localStorage:{getItem:()=>JSON.stringify(cache),setItem(){}},console,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),ResizeObserver:class{observe(){}},MutationObserver:class{observe(){}},addEventListener(){},ProximaWorkspaces:{call:async(op,args)=>{calls.push({op,args});return {ok:true};}}});vm.runInContext(code,context);
 const flow=context.ProximaFullAppFlowy;await flow.open(binding,body,'Blob','blob');await new Promise(r=>setTimeout(r,0));assert.equal(calls.filter(x=>x.op==='program-window-open').length,1);
 await flow.suspend();flow.setModalBlocked(false);await new Promise(r=>setTimeout(r,0));assert.equal(calls.at(-1).args.visible,false);await flow.open(binding,body,'Blob','blob');assert.equal(calls.filter(x=>x.op==='program-window-open').length,1);assert.deepEqual(calls.filter(x=>x.op==='program-window-visible').map(x=>x.args.visible),[false,true]);assert.equal(calls.some(x=>x.op==='browser-open'),false);
});

test('collapsing the pane parks hosted Flow and restores the same browser session',async()=>{
 const calls=[],binding={documentId:'doc',appflowyWorkspaceId:'11111111-1111-1111-1111-111111111111',appflowyPageId:'22222222-2222-2222-2222-222222222222'};
 let observer;
 const pane={hidden:false,querySelector:()=>({hidden:true,textContent:''})};
 const body={append(n){n.parentElement=this;n.isConnected=true;},closest:()=>pane};
 const surface=()=>({hidden:true,isConnected:true,parentElement:null,closest:()=>pane,querySelector:()=>null,replaceChildren(){},getBoundingClientRect:()=>({x:300,y:100,width:600,height:700})});
 const context=vm.createContext({document:{hidden:false,createElement:surface,addEventListener(){}},location:{protocol:'papers-backpack:'},window:{},localStorage:{getItem:()=>null,setItem(){}},console:{warn(){}},setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),ResizeObserver:class{observe(){}},MutationObserver:class{constructor(fn){observer=fn;}observe(){}},addEventListener(){},ProximaWorkspaces:{call:async(op,args)=>{
  calls.push({op,args});
  if(op==='program-window-open')return {ok:false,code:'PROGRAM_WINDOWS_UNAVAILABLE'};
  if(op==='browser-open')return {ok:true,sessionId:'same-session'};
  return {ok:true};
 }}});
 vm.runInContext(code,context);
 const flow=context.ProximaFullAppFlowy;
 await flow.open(binding,body,'Blob','blob');
 await flow.suspend();
 pane.hidden=true;
 observer();
 pane.hidden=false;
 await flow.open(binding,body,'Blob','blob');
 assert.equal(calls.filter(x=>x.op==='browser-open').length,1);
 assert.equal(calls.some(x=>x.op==='browser-close'),false);
 assert.deepEqual(calls.filter(x=>x.op==='browser-move').map(x=>[x.args.sessionId,x.args.rect.x]),[['same-session',-632],['same-session',300]]);
});

