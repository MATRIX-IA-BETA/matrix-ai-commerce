(()=>{
'use strict';
const $=id=>document.getElementById(id);
const state={products:[],movements:[],kits:[],view:'dashboard',movementMode:'entry',inventory:new Map(),loading:false};
const money=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const qtyFmt=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2});
const dateFmt=new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'});

function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function productId(p){return Number(p.product_id||p.id||0)}
function physical(p){return !['kit','service'].includes(String(p.product_type||''))}
function typeLabel(t){return({component:'Peça',simple:'Produto',kit:'Kit / PC',service:'Serviço'})[t]||t||'-'}
function movementLabel(t){return({entry:'Entrada',adjustment:'Ajuste',sale:'Venda',cancellation_return:'Estorno',production:'Produção',inventory:'Inventário',rma_transfer:'RMA'})[t]||t||'Movimento'}
function status(el,type,msg){el.className='statusBox show '+type;el.textContent=msg}
function clearStatus(el){el.className='statusBox';el.textContent=''}
async function api(url,options={}){
  const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.sucesso===false)throw new Error(d.mensagem||('Erro '+r.status));
  return d;
}
function openModal(id){$(id).classList.add('show')}
function closeModals(){document.querySelectorAll('.modal.show').forEach(x=>x.classList.remove('show'))}
document.querySelectorAll('.closeModal').forEach(b=>b.addEventListener('click',closeModals));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModals()}));

function setView(view){
  state.view=view;
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+view));
  document.querySelectorAll('#moduleBar button[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if(view==='inventory')renderInventory();
}
document.getElementById('moduleBar').addEventListener('click',e=>{const b=e.target.closest('button[data-view]');if(b)setView(b.dataset.view)});
document.addEventListener('click',e=>{const j=e.target.closest('[data-jump]');if(j)setView(j.dataset.jump)});

function productOptions(){
  return state.products.filter(physical).map(p=>'<option value="'+productId(p)+'">'+esc(p.sku||'')+' · '+esc(p.name||'')+'</option>').join('');
}
function filteredProducts(searchId,typeId){
  const q=($(searchId)?.value||'').trim().toLowerCase();
  const t=$(typeId)?.value||'';
  return state.products.filter(p=>{
    if(t&&p.product_type!==t)return false;
    if(!q)return true;
    return [p.sku,p.name,p.category,p.supplier_name,p.location_code].some(v=>String(v||'').toLowerCase().includes(q));
  });
}
function stockClass(v){return num(v)<0?'negative':num(v)>0?'positive':''}

