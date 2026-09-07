const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");

router.get("/fiscal/settings", async (req,res)=>{ try { res.json({sucesso:true,configuracao:await getFiscalSettings()}); } catch(e){res.status(500).json({sucesso:false,mensagem:e.message});} });

router.put("/fiscal/settings", async (req,res)=>{
 try {
  const b=req.body||{}, record={id:1,default_discount_percent:Number(b.default_discount_percent||0),suggest_ml_commission_as_discount:b.suggest_ml_commission_as_discount!==false,require_manual_confirmation:false,updated_at:nowIso()};
  const {data,error}=await supabase.from("fiscal_settings").upsert(record,{onConflict:"id"}).select("*").single();
  if(error) throw new Error(error.message); res.json({sucesso:true,configuracao:data});
 } catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}
});

router.post("/fiscal/preview/:orderId", async (req,res)=>{
 try {
  const orderId=String(req.params.orderId);
  const {data:order,error}=await supabase.from("marketplace_orders").select("*").eq("marketplace","mercadolivre").eq("marketplace_order_id",orderId).maybeSingle();
  if(error) throw new Error(error.message); if(!order) return res.status(404).json({sucesso:false,mensagem:"Pedido não encontrado."});
  const settings=await getFiscalSettings(), payments=Array.isArray(order.raw_data?.payments)?order.raw_data.payments:[];
  const commission=payments.reduce((s,p)=>s+Math.abs(Number(p?.marketplace_fee||0)),0), gross=Number(order.paid_amount??order.total_amount??0), freight=Number(req.body?.freight_amount||0);
  let discountType=req.body?.discount_type, discountValue=req.body?.discount_value, legacy=req.body?.discount_percent;
  if(discountType==null && discountValue==null && legacy==null){ discountType="percent"; discountValue=settings.suggest_ml_commission_as_discount&&gross>0&&commission>0?(commission/gross)*100:Number(settings.default_discount_percent||0); }
  const p=calculateFiscalPreview({grossAmount:gross,commissionAmount:commission,freightAmount:freight,discountType,discountValue,discountPercent:legacy});
  const base={marketplace_order_id:orderId,gross_amount:p.gross_amount,commission_amount:p.commission_amount,freight_amount:p.freight_amount,operational_net_amount:p.operational_net_amount,discount_percent:p.discount_percent,fiscal_amount:p.fiscal_amount,status:"preview",updated_at:nowIso()};
  let r=await supabase.from("fiscal_documents").upsert({...base,discount_type:p.discount_type,discount_value:p.discount_value,discount_amount:p.discount_amount},{onConflict:"marketplace_order_id"}).select("*").single();
  if(r.error && /discount_type|discount_value|discount_amount/i.test(r.error.message||"")) r=await supabase.from("fiscal_documents").upsert(base,{onConflict:"marketplace_order_id"}).select("*").single();
  if(r.error) throw new Error(r.error.message);
  res.json({sucesso:true,fiscal:{...r.data,discount_type:p.discount_type,discount_value:p.discount_value,discount_amount:p.discount_amount,discount_percent:p.discount_percent,fiscal_amount:p.fiscal_amount}});
 } catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}
});
module.exports=router;
