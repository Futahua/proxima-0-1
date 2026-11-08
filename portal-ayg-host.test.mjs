import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {File} from 'node:buffer';
import {webcrypto} from 'node:crypto';
const source=await readFile(new URL('./server/web/portal-ayg-host.js',import.meta.url),'utf8');
function fixture(){
 const calls=[],timers=[],status={textContent:''};
 const element=()=>({style:{},append(){},remove(){},addEventListener(){}});
 const ctx=vm.createContext({URL,File,Map,WeakMap,crypto:webcrypto,structuredClone,
  location:{href:'https://example.test/s/key/ayg/workspace.html?papers-blob-workspace=ayg-root',reload(){calls.push({reload:true});}},history:{replaceState(){}},
  document:{createElement:element,head:{append(){}},body:{append(){}},getElementById:()=>status},
  setTimeout:fn=>{timers.push(fn);return timers.length;},
  fetch:async(url,options)=>{calls.push({url:String(url),body:options.body?JSON.parse(options.body):null});return {ok:true,status:200,json:async()=>({ok:true,revision:'r2',serialized:'{"shortcuts":[]}'})};},
  tus:{Upload:class{constructor(file,options){this.options=options;this.url='https://example.test/s/key/uploads/'+'a'.repeat(32);}findPreviousUploads(){return Promise.resolve([]);}start(){this.options.onSuccess();}}}
 });ctx.window=ctx;vm.runInContext(source,ctx);return {host:ctx.ProximaBrowserHost,calls,timers,status};
}
test('browser dropped files stat locally then upload through the ordinary checked save without changing placements',async()=>{
 const f=fixture(),file=new File(['test bytes'],'test.txt',{lastModified:123});
 const [picked]=await f.host.blobRequest('ayg-root','resolve-dropped',[[file]]);
 const stat=await f.host.blobRequest('ayg-root','file',['stat',{path:picked.target}]);
 assert.equal(stat.entry.size,10);assert.equal(f.calls.length,0);
 const result=await f.host.blobRequest('ayg-root','save',[{groups:[],shortcuts:[{id:'shortcut-test',target:picked.target,placements:[{parentId:'selected-folder'}]}]},'r1',{}]);
 assert.equal(result.revision,'r2');const saved=f.calls.at(-1).body.args[0].shortcuts[0];
 assert.equal(saved.target,'web-upload:'+'a'.repeat(32));assert.equal(saved.placements[0].parentId,'selected-folder');
});
test('a connection conflict keeps an unsaved version in place and exposes a recovery message',()=>{
 const f=fixture();f.host.roleChanged({role:'conflict',hasUnsavedConflict:true});
 assert.equal(f.timers.length,0);assert.match(f.status.textContent,/pending version is kept/);
});

