/* Shared date cells for calendar and exact timeline rulers. */
(function(root){
 const zone='Asia/Ho_Chi_Minh';
 const parts=t=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(new Date(t)).map(p=>[p.type,p.value]));
 function update(cell,t){const date=parts(t),today=parts(Date.now());cell.classList.add('date-strip-cell');cell.classList.toggle('is-today',date.year===today.year&&date.month===today.month&&date.day===today.day);if(!cell.firstChild){cell.append(document.createElement('strong'),document.createElement('span'));}cell.firstChild.textContent=String(Number(date.day));cell.lastChild.textContent=date.weekday[0];cell.setAttribute('aria-label',new Date(t).toLocaleDateString('en-GB',{timeZone:zone,dateStyle:'full'}));return cell;}
 root.DateStrip={update,create:t=>update(document.createElement('div'),t)};
})(globalThis);
