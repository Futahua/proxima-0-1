import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const code=await readFile(new URL('./public/flow-embed-bridge.js',import.meta.url),'utf8');
const context=vm.createContext({console,setTimeout,clearTimeout,Promise});
vm.runInContext(code,context);
const {create,WORKSPACE}=context.ProximaFlowEmbedBridge;

function memoryStorage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),map};}
function harness({entries={},download=async()=>{},receive=async()=>{}}={}){
 let ids=0,revisions=0,request={ok:true,imports:[],wants:[]};const published=[],received=[],downloads=[],documents=new Map();
 const workspaces={
  receiveFile:async(...args)=>{received.push(args);await receive(...args);},
  entry:async(workspaceId,entryId)=>entries[entryId]??null,
  frameCall:async(workspaceId,method,args)=>{downloads.push(args[1].targetId);return download(args[1].targetId);},
  // Same check as the replica's document store: a save must name the current revision.
  readDocument:async id=>({content:documents.get(id)?.content??null,revision:documents.get(id)?.revision??null,conflicts:[]}),
  saveDocument:async(id,content,revision)=>{const current=documents.get(id);if((current?.revision??null)!==revision)return {ok:false,code:'DOCUMENT_CHANGED',content:current?.content??null,revision:current?.revision??null,conflicts:[]};const next={content:JSON.parse(JSON.stringify(content)),revision:'rev'+(++revisions)};documents.set(id,next);return {ok:true,...next,conflicts:[]};},
 };
 const storage=memoryStorage();
 const make=()=>create({workspaces,storage,device:async()=>'SlopTop',uuid:()=>'id'+(++ids),exchange:async detail=>{if(detail.action==='take')return request;published.push(JSON.parse(JSON.stringify(detail.resolutions)));return {ok:true};}});
 return {set:value=>{request={ok:true,imports:[],wants:[],...value};},published,received,downloads,storage,documents,make,last:()=>published.at(-1)};
}
const entry=(over={})=>({item:{workspaceFilename:'quiz.html',name:'quiz.html',target:'D:\\Data\\Workspace files\\flow-embeds\\entries\\e1\\quiz.html',workspaceAvailability:'local',...over.item},history:{deleted:false,conflict:false,...over.history}});

test('overlapping phone batches retain every requested file in their own reply',async()=>{
 let release,started;
 const gate=new Promise(r=>release=r),waiting=new Promise(r=>started=r);
 const bridge=create({device:async()=>'Phone',exchange:async()=>({ok:true}),workspaces:{
  entry:async(_workspace,id)=>{if(id==='b'){started();await gate;}return entry({item:{target:id}});},
 }});
 const first=bridge.answer({wants:['a','b'].map(entryId=>({workspaceId:WORKSPACE,entryId}))});
 await waiting;
 const second=await bridge.answer({wants:[{workspaceId:WORKSPACE,entryId:'c'}]});
 release();
 const answer=await first;
 assert.deepEqual(Object.keys(answer.files).sort(),['flow-embeds/a','flow-embeds/b']);
 assert.deepEqual(Object.keys(second.files),['flow-embeds/c']);
});

test('imports a local file once into the flow-embeds workspace and answers with a stable reference',async()=>{
 const h=harness(),bridge=h.make();
 h.set({imports:[{requestId:'r1',path:'D:\\sort\\My-Hoc-Quiz.html'}]});
 await bridge.tick();await bridge.tick();
 assert.equal(h.received.length,1);
 assert.deepEqual(h.received[0].slice(0,4),[WORKSPACE,'D:\\sort\\My-Hoc-Quiz.html','My-Hoc-Quiz.html','root']);
 assert.deepEqual(h.last().imports.r1,{ok:true,workspaceId:WORKSPACE,entryId:'r1',name:'My-Hoc-Quiz.html',origin:'SlopTop'});
 assert.equal(h.last().device,'SlopTop');
});

test('a reloaded page does not import a still-pending request twice, and forgets collected answers',async()=>{
 const h=harness();
 h.set({imports:[{requestId:'r1',path:'D:\\a.pdf'}]});
 await h.make().tick();
 await h.make().tick();
 assert.equal(h.received.length,1);
 h.set({imports:[]});await h.make().tick();
 assert.deepEqual(JSON.parse(h.storage.getItem('proxima.flow.embed-imports.v1')),{});
});

