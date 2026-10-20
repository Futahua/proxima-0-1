// AppFlowy owns its documents/databases. Only paired device exchanges reach this
// adapter; public Proxima requests never receive personal-account sessions.
//
// Creator direction (2026-10-20): blobs no longer create workspaces. Every blob owns one page
// in the creator's home space (workspace "This is Minh", space "Proxima"; ids kept in
// appflowy-links.json `home`, re-found by name if they disappear). The page is tracked by its
// own id, so opening the blob finds it wherever it was moved. A page that was deleted or put in
// the trash is replaced by a fresh one on the next open. Older per-blob workspaces are kept.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const origin='https://bop.taild88607.ts.net:8443',internal='http://127.0.0.1:48243';
const HOME_WORKSPACE='This is Minh',HOME_SPACE='Proxima';
const identity=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
export function createAppFlowy(directory){
  const configPath=path.join(directory,'appflowy-private.json'),linksPath=path.join(directory,'appflowy-links.json');
  let tail=Promise.resolve();
  async function persist(value){const temp=linksPath+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value));await rename(temp,linksPath);}
  async function json(route,options={}){
    const response=await fetch(internal+route,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Object.assign(Error('AppFlowy did not confirm the request ('+response.status+').'),{status:response.status});
    return response.json();
  }
  async function ensure(request){
    if(request?.operation!=='open'||!identity(request.documentId)||typeof request.name!=='string'||request.name.length>200)throw Error('Invalid AppFlowy workspace request.');
    let config;try{config=JSON.parse(await readFile(configPath,'utf8'));}catch{throw Error('The full AppFlowy server is not configured yet.');}
    if(typeof config.email!=='string'||typeof config.password!=='string')throw Error('AppFlowy account configuration is incomplete.');
    const session=await json('/gotrue/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:config.email,password:config.password})});
    if(!session.access_token||!session.refresh_token)throw Error('AppFlowy did not establish a personal session.');
    const headers={Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'};
    const api=async(route,options={})=>{const result=await json(route,{...options,headers});if(result.code!==0)throw Error('AppFlowy could not complete this action.');return result.data;};
    // Official first-login handshake, before accessing the user's workspaces.
    await api('/api/user/verify/'+encodeURIComponent(session.access_token));
    let links;try{links=JSON.parse(await readFile(linksPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;links={version:1,items:{}};}
    if(links.version!==1||!links.items)throw Error('Unsupported AppFlowy link registry.');

    // The home space: stored ids while they still exist, otherwise found by name.
    const workspaces=await api('/api/workspace');
    if(!Array.isArray(workspaces))throw Error('AppFlowy did not list its workspaces.');
    let workspaceId=links.home?.workspaceId;
    if(!workspaces.some(w=>w.workspace_id===workspaceId))workspaceId=workspaces.find(w=>w.workspace_name===HOME_WORKSPACE)?.workspace_id;
    if(!workspaceId)throw Error(`The AppFlowy workspace "${HOME_WORKSPACE}" was not found.`);
    const folder=await api('/api/workspace/'+workspaceId+'/folder?depth=1');
    const spaces=(folder?.children||[]).filter(view=>view.is_space||view.extra?.is_space);
    const space=spaces.find(view=>view.view_id===links.home?.spaceId)||spaces.find(view=>view.name===HOME_SPACE)||spaces[0];
    if(!space)throw Error(`The AppFlowy workspace "${HOME_WORKSPACE}" has no space for blob pages.`);
    if(links.home?.workspaceId!==workspaceId||links.home?.spaceId!==space.view_id){links.home={workspaceId,spaceId:space.view_id};await persist(links);}

    // The blob's page, if it still exists outside the trash.
    const alive=async viewId=>{
      try{const page=await json('/api/workspace/'+workspaceId+'/page-view/'+viewId,{headers});if(page.code!==0||!page.data?.view)return false;}
      catch(error){if(error.status===404)return false;throw error;}
      // Only the trashed pages' own ids count; their neighbour/parent fields name other pages.
      const trashed=new Set(),collect=view=>{if(!view)return;if(view.view_id)trashed.add(view.view_id);if(view.view?.view_id)trashed.add(view.view.view_id);(view.children||[]).forEach(collect);};
      ((await api('/api/workspace/'+workspaceId+'/trash'))?.views||[]).forEach(collect);
      return !trashed.has(viewId);
    };
    let entry=links.items[request.documentId];
    let viewId=entry?.workspaceId===workspaceId&&uuid(entry.viewId)?entry.viewId:null;
    if(viewId&&!entry.pending&&!await alive(viewId))viewId=null;
    if(!viewId||entry.pending){
      // The page id is chosen before asking AppFlowy, so a retried open can never make two pages.
      const id=viewId&&entry?.pending?viewId:randomUUID();
      links.items[request.documentId]={workspaceId,viewId:id,pending:true};await persist(links);
      if(!await alive(id).catch(()=>false)){
        const created=await api('/api/workspace/'+workspaceId+'/page-view',{method:'POST',body:JSON.stringify({parent_view_id:space.view_id,layout:0,name:request.name,view_id:id,collab_id:id})});
        if(created?.view_id&&created.view_id!==id)throw Error('AppFlowy did not confirm the blob page.');
      }
      viewId=id;links.items[request.documentId]={workspaceId,viewId};await persist(links);
    }
    const url=origin+'/app/'+encodeURIComponent(workspaceId)+'/'+encodeURIComponent(viewId);
    return {workspaceId,viewId,url,launchUrl:origin+'/papers-launch#'+new URLSearchParams({workspace_id:workspaceId,view_id:viewId,access_token:session.access_token,refresh_token:session.refresh_token,token_type:'bearer',expires_in:String(session.expires_in||3600)})};
  }
  return {open:request=>{const work=tail.catch(()=>{}).then(()=>ensure(request));tail=work;return work;}};
}
