import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./public/workspace-runtime.js',import.meta.url),'utf8');
test('originating pane receives the canonical managed targets after an import',async()=>{
 let state={shortcuts:[]},revision=1;
 const replica={load:async()=>({state:structuredClone(state),revision:String(revision),entryRevision:'entries'}),importFile:async(w,path,name,id)=>({workspaceFileId:id,target:'/managed/'+id+'/'+name}),save:async(w,doc)=>{state=structuredClone(doc);return {ok:true,revision:String(++revision)}},history:async()=>({deleted:false})};
 const c=vm.createContext({location:{href:'https://fixture/'},URL,structuredClone,navigator:{userAgent:''},document:{addEventListener(){}},addEventListener(){},setInterval(){},clearInterval(){},BroadcastChannel:class{addEventListener(){}},ProximaWorkspaceReplica:{create:()=>replica},__proximaWorkspaceNative:async(op,d)=>{assert.equal(op,'workspace-files');return {kind:'file',name:'photo.jpg'}}});
 vm.runInContext(code,c);
 const result=await c.ProximaWorkspaces.frameCall('ayg-root','save',[{shortcuts:[{id:'one',name:'photo.jpg',target:'/picked/photo.jpg',placements:[{parentId:'folder'}]}]},'1']);
 assert.equal(result.ok,true);
 const accepted=JSON.parse(result.serialized);
 assert.equal(accepted.shortcuts[0].target,'/managed/one/photo.jpg');
 assert.equal(accepted.shortcuts[0].workspaceFileId,'one');
 assert.equal(result.revision,'2');
});