function renderKpis(){
  const physicalRows=state.products.filter(physical);
  const value=physicalRows.reduce((s,p)=>s+num(p.stock_value),0);
  const total=physicalRows.reduce((s,p)=>s+num(p.total??p.on_hand),0);
  const rma=physicalRows.reduce((s,p)=>s+num(p.rma),0);
  const negative=physicalRows.filter(p=>num(p.available)<0||num(p.total??p.on_hand)<0).length;
  const low=physicalRows.filter(p=>p.below_minimum||num(p.available)<0||num(p.total??p.on_hand)<0).length;
  $('kValue').textContent=money.format(value);
  $('kProducts').textContent=String(state.products.length);
  $('kOnHand').textContent=qtyFmt.format(total);
  $('kRma').textContent=qtyFmt.format(rma);
  $('kNegative').textContent=String(negative);
  $('kLow').textContent=String(low);
}
function renderDashboard(){
  const rows=filteredProducts('dashSearch','dashType').slice(0,120);
  $('dashRows').innerHTML=rows.length?rows.map(p=>'<tr>'+
    '<td class="sku">'+esc(p.sku)+'</td>'+
    '<td class="productName">'+esc(p.name)+'</td>'+
    '<td>'+esc(p.category||'-')+'</td>'+
    '<td class="num '+stockClass(p.total??p.on_hand)+'">'+qtyFmt.format(num(p.total??p.on_hand))+'</td>'+
    '<td class="num '+stockClass(p.available)+'">'+qtyFmt.format(num(p.available))+'</td>'+
    '<td class="num">'+qtyFmt.format(num(p.rma))+'</td>'+
    '<td title="'+esc(p.rma_note||'')+'">'+esc(p.rma_note||'-')+'</td>'+
    '<td class="num">'+qtyFmt.format(num(p.minimum_stock))+'</td>'+
    '<td class="num">'+money.format(num(p.actual_cost))+'</td>'+
    '<td class="num">'+money.format(num(p.stock_value))+'</td>'+
  '</tr>').join(''):'<tr><td colspan="10" class="empty">Nenhum produto encontrado.</td></tr>';
  const mov=state.movements.slice(0,12);
  $('dashMovements').innerHTML=mov.length?mov.map(m=>{
    const q=num(m.quantity),d=new Date(m.created_at);
    return '<div class="movement"><span class="muted">'+(isNaN(d)?'-':dateFmt.format(d))+'</span><div><strong>'+esc(m.product_name||m.product_sku||'Produto')+'</strong><div class="muted">'+esc(movementLabel(m.movement_type))+(m.notes?' · '+esc(m.notes):'')+'</div></div><span class="qty '+(q<0?'negative':'positive')+'">'+(q>0?'+':'')+qtyFmt.format(q)+'</span><span class="muted">'+(m.unit_cost==null?'':money.format(num(m.unit_cost)))+'</span></div>';
  }).join(''):'<div class="empty">Nenhuma movimentação registrada.</div>';
}
function renderProducts(){
  const rows=filteredProducts('productSearch','productType');
  $('productRows').innerHTML=rows.length?rows.map(p=>{
    const id=productId(p),isKit=p.product_type==='kit';
    const situation=(p.below_minimum||num(p.total??p.on_hand)<0||num(p.available)<0)?'<span class="tag low">atenção</span>':'';
    return '<tr>'+
      '<td class="sku">'+esc(p.sku)+'</td>'+
      '<td><span class="productName">'+esc(p.name)+'</span> '+situation+'</td>'+
      '<td>'+esc(p.category||'-')+'</td>'+
      '<td><span class="tag '+(isKit?'kit':'')+'">'+esc(typeLabel(p.product_type))+'</span></td>'+
      '<td class="num '+stockClass(p.total??p.on_hand)+'">'+qtyFmt.format(num(p.total??p.on_hand))+'</td>'+
      '<td class="num '+stockClass(p.available)+'">'+qtyFmt.format(num(p.available))+'</td>'+
      '<td class="num">'+qtyFmt.format(num(p.rma))+'</td>'+
      '<td title="'+esc(p.rma_note||'')+'">'+esc(p.rma_note||'-')+'</td>'+
      '<td class="num">'+qtyFmt.format(num(p.minimum_stock))+'</td>'+
      '<td class="num">'+money.format(num(p.actual_cost))+'</td>'+
      '<td>'+esc(p.supplier_name||'-')+'</td>'+
      '<td>'+esc(p.location_code||'-')+'</td>'+
      '<td>'+(isKit?'<button class="btn" data-action="kit-detail" data-id="'+id+'">Composição</button>':'<button class="btn" data-action="edit" data-id="'+id+'">Ajustar</button> <button class="btn purple" data-action="rma" data-id="'+id+'">RMA</button>')+'</td>'+
    '</tr>';
  }).join(''):'<tr><td colspan="13" class="empty">Nenhum produto encontrado.</td></tr>';
}
function renderMovements(){
  const filter=$('movementFilter').value;
  const rows=state.movements.filter(m=>!filter||m.movement_type===filter);
  $('movementRows').innerHTML=rows.length?rows.map(m=>{
    const q=m.movement_type==='rma_transfer'?num(m.metadata?.rma_delta):num(m.quantity),d=new Date(m.created_at),suffix=m.movement_type==='rma_transfer'?' RMA':'';
    return '<div class="movement"><span class="muted">'+(isNaN(d)?'-':dateFmt.format(d))+'</span><div><strong>'+esc(m.product_name||m.product_sku||'Produto')+'</strong><div class="muted">'+esc(movementLabel(m.movement_type))+(m.notes?' · '+esc(m.notes):'')+(m.marketplace_order_id?' · ML '+esc(m.marketplace_order_id):'')+'</div></div><span class="qty '+(q<0?'negative':'positive')+'">'+(q>0?'+':'')+qtyFmt.format(q)+suffix+'</span><span class="muted">'+(m.unit_cost==null?'':money.format(num(m.unit_cost)))+'</span></div>';
  }).join(''):'<div class="empty">Nenhuma movimentação nesse filtro.</div>';
}
function renderLow(){
  const rows=state.products.filter(p=>physical(p)&&(p.below_minimum||num(p.total??p.on_hand)<0||num(p.available)<0));
  $('lowRows').innerHTML=rows.length?rows.map(p=>{
    const negative=num(p.total??p.on_hand)<0||num(p.available)<0;
    return '<tr><td class="sku">'+esc(p.sku)+'</td><td class="productName">'+esc(p.name)+'</td><td class="num '+stockClass(p.total??p.on_hand)+'">'+qtyFmt.format(num(p.total??p.on_hand))+'</td><td class="num '+stockClass(p.available)+'">'+qtyFmt.format(num(p.available))+'</td><td class="num">'+qtyFmt.format(num(p.rma))+'</td><td class="num">'+qtyFmt.format(num(p.minimum_stock))+'</td><td><span class="tag '+(negative?'low':'')+'">'+(negative?'NEGATIVO':'ABAIXO DO MÍNIMO')+'</span></td><td><button class="btn" data-action="edit" data-id="'+productId(p)+'">Ajustar</button> <button class="btn purple" data-action="rma" data-id="'+productId(p)+'">RMA</button></td></tr>';
  }).join(''):'<tr><td colspan="8" class="empty">Nenhum item abaixo do mínimo ou negativo.</td></tr>';
}
function renderKits(){
  $('kitGrid').innerHTML=state.kits.length?state.kits.map(k=>'<div class="kitCard" data-action="kit-detail" data-id="'+Number(k.id)+'"><h3>'+esc(k.name)+'</h3><div class="sku">'+esc(k.sku||'-')+'</div><div class="muted" style="margin-top:7px">'+esc(k.category||'Sem categoria')+'</div><div class="kitMeta"><span class="tag kit">'+Number(k.component_count||0)+' componentes</span>'+(k.mlb?'<span class="tag">MLB '+esc(k.mlb)+'</span>':'<span class="tag">Sem MLB</span>')+(k.active===false?'<span class="tag low">Inativo</span>':'')+'</div></div>').join(''):'<div class="empty">Nenhum kit cadastrado.</div>';
}
function renderInventory(){
  const q=($('inventorySearch').value||'').trim().toLowerCase();
  const rows=state.products.filter(p=>physical(p)&&(!q||[p.sku,p.name,p.category].some(v=>String(v||'').toLowerCase().includes(q))));
  $('inventoryRows').innerHTML=rows.length?rows.map(p=>{
    const id=productId(p),current=num(p.total??p.on_hand),has=state.inventory.has(id),counted=has?state.inventory.get(id):'',diff=has?num(counted)-current:0;
    return '<tr class="'+(has?'changedRow':'')+'"><td class="sku">'+esc(p.sku)+'</td><td class="productName">'+esc(p.name)+'</td><td class="num '+stockClass(current)+'">'+qtyFmt.format(current)+'</td><td class="num"><input class="inventoryCount" data-inventory-id="'+id+'" type="number" step="0.01" value="'+esc(counted)+'" placeholder="contar"></td><td class="num '+(has?stockClass(diff):'')+'" id="inv-diff-'+id+'">'+(has?(diff>0?'+':'')+qtyFmt.format(diff):'-')+'</td></tr>';
  }).join(''):'<tr><td colspan="5" class="empty">Nenhum item encontrado.</td></tr>';
  $('applyInventoryBtn').disabled=state.inventory.size===0;
}
function renderAll(){renderKpis();renderDashboard();renderProducts();renderMovements();renderLow();renderKits();if(state.view==='inventory')renderInventory()}

