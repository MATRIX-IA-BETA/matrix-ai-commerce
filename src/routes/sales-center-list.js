const router=require('express').Router();
const {supabase}=require('../db/supabase');
const roi=(profit,cost)=>Number(cost)>0&&profit!=null?Number(((Number(profit)/Number(cost))*100).toFixed(2)):null;
router.get('/sales/center',async(req,res)=>{try{
 const limit=Math.min(300,Math.max(1,Number(req.query.limit)||150));
 const [{data:manual,error:me},{data:fin,error:fe}]=await Promise.all([
  supabase.from('manual_sales').select('*').order('sale_date',{ascending:false}).limit(limit),
  supabase.from('marketplace_sale_financials').select('*').order('updated_at',{ascending:false}).limit(limit)
 ]);if(me)throw me;if(fe)throw fe;
 const visibleFin=(fin||[]).filter(x=>!x?.metadata?.hidden),ids=visibleFin.map(x=>String(x.marketplace_order_id)).filter(Boolean);let orders=[];
 if(ids.length){const q=await supabase.from('marketplace_orders').select('marketplace_order_id,date_created,buyer_nickname,total_amount,paid_amount,raw_data').eq('marketplace','mercadolivre').in('marketplace_order_id',ids);if(q.error)throw q.error;orders=q.data||[]}
 const map=new Map(orders.map(o=>[String(o.marketplace_order_id),o])),rows=[];
 for(const s of manual||[])rows.push({id:s.id,key:`manual:${s.id}`,origin:'Venda manual',sale_number:s.sale_number,date:s.sale_date,customer:s.customer_name||'Consumidor não identificado',product:null,gross_amount:s.gross_amount,net_amount:s.net_sale_amount,cost:s.total_cost,profit:s.total_profit,margin:roi(s.total_profit,s.total_cost),stock_status:s.stock_status,status:s.status,nfe_amount:s.nfe_amount,nfe_status:s.nfe_status,nfe_number:s.nfe_number});
 for(const f of visibleFin){const o=map.get(String(f.marketplace_order_id))||{},items=o.raw_data?.order_items||[],product=items.map(x=>x?.item?.title||x?.title).filter(Boolean).join(' + ')||null,meta=f.metadata||{};rows.push({id:String(f.marketplace_order_id),key:`ml:${f.marketplace_order_id}`,origin:'Mercado Livre',sale_number:String(f.marketplace_order_id),date:o.date_created||f.updated_at,customer:meta.local_customer_name||o.buyer_nickname||'Cliente Mercado Livre',product,gross_amount:meta.local_sale_amount??o.paid_amount??o.total_amount??null,net_amount:f.actual_net_received,cost:f.total_cost,profit:f.total_profit,margin:roi(f.total_profit,f.total_cost),stock_status:f.stock_status,status:meta.voided?'voided':'active',nfe_amount:f.nfe_amount,nfe_status:null,nfe_number:f.nfe_number});}
 rows.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));res.json({sucesso:true,vendas:rows.slice(0,limit)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});
module.exports=router;
