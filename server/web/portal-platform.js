// Platform chooses input defaults, never which calendar features are available.
(()=>{
 const ua=navigator.userAgent||'',platform=navigator.userAgentData?.platform||navigator.platform||'';
 const ios=/iPad|iPhone|iPod/.test(ua)||(/Mac/.test(platform)&&navigator.maxTouchPoints>1);
 const android=/Android/i.test(ua+' '+platform),os=ios?'ios':android?'android':'pc';
 let mode='auto';try{mode=localStorage.getItem('proxima.web.input')||'auto';}catch{}
 if(!['auto','touch','desktop'].includes(mode))mode='auto';
 const touch=mode==='touch'||mode==='auto'&&(ios||android||matchMedia('(pointer:coarse)').matches);
 const html=document.documentElement;html.dataset.platform=os;html.dataset.input=touch?'touch':'desktop';html.classList.toggle('proxima-phone-local',touch);
 const url=new URL(location.href);if(touch)url.searchParams.set('papers-phone','1');else url.searchParams.delete('papers-phone');history.replaceState(null,'',url);
 globalThis.ProximaWebPlatform={os,touch,mode,setMode(value){try{localStorage.setItem('proxima.web.input',value);}catch{}location.reload();}};
})();