async function load(){
  if(state.loading)return;state.loading=true;
  $('refreshBtn').disabled=true;$('refreshBtn').textContent='Atualizando...';
  try{
    const [p,m,k]=await Promise.all([api('/stock/products'),api('/stock/movements?limit=250'),api('/stock/kits')]);
    state.products=p.produtos||[];state.movements=m.movimentos||[];state.kits=k.kits||[];
    $('mProduct').innerHTML=productOptions();
    renderAll();
  }catch(e){alert('Estoque 2.0: '+e.message)}
  finally{state.loading=false;$('refreshBtn').disabled=false;$('refreshBtn').textContent='Atualizar'}
}
$('refreshBtn').addEventListener('click',load);
['dashSearch','dashType'].forEach(id=>$(id).addEventListener('input',renderDashboard));
['productSearch','productType'].forEach(id=>$(id).addEventListener('input',renderProducts));
$('movementFilter').addEventListener('change',renderMovements);
$('inventorySearch').addEventListener('input',renderInventory);

$('newProductBtn').addEventListener('click',()=>{
  clearStatus($('productStatus'));
  ['pSku','pName','pCategory','pSupplier','pLocation','pDescription'].forEach(id=>$(id).value='');
  $('pType').value='component';$('pMinimum').value='0';$('pCost').value='0';openModal('productModal');
});
$('saveProductBtn').addEventListener('click',async()=>{
  const b=$('saveProductBtn');try{
    b.disabled=true;clearStatus($('productStatus'));
    const payload={sku:$('pSku').value.trim(),name:$('pName').value.trim(),category:$('pCategory').value.trim()||null,product_type:$('pType').value,minimum_stock:num($('pMinimum').value),actual_cost:num($('pCost').value),supplier_name:$('pSupplier').value.trim()||null,location_code:$('pLocation').value.trim()||null,description:$('pDescription').value.trim()||null};
    if(!payload.sku||!payload.name)throw new Error('SKU e nome são obrigatórios.');
    await api('/stock/products',{method:'POST',body:JSON.stringify(payload)});
    status($('productStatus'),'ok','Produto salvo.');await load();setTimeout(closeModals,450);
  }catch(e){status($('productStatus'),'err',e.message)}finally{b.disabled=false}
});

