/* Sync conflicts, shown where the creator asked: the life clock's left half opens them, with a badge
 * counting them. A conflict is two edits made without either device knowing about the other (the phone
 * offline on holiday, a stray edit on the PC); sync-core keeps both and shows the later one until a
 * choice is made here.
 *
 * Every choice is a picture of what Proxima will look like with it: a session is drawn on a small
 * timeline of its row (its neighbours included) with that choice's name, colour, times or live state;
 * a row with that name or colour; a task or event as a card. The detail that differs is highlighted.
 * A deletion that clashed with an edit offers "keep it" or "delete it", drawn the same way.
 * Clicking a picture applies that choice (ProximaSync.resolve); other devices follow on their next sync. */
(function(root){
  if(new URL(location.href).searchParams.get('papers-device'))return;
  const sync=root.ProximaSync;if(!sync)return;

  const FIELD_NAMES={name:'Name',color:'Colour',start:'Start',end:'End',followNow:'Live',deadline:'Deadline',rowId:'Row',note:'Note',status:'Status',weight:'Weight',project:'Project',rowOrder:'Order',queue:'Queue',queueWeight:'Queue share',checked:'Done',description:'Description',recurrence:'Repeats',exceptions:'Exceptions',archivedAt:'Archived'};
  const KINDS={timelineIntervals:'Session',timelineRows:'Row',tasks:'Task',scheduleEvents:'Event',projects:'Project',importedRuns:'Run',run:'Run'};
  const style=document.createElement('style');
  style.textContent=`
.proxima-conflict-badge{position:absolute;top:-4px;right:-6px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#d9534f;color:#fff;font:700 11px/18px system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 1px 4px #0008}
.proxima-conflicts{position:fixed;inset:0;z-index:3500;display:grid;place-items:center;background:#000a}
.proxima-conflicts>section{width:min(760px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;padding:16px;border-radius:14px;background:var(--panel,#1f252b);border:1px solid var(--line,#414d5b);box-shadow:0 24px 60px #000c;color:var(--ink,#e6e9ef);font:14px/1.4 system-ui,sans-serif}
.proxima-conflicts header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.proxima-conflicts header h2{margin:0;font-size:17px;flex:1}
.proxima-conflicts header button{border:0;background:none;color:var(--dim,#97a0b0);font-size:20px;cursor:pointer}
.proxima-conflict{margin:0 0 16px;padding:12px;border-radius:10px;background:var(--panel-2,#262e37)}
.proxima-conflict h3{margin:0 0 2px;font-size:14px}
.proxima-conflict p{margin:0 0 10px;color:var(--dim,#97a0b0);font-size:12px}
.proxima-conflict-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.proxima-conflict-option{display:block;width:100%;padding:10px;border-radius:10px;border:1px solid var(--line,#414d5b);background:var(--bg,#1b2026);color:inherit;text-align:left;cursor:pointer;font:inherit}
.proxima-conflict-option:hover{border-color:var(--accent,#afc3d4);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#afc3d4) 30%,transparent)}
.proxima-conflict-option .who{display:block;margin-bottom:8px;font-size:12px;color:var(--dim,#97a0b0)}
.proxima-conflict-option .who b{color:var(--ink,#e6e9ef)}
.proxima-conflict-option .pick{display:block;margin-top:8px;font-size:12px;color:var(--accent,#afc3d4)}
.pc-track{position:relative;height:46px;border-radius:6px;background:repeating-linear-gradient(90deg,transparent 0 calc(25% - 1px),#ffffff12 calc(25% - 1px) 25%);overflow:hidden}
.pc-bar{position:absolute;top:8px;height:30px;border-radius:5px;padding:0 6px;box-sizing:border-box;display:flex;align-items:center;font-size:12px;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:6px}
.pc-bar.other{opacity:.35;color:transparent}
.pc-bar.live::after{content:'→';margin-left:auto;padding-left:4px;color:#111}
.pc-bar.target{outline:2px solid #fff;outline-offset:1px}
.pc-deadline{position:absolute;top:6px;height:34px;border:2px dashed #e05555;border-left:0;border-radius:0 6px 6px 0;box-sizing:border-box}
.pc-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dim,#97a0b0);margin-top:3px}
.pc-detail{margin-top:6px;font-size:12px}
.pc-detail .changed{background:color-mix(in srgb,#f0b429 35%,transparent);border-radius:3px;padding:0 3px}
.pc-card{padding:8px 10px;border-radius:8px;border-left:4px solid var(--accent,#afc3d4);background:#ffffff08}
.pc-card .title{font-weight:600}
.pc-card .row{font-size:12px;color:var(--dim,#97a0b0)}
.pc-removed{opacity:.35;text-decoration:line-through}
.pc-swatch{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:6px;border:1px solid #0006}
.proxima-conflicts .empty{color:var(--dim,#97a0b0);padding:20px 0;text-align:center}`;
  document.head.append(style);

  const esc=text=>String(text??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  const ago=ms=>{const s=Math.max(0,Math.round((Date.now()-ms)/1000));return s<90?'just now':s<5400?Math.round(s/60)+' min ago':s<129600?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago';};
  const when=h=>{try{return ProximaSyncCore.timeOf(h);}catch{return 0;}};
  const fmt=ms=>{const d=new Date(ms),now=new Date();const time=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});return d.toDateString()===now.toDateString()?time:d.toLocaleDateString([],{day:'numeric',month:'short'})+' '+time;};
  const show=value=>value===undefined?'(none)':typeof value==='boolean'?(value?'yes':'no'):typeof value==='object'?JSON.stringify(value):String(value);

  /** The state with one choice applied, for drawing. */
  function withChoice(state,conflict,choice){
    const [collection,...rest]=conflict.key.split('/'),id=rest.join('/');
    const list=(state[collection]||[]).map(item=>String(item.id)===id?(conflict.kind==='field'?{...item,[conflict.field]:choice.value}:item):item);
    if(conflict.kind==='delete'&&!list.some(item=>String(item.id)===id)&&conflict.record)list.push(conflict.record);
    return {...state,[collection]:list};
  }

  /** A small timeline of a session's row: its neighbours faint, the session drawn as the choice makes it. */
  function sessionPicture(state,conflicts,choices,id,choice,removed){
    const session=(state.timelineIntervals||[]).find(item=>String(item.id)===id);if(!session)return '<div class="pc-card">This session is gone.</div>';
    const row=(state.timelineRows||[]).find(r=>r.id===session.rowId)||{};
    // One window for every choice, so the pictures line up.
    const spans=choices.map(c=>{const s=withChoice(state,conflicts,c).timelineIntervals.find(item=>String(item.id)===id)||session;const start=Date.parse(s.start),end=s.followNow?Date.now():Date.parse(s.end);return [start,Math.max(end,Date.parse(s.deadline||0)||end)];});
    let from=Math.min(...spans.map(s=>s[0])),to=Math.max(...spans.map(s=>s[1]));const pad=Math.max((to-from)*0.25,30*60000);from-=pad;to+=pad;
    const x=ms=>Math.max(0,Math.min(100,(ms-from)/(to-from)*100));
    const bar=(item,cls)=>{const start=Date.parse(item.start),end=item.followNow?Date.now():Date.parse(item.end),color=item.color||row.color||'#a1cc43';return `<div class="pc-bar ${cls}${item.followNow?' live':''}" style="left:${x(start)}%;width:${Math.max(0.8,x(end)-x(start))}%;background:${esc(color)}">${cls.includes('target')?esc(item.name||row.name||''):''}</div>`+(cls.includes('target')&&item.deadline?`<div class="pc-deadline" style="left:${x(end)}%;width:${Math.max(0,x(Date.parse(item.deadline))-x(end))}%"></div>`:'');};
    const neighbours=(state.timelineIntervals||[]).filter(item=>item.rowId===session.rowId&&String(item.id)!==id).map(item=>bar(item,'other')).join('');
    const target=removed?'':bar(choice.session||session,'target');
    return `<div class="pc-track${removed?' pc-removed':''}">${neighbours}${target}</div><div class="pc-axis"><span>${esc(fmt(from))}</span><span>${esc(fmt(to))}</span></div>`;
  }

  function picture(conflict,choice,choices,state){
    const [collection,...rest]=conflict.key.split('/'),id=rest.join('/');
    const after=withChoice(state,conflict,choice),removed=conflict.kind==='delete'&&choice.keep===false;
    const record=(after[collection]||[]).find(item=>String(item.id)===id)||conflict.record||{};
    const changed=field=>conflict.kind==='field'&&conflict.field===field?' class="changed"':'';
    let body;
    if(collection==='timelineIntervals'){
      body=sessionPicture(after,conflict,choices,id,{...choice,session:record},removed);
      body+=`<div class="pc-detail${removed?' pc-removed':''}"><span${changed('name')}>${esc(record.name||'(unnamed)')}</span> · <span${changed('start')}>${esc(fmt(Date.parse(record.start)))}</span> – <span${changed('end')}${changed('followNow')}>${record.followNow?'now (live)':esc(fmt(Date.parse(record.end)))}</span>${record.deadline?` · <span${changed('deadline')}>due ${esc(fmt(Date.parse(record.deadline)))}</span>`:''}${conflict.kind==='field'&&!['name','start','end','followNow','deadline'].includes(conflict.field)?` · <span class="changed">${esc(FIELD_NAMES[conflict.field]||conflict.field)}: ${esc(show(choice.value))}</span>`:''}</div>`;
    }else if(collection==='timelineRows'){
      body=`<div class="pc-card${removed?' pc-removed':''}" style="border-left-color:${esc(record.color||'#a1cc43')}"><div class="title"><span class="pc-swatch" style="background:${esc(record.color||'#a1cc43')}"></span><span${changed('name')}>${esc(record.name||'(unnamed row)')}</span></div><div class="row">${conflict.kind==='field'&&conflict.field!=='name'?`<span class="changed">${esc(FIELD_NAMES[conflict.field]||conflict.field)}: ${esc(show(choice.value))}</span>`:esc((after.timelineIntervals||[]).filter(i=>i.rowId===id).length+' sessions')}</div></div>`;
    }else{
      const title=record.name||record.title||'(untitled)';
      const lines=Object.entries(record).filter(([k])=>!['id','rev','name','createdAt'].includes(k)&&record[k]!==''&&record[k]!=null).slice(0,5).map(([k,v])=>`<div class="row"><span${changed(k)}>${esc(FIELD_NAMES[k]||k)}: ${esc(show(k==='start'||k==='deadline'?(Date.parse(v)?fmt(Date.parse(v)):v):v))}</span></div>`).join('');
      body=`<div class="pc-card${removed?' pc-removed':''}"><div class="title"><span${changed('name')}>${esc(title)}</span></div>${lines}</div>`;
    }
    return body;
  }

  let panel=null,badge=null,mountedHost=null;
  async function open(host=mountedHost){
    mountedHost=host;
    const {conflicts,names,self}=await sync.conflicts();
    panel?.remove();panel=document.createElement('div');panel.className='proxima-conflicts';
    const section=document.createElement('section');panel.append(section);
    section.innerHTML=`<header><h2>${conflicts.length?conflicts.length+' sync conflict'+(conflicts.length>1?'s':''):'No sync conflicts'}</h2><button type="button" aria-label="Close">×</button></header>`;
    section.querySelector('header button').addEventListener('click',close);
    panel.addEventListener('click',event=>{if(event.target===panel)close();});
    if(!conflicts.length)section.insertAdjacentHTML('beforeend','<div class="empty">No unresolved conflicts recorded on this device.</div>');
    const state=typeof Store!=='undefined'?Store.snapshot():{};
    const device=node=>node===self?'this device':names[node]||'another device';
    for(const conflict of conflicts){
      const [collection,...rest]=conflict.key.split('/'),id=rest.join('/');
      const record=(state[collection]||[]).find(item=>String(item.id)===id)||conflict.record||{};
      const card=document.createElement('div');card.className='proxima-conflict';
      const what=`${KINDS[collection]||'Item'} “${esc(record.name||record.title||'untitled')}”`;
      let choices;
      if(conflict.kind==='field'){
        card.innerHTML=`<h3>${what}: ${esc(FIELD_NAMES[conflict.field]||conflict.field)}</h3><p>Changed on two devices without either seeing the other. Pick the version to keep; the other devices follow.</p>`;
        choices=[{value:conflict.shown.v,stamp:conflict.shown,showing:true},...conflict.others.map(o=>({value:o.v,stamp:o}))];
      }else{
        card.innerHTML=`<h3>${what} was deleted while edited elsewhere</h3><p>The delete on ${esc(device(conflict.tomb.o))} hadn’t seen an edit made on another device, so it was kept. Keep it, or delete it now.</p>`;
        choices=[{keep:true},{keep:false,stamp:conflict.tomb}];
      }
      const options=document.createElement('div');options.className='proxima-conflict-options';
      for(const choice of choices){
        const button=document.createElement('button');button.type='button';button.className='proxima-conflict-option';
        const who=conflict.kind==='field'?`<b>${esc(device(choice.stamp.o))}</b> · ${esc(ago(when(choice.stamp.h)))}${choice.showing?' · showing now':''}`:choice.keep?'<b>Keep it</b>':`<b>Delete it</b> · as on ${esc(device(choice.stamp.o))}`;
        button.innerHTML=`<span class="who">${who}</span>${picture(conflict,choice,choices,state)}<span class="pick">Keep this →</span>`;
        button.addEventListener('click',async()=>{button.disabled=true;try{await sync.resolve(conflict,conflict.kind==='field'?{value:choice.value}:{keep:choice.keep});await open();}catch(error){button.disabled=false;alert(error.message);}});
        options.append(button);
      }
      card.append(options);section.append(card);
    }
    (mountedHost||document.body).append(panel);
  }
  function close(){panel?.remove();panel=null;mountedHost=null;}

  async function refreshBadge(){
    const host=document.getElementById('overviewProjects');if(!host)return;
    let count=0;try{count=(await sync.conflicts()).conflicts.length;}catch{}
    if(!badge){badge=document.createElement('span');badge.className='proxima-conflict-badge';}
    if(getComputedStyle(host).position==='static')host.style.position='relative';
    if(count){badge.textContent=String(count);if(badge.parentNode!==host)host.append(badge);}else badge.remove();
    host.title='Devices, storage and sync'+(count?' · '+count+' conflict'+(count>1?'s':''):'');host.setAttribute('aria-label',host.title);
  }
  function install(){
    addEventListener('proxima:open-conflicts',event=>void open(event.detail?.host||null));
    const host=document.getElementById('overviewProjects');
    if(!host){setTimeout(install,500);return;}
    host.addEventListener('click',event=>{event.stopPropagation();void open();});
    void refreshBadge();
    addEventListener('proxima-sync:conflicts',()=>{void refreshBadge();if(panel)void open();});
    setInterval(refreshBadge,60000);
  }
  void sync.ready.then(()=>{if(document.readyState==='loading')addEventListener('DOMContentLoaded',install,{once:true});else install();});
})(globalThis);
