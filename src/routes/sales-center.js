const router=require('express').Router();
const {supabase}=require('../db/supabase');
const {previewStockTargets,createStockMovement,getStockBalance}=require('../services/stock');

const money=v=>Number((Number(v)||0).toFixed(2));
const num=v=>Number(v)||0;

async function saleDetail(id){
 const [{data:sale,error:e1},{data:items,error:e2},{data:audit,error:e3}]=await Promise.all([
  supabase.from('manual_sales').select('*').eq('id',id).single(),
  supabase.from('manual_sale_items').select('*').eq('sale_id',id).order('id'),
  supabase.from('manual_sale_audit').select('*').eq('sale_id',id).order('created_at',{ascending:false})
 ]);
 if(e1)throw e1;if(e2)throw e2;if(e3)throw e3;
 return {...sale,items:items||[],audit:audit||[]};
}

async function recalcSale(id){
 const {data:items,error}=await supabase.from('manual_sale_items').select('cost_total').eq('sale_id',id);
 if(error)throw error;
 const {data:sale,error:saleError}=await supabase.from('manual_sales').select('net_sale_amount').eq('id',id).single();
 if(saleError)throw saleError;
 const totalCost=money((items||[]).reduce((s,x)=>s+num(x.cost_total),0));
 const net=money(sale.net_sale_amount);
 const profit=money(net-totalCost);
 const margin=net>0?Number(((profit/net)*100).toFixed(2)):null;
 const {error:updateError}=await supabase.from('manual_sales').update({total_cost:totalCost,total_profit:profit,margin_percent:margin,updated_at:new Date().toISOString()}).eq('id',id);
 if(updateError)throw updateError;
 return {totalCost,profit,margin};
}

async function previewItem(item){
 const productId=Number(item.product_id);const quantity=Number(item.quantity);
 if(!productId||!(quantity>0))throw new Error('Produto e quantidade são obrigatórios.');
 const preview=await previewStockTargets(productId,quantity);
 if(preview.requires_decision){
  const shortages=preview.lines.filter(x=>x.shortage).map(x=>`${x.primary.name||x.primary.sku}: precisa ${x.required_quantity}, disponível ${x.primary.available}`);
  const e=new Error(`Estoque insuficiente: ${shortages.join('; ')}`);e.code='STOCK_DECISION_REQUIRED';e.preview=preview;throw e;
 }
 const targets=preview.lines.map(x=>({product_id:Number(x.primary.product_id),sku:x.primary.sku,name:x.primary.name,quantity:Number(x.required_quantity),unit_cost:Number(x.primary.unit_cost||0)}));
 return {preview,targets};
}