function openMovement(mode){
  state.movementMode=mode;clearStatus($('movementStatus'));$('mProduct').innerHTML=productOptions();$('mQuantity').value='1';$('mCost').value='';$('mNotes').value='';
  if(mode==='entry'){$('movementTitle').textContent='Entrada de estoque';$('mCostField').style.display='block';$('mNotes').placeholder='Ex.: compra do fornecedor...'}
  else{$('movementTitle').textContent='Ajuste de estoque';$('mCostField').style.display='none';$('mNotes').placeholder='Ex.: correção após conferência...'}
  openModal('movementModal');
}
$('entryBtn').addEventListener('click',()=>openMovement('entry'));
$('adjustBtn').addEventListener('click',()=>openMovement('adjustment'));
$('saveMovementBtn').addEventListener('click',async()=>{
  const b=$('saveMovementBtn');try{
    b.disabled=true;clearStatus($('movementStatus'));
    let q=num($('mQuantity').value);if(state.movementMode==='entry')q=Math.abs(q);if(!q)throw new Error('Informe uma quantidade diferente de zero.');
    const payload={product_id:Number($('mProduct').value),quantity:q,movement_type:state.movementMode,notes:$('mNotes').value.trim()||null};
    if(state.movementMode==='entry'&&$('mCost').value.trim()!=='')payload.unit_cost=num($('mCost').value);
    await api('/stock/movements',{method:'POST',body:JSON.stringify(payload)});
    status($('movementStatus'),'ok','Movimentação registrada.');await load();setTimeout(closeModals,450);
  }catch(e){status($('movementStatus'),'err',e.message)}finally{b.disabled=false}
});

function openEdit(id){
  const p=state.products.find(x=>productId(x)===Number(id));if(!p)return;
  clearStatus($('editStatus'));$('eProductId').value=String(id);$('eProductName').value=(p.sku||'')+' · '+(p.name||'');$('eQuantity').value=String(num(p.total??p.on_hand));$('eCost').value=String(num(p.actual_cost));$('eNotes').value='';openModal('editModal');
}
$('saveEditBtn').addEventListener('click',async()=>{
  const b=$('saveEditBtn'),id=Number($('eProductId').value);try{
    b.disabled=true;clearStatus($('editStatus'));
    await api('/stock/products/'+id+'/manual',{method:'PATCH',body:JSON.stringify({quantity:num($('eQuantity').value),actual_cost:num($('eCost').value),notes:$('eNotes').value.trim()||'Ajuste manual Estoque Matrix 2.0'})});
    status($('editStatus'),'ok','Ajuste registrado no histórico.');await load();setTimeout(closeModals,450);
  }catch(e){status($('editStatus'),'err',e.message)}finally{b.disabled=false}
});

