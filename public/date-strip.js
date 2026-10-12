/* Shared date cells for calendar and exact timeline rulers. */
(function(root){
 const zone='Asia/Ho_Chi_Minh';
 const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long'}),fullFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'full'});let todayBucket=null,todayParts=null;
 const parts=t=>Object.fromEntries(formatter.formatToParts(new Date(t)).map(p=>[p.type,p.value]));
 function update(cell,t){const bucket=Math.floor((Date.now()+7*3600000)/86400000);if(bucket!==todayBucket){todayBucket=bucket;todayParts=parts(Date.now());}if(cell.dateStripTimestamp!==t){const date=parts(t);cell.dateStripTimestamp=t;cell.dateStripDate=date;cell.dataset.dateKey=date.year+'-'+date.month+'-'+date.day;cell.classList.add('date-strip-cell');if(!cell.firstChild)cell.append(document.createElement('strong'),document.createElement('span'));cell.firstChild.textContent=String(Number(date.day));cell.lastChild.textContent=date.weekday;cell.setAttribute('aria-label',fullFormatter.format(new Date(t)));}const date=cell.dateStripDate,today=todayParts;cell.classList.toggle('is-today',date.year===today.year&&date.month===today.month&&date.day===today.day);return cell;}
 root.DateStrip={update,create:t=>update(document.createElement('div'),t)};
})(globalThis);
