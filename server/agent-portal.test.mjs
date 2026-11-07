import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createEngine} from './dist/main.mjs';
import {createPortal} from './dist/portal.mjs';

test('real portal searches live managed names and enforces preview/apply header without editing during reads',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agent-portal-'));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const key='test'.repeat(10)+'abc';await writeFile(path.join(root,'portal.json'),JSON.stringify({enabled:true,key,origin:'https://example.test',port}));
  await writeFile(path.join(root,'agent-access.json'),JSON.stringify({version:1,enabled:true,key:'A'.repeat(43)}));
  const engine=await createEngine(root),doc=await engine.replica.load('ayg-root');
  doc.state.groups.push({id:'open',name:'Research visible',parentId:'root'},{id:'hidden',name:'Research binned',parentId:'root',bin:true});
  await engine.replica.save('ayg-root',doc.state,doc.revision);
  const portal=await createPortal(engine,root),base=`http://127.0.0.1:${port}/s/${key}/`;
  const access=JSON.parse(await readFile(path.join(root,'agent-access.json'),'utf8')),auth={authorization:'Bearer '+access.key};
  try{
    assert.equal((await fetch(base+'api/agent/catalog')).status,403);
    assert.equal((await fetch(base+'api/agent/apply',{method:'POST',headers:{'content-type':'application/json','x-proxima-request':'1'},body:JSON.stringify({preview_id:'test'})})).status,403);
    const before=(await (await fetch(base+'api/state')).json()).state.seq;
    const found=await (await fetch(base+'api/agent/managed-search?q=Research',{headers:auth})).json();assert.equal(found.results.length,1);assert.equal(found.results[0].id,'open');
    const status=await fetch(base+'api/agent/sync-status',{headers:auth,signal:AbortSignal.timeout(5000)});assert.equal(status.status,200);
    const refused=await fetch(base+'api/agent/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commands:[{type:'task.create',payload:{name:'Denied'}}]})});assert.equal(refused.status,403);
    const preview=await (await fetch(base+'api/agent/preview',{method:'POST',headers:{...auth,'content-type':'application/json','x-proxima-request':'1'},body:JSON.stringify({commands:[{type:'task.create',payload:{name:'Preview only'}}]})})).json();assert(preview.preview_id);
    assert.equal((await (await fetch(base+'api/state')).json()).state.seq,before);
  }finally{await portal.close();await engine.flush();await rm(root,{recursive:true,force:true});}
});
