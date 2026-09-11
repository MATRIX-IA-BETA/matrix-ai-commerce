(()=>{
const $=id=>document.getElementById(id);
let products=[];
let productsLoaded=false;
let pieceSearch='';
let kitSearch='';

const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));
const norm=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const parseNum=value=>Number(String(value||'0').replace(/\./g,'').replace(',','.'))||0;
const qty=value=>Number(value||0).toLocaleString('pt-BR',{maximumFractionDigits:2});
const brl=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

async function api(url,opts={}){
  const response=await fetch(url,{...opts,cache:'no-store',headers:{'Content-Type':'application/json',...(opts.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.sucesso===false)throw new Error(data.mensagem||`Erro HTTP ${response.status}`);
  return data;
}

function setStatus(type,message){const el=$('kitStatus');if(!el)return;el.className=`status show ${type}`;el.textContent=message}
function clearStatus(){const el=$('kitStatus');if(!el)return;el.className='status';el.textContent=''}

async function loadProducts(){
  const data=await api('/stock/products');
  const all=(data.produtos||[]).filter(p=>p.active!==false);
  products=all.filter(p=>p.product_type!=='kit'&&p.product_type!=='service');
  productsLoaded=true;
  window.__matrixKitAllProducts=all;
  return products;
}

function productLabel(product){return `${product.sku||''} · ${product.name||''} · disp. ${qty(product.available||0)}`}
function findProduct(id){return products.find(p=>Number(p.product_id)===Number(id))}
function matchesPiece(product,search=pieceSearch){
  const q=norm(search).trim();if(!q)return true;
  return [product.sku,product.name,product.category,product.supplier_name,product.location_code].some(v=>norm(v).includes(q));
}
function primaryOptions(selectedId){
  const selected=Number(selectedId||0);
  return products.filter(p=>matchesPiece(p)||Number(p.product_id)===selected).map(product=>{
    const id=Number(product.product_id);
    return `<option value="${id}" ${id===selected?'selected':''}>${esc(productLabel(product))}</option>`;
  }).join('');
}
function substituteOptions(selectedId,primaryId){
  const selected=Number(selectedId||0),primary=Number(primaryId||0);
  const options=['<option value="">Nenhum substituto</option>'];
  for(const product of products){
    const id=Number(product.product_id);if(id===primary)continue;
    if(!matchesPiece(product)&&id!==selected)continue;
    options.push(`<option value="${id}" ${id===selected?'selected':''}>${esc(productLabel(product))}</option>`);
  }
  return options.join('');
}

function updateStockHint(row){
  const primary=findProduct(Number(row.querySelector('.comp-product')?.value||0));
  const substitute=findProduct(Number(row.querySelector('.comp-substitute')?.value||0));
  const hint=row.querySelector('.matrix-sub-stock');if(!hint)return;
  hint.textContent=`Principal: ${primary?qty(primary.available):'—'} disp. · Substituto: ${substitute?qty(substitute.available)+' disp.':'não definido'}`;
}
function refreshSubstituteSelect(row,keepValue=true){
  const primary=row.querySelector('.comp-product'),substitute=row.querySelector('.comp-substitute');if(!primary||!substitute)return;
  const current=keepValue?Number(substitute.value||0):0;
  substitute.innerHTML=substituteOptions(current,Number(primary.value||0));
  if(current&&Number(primary.value)!==current)substitute.value=String(current);
  updateStockHint(row);
}

function refreshAllComponentOptions(){
  document.querySelectorAll('#componentLines .matrix-bom-row').forEach(row=>{
    const primary=row.querySelector('.comp-product'),sub=row.querySelector('.comp-substitute');
    if(!primary||!sub)return;
    const pVal=Number(primary.value||0),sVal=Number(sub.value||0);
    primary.innerHTML=primaryOptions(pVal);
    if(pVal)primary.value=String(pVal);
    sub.innerHTML=substituteOptions(sVal,pVal);
    if(sVal)sub.value=String(sVal);
    updateStockHint(row);
  });
  renderAvailablePieces();
}

function createComponentRow(component={}){
  const container=$('componentLines');if(!container)return null;
  const substitute=(component.substitutes||[])[0]||null;
  const primaryId=Number(component.component_product_id||products.find(matchesPiece)?.product_id||products[0]?.product_id||0);
  const substituteId=Number(substitute?.substitute_product_id||0);
  const row=document.createElement('div');
  row.className='component-line matrix-bom-row';
  row.innerHTML=`
    <div class="matrix-main-piece"><select class="comp-product">${primaryOptions(primaryId)}</select></div>
    <input class="comp-qty" inputmode="decimal" value="${esc(component.quantity||1)}" aria-label="Quantidade da peça principal">
    <button class="icon-btn matrix-remove-component" type="button" title="Remover componente">×</button>
    <div class="matrix-substitution-row">
      <span class="matrix-substitution-label">Substituto se faltar</span>
      <select class="comp-substitute">${substituteOptions(substituteId,primaryId)}</select>
      <span class="matrix-sub-stock"></span>
    </div>`;
  row.querySelector('.matrix-remove-component').onclick=()=>{row.remove();updateKitTotal()};
  row.querySelector('.comp-product').addEventListener('change',()=>{refreshSubstituteSelect(row,true);updateKitTotal()});
  row.querySelector('.comp-substitute').addEventListener('change',()=>updateStockHint(row));
  row.querySelector('.comp-qty').addEventListener('input',updateKitTotal);
  updateStockHint(row);container.appendChild(row);updateKitTotal();return row;
}

function updateKitTotal(){
  const total=[...document.querySelectorAll('#componentLines .matrix-bom-row')].reduce((sum,row)=>{
    const product=findProduct(Number(row.querySelector('.comp-product')?.value||0));
    return sum+(Number(product?.actual_cost??product?.average_cost??0)||0)*parseNum(row.querySelector('.comp-qty')?.value);
  },0);
  const el=$('matrixKitTotal');if(el)el.textContent=brl(total);
}

async function renderSelectedBom(){
  const parentId=Number($('kitParent')?.value||0),container=$('componentLines');if(!container)return;
  container.innerHTML='<div class="matrix-bom-loading">Carregando composição...</div>';clearStatus();
  if(!parentId){container.innerHTML='';setStatus('err','Cadastre ou selecione primeiro um produto do tipo Kit / PC.');return}
  try{
    if(!productsLoaded)await loadProducts();
    const data=await api(`/stock/bom/${parentId}`);container.innerHTML='';
    const components=data.componentes||[];
    if(!components.length)createComponentRow();else components.forEach(createComponentRow);
    updateKitTotal();
  }catch(error){container.innerHTML='';setStatus('err',error.message)}
}

async function saveBom(){
  const button=$('saveKit');if(!button)return;
  try{
    button.disabled=true;clearStatus();if(!productsLoaded)await loadProducts();
    const parentProductId=Number($('kitParent')?.value||0);if(!parentProductId)throw new Error('Cadastre ou selecione primeiro um Kit / PC.');
    const rows=[...document.querySelectorAll('#componentLines .matrix-bom-row')];
    const components=rows.map(row=>{
      const componentProductId=Number(row.querySelector('.comp-product')?.value||0),quantity=parseNum(row.querySelector('.comp-qty')?.value),substituteProductId=Number(row.querySelector('.comp-substitute')?.value||0);
      return {component_product_id:componentProductId,quantity,substitutes:substituteProductId?[{substitute_product_id:substituteProductId,priority:1,quantity_factor:1}]:[]};
    }).filter(c=>c.component_product_id&&c.quantity>0);
    if(!components.length)throw new Error('Adicione ao menos um componente.');
    const seen=new Set();for(const component of components){if(seen.has(component.component_product_id))throw new Error('O mesmo componente principal foi adicionado mais de uma vez.');seen.add(component.component_product_id);const sub=Number(component.substitutes?.[0]?.substitute_product_id||0);if(sub===component.component_product_id)throw new Error('O substituto precisa ser diferente da peça principal.')}
    await api('/stock/bom',{method:'POST',body:JSON.stringify({parent_product_id:parentProductId,components})});
    setStatus('ok','Composição salva. O kit continua virtual e a venda baixa somente as peças físicas.');
  }catch(error){setStatus('err',error.message)}finally{button.disabled=false}
}

function kitOptions(){
  const all=window.__matrixKitAllProducts||[];
  return all.filter(p=>p.active!==false&&p.product_type==='kit');
}
function refreshKitOptions(){
  const parent=$('kitParent');if(!parent)return;
  const current=Number(parent.value||0),q=norm(kitSearch).trim();
  const kits=kitOptions().filter(k=>!q||[k.sku,k.name,k.category].some(v=>norm(v).includes(q))||Number(k.product_id)===current);
  parent.innerHTML=kits.map(k=>`<option value="${k.product_id}" ${Number(k.product_id)===current?'selected':''}>${esc(k.sku)} · ${esc(k.name)}</option>`).join('')||'<option value="">Nenhum kit encontrado</option>';
  if(current&&kits.some(k=>Number(k.product_id)===current))parent.value=String(current);
}

function renderAvailablePieces(){
  const box=$('matrixAvailablePieces');if(!box)return;
  const list=products.filter(matchesPiece).slice(0,120);
  box.innerHTML=list.length?list.map(p=>`<div class="matrix-piece-card"><div><strong>${esc(p.name||'')}</strong><div class="matrix-piece-meta">${esc(p.sku||'')} · disp. ${qty(p.available||0)} · ${brl(p.actual_cost??p.average_cost??0)}</div></div><button type="button" class="matrix-add-piece" data-product-id="${p.product_id}">+</button></div>`).join(''):'<div class="matrix-bom-loading">Nenhuma peça encontrada.</div>';
  box.querySelectorAll('.matrix-add-piece').forEach(btn=>btn.onclick=()=>createComponentRow({component_product_id:Number(btn.dataset.productId),quantity:1,substitutes:[]}));
}

function installSearchUi(){
  const modal=$('kitModal'),card=modal?.querySelector('.modal-card');if(!card||card.dataset.matrixSearchReady==='1')return;
  card.dataset.matrixSearchReady='1';
  card.classList.add('matrix-kit-modal-card');
  const kitField=$('kitParent')?.closest('.field');
  if(kitField&&!$('matrixKitSearch')){
    const input=document.createElement('input');input.id='matrixKitSearch';input.className='matrix-kit-search';input.placeholder='Buscar kit por nome, referência, MLB ou categoria...';
    kitField.insertBefore(input,$('kitParent'));input.addEventListener('input',()=>{kitSearch=input.value;refreshKitOptions()});
  }
  const heading=$('componentLines')?.previousElementSibling;
  if(heading&&!$('matrixPieceSearch')){
    const input=document.createElement('input');input.id='matrixPieceSearch';input.className='matrix-piece-search';input.placeholder='Buscar peça por nome, referência, MLB, categoria, fornecedor...';
    heading.insertAdjacentElement('afterend',input);input.addEventListener('input',()=>{pieceSearch=input.value;refreshAllComponentOptions()});
  }
  if(!$('matrixKitTotal')){
    const total=document.createElement('div');total.className='matrix-kit-total';total.innerHTML='<span>Custo total do kit (1 unidade)</span><strong id="matrixKitTotal">R$ 0,00</strong>';
    $('componentLines').insertAdjacentElement('afterend',total);
  }
  if(!$('matrixAvailablePanel')){
    const panel=document.createElement('aside');panel.id='matrixAvailablePanel';panel.className='matrix-available-panel';panel.innerHTML='<div class="matrix-available-head"><strong>Peças disponíveis no estoque</strong><span>Use a busca acima e clique em + para adicionar</span></div><div id="matrixAvailablePieces" class="matrix-available-pieces"></div>';
    const body=document.createElement('div');body.className='matrix-kit-layout';
    const left=document.createElement('div');left.className='matrix-kit-left';
    const children=[...card.children].filter(el=>!el.classList.contains('modal-actions')&&el.id!=='kitStatus');
    children.forEach(el=>left.appendChild(el));
    body.appendChild(left);body.appendChild(panel);
    const status=$('kitStatus'),actions=card.querySelector('.modal-actions');card.insertBefore(body,status||actions);renderAvailablePieces();
  }
}

function installStyles(){
  if(document.getElementById('matrixBomSubstitutionStyle'))return;
  const style=document.createElement('style');style.id='matrixBomSubstitutionStyle';style.textContent=`
    #kitModal{align-items:stretch;padding:16px}.matrix-kit-modal-card{width:min(1760px,calc(100vw - 32px))!important;max-height:calc(100vh - 32px)!important;height:calc(100vh - 32px);padding:18px 20px!important;display:flex;flex-direction:column;overflow:hidden!important}
    .matrix-kit-layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(420px,.85fr);gap:14px;min-height:0;flex:1;overflow:hidden}.matrix-kit-left{min-width:0;overflow:auto;padding-right:4px}.matrix-available-panel{border:1px solid #24466f;background:#081525;border-radius:14px;display:flex;flex-direction:column;min-height:0;overflow:hidden}.matrix-available-head{padding:14px 15px;border-bottom:1px solid #1f3b60;display:flex;flex-direction:column;gap:3px}.matrix-available-head span{font-size:11px;color:#8fa4c3}.matrix-available-pieces{overflow:auto;min-height:0}.matrix-piece-card{display:grid;grid-template-columns:1fr 42px;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid #18314f}.matrix-piece-card strong{display:block}.matrix-piece-meta{font-size:11px;color:#8fa4c3;margin-top:3px}.matrix-add-piece{width:34px;height:34px;border-radius:9px;border:1px solid #865cff;background:#6f43e8;color:#fff;font-size:20px;font-weight:900;cursor:pointer}.matrix-add-piece:hover{filter:brightness(1.15)}
    .matrix-bom-safety{margin:10px 0 14px;padding:11px 12px;border:1px solid #7b5422;background:#2b210d;border-radius:11px;color:#ffe59a;font-size:12px}.matrix-kit-search,.matrix-piece-search{width:100%;background:#071524;color:#fff;border:1px solid #6f4ce9;border-radius:10px;padding:11px 13px;margin-bottom:9px;outline:none}.matrix-kit-search:focus,.matrix-piece-search:focus{box-shadow:0 0 0 2px rgba(128,87,245,.24)}
    .component-line.matrix-bom-row{grid-template-columns:minmax(300px,1fr) 100px 44px;padding:10px;border:1px solid #203b5e;background:#091727;border-radius:11px;margin-bottom:10px}.matrix-main-piece select{width:100%;background:#081526;border:1px solid #315078;color:#fff;border-radius:9px;padding:9px}.matrix-substitution-row{grid-column:1/-1;display:grid;grid-template-columns:150px minmax(240px,1fr) 230px;gap:9px;align-items:center;margin-top:8px;padding-top:9px;border-top:1px dashed #284667}.matrix-substitution-label{font-size:12px;color:#adc0da;font-weight:800}.matrix-substitution-row select{width:100%;background:#081526;border:1px solid #315078;color:#fff;border-radius:9px;padding:9px}.matrix-sub-stock{color:#8fa4c3;font-size:11px;text-align:right}.matrix-bom-loading{padding:14px;color:#8fa4c3;text-align:center}.matrix-kit-total{display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding:12px 14px;border:1px solid #17694f;background:#0a3027;border-radius:11px;color:#a8f6d8;font-weight:800}.matrix-kit-total strong{font-size:18px;color:#69f5ba}.matrix-kit-modal-card>.modal-actions{margin-top:12px}.matrix-kit-modal-card>#kitStatus{flex:0 0 auto}
    @media(max-width:1100px){.matrix-kit-layout{grid-template-columns:1fr}.matrix-available-panel{max-height:300px}.matrix-kit-modal-card{height:calc(100vh - 20px)!important}.matrix-substitution-row{grid-template-columns:1fr}.matrix-sub-stock{text-align:left}}
    @media(max-width:760px){#kitModal{padding:6px}.matrix-kit-modal-card{width:calc(100vw - 12px)!important;height:calc(100vh - 12px)!important;max-height:calc(100vh - 12px)!important}.component-line.matrix-bom-row{grid-template-columns:1fr 90px 44px}}
  `;document.head.appendChild(style);
}

function installSafetyNotice(){
  const modal=$('kitModal');if(!modal||modal.querySelector('.matrix-bom-safety'))return;
  const heading=modal.querySelector('.modal-card h2');if(!heading)return;
  const note=document.createElement('div');note.className='matrix-bom-safety';note.innerHTML='<strong>Baixa manual/assistida.</strong> O Mercado Livre não baixa estoque sozinho. Se a peça principal estiver sem saldo suficiente, a Matrix deve perguntar antes de usar o substituto ou permitir estoque negativo.';heading.insertAdjacentElement('afterend',note);
}

function install(){
  const kitBtn=$('kitBtn'),addButton=$('addComponent'),saveButton=$('saveKit'),parent=$('kitParent'),container=$('componentLines');if(!kitBtn||!addButton||!saveButton||!parent||!container)return;
  installStyles();installSafetyNotice();
  loadProducts().then(()=>{installSearchUi();refreshKitOptions();renderAvailablePieces()}).catch(()=>{});
  const originalKitClick=kitBtn.onclick;
  kitBtn.onclick=async event=>{if(typeof originalKitClick==='function')originalKitClick.call(kitBtn,event);if(!productsLoaded)await loadProducts();installSearchUi();refreshKitOptions();renderAvailablePieces();await renderSelectedBom()};
  addButton.onclick=async event=>{event.preventDefault();if(!productsLoaded)await loadProducts();createComponentRow()};
  saveButton.onclick=event=>{event.preventDefault();saveBom()};
  parent.addEventListener('change',()=>renderSelectedBom());
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
