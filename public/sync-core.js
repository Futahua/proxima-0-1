/* Proxima sync between the creator's devices: the merge rules, with no storage or transport.
 *
 * Every synced field of every record carries a stamp {h, o, n, c}:
 *   h  hybrid logical clock "<ms base36, 11>.<counter base36, 4>.<node>" — compares as a string, so a
 *      device whose clock is wrong still orders its own edits and never goes backwards after seeing
 *      another device's edit;
 *   o  the device that made the edit, n its running number on that device (for "what am I missing");
 *   c  what that device had already seen when it made the edit: {device: highest n}.
 * One edit supersedes another only when its device had seen the other. Two edits where neither device
 * had seen the other are concurrent (the phone offline on holiday, a stray edit on the PC): different
 * fields simply both apply; the same field shows the later edit, and the other values ride along on
 * the field's stamp (`alt`, each with its value) to every device until the creator picks one: an edit
 * that has seen them all. Nothing is silently dropped, and every device shows the same conflicts.
 *
 * A deletion is a stamp on the record's "~" field, and removes only what the deleting device had
 * seen: a record stays while one of its fields was edited without the deleter knowing (edit wins over
 * an unseen delete), and that clash is kept as a conflict too.
 *
 * Changes travel whole records (every field with its stamp) so a revived record arrives complete.
 * Each device keeps a version vector {o: highest n seen}; a peer sends the records holding any stamp
 * above it. After a merge, repair() resolves what only makes sense across records; it is
 * deterministic, so devices that merged the same data repair it identically. Fields recomputed from
 * other records (a session's copy of its row's order) and compare-and-set tokens stay local. */