function openRma(id){
  const p=state.products.find(x=>productId(x)===Number(id));if(!p)return;
  clearStatus($('rmaStatus'));
  $('rProductId').value=String(id);
  $('rProductName').value=(p.sku||'')+' · '+(p.name||'');
  $('rTotal').value=String(num(p.total??p.on_hand));
  $('rAvailable').value=String(num(p.available));
  $('rQuantity').value=String(num(p.rma));
  $('rNote').value=p.rma_note||'';
  openModal('rmaModal');
}
$('rQuantity').addEventListener('input',()=>{
  $('rAvailable').value=String(num($('rTotal').value)-num($('rQuantity').value));
});
$('saveRmaBtn').addEventListener('click',async()=>{
  const b=$('saveRmaBtn'),id=Number($('rProductId').value);
  try{
    b.disabled=true;clearStatus($('rmaStatus'));
    await api('/stock/products/'+id+'/rma',{method:'PATCH',body:JSON.stringify({rma_quantity:num($('rQuantity').value),rma_note:$('rNote').value.trim()})});
    status($('rmaStatus'),'ok','RMA atualizado. O TOTAL permaneceu igual e o DISPONÍVEL foi recalculado.');
    await load();setTimeout(closeModals,550);
  }catch(e){status($('rmaStatus'),'err',e.message)}finally{b.disabled=false}
});

async function openKit(id){
  $('kitTitle').textContent='Composição do kit';$('kitDetail').innerHTML='<div class="empty">Carregando...</div>';openModal('kitModal');
  try{
    const d=await api('/stock/kits/'+id),k=d.kit||{};$('kitTitle').textContent=(k.sku?k.sku+' · ':'')+(k.name||'Kit');
    const pmap=new Map(state.products.map(p=>[productId(p),p]));
    const components=Array.isArray(k.components)?k.components:[];
    $('kitDetail').innerHTML=components.length?components.map(c=>{
      const p=pmap.get(Number(c.component_product_id))||{},subs=Array.isArray(c.substitutes)?c.substitutes:[];
      return '<div class="kitDetailLine"><div><strong>'+esc(p.name||('Produto #'+c.component_product_id))+'</strong><div class="muted">'+esc(p.sku||'')+(subs.length?' · substitutos: '+subs.map(s=>{const sp=pmap.get(Number(s.substitute_product_id))||{};return esc(sp.sku||sp.name||('#'+s.substitute_product_id))}).join(', '):'')+'</div></div><strong style="text-align:right">'+qtyFmt.format(num(c.quantity))+' UN</strong></div>';
    }).join(''):'<div class="empty">Kit ainda sem composição cadastrada.</div>';
  }catch(e){$('kitDetail').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-action]');if(!b)return;
  if(b.dataset.action==='edit')openEdit(b.dataset.id);
  if(b.dataset.action==='rma')openRma(b.dataset.id);
  if(b.dataset.action==='kit-detail')openKit(b.dataset.id);
});

$('inventoryRows').addEventListener('input',e=>{
  const input=e.target.closest('[data-inventory-id]');if(!input)return;
  const id=Number(input.dataset.inventoryId),p=state.products.find(x=>productId(x)===id);if(!p)return;
  if(input.value==='')state.inventory.delete(id);else state.inventory.set(id,num(input.value));
  const diff=state.inventory.has(id)?state.inventory.get(id)-num(p.on_hand):0,cell=$('inv-diff-'+id);
  if(cell){cell.textContent=state.inventory.has(id)?((diff>0?'+':'')+qtyFmt.format(diff)):'-';cell.className='num '+(state.inventory.has(id)?stockClass(diff):'')}
  input.closest('tr')?.classList.toggle('changedRow',state.inventory.has(id));
  $('applyInventoryBtn').disabled=state.inventory.size===0;
});
$('applyInventoryBtn').addEventListener('click',async()=>{
  if(!state.inventory.size)return;
  const b=$('applyInventoryBtn'),entries=[...state.inventory.entries()];if(!confirm('Aplicar '+entries.length+' contagem(ns) física(s) no estoque?'))return;
  b.disabled=true;b.textContent='Aplicando...';let ok=0,errors=[];
  for(const [id,counted] of entries){
    try{await api('/stock/products/'+id+'/manual',{method:'PATCH',body:JSON.stringify({quantity:counted,notes:'Inventário físico pelo Estoque Matrix 2.0'})});ok++}
    catch(e){errors.push('#'+id+': '+e.message)}
  }
  state.inventory.clear();await load();renderInventory();b.textContent='Aplicar contagens';b.disabled=true;
  alert('Inventário concluído: '+ok+' ajustado(s)'+(errors.length?' · '+errors.length+' erro(s).\n'+errors.join('\n'):''));
});

load();
})();