test('an import failure is reported to Flow instead of thrown',async()=>{
 const h=harness({receive:async()=>{throw new Error('Choose a regular file.');}}),bridge=h.make();
 h.set({imports:[{requestId:'r1',path:'D:\\folder'}]});
 await bridge.tick();
 assert.deepEqual(h.last().imports.r1,{ok:false,message:'Choose a regular file.'});
});

test('resolves local, conflicting, deleted and unsynced entries',async()=>{
 const h=harness({entries:{
  e1:entry(),
  e2:entry({history:{conflict:true}}),
  e3:entry({history:{deleted:true}}),
 }}),bridge=h.make();
 h.set({wants:['e1','e2','e3','e4'].map(entryId=>({workspaceId:WORKSPACE,entryId,retry:0}))});
 await bridge.tick();
 const files=h.last().files;
 assert.equal(files['flow-embeds/e1'].status,'ready');
 assert.equal(files['flow-embeds/e1'].path,'D:\\Data\\Workspace files\\flow-embeds\\entries\\e1\\quiz.html');
 assert.equal(files['flow-embeds/e2'].status,'conflict');
 assert.ok(files['flow-embeds/e2'].path);
 assert.equal(files['flow-embeds/e3'].status,'deleted');
 assert.equal(files['flow-embeds/e4'].status,'missing');
});

test('a missing local copy downloads through the existing path, then waits, and retries on request',async()=>{
 let fail=true;
 const h=harness({entries:{e1:entry({item:{workspaceAvailability:'pending'}})},download:async()=>{if(fail)throw new Error('No connected device has this file. Its folder entry is kept.');}}),bridge=h.make();
 h.set({wants:[{workspaceId:WORKSPACE,entryId:'e1',retry:0}]});
 await bridge.tick();
 assert.equal(h.last().files['flow-embeds/e1'].status,'downloading');
 await new Promise(resolve=>setTimeout(resolve,0));
 await bridge.tick();
 assert.equal(h.last().files['flow-embeds/e1'].status,'waiting');
 assert.match(h.last().files['flow-embeds/e1'].message,/No connected device/);
 assert.equal(h.downloads.length,1,'no new attempt without a retry');
 h.set({wants:[{workspaceId:WORKSPACE,entryId:'e1',retry:1}]});
 await bridge.tick();
 assert.equal(h.downloads.length,2);
 assert.equal(h.last().files['flow-embeds/e1'].retry,1);
});

test('entries Flow no longer shows are dropped from the answers',async()=>{
 const h=harness({entries:{e1:entry()}}),bridge=h.make();
 h.set({wants:[{workspaceId:WORKSPACE,entryId:'e1',retry:0}]});await bridge.tick();
 h.set({wants:[]});await bridge.tick();
 assert.deepEqual(h.last().files,{});
});

test('two pages sharing storage import a pending request only once',async()=>{
 const h=harness();
 h.set({imports:[{requestId:'r1',path:'D:\a.pdf'}]});
 const first=h.make(),second=h.make();
 await first.tick();await second.tick();await first.tick();
 assert.equal(h.received.length,1);
});

test('only the page holding the leader lock answers Flow',async()=>{
 const takes=[];let holder=null;const waiting=[];
 const locks={request:(name,fn)=>{if(holder){waiting.push(fn);return new Promise(()=>{});}holder=fn;return fn();}};
 const page=id=>{
  const ctx=vm.createContext({console,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},addEventListener:()=>{},Promise,URL,
   location:{protocol:'papers-backpack:',href:'papers-backpack://proxima/index.html'},navigator:{locks},localStorage:memoryStorage(),
   ProximaWorkspaces:{call:async(op,detail)=>{takes.push(id+':'+detail.action);return detail.action==='take'?{ok:true,imports:[],wants:[]}:{ok:true};}}});
  vm.runInContext(code,ctx);
 };
 page('A');page('B');
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(takes.includes('A:take'));
 assert.ok(!takes.some(t=>t.startsWith('B:')),'the second page waits for the lock');
 assert.equal(waiting.length,1);
});

