import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./public/device-mirror.js',import.meta.url),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Pages of one device share a lock (one page drives) and a broadcast channel.
function device(){
  const channels=new Set();let held=false;
  class BroadcastChannel{constructor(){this.listeners=[];channels.add(this);}postMessage(data){for(const c of channels)if(c!==this)for(const l of c.listeners)setTimeout(()=>l({data}),0);}addEventListener(_t,l){this.listeners.push(l);}}
  const locks={request:(_name,start)=>{if(held)return new Promise(()=>{});held=true;return start();}};
  return {BroadcastChannel,locks};
}
function page(shared,network){
  const phone={id:'phone',name:'Poordroid'};
  const context=vm.createContext({
    location:{href:'https://proxima.test/index.html'},URL,Map,Promise,Date,Error,Event,setTimeout,clearTimeout,setInterval:()=>0,
    BroadcastChannel:shared.BroadcastChannel,navigator:{locks:shared.locks},
    document:{createElement:()=>({}),head:{append(){}}},localStorage:{removeItem(){}},
    addEventListener(){},dispatchEvent(){},
    __proximaDeviceCopy:{devices:async()=>({self:{name:'SlopTop'},others:[phone]}),exchange:async()=>({}),toast(){}},
    ProximaSync:{ready:Promise.resolve(),exchange:async()=>({ok:true}),syncWith:async id=>{network.attempts.push(id);if(!network.phoneOnline)throw Error('That computer is offline.');return {notes:[]};}},
    __proximaReplaceAll:async()=>({}),
  });
  context.globalThis=context;vm.runInContext(source,context);return context;
}

test('a device that contacts this one after failing is retried promptly, not after its backoff',async()=>{
  const network={phoneOnline:false,attempts:[]},driver=page(device(),network);
  await wait(1700); // the driver's first sync, 1.5 s after it starts
  assert.equal(driver.__proximaMirror.status().get('phone').state,'failed');
  assert.ok(driver.__proximaMirror.status().get('phone').retryAt>Date.now()+30000);
  network.phoneOnline=true;const before=network.attempts.length;
  await driver.__proximaReplaceAll({proximaSync:{protocol:2}},'paired device');
  await wait(1300);
  assert.equal(network.attempts.length,before+1);
  assert.equal(driver.__proximaMirror.status().get('phone').state,'ok');
});

test('a contact received by a page that does not drive still clears the driving page\'s backoff',async()=>{
  const shared=device(),network={phoneOnline:false,attempts:[]};
  const driver=page(shared,network);await wait(50);const receiver=page(shared,network);
  await wait(1700);
  assert.equal(driver.__proximaMirror.status().get('phone').state,'failed');
  assert.equal(receiver.__proximaMirror.status().size,0); // it never drove
  network.phoneOnline=true;const before=network.attempts.length;
  await receiver.__proximaReplaceAll({proximaSync:{protocol:2}},'paired device');
  await wait(1300);
  assert.equal(network.attempts.length,before+1);
  assert.equal(driver.__proximaMirror.status().get('phone').state,'ok');
});

test('a device that never answers does not hold up syncing with the others',async()=>{
  const finished=[];
  const context=vm.createContext({
    location:{href:'https://proxima.test/index.html'},URL,Map,Promise,Date,Error,Event,setTimeout,clearTimeout,setInterval:()=>0,
    navigator:{locks:{request:(_n,start)=>start()}},
    document:{createElement:()=>({}),head:{append(){}}},localStorage:{removeItem(){}},addEventListener(){},dispatchEvent(){},
    __proximaDeviceCopy:{devices:async()=>({self:{name:'SlopTop'},others:[{id:'phone',name:'Poordroid'},{id:'bop',name:'BOP'}]}),exchange:async()=>({}),toast(){}},
    ProximaSync:{ready:Promise.resolve(),exchange:async()=>({}),syncWith:async id=>{if(id==='phone')await new Promise(()=>{});finished.push(id);return {notes:[]};}},
  });
  context.globalThis=context;vm.runInContext(source,context);
  await wait(1700); // the first round starts 1.5 s after startup
  assert.deepEqual(finished,['bop']);
  assert.equal(context.__proximaMirror.status().get('bop').state,'ok');
});
