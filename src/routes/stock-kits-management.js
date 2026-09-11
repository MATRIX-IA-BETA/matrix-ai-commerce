const router=require('express').Router();
const {supabase}=require('../db/supabase');
const {nowIso}=require('../utils/common');

async function kitDetails(id){
  const [{data:kit,error:kerr},{data:components,error:cerr},{data:links,error:lerr}]=await Promise.all([
    supabase.from('inventory_products').select('id,sku,name,description,category,product_type,unit,minimum_stock,average_cost,supplier_name,location_code,active,metadata,created_at,updated_at').eq('id',id).single(),
    supabase.from('inventory_bom_components').select('id,parent_product_id,component_product_id,quantity,notes').eq('parent_product_id',id).order('id'),
    supabase.from('inventory_marketplace_links').select('id,marketplace,external_item_id,variation_id,seller_sku,sync_enabled').eq('product_id',id).eq('marketplace','mercadolivre').order('id')
  ]);
  if(kerr)throw kerr;if(cerr)throw cerr;if(lerr)throw lerr;
  const rows=components||[];let substitutes=[];
  if(rows.length){
    const r=await supabase.from('inventory_bom_substitutes').select('id,bom_component_id,substitute_product_id,priority,quantity_factor,notes,active').in('bom_component_id',rows.map(x=>x.id)).order('priority');
    if(r.error)throw r.error;substitutes=r.data||[];
  }
  return {...kit,components:rows.map(c=>({...c,substitutes:substitutes.filter(s=>Number(s.bom_component_id)===Number(c.id))})),mercadolivre_links:links||[]};
}

