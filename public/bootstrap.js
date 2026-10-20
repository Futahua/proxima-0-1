(async()=>{
 try{
  await ProximaPersistence.ready;
  for(const name of ['schedule-fixture','remote-domain','schedule-projection','remote-follow','store','schedule-zoom','life-clock','date-strip','marquee-controller','exact-timeline','appflowy-workspace','blob-workspaces','blob-pane-controls','app']){
   await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=name+'.js?v=calendar-native-peek-v173';script.onload=resolve;script.onerror=reject;document.body.append(script);});
   if(name==='store'&&globalThis.__proximaDevice)Store.command=globalThis.__proximaDevice.command;
   if(name==='store'){
    globalThis.__papersFlushBeforeClose=()=>Store.flushCommands();
    if(!globalThis.__proximaDevice){
     globalThis.__papersSharedData=(source,control=false)=>Store.remoteProjection(source,null,control===true);
     globalThis.__papersSharedCommand=async(source,envelope)=>{
      if(!envelope||typeof envelope.commandId!=='string'||!envelope.commandId||!Number.isSafeInteger(envelope.expectedSeq)||! /^(?:task|project|run|schedule-event|timeline-interval|timeline-queue)\.[a-z.-]+$|^timeline\.(?:undo|redo)$/.test(envelope.type))throw Error('Invalid Proxima command.');
      const command=await Store.command({...envelope,actor:'remote-device',client:'papers-remote'});
      const snapshot=await Store.remoteProjection(source,null,true);
      if(command.ok&&command.changed)dispatchEvent(new Event('proxima:remote-imported'));
      return {command,snapshot};
     };
    }
   }
   if(name==='store'&&!globalThis.__proximaDevice&&!localStorage.getItem('proxima.timeline.rows-migrated.v1')){const result=await Store.command({type:'timeline.migrate'});if(!result.ok)throw new Error('Could not migrate timeline rows');localStorage.setItem('proxima.timeline.rows-migrated.v1','1');}
  }
  if(globalThis.__proximaDevice)globalThis.__proximaDeviceButtons();else if(globalThis.__proximaPhoneLocal)globalThis.__proximaPhoneLocal.buttons();else await import('./remote-devices.js?v=one-palette');
 }catch(error){const message=document.createElement('p');message.setAttribute('role','alert');message.textContent='Could not open saved data. Your existing data is preserved. '+error.message;document.body.prepend(message);console.error(error);}
})();
