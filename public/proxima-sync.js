/* Proxima sync between the creator's devices: storage, stamping and the exchange (rules: sync-core.js).
 *
 * Every save of this device's Proxima is diffed against what was stored and the changed fields are
 * stamped (IndexedDB "proxima-sync"). ProximaSync.exchange() answers a peer: it merges the peer's
 * changes under the store's own write lock, repairs, and returns what the peer has not seen.
 * ProximaSync.syncWith() is the asking side; device-mirror.js decides when and with whom.
 * Runs in a device's own Proxima (computer page, phone page, the phone's owner engine), never in a
 * view of another device. Loaded after persistence.js and before the store. */
(function(root){
  if(new URL(location.href).searchParams.get('papers-device'))return;
  const persistence=root.ProximaPersistence,core=root.ProximaSyncCore;
  if(!persistence||persistence.device||!core||root.ProximaSync)return;
  const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const done=t=>new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error||Error('Sync transaction aborted'));});
  const withWriteLock=fn=>root.navigator?.locks?navigator.locks.request('proxima-store-write',fn):fn();
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('proxima-sync'):null;

  // ── Storage: stamps (key -> {h,o,n}) and meta (node, n, clock, vv, peers) ──
  let dbPromise=null;
  function db(){return dbPromise||(dbPromise=(async()=>{const open=indexedDB.open('proxima-sync',1);open.onupgradeneeded=()=>{open.result.createObjectStore('stamps');open.result.createObjectStore('meta');};const value=await request(open);value.onversionchange=()=>value.close();return value;})());}
  async function load(){
    const d=await db(),tx=d.transaction(['stamps','meta'],'readonly'),finished=done(tx);
    const [keys,values,metaKeys,metaValues]=await Promise.all([request(tx.objectStore('stamps').getAllKeys()),request(tx.objectStore('stamps').getAll()),request(tx.objectStore('meta').getAllKeys()),request(tx.objectStore('meta').getAll())]);
    await finished;
    const meta=Object.fromEntries(metaKeys.map((key,i)=>[key,metaValues[i]]));
    if(!meta.node)meta.node=crypto.randomUUID().slice(0,8);
    meta.n??=0;meta.clock??=null;meta.vv??={};meta.peers??={};
    return {stamps:new Map(keys.map((key,i)=>[key,values[i]])),meta,dirty:new Set()};
  }
  async function save(store){
    const d=await db(),tx=d.transaction(['stamps','meta'],'readwrite'),finished=done(tx),stamps=tx.objectStore('stamps'),meta=tx.objectStore('meta');
    for(const key of store.dirty){const value=store.stamps.get(key);if(value)stamps.put(value,key);else stamps.delete(key);}
    for(const [key,value] of Object.entries(store.meta))meta.put(value,key);
    await finished;store.dirty.clear();
  }
  // Marks stamps that change, so only those are written.
  function tracked(store){const set=store.stamps.set.bind(store.stamps);store.stamps.set=(key,value)=>{store.dirty.add(key);return set(key,value);};return store;}
  const nextStamp=store=>()=>{store.meta.clock=core.tick(store.meta.clock,Date.now(),store.meta.node);store.meta.n++;store.meta.vv[store.meta.node]=store.meta.n;return {h:store.meta.clock,o:store.meta.node,n:store.meta.n};};

  // ── Stamping every save (the caller holds the store's write lock) ──
  const read=persistence.read.bind(persistence),write=persistence.write.bind(persistence);
  persistence.write=async state=>{
    const before=await read();const result=await write(state);
    const changes=core.diff(before,state);
    if(changes.length){const store=tracked(await load());core.stampChanges(store.stamps,changes,nextStamp(store));await save(store);dispatchEvent(new Event('proxima-sync:local-change'));}
    return result;
  };

  // The first run on a device stamps what it already has, as older than any real edit, so the first
  // exchange can carry it. Where two devices start with different values, the one that was the
  // authoritative device (device-mirror.js's earlier model) wins the tie; otherwise the device id decides.
  const ready=(async()=>{await persistence.ready;await withWriteLock(async()=>{
    const store=tracked(await load());if(store.meta.bootstrapped)return;
    let authoritative=false;try{authoritative=!!localStorage.getItem('proxima.mirror.self');}catch{}
    let count=0;
    core.bootstrap(store.stamps,await read(),()=>{store.meta.n++;store.meta.vv[store.meta.node]=store.meta.n;return {h:core.stamp(authoritative?1:0,count++,store.meta.node),o:store.meta.node,n:store.meta.n};});
    store.meta.bootstrapped=true;await save(store);
  });})();

  /** Merges a peer's changes (caller holds the write lock). Returns {store, state, notes, changed}. */
  async function apply(store,changes,peerVV){
    for(const change of changes)for(const s of [change.tomb,...Object.values(change.fields||{})])if(s)store.meta.clock=core.witness(store.meta.clock,s.h);
    const current=await read(),merged=core.merge(current,store.stamps,changes);
    store.meta.vv=core.joinVectors(store.meta.vv,peerVV);
    if(!merged.changed)return {state:current,notes:[],changed:false};
    let next={...merged.state,seq:(Number(current?.seq)||0)+1};
    const repaired=core.repair(next);
    core.stampChanges(store.stamps,core.diff(next,repaired.state),nextStamp(store)); // repairs are this device's own edits
    next=repaired.state;
    await write(next);
    return {state:next,notes:repaired.notes,changed:true};
  }
  async function refresh(){
    if(typeof Store!=='undefined'&&!root.__proximaOwnerEngine){
      await Store.remoteProjection({ownerId:'computer',backpackId:'proxima'}); // re-reads the store
      dispatchEvent(new Event('proxima:remote-imported'));
      const timeline=document.querySelector?.('.exact-timeline');if(timeline)root.ExactTimeline?.mount(timeline,null)?.refresh();
    }
  }
  channel?.addEventListener('message',event=>{if(event.data==='changed')void refresh();});
  async function afterChange(){channel?.postMessage('changed');await refresh();}

  /** Answers a peer: {from, vv, changes} -> {node, vv, changes, notes}. */
  async function exchange(message){
    await ready;
    if(!message||typeof message!=='object'||!Array.isArray(message.changes)||!message.vv||typeof message.vv!=='object')throw Error('Invalid Proxima sync request.');
    let outcome;
    if(typeof Store!=='undefined')await Store.flushCommands?.(); // before the lock: a queued edit may be waiting for it
    await withWriteLock(async()=>{
      const store=tracked(await load()),applied=await apply(store,message.changes,message.vv);
      const reply=core.changesSince(applied.state,store.stamps,message.vv);
      await save(store);
      outcome={changed:applied.changed,reply:{node:store.meta.node,vv:store.meta.vv,changes:reply,notes:applied.notes}};
    });
    if(outcome.changed)await afterChange();
    return outcome.reply;
  }

  /** Syncs with one device through `send(message) -> reply`. Returns {received, sent, notes}. */
  async function syncWith(peerId,send){
    await ready;
    let message;
    await withWriteLock(async()=>{const store=await load();const known=store.meta.peers[peerId]||{};message={vv:store.meta.vv,changes:core.changesSince(await read(),store.stamps,known)};});
    const reply=await send(message);
    if(!reply||!Array.isArray(reply.changes)||!reply.vv)throw Error('The device did not answer the sync.');
    let outcome;
    if(typeof Store!=='undefined')await Store.flushCommands?.();
    await withWriteLock(async()=>{
      const store=tracked(await load()),applied=await apply(store,reply.changes,reply.vv);
      store.meta.peers={...store.meta.peers,[peerId]:reply.vv};
      await save(store);
      outcome={changed:applied.changed,notes:[...(reply.notes||[]),...applied.notes],received:reply.changes.length,sent:message.changes.length};
    });
    if(outcome.changed)await afterChange();
    return outcome;
  }

  root.ProximaSync=Object.freeze({ready,exchange,syncWith});
})(globalThis);
