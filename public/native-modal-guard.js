(function(root){
 'use strict';let blocked=false,scheduled=false;
 const selector='dialog[open],[role=dialog],[aria-modal=true]';
 function update(){scheduled=false;const next=[...document.querySelectorAll(selector)].some(node=>node.getClientRects().length&&!node.hidden);if(next===blocked)return;blocked=next;root.ProximaBlobLayout?.syncOverlay();root.ProximaFullAppFlowy?.setModalBlocked(blocked);}
 function schedule(){if(!scheduled){scheduled=true;queueMicrotask(update);}}
 root.ProximaModalGuard=Object.freeze({blocked:()=>blocked});
 new MutationObserver(records=>{if(records.some(record=>record.type==='attributes'?record.target.matches('dialog,[role=dialog],[aria-modal=true]'):[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches('dialog,[role=dialog],[aria-modal=true]')||node.querySelector('dialog,[role=dialog],[aria-modal=true]')))))schedule();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','class','style','aria-modal']});
 for(const event of ['toggle','close','cancel'])document.addEventListener(event,schedule,true);
 update();
})(globalThis);
