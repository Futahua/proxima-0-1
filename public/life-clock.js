/* Maps the creator's 2006–2046 interval onto a 365-day year and 24-hour day. */
(function(root){
 function lifeProgressText(now=new Date()){
  const start=new Date('2006-08-21T00:00:00+07:00'),end=new Date('2046-08-21T00:00:00+07:00');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now).map(x=>[x.type,x.value]));
  const year=Number(parts.year),month=Number(parts.month),day=Number(parts.day);
  const years=year-2006-(month<8||month===8&&day<21?1:0);
  const months=(year-2006)*12+month-8-(day<21?1:0);
  const days=Math.trunc((now-start)/86400000),weeks=Math.trunc(days/7);
  const elapsedMinutes=Math.trunc((now-start)/60000),progress=elapsedMinutes/((end-start)/60000);
  const scaledDays=Math.round(progress*365),scaledMinutes=Math.round(progress*1440);
  const date=new Date(Date.UTC(2024,0,1+scaledDays)).toLocaleDateString('en-US',{timeZone:'UTC',month:'long',day:'numeric'});
  const time=String(Math.floor(scaledMinutes/60)).padStart(2,'0')+':'+String(scaledMinutes%60).padStart(2,'0');
  return `${years}y ${months-years*12}m | ${weeks}w ${days-weeks*7}d | ${days}d | ${date} | ${time}`;
 }
 root.lifeProgressText=lifeProgressText;
 if(typeof document==='undefined')return;
 const node=document.getElementById('lifeProgressClock');if(!node)return;
 const left=document.createElement('button'),right=document.createElement('button');left.type=right.type='button';left.id='overviewProjects';right.id='overviewBoard';left.title='Projects and Schedules';right.title='Board and Deadlines';left.setAttribute('aria-label',left.title);right.setAttribute('aria-label',right.title);left.className=right.className='life-progress-stack';
 const days=document.createElement('span'),weeks=document.createElement('span'),age=document.createElement('span'),years=document.createElement('span'),months=document.createElement('span');
 days.className='life-days';weeks.className='life-weeks';age.className='life-age';years.className='life-years';months.className='life-months';age.append(years,months);const main=document.createElement('span');main.className='life-age-main';main.append(weeks,age);left.append(days,main);
 const calendar=document.createElement('span');calendar.className='life-mini-calendar';const monthLabel=document.createElement('span');monthLabel.className='life-mini-calendar-month';const dayLabel=document.createElement('span');dayLabel.className='life-mini-calendar-day';calendar.append(monthLabel,dayLabel);const timeLabel=document.createElement('span');timeLabel.className='life-calendar-time';right.append(calendar,timeLabel);node.replaceChildren(right,left);
 const tick=()=>{const values=lifeProgressText().split(' | ');const ageParts=values[0].match(/(-?\d+)y (-?\d+)m/);const dayText=values[2].replace(/d$/,'');if(days.dataset.value!==dayText){days.dataset.value=dayText;const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 46 56');svg.setAttribute('width','46');svg.setAttribute('height','56');const defs=document.createElementNS(ns,'defs'),gradient=document.createElementNS(ns,'linearGradient');gradient.id='life-days-fill';gradient.setAttribute('x1','0');gradient.setAttribute('y1','0');gradient.setAttribute('x2','0');gradient.setAttribute('y2','56');gradient.setAttribute('gradientUnits','userSpaceOnUse');for(const color of ['#5ee5ef','#fff']){const stop=document.createElementNS(ns,'stop');stop.setAttribute('stop-color',color);gradient.append(stop);}defs.append(gradient);svg.append(defs);[dayText[0],dayText[1],dayText.slice(2)].forEach((digit,i)=>{const text=document.createElementNS(ns,'text');text.setAttribute('x',i===0?7:i===1?1:24);text.setAttribute('y',i===0?26:49);text.setAttribute('fill','#5ee5ef');text.setAttribute('class',i===2?'life-day-tail':'life-day-large');text.textContent=digit;svg.append(text);});days.replaceChildren(svg);}days.setAttribute('aria-label',dayText+' days');weeks.textContent=values[1].split('w')[0];const remainder=Number(values[1].match(/w (-?\d+)d/)[1]);const fill=Math.max(0,Math.min(1,remainder/7));days.style.setProperty('--week-fill',fill*100+'%');weeks.style.setProperty('--week-fill',fill*100+'%');years.textContent=ageParts[1];months.textContent=ageParts[2];const scaled=values[3].split(' ');monthLabel.textContent=scaled[0].slice(0,3).toUpperCase();dayLabel.textContent=scaled[1];timeLabel.textContent=values[4];right.title='Board and Deadlines · '+values[3]+' · '+values[4];};tick();
 const timer=setInterval(tick,1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})(globalThis);
