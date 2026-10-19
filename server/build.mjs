import {createRequire} from 'node:module';
import {mkdir,copyFile,writeFile,cp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const papers=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Pass the Papers source checkout path.');
const require=createRequire(path.join(papers,'package.json')),{build}=require('esbuild');
const out=path.join(here,'dist');await mkdir(out,{recursive:true});
await build({stdin:{contents:`export {WorkspaceFiles} from './src/main/backpacks/workspaceFiles.ts';export {RemoteDeviceService} from './src/main/backpacks/remoteDeviceService.ts';export {Server as TusServer} from '@tus/server';export {FileStore} from '@tus/file-store';`,resolveDir:papers},outfile:path.join(out,'host.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',plugins:[{name:'omit-unused-electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',external:true,sideEffects:false}));}}]});
for(const name of ['sync-core','workspace-domain','workspace-replica'])await copyFile(path.join(here,'../public',name+'.js'),path.join(out,name+'.js'));
await copyFile(path.join(here,'main.mjs'),path.join(out,'main.mjs'));
for(const name of ['calendar.mjs','portal.mjs','web-domain.mjs','browser-workspace.mjs','preview-extract.mjs'])await copyFile(path.join(here,name),path.join(out,name));
await cp(path.join(here,'../public'),path.join(out,'public'),{recursive:true});await cp(path.join(here,'web'),path.join(out,'web'),{recursive:true});
// Reuse the installed phone's mouse/gesture controllers on iOS and Android web too.
for(const name of ['phone-mouse.js','proxima-phone.js']){
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(path.join(papers,'clients/android/assets',name),'utf8');
 await writeFile(path.join(out,'web',name),'if(globalThis.ProximaWebPlatform?.touch){\n'+source.replace("const api = { active: () => mode !== 'off' };","const api = { active: () => mode !== 'off', stop: () => hide() };")+'\n}');
}
const ayg=process.argv[3];if(!ayg)throw Error('Pass the As you Go source checkout path as the third argument.');
await cp(path.join(ayg,'public'),path.join(out,'ayg'),{recursive:true});
// The original pane's browser entry lives under the same capability URL.
const blob=await readFile(path.join(out,'public/blob-workspaces.js'),'utf8');
await writeFile(path.join(out,'public/blob-workspaces.js'),blob.replace("new URL('../ayg/workspace-20260730b.html',location.href)","new URL('ayg/workspace-20260730b.html',location.href)").replace("url.searchParams.set('papers-inline-device','1')","url.searchParams.set('papers-inline-device','0')"));
await build({stdin:{contents:`export {Upload} from 'tus-js-client';`,resolveDir:papers},outfile:path.join(out,'web/tus.js'),bundle:true,platform:'browser',format:'iife',globalName:'tus',target:'es2020',minify:true});
await writeFile(path.join(out,'package.json'),JSON.stringify({private:true,type:'module'}));
console.log('Headless replica built at '+out);
