import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./public/phone-back.js',import.meta.url),'utf8');
function setup({dialogs=[],timelines=[],pane=null,active=null}={}){
 let closed=0;const listeners={};const context=vm.createContext({Event,location:{hash:'#/'},addEventListener:(type,cb)=>listeners[type]=cb,document:{activeElement:active,querySelectorAll:s=>s==='dialog[open]'?dialogs:timelines,querySelector:()=>pane},ProximaBlobWorkspaces:{close:()=>closed++}});
 vm.runInContext(source,context);return {back:()=>context.papersPhoneBack(),context,listeners,closed:()=>closed};
}
test('Back cancels the top dialog without closing the pane',()=>{let closed=false;const env=setup({dialogs:[{dispatchEvent:()=>true,close:value=>closed=value}]});assert.equal(env.back(),true);assert.equal(closed,'cancel');assert.equal(env.closed(),0);});
test('a dialog may veto cancellation without falling through to exit',()=>{const env=setup({dialogs:[{dispatchEvent:()=>false,close:()=>assert.fail()}]});assert.equal(env.back(),true);});
test('Back invokes edit cancellation instead of blur-saving',()=>{let cancelled=0;const env=setup({active:{papersCancelEdit:()=>cancelled++}});assert.equal(env.back(),true);assert.equal(cancelled,1);});
test('selection cancellation precedes collapsing blob contents',()=>{let selected=true;const env=setup({timelines:[{getClientRects:()=>[1],papersPhoneBack:()=>{if(!selected)return false;selected=false;return true;}}],pane:{querySelector:()=>null}});assert.equal(env.back(),true);assert.equal(env.closed(),0);assert.equal(env.back(),true);assert.equal(env.closed(),1);});
test('Back returns along visited routes then yields to the phone host',()=>{const env=setup();env.context.location.hash='#/project/a';env.listeners.hashchange();assert.equal(env.back(),true);assert.equal(env.context.location.hash,'#/');env.listeners.hashchange();assert.equal(env.back(),false);});
