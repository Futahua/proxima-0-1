// Identity comes from Papers' durable owner, never from the installed code location.
const identities={
 'dedd3a17-6f98-40ba-8daa-f6ac3d1bf82e':'blue',
 '417c0ac8-2d5c-4f32-9cf0-61c22ac0d774':'green'
};
const palettes={
 blue:{bg:'#22272e',panel:'#292f38',raised:'#323b46',line:'#414d5b',dim:'#a2adba',accent:'#afc3d4',grid:'#718ba038'},
 green:{bg:'#232824',panel:'#292f2b',raised:'#333c35',line:'#424e45',dim:'#a6b0a7',accent:'#b5c3af',grid:'#778c7b38'},
 // The phone (Poordroid): desaturated, so only the frame turns grey; blobs and events keep their colours.
 grey:{bg:'#242526',panel:'#2b2c2e',raised:'#35363a',line:'#45474b',dim:'#a9abaf',accent:'#c4c6ca',grid:'#80828638'}
};
// The grey palette also greys the stylesheet's fixed blue-greys (calendar cells, borders, headers);
// only those exact colours change, so events and blobs keep theirs.
const greyed={'rgb(32, 38, 49)':'rgb(40, 41, 43)','rgb(29, 34, 44)':'rgb(35, 36, 38)','rgb(27, 32, 40)':'rgb(33, 34, 36)','rgb(48, 56, 70)':'rgb(56, 57, 60)'};
function greyOverrides(doc){
 const out=[],keys=Object.keys(greyed);
 const walk=rules=>{for(const rule of rules){if(rule.cssRules&&!rule.selectorText){walk(rule.cssRules);continue;}if(!rule.style||!rule.selectorText)continue;
  const decls=[];for(const name of rule.style){const value=rule.style.getPropertyValue(name);if(keys.some(key=>value.includes(key)))decls.push(name+':'+keys.reduce((text,key)=>text.split(key).join(greyed[key]),value)+(rule.style.getPropertyPriority(name)?' !important':''));}
  if(decls.length)out.push(rule.selectorText.split(',').map(part=>'html[data-proxima-palette="grey"] '+part.trim()).join(',')+'{'+decls.join(';')+'}');}};
 for(const sheet of doc.styleSheets){if(sheet.ownerNode?.id==='proxima-owner-palette')continue;try{walk(sheet.cssRules);}catch{}}
 return out.join('\n');
}
export function applyDeviceTheme(doc,owner){
 // One Proxima on every device (sync), so one look (creator, 2026-10-14): SlopTop's blue everywhere.
 // The per-machine mapping above is kept for reference only.
 const identity='blue',p=palettes[identity];
 doc.documentElement.dataset.proximaPalette=identity;
 let style=doc.getElementById('proxima-owner-palette');if(!style){style=doc.createElement('style');style.id='proxima-owner-palette';doc.head.append(style);}
 style.textContent=`:root{--bg:${p.bg};--panel:${p.panel};--panel-2:${p.raised};--line:${p.line};--dim:${p.dim};--accent:${p.accent};--border:${p.line};--text:var(--ink)}
 html[data-proxima-palette] .date-strip-cell{background:var(--panel);border-right-color:var(--line)}
 html[data-proxima-palette] .exact-day-boundary{background:${p.grid}}
 html[data-proxima-palette] .exact-queue-end,
 html[data-proxima-palette] .exact-queue-end:hover,
 html[data-proxima-palette] .exact-queue-end:active{background:transparent;border:0;border-radius:0;box-shadow:none}
 html[data-proxima-palette] .exact-queue-end::after{border-color:var(--accent)}`+(identity==='grey'?'\n'+greyOverrides(doc):'');
 return p;
}
