import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./public/device-mirror.js',import.meta.url),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('a device that contacts this one after failing is retried promptly, not after its backoff',async()=>{
  let phoneOnline=false;const attempts=[];
  const phone={id:'phone',name:'Poordroid'};
  const context=vm.createContext({
    location:{href:'https://proxima.test/index.html'},URL,Map,Promise,Date,Error,Event,setTimeout,clearTimeout,setInterval:()=>0,
    document:{createElement:()=>({}),head:{append(){}}},navigator:{},localStorage:{removeItem(){}},
    addEventListener(){},dispatchEvent(){},
    __proximaDeviceCopy:{devices:async()=>({self:{name:'SlopTop'},others:[phone]}),exchange:async()=>({}),toast(){}},
    ProximaSync:{ready:Promise.resolve(),exchange:async()=>({ok:true}),syncWith:async id=>{attempts.push(id);if(!phoneOnline)throw Error('That computer is offline.');return {notes:[]};}},
    __proximaReplaceAll:async()=>({}),
  });
  context.globalThis=context;
  vm.runInContext(source,context);
  await wait(1700); // the driver's first sync, 1.5 s after it starts
  assert.equal(context.__proximaMirror.status().get('phone').state,'failed');
  assert.ok(context.__proximaMirror.status().get('phone').retryAt>Date.now()+30000);
  phoneOnline=true;const before=attempts.length;
  await context.__proximaReplaceAll({proximaSync:{protocol:2}},'paired device');
  await wait(1300);
  assert.equal(attempts.length,before+1);
  assert.equal(context.__proximaMirror.status().get('phone').state,'ok');
});
