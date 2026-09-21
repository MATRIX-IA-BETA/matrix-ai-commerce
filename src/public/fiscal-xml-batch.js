(()=>{
'use strict';
const MAX_XML_BYTES=1024*1024;
const W={downloaded:new Set(),loaded:new Map(),batchIds:new Set(),busyDownload:false,busyUpload:false,busySend:false};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const orderId=tr=>String(tr?.querySelector('.row-select')?.dataset?.id||tr?.querySelector('td.order')?.textContent||'').trim();

function css(){
 if(document.getElementById('matrixFiscalXmlBatchStyle'))return;
 const s=document.createElement('style');s.id='matrixFiscalXmlBatchStyle';
 s.textContent='.matrix-xml-workflow{margin:0 0 14px;border:1px solid var(--line);background:linear-gradient(180deg,#111c34,#0e182d);border-radius:14px;overflow:hidden}.matrix-xml-actions{display:grid;grid-template-columns:minmax(170px,.8fr) repeat(3,minmax(210px,1fr));gap:10px;align-items:stretch;padding:11px 12px}.matrix-xml-selected{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #294367;border-radius:11px;background:#0c172b;min-width:0}.matrix-xml-selected strong{font-size:13px}.matrix-xml-selected small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.matrix-xml-count{width:28px;height:28px;border-radius:8px;background:#1f6feb;display:grid;place-items:center;font-weight:900}.matrix-xml-btn{border:1px solid #31557e;border-radius:11px;padding:10px 13px;color:#fff;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;min-height:58px;text-align:left}.matrix-xml-btn span{display:block}.matrix-xml-btn small{display:block;font-size:10px;font-weight:600;opacity:.85;margin-top:2px}.matrix-xml-btn.download{background:linear-gradient(180deg,#15945f,#0d7047);border-color:#27b579}.matrix-xml-btn.upload{background:linear-gradient(180deg,#6547df,#4830b8);border-color:#7c62ef}.matrix-xml-btn.send{background:linear-gradient(180deg,#1986ff,#0965c9);border-color:#459cf7}.matrix-xml-btn:disabled{opacity:.42;cursor:not-allowed;filter:none}.matrix-xml-queue{display:none;border-top:1px solid var(--line);padding:10px 12px 12px}.matrix-xml-queue.show{display:block}.matrix-xml-queue-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.matrix-xml-queue-head strong{font-size:13px}.matrix-xml-clear{border:1px solid #344d70;background:#17243a;color:#dbe8fb;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:11px}.matrix-xml-list{display:grid;gap:6px}.matrix-xml-item{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1.35fr) 120px;gap:8px;align-items:center;border:1px solid #233c5d;background:#0a1628;border-radius:9px;padding:8px 10px;font-size:11px}.matrix-xml-item .file{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c6d8f1}.matrix-xml-state{justify-self:end;display:inline-flex;padding:4px 8px;border-radius:999px;font-weight:900}.matrix-xml-state.ready,.matrix-xml-state.sent{background:#143e2d;color:#9cf1cf}.matrix-xml-state.wait{background:#1b3555;color:#b9d9ff}.matrix-xml-state.err{background:#451d29;color:#ffb6c0}.matrix-xml-docbadge{display:inline-flex;margin-left:4px;padding:3px 6px;border-radius:999px;font-size:9px;font-weight:900;border:1px solid #345274;background:#102542;color:#bdd7fa}.matrix-xml-docbadge.local{border-color:#684fbb;background:#281f54;color:#d9cbff}.matrix-xml-docbadge.sent{border-color:#2f775c;background:#15362a;color:#9df0cf}@media(max-width:1150px){.matrix-xml-actions{grid-template-columns:1fr 1fr}.matrix-xml-item{grid-template-columns:1fr 1fr}.matrix-xml-item .matrix-xml-state{grid-column:2;justify-self:end}}@media(max-width:700px){.matrix-xml-actions{grid-template-columns:1fr}.matrix-xml-item{grid-template-columns:1fr}.matrix-xml-item .matrix-xml-state{grid-column:auto;justify-self:start}}';
 document.head.appendChild(s);
}
function selectedRows(){
 return [...document.querySelectorAll('#tbody tr')].filter(tr=>tr.querySelector('.row-select:checked')).map(tr=>{
  const id=orderId(tr),b=tr.querySelector('[data-action="download-doc"][data-format="xml"]'),key=String(b?.dataset?.key||'');
  return{tr,id,key,xmlReady:/^\d{44}$/.test(key)&&!b?.disabled};
 }).filter(x=>x.id);
}
function selectedIds(){return selectedRows().map(x=>x.id)}
function snapshot(){W.batchIds=new Set(selectedIds())}
function activeIds(){return W.batchIds.size?[...W.batchIds]:selectedIds()}

function ensure(){
 if(document.getElementById('matrixFiscalXmlWorkflow'))return;
 css();const batchbar=document.querySelector('.batchbar');if(!batchbar)return;
 const box=document.createElement('section');box.id='matrixFiscalXmlWorkflow';box.className='matrix-xml-workflow';
 box.innerHTML='<div class="matrix-xml-actions"><div class="matrix-xml-selected"><div class="matrix-xml-count" id="matrixXmlSelectedCount">0</div><div><strong>vendas selecionadas</strong><small>O desconto e a emissão continuam logo acima.</small></div></div><button class="matrix-xml-btn download" id="matrixXmlDownload" type="button" disabled><span>⇩</span><span><b>BAIXAR XMLs</b><small>Baixa do Bling para o computador</small></span></button><button class="matrix-xml-btn upload" id="matrixXmlUpload" type="button" disabled><span>⇧</span><span><b>CARREGAR XML</b><small>Carregar os arquivos</small></span></button><button class="matrix-xml-btn send" id="matrixXmlSend" type="button" disabled><span>➤</span><span><b>ENVIAR XMLs AO ML</b><small>Envia os XMLs carregados</small></span></button><input id="matrixXmlFiles" type="file" accept=".xml,application/xml,text/xml" multiple hidden></div><div class="matrix-xml-queue" id="matrixXmlQueue"><div class="matrix-xml-queue-head"><strong id="matrixXmlQueueTitle">Arquivos carregados</strong><button class="matrix-xml-clear" id="matrixXmlClear" type="button">Limpar lote XML</button></div><div class="matrix-xml-list" id="matrixXmlList"></div></div>';
 batchbar.after(box);
 document.getElementById('matrixXmlDownload').onclick=downloadSelected;
 document.getElementById('matrixXmlUpload').onclick=()=>{if(!W.batchIds.size)snapshot();document.getElementById('matrixXmlFiles').click()};
 document.getElementById('matrixXmlFiles').onchange=e=>{loadFiles(e.target.files);e.target.value=''};
 document.getElementById('matrixXmlSend').onclick=sendLoaded;
 document.getElementById('matrixXmlClear').onclick=()=>{W.loaded.clear();W.downloaded.clear();W.batchIds.clear();refresh();if(typeof toast==='function')toast('Lote XML limpo.','ok')};
 refresh();
}
function statusFor(i){if(i.status==='identifying')return['wait','Identificando'];if(i.status==='sending')return['wait','Enviando'];if(i.status==='sent')return['sent','Enviado ao ML'];if(i.status==='ready')return['ready','Pronto'];return['err','Erro']}
function queue(){
 const q=document.getElementById('matrixXmlQueue'),list=document.getElementById('matrixXmlList'),title=document.getElementById('matrixXmlQueueTitle');if(!q||!list||!title)return;
 const items=[...W.loaded.values()];q.classList.toggle('show',items.length>0);title.textContent=items.length?'Arquivos carregados ('+items.length+')':'Arquivos carregados';
 list.innerHTML=items.map(i=>{const st=statusFor(i);return '<div class="matrix-xml-item"><strong>Pedido '+esc(i.orderId||'-')+'</strong><span class="file" title="'+esc(i.fileName||'')+'">'+esc(i.fileName||'Arquivo XML')+(i.error?' · '+esc(i.error):'')+'</span><span class="matrix-xml-state '+st[0]+'">'+st[1]+'</span></div>'}).join('');
}
function decorate(){
 document.querySelectorAll('#tbody tr').forEach(tr=>{
  const id=orderId(tr);if(!id)return;const docs=tr.querySelector('.documents');if(!docs)return;docs.querySelectorAll('.matrix-xml-docbadge').forEach(x=>x.remove());
  if(W.downloaded.has(id)){const b=document.createElement('span');b.className='matrix-xml-docbadge';b.textContent='Baixado';docs.appendChild(b)}
  const i=W.loaded.get(id);if(i&&['ready','sending','sent'].includes(i.status)){const b=document.createElement('span');b.className='matrix-xml-docbadge '+(i.status==='sent'?'sent':'local');b.textContent=i.status==='sent'?'ML ✓':'Local ✓';docs.appendChild(b)}
 });
}
function refresh(){
 ensure();
 const sel=selectedRows(),countN=sel.length,downloadable=sel.filter(x=>x.xmlReady).length,count=document.getElementById('matrixXmlSelectedCount'),down=document.getElementById('matrixXmlDownload'),up=document.getElementById('matrixXmlUpload'),send=document.getElementById('matrixXmlSend');
 if(count)count.textContent=String(countN);
 if(down){down.disabled=W.busyDownload||downloadable===0;const b=down.querySelector('b');if(b)b.textContent=W.busyDownload?'BAIXANDO...':'BAIXAR XMLs'+(downloadable?' ('+downloadable+')':'')}
 if(up)up.disabled=W.busyUpload||W.busyDownload||W.busySend||(countN===0&&W.batchIds.size===0);
 const ready=[...W.loaded.values()].filter(x=>x.status==='ready').length;
 if(send){send.disabled=W.busySend||ready===0;const b=send.querySelector('b');if(b)b.textContent=W.busySend?'ENVIANDO...':'ENVIAR XMLs AO ML'+(ready?' ('+ready+')':'')}
 queue();decorate();
}
async function fetchXml(key){
 const r=await fetch('/bling/nfe/document/'+encodeURIComponent(key)+'/xml',{cache:'no-store'});
 if(!r.ok){let msg='Não foi possível baixar o XML do Bling.';try{const j=await r.json();msg=j.mensagem||msg}catch(_){}throw new Error(msg)}return r.blob();
}
function save(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500)}
async function downloadSelected(){
 const rows=selectedRows().filter(x=>x.xmlReady);if(!rows.length){if(typeof toast==='function')toast('Selecione pelo menos uma venda com XML disponível.','bad');return}
 W.busyDownload=true;snapshot();refresh();const files=[],errors=[];
 for(const row of rows){try{const blob=await fetchXml(row.key);files.push({blob,name:'NFe-'+row.key+'.xml',id:row.id});W.downloaded.add(row.id)}catch(e){errors.push(row.id+': '+e.message)}refresh()}
 for(const f of files)save(f.blob,f.name);W.busyDownload=false;refresh();
 if(typeof toast==='function')toast(files.length+' XML'+(files.length===1?' baixado':'s baixados')+(errors.length?' · '+errors.length+' com erro':'' )+'.',errors.length?'bad':'ok');
 if(errors.length)console.error('[FISCAL XML DOWNLOAD]',errors);
}
async function identify(file){
 const i={orderId:null,fileName:file.name,xmlText:'',status:'identifying',error:''};if(file.size>MAX_XML_BYTES){i.status='error';i.error='Arquivo maior que 1 MB.';return i}
 try{
  i.xmlText=await file.text();const r=await fetch('/api/ml/xml-upload/identify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xml:i.xmlText}),cache:'no-store'}),j=await r.json().catch(()=>({}));
  if(!r.ok||j.sucesso===false)throw new Error(j.mensagem||'Não foi possível identificar o XML.');i.orderId=String(j.order_id||'');const active=new Set(activeIds());if(active.size&&!active.has(i.orderId))throw new Error('O XML pertence ao pedido '+i.orderId+', que não está no lote selecionado.');i.status='ready';i.context=j;
 }catch(e){i.status='error';i.error=e.message}return i;
}
async function loadFiles(fileList){
 const files=[...(fileList||[])].filter(f=>/\.xml$/i.test(f.name));if(!files.length){if(typeof toast==='function')toast('Selecione um ou mais arquivos XML.','bad');return}
 if(!W.batchIds.size)snapshot();W.busyUpload=true;refresh();let ok=0,err=0;
 for(const file of files){
  const temp='loading:'+file.name+':'+Date.now()+':'+Math.random();W.loaded.set(temp,{orderId:'-',fileName:file.name,xmlText:'',status:'identifying',error:''});refresh();
  const i=await identify(file);W.loaded.delete(temp);
  if(i.orderId){const old=W.loaded.get(i.orderId);if(old&&old.status==='sent'){i.status='error';i.error='Este pedido já foi enviado ao ML nesta sessão.'}W.loaded.set(i.orderId,i)}else W.loaded.set('error:'+file.name+':'+Date.now(),i);
  if(i.status==='ready')ok++;else err++;refresh();
 }
 W.busyUpload=false;refresh();if(typeof toast==='function')toast(ok+' XML'+(ok===1?' carregado':'s carregados')+(err?' · '+err+' com erro':'' )+'.',err?'bad':'ok');
}
async function sendLoaded(){
 const items=[...W.loaded.values()].filter(x=>x.status==='ready'&&x.orderId&&x.xmlText);if(!items.length)return;W.busySend=true;refresh();let ok=0,err=0;const errors=[];
 for(const i of items){
  i.status='sending';refresh();
  try{const r=await fetch('/api/ml/xml-upload/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xml:i.xmlText})}),j=await r.json().catch(()=>({}));if(!r.ok||j.sucesso===false)throw new Error(j.mensagem||'Mercado Livre recusou o XML.');i.status='sent';i.error='';ok++}
  catch(e){i.status='error';i.error=e.message;err++;errors.push(i.orderId+': '+e.message)}
  refresh();
 }
 W.busySend=false;refresh();if(typeof toast==='function')toast('Envio concluído: '+ok+' enviado'+(ok===1?'':'s')+(err?' · '+err+' com erro':'' )+'.',err?'bad':'ok');if(errors.length)console.error('[FISCAL XML ML]',errors);
}
function observe(){const tbody=document.getElementById('tbody');if(tbody)new MutationObserver(()=>setTimeout(refresh,0)).observe(tbody,{childList:true,subtree:false});document.addEventListener('change',e=>{if(e.target.matches('.row-select,.select-all'))setTimeout(refresh,0)})}
function init(){ensure();observe();refresh()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();