(function(root){
  'use strict';
  const COLLECTIONS=['projects','tasks','scheduleEvents','timelineRows','timelineIntervals','importedRuns'];
  const SINGLETONS=['run'];
  // Per-device fields: compare-and-set tokens (bumped locally after a merge) and derived copies.
  const LOCAL_FIELDS={'*':new Set(['rev']),timelineIntervals:new Set(['rev','rowOrder'])};
  const localFields=collection=>LOCAL_FIELDS[collection]||LOCAL_FIELDS['*'];
  const TOMB='~';

  // ── Hybrid logical clock ──
  const pad=(value,width)=>value.toString(36).padStart(width,'0');
  const stamp=(ms,count,node)=>pad(ms,11)+'.'+pad(count,4)+'.'+node;
  const parse=h=>{const [ms,count]=h.split('.');return {ms:parseInt(ms,36),count:parseInt(count,36)};};
  /** Next clock reading after `last` (a stamp or null), at wall time `now`, for device `node`. */
  function tick(last,now,node){
    const previous=last?parse(last):{ms:0,count:0};
    return previous.ms>=now?stamp(previous.ms,previous.count+1,node):stamp(now,0,node);
  }
  /** The clock after seeing a remote stamp: never behind it. */
  const witness=(last,remote)=>!last||remote>last?remote:last;
  /** Wall time of a stamp, in ms. */
  const timeOf=h=>parse(h).ms;

  // ── Causality ──
  /** Had a device whose knowledge was `context` seen stamp `s`? */
  const seen=(context,s)=>!!s&&((context&&context[s.o])||0)>=s.n;
  const sameStamp=(a,b)=>!!a&&!!b&&a.o===b.o&&a.n===b.n;
  const plain=s=>{const out={h:s.h,o:s.o,n:s.n,c:s.c||{}};if(s.alt?.length)out.alt=s.alt.map(a=>{const x={h:a.h,o:a.o,n:a.n,c:a.c||{}};if('v' in a)x.v=a.v;return x;});return out;};
  const bare=s=>({h:s.h,o:s.o,n:s.n,c:s.c||{}});
  const withSnapshot=s=>{const out=bare(s);if(s.v!==undefined)out.v=s.v;if(s.also?.length)out.also=s.also.map(bare);return out;};
  /** Every concurrent deletion of a record: its stamp plus the others kept in `also`. */
  const deletionsOf=t=>t?[bare(t),...(t.also||[]).map(bare)]:[];
  /** What the deletions of a record had seen, combined: each removed what it knew. */
  const deletionContext=t=>deletionsOf(t).reduce((c,d)=>joinVectors(c,d.c),{});

  // ── Records ──
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  /** Map "collection/id" -> record (local-only fields removed). */
  function recordsOf(state){
    const out=new Map();if(!state)return out;
    for(const name of COLLECTIONS)for(const item of Array.isArray(state[name])?state[name]:[])if(item&&item.id!=null)out.set(name+'/'+item.id,strip(name,item));
    for(const name of SINGLETONS)if(state[name]&&typeof state[name]==='object')out.set(name+'/'+name,strip(name,state[name]));
    return out;
  }
  function strip(collection,record){const local=localFields(collection),value={};for(const [key,field] of Object.entries(record))if(!local.has(key))value[key]=field;return value;}

  /** What changed between two states: [{key, fields:[names], deleted}] (fields include removed ones). */
  function diff(before,after){
    const a=recordsOf(before),b=recordsOf(after),changes=[];
    for(const [key,next] of b){const prev=a.get(key);const fields=new Set();for(const field of Object.keys(next))if(!prev||!same(prev[field],next[field]))fields.add(field);if(prev)for(const field of Object.keys(prev))if(!(field in next))fields.add(field);if(fields.size)changes.push({key,fields:[...fields],deleted:false});}
    for(const [key,prev] of a)if(!b.has(key))changes.push({key,fields:[],deleted:true,record:prev});
    return changes;
  }

  /** Stamps local changes in place. `next()` returns a fresh {h,o,n,c} for each stamped field. */
  function stampChanges(stamps,changes,next){
    for(const change of changes){
      // A deletion carries the record as it was, so a device that later sees it revived (by an edit
      // the deleter had not seen) can restore the fields it had thrown away.
      if(change.deleted){const tomb=next();if(change.record)tomb.v=structuredClone(change.record);stamps.set(change.key+'#'+TOMB,tomb);keepValues(stamps,change.key,change.record);continue;}
      for(const field of change.fields)stamps.set(change.key+'#'+field,next());
    }
  }
  /** Stamps every field of every record not stamped yet (the first run on a device). */
  function bootstrap(stamps,state,next){
    for(const [key,record] of recordsOf(state))for(const field of Object.keys(record))if(!stamps.has(key+'#'+field))stamps.set(key+'#'+field,next());
  }

  const recordKeyOf=stampKey=>stampKey.slice(0,stampKey.lastIndexOf('#'));
  /** A removed record's values stay on its field stamps, so this device can still send them (to a
   * device that revives it, or as a competing value) and restore them itself. */
  function keepValues(stamps,key,record){
    if(!record)return;
    for(const [field,value] of Object.entries(record)){const s=stamps.get(key+'#'+field);if(s)stamps.set(key+'#'+field,{...s,v:structuredClone(value)});}
  }
  /** Records a peer with version vector `vv` has not seen: [{key, fields:{f:{v?,h,o,n,c}}, tomb?}]. */
  function changesSince(state,stamps,vv){
    const records=recordsOf(state),wanted=new Set();
    for(const [key,s] of stamps)if(s.n>(vv[s.o]||0)||s.alt?.some(a=>a.n>(vv[a.o]||0))||s.also?.some(a=>a.n>(vv[a.o]||0)))wanted.add(recordKeyOf(key));
    const byRecord=new Map();for(const [key,s] of stamps){const record=recordKeyOf(key);if(wanted.has(record)){if(!byRecord.has(record))byRecord.set(record,[]);byRecord.get(record).push([key.slice(record.length+1),s]);}}
    const out=[];
    for(const [key,entries] of byRecord){
      const record=records.get(key),change={key,fields:{}};
      for(const [field,s] of entries){
        if(field===TOMB){change.tomb=withSnapshot(s);continue;}
        const entry=plain(s);if(record&&field in record)entry.v=record[field];else if(!record&&'v' in s)entry.v=s.v;change.fields[field]=entry;
      }
      out.push(change);
    }
    return out;
  }

  /** Is the record alive: some field was edited without its deleter having seen that edit? */
  function aliveUnder(tomb,fieldStamps){if(!tomb)return true;const context=deletionContext(tomb);return fieldStamps.some(s=>!seen(context,s));}

  /** Merges a peer's changes. Returns {state, changed, touched, overwritten}; `stamps` is updated in
   * place. overwritten: [{key, field, before, by}] — values replaced by edits that had seen them, kept
   * as history. Conflicts are read from the stamps afterwards (conflictsOf). */
  function merge(state,stamps,incoming){
    const records=recordsOf(state),touched=[],overwritten=[];
    const fieldsOf=new Map(); // record key -> its field stamp keys (not the deletion)
    for(const key of stamps.keys())if(!key.endsWith('#'+TOMB)){const record=recordKeyOf(key);if(!fieldsOf.has(record))fieldsOf.set(record,new Set());fieldsOf.get(record).add(key);}
    for(const change of incoming){
      const key=change.key,collection=key.split('/')[0];
      if(!COLLECTIONS.includes(collection)&&!SINGLETONS.includes(collection))continue;
      const before=records.has(key)?records.get(key):null;
      let record=before?{...before}:null,changed=false;
      const localTomb=stamps.get(key+'#'+TOMB);
      // Deletions: one that had seen another supersedes it; concurrent deletions are all kept (the later
      // shows), so every device combines the same set, whichever order they arrive in.
      if(change.tomb){
        const all=[];for(const d of [...deletionsOf(localTomb),...deletionsOf(change.tomb)])if(!all.some(x=>sameStamp(x,d)))all.push(d);
        const current=all.filter(x=>!all.some(y=>y!==x&&seen(y.c,x))).sort((a,b)=>a.h<b.h?1:a.h>b.h?-1:0);
        const snapshot={...(localTomb?.v||{}),...(change.tomb.v||{})};
        const next={...current[0]};if(current.length>1)next.also=current.slice(1);if(Object.keys(snapshot).length)next.v=snapshot;
        stamps.set(key+'#'+TOMB,next);
      }
      for(const [field,entry] of Object.entries(change.fields||{})){
        const local=stamps.get(key+'#'+field),haveValue=!!record&&field in record;
        if(local&&sameStamp(local,entry)&&!entry.alt?.length&&!local.alt?.length){
          if(!haveValue&&'v' in entry){if(!record)record={};record[field]=structuredClone(entry.v);changed=true;} // fill in a value this device no longer has
          continue;
        }
        // Every version of this field either device knows: its shown edit and its kept alternatives.
        const candidates=[];const add=(st,value,hasValue)=>{if(!st)return;const known=candidates.find(x=>sameStamp(x.s,st));if(!known)candidates.push({s:bare(st),v:value,has:hasValue});else if(!known.has&&hasValue){known.v=value;known.has=true;}}; // the same version: a copy that still has its value fills in one that lost it
        if(local){const kept=!haveValue&&'v' in local;add(local,haveValue?record[field]:kept?local.v:undefined,haveValue||kept);for(const a of local.alt||[])add(a,a.v,'v' in a);}
        add(entry,entry.v,'v' in entry);for(const a of entry.alt||[])add(a,a.v,'v' in a);
        // Versions some other version had seen are superseded; the rest are concurrent.
        const current=candidates.filter(x=>!candidates.some(y=>y!==x&&seen(y.s.c,x.s)));
        current.sort((a,b)=>a.s.h<b.s.h?1:a.s.h>b.s.h?-1:0);
        // Every concurrent version is kept (equal values too): what each device knows of a version's value can
        // differ (a local deletion loses it), so filtering here would let devices keep different sets.
        const winner=current[0],alt=current.slice(1).map(x=>x.has?{...x.s,v:structuredClone(x.v)}:{...x.s});
        const next={...winner.s};if(alt.length)next.alt=alt;
        if(local&&haveValue&&!sameStamp(local,winner.s)&&!current.some(x=>sameStamp(x.s,local))&&!same(record[field],winner.v))overwritten.push({key,field,before:structuredClone(record[field]),by:winner.s.o});
        stamps.set(key+'#'+field,next);
        if(!fieldsOf.has(key))fieldsOf.set(key,new Set());fieldsOf.get(key).add(key+'#'+field);
        if(!record)record={};
        if(winner.has){if(!same(record[field],winner.v)){record[field]=structuredClone(winner.v);changed=true;}}
        else if(field in record){delete record[field];changed=true;}
      }
      const tomb=stamps.get(key+'#'+TOMB),fieldStamps=[...(fieldsOf.get(key)||[])].map(k=>stamps.get(k)).filter(Boolean);
      const alive=fieldStamps.length>0&&aliveUnder(tomb,fieldStamps);
      // Revived after a deletion: fields this device no longer has come back from their kept values (or
      // the deletion's snapshot).
      if(alive){for(const k of [...(fieldsOf.get(key)||[])]){const field=k.slice(key.length+1),st=stamps.get(k);if(record&&field in record)continue;const from=st&&'v' in st?st:tomb?.v&&field in tomb.v?{v:tomb.v[field]}:null;if(from){if(!record)record={};record[field]=structuredClone(from.v);changed=true;}}}
      if(alive){if(changed||!records.has(key)){records.set(key,record);touched.push(key);}}
      else{keepValues(stamps,key,record);if(records.has(key)){records.delete(key);touched.push(key);}}
    }
    if(!touched.length)return {state,changed:false,touched,overwritten};
    return {state:rebuild(state,records,touched),changed:true,touched,overwritten};
  }

  /** Writes merged records back into the state, keeping array order and each record's local fields. */
  function rebuild(state,records,touched){
    const next={...state},touchedSet=new Set(touched);
    for(const name of COLLECTIONS){
      const list=Array.isArray(state[name])?state[name]:[],seenKeys=new Set(),out=[];
      for(const item of list){const key=name+'/'+item.id;seenKeys.add(key);if(!touchedSet.has(key)){out.push(item);continue;}const merged=records.get(key);if(merged)out.push(withLocal(name,merged,item));}
      for(const key of touched)if(key.startsWith(name+'/')&&!seenKeys.has(key)&&records.has(key))out.push(withLocal(name,records.get(key),null));
      next[name]=out;
    }
    for(const name of SINGLETONS){const key=name+'/'+name;if(touchedSet.has(key))next[name]=records.has(key)?withLocal(name,records.get(key),state[name]):null;}
    return next;
  }
  const REVISED=new Set(['projects','tasks','scheduleEvents','timelineIntervals','importedRuns','run']);
  /** A merged record keeps this device's local fields and gets a new revision, so an edit based on
   * what was shown before is refused. */
  function withLocal(collection,merged,previous){
    const value=structuredClone(merged);
    for(const field of localFields(collection))if(previous&&field in previous)value[field]=previous[field];
    if(REVISED.has(collection))value.rev=(Number(previous?.rev)||0)+1;
    return value;
  }

  /** The open conflicts, the same on every device that has the same stamps:
   * [{kind:'field', key, field, shown:{h,o,n,v}, others:[{h,o,n,v}]} | {kind:'delete', key, tomb, record}].
   * A field conflict ends when an edit that had seen every version replaces them; a delete conflict
   * when the record is deleted again (seeing its edits) or a field is edited knowing the delete. */
  function conflictsOf(state,stamps){
    const records=recordsOf(state),out=[],fieldsBy=new Map();
    for(const [k,s] of stamps){
      const key=recordKeyOf(k),field=k.slice(key.length+1);
      if(field===TOMB)continue;
      if(!fieldsBy.has(key))fieldsBy.set(key,[]);fieldsBy.get(key).push(s);
      if(!s.alt?.length||!records.has(key))continue;
      // Only versions whose value is known and differs from what shows are a choice to make.
      const shown=records.get(key)[field],others=s.alt.filter(a=>'v' in a&&!same(a.v,shown)).map(a=>({h:a.h,o:a.o,n:a.n,v:a.v}));
      if(others.length)out.push({kind:'field',key,field,shown:{h:s.h,o:s.o,n:s.n,v:shown},others});
    }
    for(const [k,tomb] of stamps){
      if(!k.endsWith('#'+TOMB))continue;const key=recordKeyOf(k),fields=fieldsBy.get(key)||[];
      if(records.has(key)&&!fields.some(s=>deletionsOf(tomb).some(d=>seen(s.c,d))))out.push({kind:'delete',key,tomb:bare(tomb),record:structuredClone(records.get(key))});
    }
    return out;
  }

  /** Version vector after merging everything a peer had (it sent all it had above ours). */
  function joinVectors(a,b){const out={...a};for(const [o,n] of Object.entries(b||{}))if((out[o]||0)<n)out[o]=n;return out;}
  function vectorOf(stamps){const out={};for(const s of stamps.values())if((out[s.o]||0)<s.n)out[s.o]=s.n;return out;}

  /** Cross-record repairs after a merge. Deterministic; returns {state, notes}. */
  function repair(state){
    const notes=[];let next=state;
    const intervals=Array.isArray(state.timelineIntervals)?state.timelineIntervals:[],rows=Array.isArray(state.timelineRows)?state.timelineRows:[];
    const ids=new Set(intervals.map(item=>item.id));
    // Queues may only list sessions that still exist.
    let rowsOut=rows.map(row=>{
      if(!row.queue||!Array.isArray(row.queue.ids))return row;
      const kept=row.queue.ids.filter(id=>ids.has(id));
      if(kept.length===row.queue.ids.length)return row;
      notes.push('A queue in "'+(row.name||'a row')+'" dropped '+(row.queue.ids.length-kept.length)+' deleted session(s).');
      if(!kept.length){const {queue,...rest}=row;return rest;}
      return {...row,queue:{...row.queue,ids:kept}};
    });
    // One live session per row: the one started last stays live, the others end where it starts.
    const live=new Map();for(const item of intervals)if(item.followNow){const row=item.rowId||item.id;if(!live.has(row))live.set(row,[]);live.get(row).push(item);}
    const ended=new Map();
    for(const [row,items] of live){
      if(items.length<2)continue;
      items.sort((a,b)=>Date.parse(b.start)-Date.parse(a.start)||(a.id<b.id?-1:1));
      const keep=items[0];
      for(const item of items.slice(1)){const end=new Date(Math.max(Date.parse(item.start)+1,Date.parse(keep.start))).toISOString();ended.set(item.id,{...item,followNow:false,end});}
      notes.push('Two sessions were live in "'+((rows.find(r=>r.id===row)||{}).name||keep.name||'a row')+'"; the earlier one was ended when the later one started.');
    }
    // Row order: duplicates (two devices moved rows at once) are renumbered by order, then identity.
    const orders=rowsOut.map(row=>row.rowOrder).filter(value=>Number.isFinite(value));
    if(new Set(orders).size!==orders.length){
      const sorted=[...rowsOut].sort((a,b)=>(Number.isFinite(a.rowOrder)?a.rowOrder:Infinity)-(Number.isFinite(b.rowOrder)?b.rowOrder:Infinity)||(String(a.id)<String(b.id)?-1:1));
      const position=new Map(sorted.map((row,index)=>[row.id,index]));
      rowsOut=rowsOut.map(row=>Number.isFinite(row.rowOrder)&&row.rowOrder!==position.get(row.id)?{...row,rowOrder:position.get(row.id)}:row);
      notes.push('Rows moved on two devices at once were put in one order.');
    }
    if(rowsOut.some((row,index)=>row!==rows[index]))next={...next,timelineRows:rowsOut};
    if(ended.size)next={...next,timelineIntervals:intervals.map(item=>ended.get(item.id)||item)};
    return {state:next,notes};
  }

  root.ProximaSyncCore=Object.freeze({COLLECTIONS,SINGLETONS,TOMB,tick,witness,stamp,timeOf,seen,recordsOf,diff,stampChanges,bootstrap,changesSince,merge,conflictsOf,joinVectors,vectorOf,repair});
})(globalThis);
