const router=require('express').Router();
const {supabase}=require('../db/supabase');
const {createStockMovement,getStockBalance}=require('../services/stock');
const money=v=>Number((Number(v)||0).toFixed(2));
const num=v=>Number(v)||0;
const roi=(profit,cost)=>Number(cost)>0&&profit!=null?Number(((Number(profit)/Number(cost))*100).toFixed(2)):null;
const actualCost=p=>{const m=p?.metadata||{};for(const v of [m.actual_cost,m.manual_cost,m.last_cost,p?.average_cost]){const n=Number(v);if(Number.isFinite(n)&&n>=0)return n}return 0};
async function detail(orderId){
 const [{data:order,error:oe},{data:fin,error:fe},{data:doc,error:de},{data:moves,error:me}]=await Promise.all([
  supabase.from('marketplace_orders').select('*').eq('marketplace','mercadolivre').eq('marketplace_order_id',String(orderId)).maybeSingle(),
  supabase.from('marketplace_sale_financials').select('*').eq('marketplace_order_id',String(orderId)).maybeSingle(),
  supabase.from('fiscal_documents').select('*').eq('marketplace_order_id',String(orderId)).maybeSingle(),
  supabase.from('inventory_movements').select('id,product_id,quantity,movement_type,unit_cost,metadata,inventory_products!inventory_movements_product_id_fkey(id,sku,name,product_type,average_cost,metadata)').eq('marketplace_order_id',String(orderId)).order('id',{ascending:true})
 ]);if(oe)throw oe;if(fe)throw fe;if(de)throw de;if(me)throw me;if(!order&&!fin)throw new Error('Venda do Mercado Livre não encontrada.');
 const components=(moves||[]).filter(x=>x.movement_type==='sale').map(x=>({movement_id:x.id,product_id:x.product_id,sku:x.inventory_products?.sku||null,name:x.inventory_products?.name||null,quantity:Math.abs(num(x.quantity)),unit_cost:x.unit_cost==null?actualCost(x.inventory_products):Number(x.unit_cost),cost_total:money(Math.abs(num(x.quantity))*num(x.unit_cost)),metadata:x.metadata||{}}));
 const meta=fin?.metadata||{};return {order_id:String(orderId),order,financial:{...fin,margin_percent:roi(fin?.total_profit,fin?.total_cost)},fiscal:doc||null,items:Array.isArray(order?.raw_data?.order_items)?order.raw_data.order_items:[],components,local:{customer_name:meta.local_customer_name||null,notes:meta.local_notes||null,hidden:Boolean(meta.hidden),voided:Boolean(meta.voided)}};
}
router.get('/sales/marketplace/:orderId',async(req,res)=>{try{res.json({sucesso:true,venda:await detail(req.params.orderId)})}catch(e){res.status(500).json({sucesso:false,mensagem:e.message})}});
router.patch('/sales/marketplace/:orderId',async(req,res)=>{try{const id=String(req.params.orderId),q=await supabase.from('marketplace_sale_financials').select('*').eq('marketplace_order_id',id).single();if(q.error)throw q.error;const metadata={...(q.data.metadata||{})};if('customer_name'in(req.body||{}))metadata.local_customer_name=String(req.body.customer_name||'').trim()||null;if('notes'in(req.body||{}))metadata.local_notes=String(req.body.notes||'').trim()||null;metadata.local_edited_at=new Date().toISOString();const u=await supabase.from('marketplace_sale_financials').update({metadata,updated_at:new Date().toISOString()}).eq('marketplace_order_id',id);if(u.error)throw u.error;res.json({sucesso:true,venda:await detail(id)})}catch(e){res.status(500).json({sucesso:false,mensagem:e.message})}});
module.exports={router,detail,money,num,roi,actualCost};