router.get('/stock/kits',async(req,res)=>{try{
  const {data:kits,error}=await supabase.from('inventory_products').select('id,sku,name,description,category,active,metadata,created_at,updated_at').eq('product_type','kit').order('active',{ascending:false}).order('name');
  if(error)throw error;
  const ids=(kits||[]).map(x=>x.id);let components=[],links=[];
  if(ids.length){
    const [c,l]=await Promise.all([
      supabase.from('inventory_bom_components').select('parent_product_id,component_product_id,quantity').in('parent_product_id',ids),
      supabase.from('inventory_marketplace_links').select('product_id,external_item_id,variation_id,sync_enabled').eq('marketplace','mercadolivre').in('product_id',ids)
    ]);if(c.error)throw c.error;if(l.error)throw l.error;components=c.data||[];links=l.data||[];
  }
  const result=(kits||[]).map(k=>({
    ...k,
    component_count:components.filter(c=>Number(c.parent_product_id)===Number(k.id)).length,
    mlb:(links.find(l=>Number(l.product_id)===Number(k.id)&&l.sync_enabled!==false)||links.find(l=>Number(l.product_id)===Number(k.id)))?.external_item_id||null
  }));
  res.json({sucesso:true,kits:result});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.get('/stock/kits/:id',async(req,res)=>{try{
  const kit=await kitDetails(Number(req.params.id));
  if(kit.product_type!=='kit')return res.status(400).json({sucesso:false,mensagem:'Produto informado não é um kit.'});
  res.json({sucesso:true,kit});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.patch('/stock/kits/:id',async(req,res)=>{try{
  const id=Number(req.params.id),body=req.body||{};if(!id)return res.status(400).json({sucesso:false,mensagem:'Kit inválido.'});
  const {data:kit,error}=await supabase.from('inventory_products').select('id,product_type,metadata').eq('id',id).single();if(error)throw error;if(kit.product_type!=='kit')return res.status(400).json({sucesso:false,mensagem:'Produto informado não é um kit.'});
  const patch={updated_at:nowIso()};
  if(body.sku!=null){const sku=String(body.sku).trim();if(!sku)throw new Error('SKU é obrigatório.');patch.sku=sku;}
  if(body.name!=null){const name=String(body.name).trim();if(!name)throw new Error('Nome é obrigatório.');patch.name=name;}
  if(body.description!==undefined)patch.description=body.description||null;
  if(body.category!==undefined)patch.category=body.category||null;
  if(body.active!==undefined)patch.active=Boolean(body.active);
  const u=await supabase.from('inventory_products').update(patch).eq('id',id);if(u.error)throw u.error;
  if(body.mlb!==undefined){
    const mlb=String(body.mlb||'').trim();
    const {data:existing,error:le}=await supabase.from('inventory_marketplace_links').select('id').eq('product_id',id).eq('marketplace','mercadolivre').order('id').limit(1).maybeSingle();if(le)throw le;
    if(mlb){
      if(existing){const r=await supabase.from('inventory_marketplace_links').update({external_item_id:mlb,sync_enabled:true,updated_at:nowIso()}).eq('id',existing.id);if(r.error)throw r.error;}
      else{const r=await supabase.from('inventory_marketplace_links').insert({product_id:id,marketplace:'mercadolivre',external_item_id:mlb,variation_id:null,sync_enabled:true,updated_at:nowIso()});if(r.error)throw r.error;}
    }else if(existing){const r=await supabase.from('inventory_marketplace_links').update({sync_enabled:false,updated_at:nowIso()}).eq('id',existing.id);if(r.error)throw r.error;}
  }
  res.json({sucesso:true,kit:await kitDetails(id)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.post('/stock/kits/:id/clone',async(req,res)=>{try{
  const sourceId=Number(req.params.id),body=req.body||{};if(!sourceId)return res.status(400).json({sucesso:false,mensagem:'Kit de origem inválido.'});
  const source=await kitDetails(sourceId);if(source.product_type!=='kit')return res.status(400).json({sucesso:false,mensagem:'Produto de origem não é um kit.'});
  const sku=String(body.sku||`${source.sku}-COPIA-${Date.now().toString().slice(-5)}`).trim();
  const name=String(body.name||`${source.name} - Cópia`).trim();
  const metadata={...(source.metadata||{}),cloned_from_product_id:sourceId,cloned_at:nowIso()};
  const {data:newKit,error:insertError}=await supabase.from('inventory_products').insert({sku,name,description:source.description,category:source.category,product_type:'kit',unit:source.unit||'UN',minimum_stock:0,average_cost:0,supplier_name:null,location_code:null,active:true,metadata,updated_at:nowIso()}).select('*').single();
  if(insertError)throw insertError;
  const oldToNew=new Map();
  for(const c of source.components||[]){
    const {data:newComp,error:ce}=await supabase.from('inventory_bom_components').insert({parent_product_id:newKit.id,component_product_id:c.component_product_id,quantity:c.quantity,notes:c.notes||null}).select('id').single();if(ce)throw ce;oldToNew.set(Number(c.id),Number(newComp.id));
  }
  for(const c of source.components||[]){for(const s of c.substitutes||[]){
    const bomId=oldToNew.get(Number(c.id));if(!bomId)continue;
    const r=await supabase.from('inventory_bom_substitutes').insert({bom_component_id:bomId,substitute_product_id:s.substitute_product_id,priority:s.priority||1,quantity_factor:s.quantity_factor||1,notes:s.notes||null,active:s.active!==false});if(r.error)throw r.error;
  }}
  const mlb=String(body.mlb||'').trim();
  if(mlb){const r=await supabase.from('inventory_marketplace_links').insert({product_id:newKit.id,marketplace:'mercadolivre',external_item_id:mlb,variation_id:null,sync_enabled:true,updated_at:nowIso()});if(r.error)throw r.error;}
  res.json({sucesso:true,kit:await kitDetails(newKit.id)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.delete('/stock/kits/:id',async(req,res)=>{try{
  const id=Number(req.params.id);if(!id)return res.status(400).json({sucesso:false,mensagem:'Kit inválido.'});
  const {data:kit,error}=await supabase.from('inventory_products').select('id,product_type').eq('id',id).single();if(error)throw error;if(kit.product_type!=='kit')return res.status(400).json({sucesso:false,mensagem:'Produto informado não é um kit.'});
  const r=await supabase.from('inventory_products').update({active:false,updated_at:nowIso()}).eq('id',id);if(r.error)throw r.error;
  const l=await supabase.from('inventory_marketplace_links').update({sync_enabled:false,updated_at:nowIso()}).eq('product_id',id);if(l.error)throw l.error;
  res.json({sucesso:true,mensagem:'Kit excluído da operação e preservado no histórico.'});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

module.exports=router;
