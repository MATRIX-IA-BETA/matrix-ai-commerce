const router=require('express').Router();
const {supabase}=require('../db/supabase');
const roi=(profit,cost)=>Number(cost)>0&&profit!=null?Number(((Number(profit)/Number(cost))*100).toFixed(2)):null;
const profitMargin=(profit,received)=>Number(received)>0&&profit!=null?Number(((Number(profit)/Number(received))*100).toFixed(2)):null;
const money=v=>Number((Number(v)||0).toFixed(2));
const startOfDay=v=>v?`${String(v).slice(0,10)}T00:00:00-03:00`:null;
const endOfDay=v=>v?`${String(v).slice(0,10)}T23:59:59.999-03:00`:null;
const chunks=(arr,size=180)=>{const out=[];for(let i=0;i<arr.length;i+=size)out.push(arr.slice(i,i+size));return out};
function saleRowManual(s){return{id:s.id,key:`manual:${s.id}`,origin:'Venda manual',sale_number:s.sale_number,date:s.sale_date,customer:s.customer_name||'Consumidor não identificado',product:null,gross_amount:s.gross_amount,net_amount:s.net_sale_amount,cost:s.total_cost,profit:s.total_profit,margin:roi(s.total_profit,s.total_cost),stock_status:s.stock_status,status:s.status,nfe_amount:s.nfe_amount,nfe_status:s.nfe_status,nfe_number:s.nfe_number}}
function saleRowMl(f,o={}){const items=o.raw_data?.order_items||[],product=items.map(x=>x?.item?.title||x?.title).filter(Boolean).join(' + ')||null,meta=f.metadata||{},mlStatus=String(o.status||meta.marketplace_status||'').toLowerCase(),cancelled=meta.marketplace_cancelled||['cancelled','canceled'].includes(mlStatus);return{id:String(f.marketplace_order_id),key:`ml:${f.marketplace_order_id}`,origin:'Mercado Livre',sale_number:String(f.marketplace_order_id),date:o.date_created||f.updated_at,customer:meta.local_customer_name||o.buyer_nickname||'Cliente Mercado Livre',product,gross_amount:meta.local_sale_amount??o.paid_amount??o.total_amount??null,net_amount:f.actual_net_received,cost:f.total_cost,profit:f.total_profit,margin:roi(f.total_profit,f.total_cost),stock_status:f.stock_status,status:cancelled?'cancelled':(meta.voided?'voided':'active'),marketplace_status:o.status||meta.marketplace_status||null,nfe_amount:f.nfe_amount,nfe_status:null,nfe_number:f.nfe_number}}
async function financialsForIds(ids){const out=[];for(const part of chunks([...new Set(ids.map(String).filter(Boolean))])){if(!part.length)continue;const q=await supabase.from('marketplace_sale_financials').select('*').in('marketplace_order_id',part);if(q.error)throw q.error;out.push(...(q.data||[]))}return out}
async function ordersForIds(ids){const out=[];for(const part of chunks([...new Set(ids.map(String).filter(Boolean))])){if(!part.length)continue;const q=await supabase.from('marketplace_orders').select('marketplace_order_id,date_created,buyer_nickname,total_amount,paid_amount,status,status_detail,raw_data').eq('marketplace','mercadolivre').in('marketplace_order_id',part);if(q.error)throw q.error;out.push(...(q.data||[]))}return out}
async function fetchAll(build,pageSize=800){const out=[];for(let from=0;;from+=pageSize){const q=build().range(from,from+pageSize-1),r=await q;if(r.error)throw r.error;const data=r.data||[];out.push(...data);if(data.length<pageSize)break}return out}
async function periodRows(dateFrom,dateTo,origin=''){
 const from=startOfDay(dateFrom),to=endOfDay(dateTo),rows=[];
 if(origin!=='Mercado Livre'){
  const manual=await fetchAll(()=>{let q=supabase.from('manual_sales').select('*').order('sale_date',{ascending:false});if(from)q=q.gte('sale_date',from);if(to)q=q.lte('sale_date',to);return q});
  rows.push(...manual.map(saleRowManual));
 }
 if(origin!=='Venda manual'){
  const orders=await fetchAll(()=>{let q=supabase.from('marketplace_orders').select('marketplace_order_id,date_created,buyer_nickname,total_amount,paid_amount,status,status_detail,raw_data').eq('marketplace','mercadolivre').order('date_created',{ascending:false});if(from)q=q.gte('date_created',from);if(to)q=q.lte('date_created',to);return q});
  const fin=await financialsForIds(orders.map(x=>x.marketplace_order_id)),fm=new Map(fin.filter(x=>!x?.metadata?.hidden).map(x=>[String(x.marketplace_order_id),x]));
  for(const o of orders){const f=fm.get(String(o.marketplace_order_id));if(f)rows.push(saleRowMl(f,o))}
 }
 rows.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));return rows;
}
router.get('/sales/period-summary',async(req,res)=>{try{const rows=await periodRows(req.query.date_from,req.query.date_to,String(req.query.origin||''));const active=rows.filter(r=>!['cancelled','voided'].includes(String(r.status||'').toLowerCase())),known=active.filter(r=>r.profit!=null&&r.net_amount!=null),totalSales=active.reduce((s,r)=>s+Number(r.gross_amount||0),0),totalReceived=active.reduce((s,r)=>s+Number(r.net_amount||0),0),knownReceived=known.reduce((s,r)=>s+Number(r.net_amount||0),0),totalProfit=known.reduce((s,r)=>s+Number(r.profit||0),0);res.json({sucesso:true,total:active.length,total_vendas:money(totalSales),total_liquido:money(totalReceived),total_lucro:money(totalProfit),margem_lucro_percent:profitMargin(totalProfit,knownReceived),lucros_conhecidos:known.length,liquido_base_margem:money(knownReceived)})}catch(e){res.status(500).json({sucesso:false,mensagem:e.message})}});
router.get('/sales/center',async(req,res)=>{try{
 const limit=Math.min(1000,Math.max(1,Number(req.query.limit)||200)),dateFrom=req.query.date_from||'',dateTo=req.query.date_to||'',origin=String(req.query.origin||'');let rows=[];
 if(dateFrom||dateTo){rows=await periodRows(dateFrom,dateTo,origin);}
 else{
  const manualPromise=origin==='Mercado Livre'?Promise.resolve({data:[],error:null}):supabase.from('manual_sales').select('*').order('sale_date',{ascending:false}).limit(limit);
  const finPromise=origin==='Venda manual'?Promise.resolve({data:[],error:null}):supabase.from('marketplace_sale_financials').select('*').order('updated_at',{ascending:false}).limit(limit);
  const [m,f]=await Promise.all([manualPromise,finPromise]);if(m.error)throw m.error;if(f.error)throw f.error;const visibleFin=(f.data||[]).filter(x=>!x?.metadata?.hidden),orders=await ordersForIds(visibleFin.map(x=>x.marketplace_order_id)),map=new Map(orders.map(o=>[String(o.marketplace_order_id),o]));rows.push(...(m.data||[]).map(saleRowManual));rows.push(...visibleFin.map(x=>saleRowMl(x,map.get(String(x.marketplace_order_id))||{})));rows.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
 }
 res.json({sucesso:true,total:rows.length,vendas:rows.slice(0,limit)});
}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});
module.exports=router;
