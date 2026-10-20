import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Editor,EditorProvider,FixedToolbar,NodeType} from '@appflowyinc/editor';
import '@appflowyinc/editor/style';
const documentId=new URL(location.href).searchParams.get('document');
const pending=new Map();
function request(method,detail={}){return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('The document owner did not answer. Your draft is kept in this browser.'));},30000);pending.set(requestId,{resolve,reject,timer});parent.postMessage({type:'proxima:document:request',documentId,requestId,method,...detail},location.origin);});}
addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='proxima:document:result')return;const task=pending.get(event.data.requestId);if(!task)return;clearTimeout(task.timer);pending.delete(event.data.requestId);event.data.error?task.reject(Error(event.data.error)):task.resolve(event.data.result);});
let viewId=sessionStorage.getItem('proxima.appflowy.view');if(!viewId){viewId=crypto.randomUUID();sessionStorage.setItem('proxima.appflowy.view',viewId);}const draftKey='proxima.appflowy.draft.'+documentId+'.'+viewId;
let saveNow=async()=>{};
addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='proxima:document:flush')return;const requestId=event.data.requestId;saveNow().then(()=>parent.postMessage({type:'proxima:document:flushed',requestId,ok:true},location.origin),error=>parent.postMessage({type:'proxima:document:flushed',requestId,ok:false,error:error.message},location.origin));});
const blank=[{type:NodeType.Paragraph,data:{},delta:[{insert:''}],children:[]}];
class EditorBoundary extends React.Component{
 constructor(props){super(props);this.state={error:null};}
 static getDerivedStateFromError(error){return {error:error.message};}
 render(){return this.state.error?<aside>The document could not be displayed: {this.state.error}. Any saved document and browser draft are kept.</aside>:this.props.children;}
}
function App(){
 const [loaded,setLoaded]=useState(null),[status,setStatus]=useState('Opening document…'),[epoch,setEpoch]=useState(0),[problem,setProblem]=useState(null),[recovery,setRecovery]=useState(null);
 useEffect(()=>{let alive=true,revision,draft,acknowledged,dirty=false,timer,queue=Promise.resolve(),blocked=false;
 const keepDraft=()=>{try{localStorage.setItem(draftKey,JSON.stringify({content:draft,revision,at:new Date().toISOString()}));}catch{setStatus('Not saved: browser recovery storage is full. Keep this page open.');}};
 const flush=()=>{clearTimeout(timer);queue=queue.catch(()=>{}).then(async()=>{if(blocked)throw Error('This document changed elsewhere. Your draft is kept.');if(!dirty)return;const saving=JSON.stringify(draft),result=await request('save',{content:JSON.parse(saving),revision});if(!result.ok){blocked=true;setProblem(result);setStatus('Changed elsewhere · your draft is kept');throw Error('This document changed elsewhere. Your draft is kept.');}revision=result.revision;acknowledged=saving;dirty=JSON.stringify(draft)!==saving;if(!dirty){localStorage.removeItem(draftKey);setStatus(location.protocol==='https:'&&location.host!=='papers.local'?'Saved on BOP':'Saved locally');}else{keepDraft();setStatus('Saving…');timer=setTimeout(()=>void flush().catch(showFailure),700);}});return queue;};
 const showFailure=error=>{if(alive)setStatus('Not saved · '+error.message);};
 saveNow=flush;
 request('load').then(result=>{if(!alive)return;revision=result.revision;draft=result.content??blank;acknowledged=JSON.stringify(draft);if(result.conflicts?.length){blocked=true;setProblem(result);setStatus('Competing versions kept · choose a version below');}else setStatus('Ready');try{const prior=JSON.parse(localStorage.getItem(draftKey)||'null');if(prior&&JSON.stringify(prior.content)!==acknowledged)setRecovery(prior);}catch{}
 setLoaded({content:draft,change:value=>{const next=JSON.stringify(value);if(next===JSON.stringify(draft))return;draft=value;dirty=next!==acknowledged;if(!dirty)return;keepDraft();setStatus('Saving…');clearTimeout(timer);timer=setTimeout(()=>void flush().catch(showFailure),700);},restore:content=>{draft=content;dirty=true;keepDraft();setLoaded(current=>({...current,content}));setEpoch(n=>n+1);setRecovery(null);void flush().catch(showFailure);},loadSaved:async()=>{const latest=await request('load');if(latest.conflicts?.length){setProblem(latest);return;}revision=latest.revision;draft=latest.content??blank;dirty=false;blocked=false;acknowledged=JSON.stringify(draft);setProblem(null);setStatus('Loaded saved copy');setLoaded(current=>({...current,content:draft}));setEpoch(n=>n+1);}});
 }).catch(showFailure);
 const leave=event=>{if(!dirty)return;event.preventDefault();event.returnValue='';};addEventListener('beforeunload',leave);
 return()=>{alive=false;clearTimeout(timer);removeEventListener('beforeunload',leave);};
 },[]);
 const download=()=>{const saved=localStorage.getItem(draftKey);if(!saved)return;const a=document.createElement('a'),url=URL.createObjectURL(new Blob([saved],{type:'application/json'}));a.href=url;a.download='AppFlowy-draft-'+documentId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 return <><header className="document-toolbar"><span role="status">{status}</span><button onClick={()=>saveNow().catch(error=>setStatus(error.message))}>Save</button></header>
 {recovery&&<aside>There is an unsaved draft from this tab. <button onClick={()=>loaded.restore(recovery.content)}>Restore draft</button><button onClick={download}>Download draft</button><button onClick={()=>setRecovery(null)}>Use saved copy</button></aside>}
 {problem&&<aside>Your draft has been kept. <button onClick={download}>Download draft</button><button onClick={()=>loaded.loadSaved().catch(error=>setStatus(error.message))}>Load saved copy</button>{(problem.conflicts||[]).flatMap((conflict,i)=>[conflict.shown,...conflict.others].map((version,n)=><button key={i+'-'+n} onClick={async()=>{try{await request('resolve',{conflict,value:version.v});await loaded.loadSaved();}catch(error){setStatus(error.message);}}}>Use saved version {n+1}</button>))}</aside>}
 {loaded&&<EditorBoundary key={epoch}><EditorProvider><Editor initialValue={loaded.content} onChange={loaded.change} theme="dark" locale={{lang:'en'}} ToolbarComponent={FixedToolbar}/></EditorProvider></EditorBoundary>}
 </>;
}
createRoot(document.getElementById('editor')).render(<App/>);