test('lost receipt after import commit replays the same managed entry identity',async()=>{
 const owned=new Set(),h=harness({receive:async(_workspace,_path,_name,_parent,entryId)=>owned.add(entryId)});
 h.storage.setItem=()=>{throw Error('Receipt unavailable');};
 h.set({imports:[{requestId:'replayed-request',path:'D:\\a.pdf'}]});
 await h.make().tick();await h.make().tick();
 assert.equal(h.received.length,2);
 assert.deepEqual(h.received.map(args=>args[4]),['replayed-request','replayed-request']);
 assert.equal(owned.size,1);
 assert.equal(h.last().imports['replayed-request'].entryId,'replayed-request');
});

test('invalid import identity is refused before touching managed files',async()=>{
 const h=harness();h.set({imports:[{requestId:'../bad',path:'D:\\a.pdf'}]});await h.make().tick();
 assert.equal(h.received.length,0);assert.equal(h.last().imports['../bad'].ok,false);
});
test('interactive embeds load and save their data through the checked document store',async()=>{
 const h=harness(),bridge=h.make();
 h.set({docs:[{requestId:'q1',op:'load',documentId:'flow-embed.e1'}]});
 await bridge.tick();
 assert.deepEqual(h.last().docs.q1,{ok:true,content:null,revision:null});
 h.set({docs:[{requestId:'q2',op:'save',documentId:'flow-embed.e1',content:{answers:[1,2]},revision:null}]});
 await bridge.tick();
 assert.equal(h.last().docs.q2.ok,true);
 const revision=h.last().docs.q2.revision;
 assert.deepEqual(h.documents.get('flow-embed.e1').content,{answers:[1,2]});
 h.set({docs:[{requestId:'q3',op:'save',documentId:'flow-embed.e1',content:{answers:[9]},revision:'stale'}]});
 await bridge.tick();
 assert.deepEqual(h.last().docs.q3,{ok:false,code:'DOCUMENT_CHANGED',content:{answers:[1,2]},revision,message:'This was saved from another device first.'});
});

test('a save retried after it already landed is reported as saved, not as a conflict',async()=>{
 const h=harness();
 const save={requestId:'q1',op:'save',documentId:'flow-embed.e1',content:{n:1},revision:null};
 h.set({docs:[save]});
 await h.make().tick();
 await h.make().tick();
 assert.equal(h.last().docs.q1.ok,true);
 assert.deepEqual(h.documents.get('flow-embed.e1').content,{n:1});
});

test('answer() serves one batch directly (the phone owner page path) and carries the content hash',async()=>{
 const h=harness({entries:{e1:{item:{workspaceFilename:'quiz.html',name:'quiz.html',target:'/data/papers/e1/quiz.html',workspaceAvailability:'local'},history:{deleted:false,conflict:false},binding:{hash:'abc123',available:true}}}});
 const bridge=h.make();
 const result=await bridge.answer({wants:[{workspaceId:WORKSPACE,entryId:'e1',retry:0}],docs:[{requestId:'q1',op:'load',documentId:'flow-embed.e1'}]});
 assert.equal(result.files['flow-embeds/e1'].status,'ready');
 assert.equal(result.files['flow-embeds/e1'].hash,'abc123');
 assert.deepEqual(JSON.parse(JSON.stringify(result.docs.q1)),{ok:true,content:null,revision:null});
 assert.equal(result.device,'SlopTop');
 assert.equal(h.published.length,0,'answer() does not publish to the desktop mailbox');
});

test('embedded files are downloaded as soon as they sync, skipping local and binned ones, with backoff',async()=>{
 const h=harness({download:async id=>{if(id==='fails')throw new Error('offline');}});
 const shortcuts=[
  {workspaceFileId:'pending',workspaceAvailability:'pending',placements:[{}]},
  {workspaceFileId:'local',workspaceAvailability:'local',placements:[{}]},
  {workspaceFileId:'binned',workspaceAvailability:'pending',placements:[{bin:{}}]},
  {workspaceFileId:'fails',workspaceAvailability:'evicted',placements:[{}]},
 ];
 const bridge=create({workspaces:{load:async()=>({state:{shortcuts}}),frameCall:async(w,m,args)=>{h.downloads.push(args[1].targetId);if(args[1].targetId==='fails')throw new Error('offline');}},exchange:async()=>({ok:true}),device:async()=>'SlopTop',uuid:()=>'x'});
 assert.equal(await bridge.prefetch(1_000_000),2);
 assert.deepEqual([...h.downloads],['pending','fails']);
 assert.equal(await bridge.prefetch(1_000_000+30_000),1,'the failed one waits; the rest repeat');
 assert.deepEqual([...h.downloads],['pending','fails','pending']);
 assert.equal(await bridge.prefetch(1_000_000+5_000),0,'not more often than every 20 s');
});

