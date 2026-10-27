/* Android Back delegates to the current surface owner before the phone host
 * closes Proxima. No key synthesis, storage changes or extra navigation store. */
(function(root){
 const trail=[location.hash];let returning=false;
 addEventListener('hashchange',()=>{if(returning){returning=false;return;}if(trail.at(-1)!==location.hash)trail.push(location.hash);});
 root.papersPhoneBack=()=>{
  const dialogs=[...document.querySelectorAll('dialog[open]')];
  const dialog=dialogs.at(-1);
  if(dialog){const cancel=new Event('cancel',{cancelable:true});if(dialog.dispatchEvent(cancel))dialog.close('cancel');return true;}
  const active=document.activeElement;
  if(typeof active?.papersCancelEdit==='function'){active.papersCancelEdit();return true;}
  // Popovers and selection are transient and must cancel before leaving a pane.
  for(const timeline of [...document.querySelectorAll('[data-proxima-back]')].reverse()){
   if(timeline.getClientRects().length&&timeline.papersPhoneBack?.())return true;
  }
  const pane=document.querySelector('.blob-workspace-pane:not([hidden])');
  if(pane){
   const frame=pane.querySelector('iframe');
   try{if(frame?.contentWindow?.papersPhoneBack?.())return true;}catch{}
   root.ProximaBlobWorkspaces?.close();return true;
  }
  if(trail.length>1){trail.pop();returning=true;location.hash=trail.at(-1);return true;}
  return false;
 };
})(globalThis);