router.get('/sales/manual',async(req,res)=>{try{
 const limit=Math.min(300,Math.max(1,Number(req.query.limit)||100));
 let q=supabase.from('manual_sales').select('*',{count:'exact'}).order('sale_date',{ascending:false}).limit(limit);
 if(req.query.status)q=q.eq('status',String(req.query.status));
 const {data,error,count}=await q;if(error)throw error;res.json({sucesso:true,vendas:data||[],total:count||0});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.get('/sales/manual/:id',async(req,res)=>{try{res.json({sucesso:true,venda:await saleDetail(req.params.id)});}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.post('/sales/manual',async(req,res)=>{let saleId=null;try{
 const body=req.body||{};const rawItems=Array.isArray(body.items)?body.items:[];if(!rawItems.length)return res.status(400).json({sucesso:false,mensagem:'Adicione ao menos um produto.'});
 const prepared=[];
 for(const item of rawItems){
  const stock=await previewItem(item);
  prepared.push({item,stock});
 }
 const gross=money(rawItems.reduce((s,x)=>s+num(x.unit_price)*num(x.quantity),0));
 const discount=Math.max(0,money(body.discount_amount));const net=money(Math.max(0,gross-discount));
 const {data:sale,error:saleError}=await supabase.from('manual_sales').insert({
  sale_date:body.sale_date||new Date().toISOString(),customer_name:body.customer_name||null,customer_document:body.customer_document||null,customer_phone:body.customer_phone||null,customer_email:body.customer_email||null,customer_address:body.customer_address||{},gross_amount:gross,discount_amount:discount,net_sale_amount:net,payment_method:body.payment_method||null,notes:body.notes||null,status:'active',stock_status:'processing',metadata:{quick_sale:!body.customer_name&&!body.customer_document}
 }).select('*').single();
 if(saleError)throw saleError;saleId=sale.id;
 let totalCost=0;
 for(let i=0;i<prepared.length;i++){
  const {item,stock}=prepared[i];const p=stock.preview.product;const lineTotal=money(num(item.unit_price)*num(item.quantity));const costTotal=money(stock.targets.reduce((s,t)=>s+t.quantity*t.unit_cost,0));totalCost+=costTotal;
  const {data:itemRow,error:itemError}=await supabase.from('manual_sale_items').insert({sale_id:saleId,product_id:Number(item.product_id),product_sku:p.sku||null,product_name:p.name||null,product_type:p.product_type||null,quantity:Number(item.quantity),unit_price:money(item.unit_price),line_total:lineTotal,unit_cost:Number(costTotal/Number(item.quantity||1)),cost_total:costTotal,stock_snapshot:stock.targets}).select('*').single();
  if(itemError)throw itemError;
  for(let j=0;j<stock.targets.length;j++){
   const t=stock.targets[j];
   await createStockMovement({productId:t.product_id,quantity:-Math.abs(t.quantity),movementType:'sale',unitCost:t.unit_cost,referenceType:'manual_sale',referenceId:saleId,idempotencyKey:`manual-sale:${saleId}:${itemRow.id}:${j}`,notes:`Venda manual #${sale.sale_number}`,metadata:{manual_sale_id:saleId,manual_sale_item_id:itemRow.id,source_product_id:Number(item.product_id),source_product_type:p.product_type}});
  }
 }
 totalCost=money(totalCost);const profit=money(net-totalCost);const margin=net>0?Number(((profit/net)*100).toFixed(2)):null;
 const {error:u}=await supabase.from('manual_sales').update({stock_status:'posted',total_cost:totalCost,total_profit:profit,margin_percent:margin,updated_at:new Date().toISOString()}).eq('id',saleId);if(u)throw u;
 await supabase.from('manual_sale_audit').insert({sale_id:saleId,action:'created',details:{gross,discount,net,total_cost:totalCost}});
 res.json({sucesso:true,venda:await saleDetail(saleId)});
}catch(e){if(saleId)await supabase.from('manual_sales').update({stock_status:'error',metadata:{error:e.message},updated_at:new Date().toISOString()}).eq('id',saleId);res.status(e.code==='STOCK_DECISION_REQUIRED'?409:500).json({sucesso:false,mensagem:e.message,preview:e.preview||null});}});

router.patch('/sales/manual/:id',async(req,res)=>{try{
 const allowed=['customer_name','customer_document','customer_phone','customer_email','customer_address','payment_method','notes'];const patch={};for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body||{},k))patch[k]=req.body[k]||null;patch.updated_at=new Date().toISOString();
 const {error}=await supabase.from('manual_sales').update(patch).eq('id',req.params.id);if(error)throw error;await supabase.from('manual_sale_audit').insert({sale_id:req.params.id,action:'edited',details:patch});res.json({sucesso:true,venda:await saleDetail(req.params.id)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.post('/sales/manual/:id/void',async(req,res)=>{try{
 const id=req.params.id;const {data:sale,error:saleError}=await supabase.from('manual_sales').select('*').eq('id',id).single();if(saleError)throw saleError;if(sale.status==='voided')return res.json({sucesso:true,venda:await saleDetail(id)});
 const {data:moves,error:moveError}=await supabase.from('inventory_movements').select('id,product_id,quantity,unit_cost,metadata').eq('reference_type','manual_sale').eq('reference_id',id).eq('movement_type','sale');if(moveError)throw moveError;
 for(const m of moves||[])await createStockMovement({productId:m.product_id,quantity:Math.abs(num(m.quantity)),movementType:'return',unitCost:m.unit_cost,referenceType:'manual_sale_void',referenceId:id,idempotencyKey:`manual-sale-void:${id}:${m.id}`,notes:`Estorno venda manual #${sale.sale_number}`,metadata:{reverses_movement_id:m.id}});
 const {error:u}=await supabase.from('manual_sales').update({status:'voided',stock_status:'reversed',updated_at:new Date().toISOString()}).eq('id',id);if(u)throw u;await supabase.from('manual_sale_audit').insert({sale_id:id,action:'voided',details:{reason:req.body?.reason||null}});res.json({sucesso:true,venda:await saleDetail(id)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.patch('/sales/manual/:saleId/items/:itemId/components',async(req,res)=>{try{
 const saleId=req.params.saleId,itemId=Number(req.params.itemId);const components=Array.isArray(req.body?.components)?req.body.components:[];if(!components.length)return res.status(400).json({sucesso:false,mensagem:'Informe os componentes usados nesta venda.'});
 const {data:item,error:itemError}=await supabase.from('manual_sale_items').select('*').eq('id',itemId).eq('sale_id',saleId).single();if(itemError)throw itemError;if(item.product_type!=='kit')return res.status(400).json({sucesso:false,mensagem:'A troca de componentes é permitida apenas para itens do tipo kit.'});
 const checked=[];for(const c of components){const productId=Number(c.product_id),quantity=Number(c.quantity);if(!productId||!(quantity>0))throw new Error('Componente inválido.');const balance=await getStockBalance(productId);if(num(balance.available)<quantity)throw new Error(`Saldo insuficiente para o componente ${productId}.`);const {data:p,error:pe}=await supabase.from('inventory_products').select('id,sku,name,product_type,average_cost,metadata').eq('id',productId).single();if(pe)throw pe;if(p.product_type==='kit')throw new Error('Um componente corrigido não pode ser outro kit.');const cost=Number(p.metadata?.actual_cost??p.metadata?.manual_cost??p.metadata?.last_cost??p.average_cost??0);checked.push({product_id:productId,sku:p.sku,name:p.name,quantity,unit_cost:cost});}
 const {data:moves,error:me}=await supabase.from('inventory_movements').select('id,product_id,quantity,unit_cost').eq('reference_type','manual_sale').eq('reference_id',saleId).eq('movement_type','sale').contains('metadata',{manual_sale_item_id:itemId});if(me)throw me;
 for(const m of moves||[])await createStockMovement({productId:m.product_id,quantity:Math.abs(num(m.quantity)),movementType:'return',unitCost:m.unit_cost,referenceType:'manual_sale_component_correction',referenceId:saleId,idempotencyKey:`manual-correction-return:${saleId}:${itemId}:${m.id}`,notes:'Correção de componente da venda',metadata:{manual_sale_item_id:itemId,reverses_movement_id:m.id}});
 for(let i=0;i<checked.length;i++){const c=checked[i];await createStockMovement({productId:c.product_id,quantity:-c.quantity,movementType:'sale',unitCost:c.unit_cost,referenceType:'manual_sale',referenceId:saleId,idempotencyKey:`manual-correction-sale:${saleId}:${itemId}:${Date.now()}:${i}`,notes:'Componente corrigido da venda',metadata:{manual_sale_id:saleId,manual_sale_item_id:itemId,corrected:true}});}
 const costTotal=money(checked.reduce((s,c)=>s+c.quantity*c.unit_cost,0));const {error:ie}=await supabase.from('manual_sale_items').update({unit_cost:Number(costTotal/Number(item.quantity||1)),cost_total:costTotal,stock_snapshot:checked}).eq('id',itemId);if(ie)throw ie;await recalcSale(saleId);await supabase.from('manual_sale_audit').insert({sale_id:saleId,action:'components_corrected',details:{item_id:itemId,components:checked}});res.json({sucesso:true,venda:await saleDetail(saleId)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.delete('/sales/manual/:id',async(req,res)=>{try{const {data:sale,error}=await supabase.from('manual_sales').select('*').eq('id',req.params.id).single();if(error)throw error;if(sale.stock_status!=='pending'||sale.nfe_status||sale.bling_nfe_id)return res.status(409).json({sucesso:false,mensagem:'Venda com estoque ou NF-e não pode ser apagada. Use Estornar.'});const d=await supabase.from('manual_sales').delete().eq('id',req.params.id);if(d.error)throw d.error;res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

module.exports=router;
