// Keeps BOP's Papers server running from a folder BOP's own user can update (no administrator rights).
// node supervisor.mjs <app root> <data directory> [mirror root]
//   <app root>\current.txt     names the app folder to run (e.g. app-20261018)
//   <app root>\restart.request touch it to restart the server on the current app folder
import {spawn,execFile} from 'node:child_process';
import {readFileSync,statSync,appendFileSync,renameSync,existsSync} from 'node:fs';
import path from 'node:path';
const [root,data,mirror]=process.argv.slice(2);
if(!root||!data)throw Error('Pass the app root and the data directory.');
const flag=path.join(root,'restart.request'),logFile=path.join(root,'server.log');
const mtime=()=>{try{return statSync(flag).mtimeMs;}catch{return 0;}};
function log(text){try{if(existsSync(logFile)&&statSync(logFile).size>5*1024**2)renameSync(logFile,logFile+'.old');appendFileSync(logFile,new Date().toISOString()+' '+text+(text.endsWith('\n')?'':'\n'));}catch{}}
let child=null,seen=mtime(),quick=false;
function start(){
  let app='';try{app=readFileSync(path.join(root,'current.txt'),'utf8').trim();}catch{}
  if(!app||/[\/:]|\.\./.test(app)||!existsSync(path.join(root,app,'main.mjs'))){log('supervisor: current.txt does not name an app folder with main.mjs');setTimeout(start,5000);return;}
  log('supervisor: starting '+app);
  child=spawn(process.execPath,[path.join(root,app,'main.mjs'),data],{cwd:path.join(root,app),stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',d=>log(String(d)));child.stderr.on('data',d=>log('ERR '+String(d)));
  const started=child;child.on('exit',code=>{log('supervisor: server exited '+code);child=null;setTimeout(start,quick?300:3000);quick=false;});
  setTimeout(()=>{if(child===started)mirrorNow();},20000); // only a version that stays up is copied
}
// Mirror the code (not logs) when the mirror's drive is present; robocopy /MIR keeps it identical.
let mirroring=false;
function mirrorNow(){
  if(!mirror||mirroring||!existsSync(path.parse(mirror).root))return;mirroring=true;
  execFile('robocopy.exe',[root,mirror,'/MIR','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XF','server.log','server.log.old','restart.request'],{windowsHide:true},error=>{mirroring=false;if(error&&error.code>=8)log('supervisor: mirror to '+mirror+' failed ('+error.code+')');});
}
setInterval(mirrorNow,10*60*1000);
setInterval(()=>{const m=mtime();if(m!==seen){seen=m;log('supervisor: restart requested');if(child){quick=true;child.kill();}}},1000);
start();
