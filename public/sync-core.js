/* Proxima sync between the creator's devices: the merge rules, with no storage or transport.
 *
 * Every synced field of every record carries a stamp {h, o, n}:
 *   h  hybrid logical clock "<ms base36, 11>.<counter base36, 4>.<node>" — compares as a string, so a
 *      device whose clock is wrong still orders its own edits and never goes backwards after seeing
 *      another device's edit;
 *   o  the device that made the edit, n its running number on that device (for "what am I missing").
 * A deletion is a stamp on the record's "~" field. A record exists while one of its field stamps is
 * newer than its deletion, so whichever was done later wins, and a later edit brings a record back.
 *
 * Merging is per field: the newer stamp wins; edits to different fields of one record both survive.
 * Changes travel whole records (every field with its stamp) so a revived record arrives complete.
 * Each device keeps a version vector {o: highest n seen}; a peer sends the records holding any stamp
 * above it. After a merge, repair() resolves what only makes sense across records; it is
 * deterministic, so devices that merged the same data repair it identically. */
(function(root){
  'use strict';
  const COLLECTIONS=['projects','tasks','scheduleEvents','timelineRows','timelineIntervals','importedRuns'];
  const SINGLETONS=['run'];
  const LOCAL_FIELDS=new Set(['rev']); // per-device compare-and-set tokens, bumped locally after a merge
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

  // ── Records ──
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  /** Map "collection/id" -> record (local-only fields removed). */
  function recordsOf(state){
    const out=new Map();if(!state)return out;
    for(const name of COLLECTIONS)for(const item of Array.isArray(state[name])?state[name]:[])if(item&&item.id!=null)out.set(name+'/'+item.id,strip(item));
    for(const name of SINGLETONS)if(state[name]&&typeof state[name]==='object')out.set(name+'/'+name,strip(state[name]));
    return out;
  }
  function strip(record){const value={};for(const [key,field] of Object.entries(record))if(!LOCAL_FIELDS.has(key))value[key]=field;return value;}

  /** What changed between two states: [{key, fields:[names], deleted}] (fields include removed ones). */
  function diff(before,after){
    const a=recordsOf(before),b=recordsOf(after),changes=[];
    for(const [key,next] of b){const prev=a.get(key);const fields=new Set();for(const field of Object.keys(next))if(!prev||!same(prev[field],next[field]))fields.add(field);if(prev)for(const field of Object.keys(prev))if(!(field in next))fields.add(field);if(fields.size)changes.push({key,fields:[...fields],deleted:false});}
    for(const key of a.keys())if(!b.has(key))changes.push({key,fields:[],deleted:true});
    return changes;
  }

  /** Stamps local changes in place. `next()` returns a fresh {h,o,n} for each stamped field. */
  function stampChanges(stamps,changes,next){
    for(const change of changes){
      if(change.deleted){stamps.set(change.key+'#'+TOMB,next());continue;}
      for(const field of change.fields)stamps.set(change.key+'#'+field,next());
    }
  }
  /** Stamps every field of every record not stamped yet (the first run on a device). */
  function bootstrap(stamps,state,next){
    for(const [key,record] of recordsOf(state))for(const field of Object.keys(record))if(!stamps.has(key+'#'+field))stamps.set(key+'#'+field,next());
  }

  const recordKeyOf=stampKey=>stampKey.slice(0,stampKey.lastIndexOf('#'));
  /** Records a peer with version vector `vv` has not seen: [{key, fields:{f:{v?,h,o,n}}, tomb?}]. */
  function changesSince(state,stamps,vv){
    const records=recordsOf(state),wanted=new Set();
    for(const [key,s] of stamps)if(s.n>(vv[s.o]||0))wanted.add(recordKeyOf(key));
    const byRecord=new Map();for(const [key,s] of stamps){const record=recordKeyOf(key);if(wanted.has(record)){if(!byRecord.has(record))byRecord.set(record,[]);byRecord.get(record).push([key.slice(record.length+1),s]);}}
    const out=[];
    for(const [key,entries] of byRecord){
      const record=records.get(key),change={key,fields:{}};
      for(const [field,s] of entries){
        if(field===TOMB){change.tomb={h:s.h,o:s.o,n:s.n};continue;}
        const entry={h:s.h,o:s.o,n:s.n};if(record&&field in record)entry.v=record[field];change.fields[field]=entry;
      }
      out.push(change);
    }
    return out;
  }
  const newest=stamps=>{let best=null;for(const s of stamps)if(s&&(!best||s.h>best.h))best=s;return best;};

  /** Merges a peer's changes. Returns {state, changed, touched:[keys]}; `stamps` is updated in place. */
  function merge(state,stamps,incoming){
    const records=recordsOf(state),touched=[];
    const fieldsOf=new Map(); // record key -> its field stamp keys (not the deletion)
    for(const key of stamps.keys())if(!key.endsWith('#'+TOMB)){const record=recordKeyOf(key);if(!fieldsOf.has(record))fieldsOf.set(record,new Set());fieldsOf.get(record).add(key);}
    for(const change of incoming){
      const key=change.key,collection=key.split('/')[0];
      if(!COLLECTIONS.includes(collection)&&!SINGLETONS.includes(collection))continue;
      let record=records.has(key)?{...records.get(key)}:null,changed=false;
      const localTomb=stamps.get(key+'#'+TOMB);
      if(change.tomb&&(!localTomb||change.tomb.h>localTomb.h))stamps.set(key+'#'+TOMB,change.tomb);
      for(const [field,entry] of Object.entries(change.fields||{})){
        const local=stamps.get(key+'#'+field),haveValue=!!record&&field in record;
        // The newer stamp wins; an equal stamp only fills in a value this device no longer has.
        if(local&&(local.h>entry.h||local.h===entry.h&&haveValue))continue;
        stamps.set(key+'#'+field,{h:entry.h,o:entry.o,n:entry.n});
        if(!fieldsOf.has(key))fieldsOf.set(key,new Set());fieldsOf.get(key).add(key+'#'+field);
        if(!record)record={};
        if('v' in entry){if(!same(record[field],entry.v)){record[field]=structuredClone(entry.v);changed=true;}}
        else if(field in record){delete record[field];changed=true;}
      }
      // A record exists while one of its fields was set after its deletion.
      const tomb=stamps.get(key+'#'+TOMB),lastEdit=newest([...(fieldsOf.get(key)||[])].map(k=>stamps.get(k)));
      const alive=!!record&&Object.keys(record).length>0&&(!tomb||!!lastEdit&&lastEdit.h>tomb.h);
      if(alive){if(changed||!records.has(key)){records.set(key,record);touched.push(key);}}
      else if(records.has(key)){records.delete(key);touched.push(key);}
    }
    if(!touched.length)return {state,changed:false,touched};
    return {state:rebuild(state,records,touched),changed:true,touched};
  }

  /** Writes merged records back into the state, keeping array order and each record's local fields. */
  function rebuild(state,records,touched){
    const next={...state},touchedSet=new Set(touched);
    for(const name of COLLECTIONS){
      const list=Array.isArray(state[name])?state[name]:[],seen=new Set(),out=[];
      for(const item of list){const key=name+'/'+item.id;seen.add(key);if(!touchedSet.has(key)){out.push(item);continue;}const merged=records.get(key);if(merged)out.push(withLocal(name,merged,item));}
      for(const key of touched)if(key.startsWith(name+'/')&&!seen.has(key)&&records.has(key))out.push(withLocal(name,records.get(key),null));
      next[name]=out;
    }
    for(const name of SINGLETONS){const key=name+'/'+name;if(touchedSet.has(key))next[name]=records.has(key)?withLocal(name,records.get(key),state[name]):null;}
    return next;
  }
  const REVISED=new Set(['projects','tasks','scheduleEvents','timelineIntervals','importedRuns','run']);
  /** A merged record gets a new local revision, so an edit based on what was shown before is refused. */
  function withLocal(collection,merged,previous){
    const value=structuredClone(merged);
    if(REVISED.has(collection))value.rev=(Number(previous?.rev)||0)+1;
    return value;
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

  root.ProximaSyncCore=Object.freeze({COLLECTIONS,SINGLETONS,TOMB,tick,witness,stamp,recordsOf,diff,stampChanges,bootstrap,changesSince,merge,joinVectors,vectorOf,repair});
})(globalThis);