test('an old machine-path embed is found by its file name, ignoring binned copies',async()=>{
 const shortcuts=[
  {workspaceFileId:'old',workspaceFilename:'quiz.html',placements:[{bin:{}}]},
  {workspaceFileId:'live',workspaceFilename:'quiz.html',placements:[{}]},
  {workspaceFileId:'pdf',workspaceFilename:'book.pdf',placements:[{}]},
 ];
 const bridge=create({workspaces:{load:async()=>({state:{shortcuts}})},exchange:async()=>({ok:true}),device:async()=>'Phone',uuid:()=>'x'});
 const result=JSON.parse(JSON.stringify(await bridge.answer({lookups:['quiz.html','missing.pdf']})));
 assert.deepEqual(result.lookups,{'quiz.html':{workspaceId:WORKSPACE,entryId:'live',name:'quiz.html'},'missing.pdf':null});
});

const never=()=>new Promise(()=>{});
const fast={call:20,store:20,download:40,batch:200};
const remote=entry({item:{workspaceAvailability:'remote'}});

test('a download that never finishes is reported and can be retried',async()=>{
 const tries=[];
 const bridge=create({workspaces:{entry:async()=>remote,frameCall:async(w,m,a)=>{tries.push(a[1].targetId);return never();},load:async()=>({state:{shortcuts:[]}})},exchange:async()=>({ok:true}),device:async()=>'Phone',limits:fast});
 const want={workspaceId:WORKSPACE,entryId:'e1',retry:0};
 assert.equal((await bridge.answer({wants:[want]})).files[WORKSPACE+'/e1'].status,'downloading');
 await new Promise(r=>setTimeout(r,80));
 const timedOut=(await bridge.answer({wants:[want]})).files[WORKSPACE+'/e1'];
 assert.equal(timedOut.status,'waiting');
 assert.match(timedOut.message,/did not finish in time/);
 assert.equal((await bridge.answer({wants:[{...want,retry:1}]})).files[WORKSPACE+'/e1'].status,'downloading');
 assert.equal(tries.length,2);
});

test('a step that never answers does not stop the bridge',async()=>{
 let hang=true,published=0;
 const bridge=create({workspaces:{load:async()=>({state:{shortcuts:[]}})},device:async()=>'SlopTop',limits:fast,
  exchange:async detail=>{if(detail.action==='take')return hang?never():{ok:true,wants:[]};published++;return {ok:true};}});
 await assert.rejects(bridge.tick(),/did not finish in time/);
 hang=false;
 assert.equal(await bridge.tick(),true);
 assert.equal(published,1);
});

test('a slow import is joined by the next batch, never started twice',async()=>{
 let release;const gate=new Promise(r=>release=r),stored=[];
 const bridge=create({workspaces:{receiveFile:async(...args)=>{stored.push(args);await gate;}},exchange:async()=>({ok:true}),device:async()=>'SlopTop',uuid:()=>'u',limits:{...fast,store:1000,batch:30}});
 const request={imports:[{requestId:'r1',path:'D:\quiz.html'}]};
 const first=bridge.answer(request),second=bridge.answer(request);
 release();
 const [a,b]=await Promise.all([first,second]);
 assert.equal(stored.length,1);
 assert.equal(a.imports.r1.ok,true);
 assert.equal(b.imports.r1.ok,true);
});

test('prefetch shares the download in progress instead of fetching again',async()=>{
 let release;const gate=new Promise(r=>release=r),tries=[];
 const shortcuts=[{workspaceFileId:'e1',workspaceAvailability:'remote',placements:[{}]}];
 const bridge=create({workspaces:{entry:async()=>remote,load:async()=>({state:{shortcuts}}),frameCall:async(w,m,a)=>{tries.push(a[1].targetId);await gate;}},exchange:async()=>({ok:true}),device:async()=>'Phone',limits:fast});
 await bridge.answer({wants:[{workspaceId:WORKSPACE,entryId:'e1',retry:0}]});
 assert.equal(await bridge.prefetch(Date.now()+60000),0);
 release();
 assert.equal(tries.length,1);
});
