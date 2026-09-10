(()=>{
const $=id=>document.getElementById(id);
let products=[];
let productsLoaded=false;

const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));

const parseNum=value=>Number(String(value||'0').replace(/\./g,'').replace(',','.'))||0;
const qty=value=>Number(value||0).toLocaleString('pt-BR',{maximumFractionDigits:2});

async function api(url,opts={}){
  const response=await fetch(url,{
    ...opts,
    cache:'no-store',
    headers:{'Content-Type':'application/json',...(opts.headers||{})}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.sucesso===false){
    throw new Error(data.mensagem||`Erro HTTP ${response.status}`);
  }
  return data;
}

function setStatus(type,message){
  const el=$('kitStatus');
  if(!el)return;
  el.className=`status show ${type}`;
  el.textContent=message;
}

function clearStatus(){
  const el=$('kitStatus');
  if(!el)return;
  el.className='status';
  el.textContent='';
}

async function loadProducts(){
  const data=await api('/stock/products');
  products=(data.produtos||[]).filter(product=>
    product.active!==false&&
    product.product_type!=='kit'&&
    product.product_type!=='service'
  );
  productsLoaded=true;
  return products;
}

function productLabel(product){
  const available=Number(product.available||0);
  return `${product.sku||''} · ${product.name||''} · disp. ${qty(available)}`;
}

function primaryOptions(selectedId){
  return products.map(product=>{
    const id=Number(product.product_id);
    return `<option value="${id}" ${id===Number(selectedId)?'selected':''}>${esc(productLabel(product))}</option>`;
  }).join('');
}

function substituteOptions(selectedId,primaryId){
  const options=['<option value="">Nenhum substituto</option>'];
  for(const product of products){
    const id=Number(product.product_id);
    if(id===Number(primaryId))continue;
    options.push(`<option value="${id}" ${id===Number(selectedId)?'selected':''}>${esc(productLabel(product))}</option>`);
  }
  return options.join('');
}

function findProduct(id){
  return products.find(product=>Number(product.product_id)===Number(id));
}

function updateStockHint(row){
  const primaryId=Number(row.querySelector('.comp-product')?.value||0);
  const substituteId=Number(row.querySelector('.comp-substitute')?.value||0);
  const primary=findProduct(primaryId);
  const substitute=findProduct(substituteId);
  const hint=row.querySelector('.matrix-sub-stock');
  if(!hint)return;

  const primaryText=primary?`Principal: ${qty(primary.available)} disp.`:'Principal: —';
  const substituteText=substitute?`Substituto: ${qty(substitute.available)} disp.`:'Substituto: não definido';
  hint.textContent=`${primaryText} · ${substituteText}`;
}

function refreshSubstituteSelect(row,keepValue=true){
  const primary=row.querySelector('.comp-product');
  const substitute=row.querySelector('.comp-substitute');
  if(!primary||!substitute)return;
  const current=keepValue?Number(substitute.value||0):0;
  substitute.innerHTML=substituteOptions(current,Number(primary.value||0));
  if(current&&Number(primary.value)!==current){
    substitute.value=String(current);
  }
  updateStockHint(row);
}

function createComponentRow(component={}){
  const container=$('componentLines');
  if(!container)return null;

  const substitute=(component.substitutes||[])[0]||null;
  const primaryId=Number(component.component_product_id||products[0]?.product_id||0);
  const substituteId=Number(substitute?.substitute_product_id||0);

  const row=document.createElement('div');
  row.className='component-line matrix-bom-row';
  row.innerHTML=`
    <select class="comp-product">${primaryOptions(primaryId)}</select>
    <input class="comp-qty" inputmode="decimal" value="${esc(component.quantity||1)}" aria-label="Quantidade da peça principal">
    <button class="icon-btn matrix-remove-component" type="button" title="Remover componente">×</button>
    <div class="matrix-substitution-row">
      <span class="matrix-substitution-label">Substituto se faltar</span>
      <select class="comp-substitute">${substituteOptions(substituteId,primaryId)}</select>
      <span class="matrix-sub-stock"></span>
    </div>`;

  row.querySelector('.matrix-remove-component').onclick=()=>row.remove();
  row.querySelector('.comp-product').addEventListener('change',()=>refreshSubstituteSelect(row,true));
  row.querySelector('.comp-substitute').addEventListener('change',()=>updateStockHint(row));
  updateStockHint(row);
  container.appendChild(row);
  return row;
}

async function renderSelectedBom(){
  const parentId=Number($('kitParent')?.value||0);
  const container=$('componentLines');
  if(!container)return;

  container.innerHTML='<div class="matrix-bom-loading">Carregando composição...</div>';
  clearStatus();

  if(!parentId){
    container.innerHTML='';
    setStatus('err','Cadastre ou selecione primeiro um produto do tipo Kit / PC.');
    return;
  }

  try{
    if(!productsLoaded)await loadProducts();
    const data=await api(`/stock/bom/${parentId}`);
    container.innerHTML='';
    const components=data.componentes||[];
    if(!components.length){
      createComponentRow();
      return;
    }
    components.forEach(createComponentRow);
  }catch(error){
    container.innerHTML='';
    setStatus('err',error.message);
  }
}

async function saveBom(){
  const button=$('saveKit');
  if(!button)return;

  try{
    button.disabled=true;
    clearStatus();
    if(!productsLoaded)await loadProducts();

    const parentProductId=Number($('kitParent')?.value||0);
    if(!parentProductId)throw new Error('Cadastre ou selecione primeiro um Kit / PC.');

    const rows=[...document.querySelectorAll('#componentLines .matrix-bom-row')];
    const components=rows.map(row=>{
      const componentProductId=Number(row.querySelector('.comp-product')?.value||0);
      const quantity=parseNum(row.querySelector('.comp-qty')?.value);
      const substituteProductId=Number(row.querySelector('.comp-substitute')?.value||0);
      return {
        component_product_id:componentProductId,
        quantity,
        substitutes:substituteProductId?[{
          substitute_product_id:substituteProductId,
          priority:1,
          quantity_factor:1
        }]:[]
      };
    }).filter(component=>component.component_product_id&&component.quantity>0);

    if(!components.length)throw new Error('Adicione ao menos um componente.');

    const seen=new Set();
    for(const component of components){
      if(seen.has(component.component_product_id)){
        throw new Error('O mesmo componente principal foi adicionado mais de uma vez.');
      }
      seen.add(component.component_product_id);
      const substituteId=Number(component.substitutes?.[0]?.substitute_product_id||0);
      if(substituteId===component.component_product_id){
        throw new Error('O substituto precisa ser diferente da peça principal.');
      }
    }

    await api('/stock/bom',{
      method:'POST',
      body:JSON.stringify({
        parent_product_id:parentProductId,
        components
      })
    });

    setStatus(
      'ok',
      'Composição salva. A baixa continua manual/assistida: se faltar a peça principal, a Matrix exigirá confirmação para usar o substituto ou deixar o principal negativo.'
    );
  }catch(error){
    setStatus('err',error.message);
  }finally{
    button.disabled=false;
  }
}

function installStyles(){
  if(document.getElementById('matrixBomSubstitutionStyle'))return;
  const style=document.createElement('style');
  style.id='matrixBomSubstitutionStyle';
  style.textContent=`
    .matrix-bom-safety{margin:10px 0 14px;padding:11px 12px;border:1px solid #7b5422;background:#2b210d;border-radius:11px;color:#ffe59a;font-size:12px}
    .component-line.matrix-bom-row{grid-template-columns:minmax(300px,1fr) 110px 44px;padding:10px;border:1px solid #203b5e;background:#091727;border-radius:11px;margin-bottom:10px}
    .matrix-substitution-row{grid-column:1/-1;display:grid;grid-template-columns:150px minmax(280px,1fr) 245px;gap:9px;align-items:center;margin-top:8px;padding-top:9px;border-top:1px dashed #284667}
    .matrix-substitution-label{font-size:12px;color:#adc0da;font-weight:800}
    .matrix-substitution-row select{width:100%;background:#081526;border:1px solid #315078;color:#fff;border-radius:9px;padding:9px}
    .matrix-sub-stock{color:#8fa4c3;font-size:11px;text-align:right}
    .matrix-bom-loading{padding:14px;color:#8fa4c3;text-align:center}
    @media(max-width:760px){.component-line.matrix-bom-row{grid-template-columns:1fr 90px 44px}.matrix-substitution-row{grid-template-columns:1fr}.matrix-sub-stock{text-align:left}}
  `;
  document.head.appendChild(style);
}

function installSafetyNotice(){
  const modal=$('kitModal');
  if(!modal||modal.querySelector('.matrix-bom-safety'))return;
  const heading=modal.querySelector('.modal-card h2');
  if(!heading)return;
  const note=document.createElement('div');
  note.className='matrix-bom-safety';
  note.innerHTML='<strong>Baixa manual/assistida.</strong> O Mercado Livre não baixa estoque sozinho. Se a peça principal estiver sem saldo suficiente, a Matrix deve perguntar antes de usar o substituto ou permitir estoque negativo.';
  heading.insertAdjacentElement('afterend',note);
}

function install(){
  const kitBtn=$('kitBtn');
  const addButton=$('addComponent');
  const saveButton=$('saveKit');
  const parent=$('kitParent');
  const container=$('componentLines');
  if(!kitBtn||!addButton||!saveButton||!parent||!container)return;

  installStyles();
  installSafetyNotice();

  loadProducts().catch(()=>{});

  const originalKitClick=kitBtn.onclick;
  kitBtn.onclick=async event=>{
    if(typeof originalKitClick==='function')originalKitClick.call(kitBtn,event);
    await renderSelectedBom();
  };

  addButton.onclick=async event=>{
    event.preventDefault();
    if(!productsLoaded)await loadProducts();
    createComponentRow();
  };

  saveButton.onclick=event=>{
    event.preventDefault();
    saveBom();
  };

  parent.addEventListener('change',()=>renderSelectedBom());
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',install,{once:true});
}else{
  install();
}
})();
