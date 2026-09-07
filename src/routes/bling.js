const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");
const { upsertCustomerFromMarketplaceOrder } = require("../services/customers");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");
const { getBlingAccount, saveBlingToken, blingBasicAuth, blingFetch, createOrUpdateBlingContact } = require("../services/bling");
const { BLING_CLIENT_ID, BLING_CLIENT_SECRET, BLING_REDIRECT_URI, BLING_API_BASE, BLING_AUTH_BASE }=env;
const sessions=new Map();

router.get("/auth/bling",(req,res)=>{
 if(!BLING_CLIENT_ID||!BLING_CLIENT_SECRET||!BLING_REDIRECT_URI) return res.status(500).json({sucesso:false,mensagem:"Variáveis do Bling não configuradas."});
 const state=crypto.randomBytes(24).toString("hex"); sessions.set(state,{created_at:Date.now()});
 res.redirect(`${BLING_AUTH_BASE}/authorize?${new URLSearchParams({response_type:"code",client_id:BLING_CLIENT_ID,state})}`);
});
router.get("/auth/bling/callback",async(req,res)=>{
 try{
  const {code,state,error}=req.query; if(error)return res.status(400).json({sucesso:false,erro:error});
  if(!code||!state||!sessions.has(state))return res.status(400).json({sucesso:false,mensagem:"Code/state inválido no OAuth Bling."}); sessions.delete(state);
  const tr=await fetch(`${BLING_API_BASE}/oauth/token`,{method:"POST",headers:{Authorization:`Basic ${blingBasicAuth()}`,"Content-Type":"application/x-www-form-urlencoded","enable-jwt":"1"},body:new URLSearchParams({grant_type:"authorization_code",code:String(code)}).toString()});
  const td=await tr.json(); if(!tr.ok)return res.status(tr.status).json({sucesso:false,mensagem:"Bling recusou o token.",detalhe:td});
  const a=await saveBlingToken(td); res.json({sucesso:true,mensagem:"Bling conectado à Matrix AI Commerce.",expires_at:a.expires_at});
 }catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}
});
router.get("/bling/status",async(req,res)=>{try{const a=await getBlingAccount();res.json({sucesso:true,conectado:Boolean(a),expires_at:a?.expires_at||null,token_expirado:a?.expires_at?new Date(a.expires_at).getTime()<=Date.now():null});}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});
router.post("/bling/customers/:customerId/sync",async(req,res)=>{try{const {data:c,error}=await supabase.from("customers").select("*").eq("id",req.params.customerId).single();if(error)throw new Error(error.message);res.json({sucesso:true,bling_contact_id:await createOrUpdateBlingContact(c)});}catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}});

router.post("/bling/nfe/from-order/:orderId",async(req,res)=>{
 try{
  const orderId=String(req.params.orderId), {data:o,error}=await supabase.from("marketplace_orders").select("*").eq("marketplace","mercadolivre").eq("marketplace_order_id",orderId).maybeSingle();
  if(error)throw new Error(error.message); if(!o)return res.status(404).json({sucesso:false,mensagem:"Pedido não encontrado."});
  const customer=await upsertCustomerFromMarketplaceOrder(orderId,req.body?.customer||{}), contact=await createOrUpdateBlingContact(customer), settings=await getFiscalSettings();
  const payments=Array.isArray(o.raw_data?.payments)?o.raw_data.payments:[], commission=payments.reduce((s,p)=>s+Math.abs(Number(p?.marketplace_fee||0)),0), gross=Number(o.paid_amount??o.total_amount??0), freight=Number(req.body?.freight_amount||0);
  let dt=req.body?.discount_type,dv=req.body?.discount_value,legacy=req.body?.discount_percent;
  if(dt==null&&dv==null&&legacy==null){dt="percent";dv=settings.suggest_ml_commission_as_discount&&gross>0&&commission>0?(commission/gross)*100:Number(settings.default_discount_percent||0);}
  const p=calculateFiscalPreview({grossAmount:gross,commissionAmount:commission,freightAmount:freight,discountType:dt,discountValue:dv,discountPercent:legacy});
  const items=Array.isArray(o.raw_data?.order_items)?o.raw_data.order_items:[]; if(!items.length)return res.status(400).json({sucesso:false,mensagem:"Pedido sem itens para emissão fiscal."});
  const source=items.reduce((s,i)=>s+Number(i.unit_price||0)*Number(i.quantity||1),0), factor=source>0?p.fiscal_amount/source:0; let remaining=p.fiscal_amount;
  const finalItems=items.map((i,x)=>{const q=Math.max(1,Number(i.quantity||1)), line=x===items.length-1?+Math.max(0,remaining).toFixed(2):+(Number(i.unit_price||0)*q*factor).toFixed(2);remaining=+(remaining-line).toFixed(2);return{codigo:i.item?.seller_sku||i.item?.id||undefined,descricao:i.item?.title||"Produto Mercado Livre",quantidade:q,valor:+(line/q).toFixed(2)};});
  const payload=req.body?.bling_payload||{tipo:1,contato:{id:Number(contact)},dataOperacao:new Date(o.date_created||Date.now()).toISOString().slice(0,10),itens:finalItems,observacoes:`Pedido Mercado Livre ${orderId}.`};
  const br=await blingFetch("/nfe",{method:"POST",body:JSON.stringify(payload)}), bd=await br.json(), nfeId=bd?.data?.id||bd?.id||null;
  const base={marketplace_order_id:orderId,customer_id:customer.id,gross_amount:p.gross_amount,commission_amount:p.commission_amount,freight_amount:p.freight_amount,operational_net_amount:p.operational_net_amount,discount_percent:p.discount_percent,fiscal_amount:p.fiscal_amount,bling_contact_id:String(contact),bling_nfe_id:nfeId?String(nfeId):null,status:br.ok?"sent_to_bling":"bling_error",bling_request:payload,bling_response:bd,updated_at:nowIso()};
  let r=await supabase.from("fiscal_documents").upsert({...base,discount_type:p.discount_type,discount_value:p.discount_value,discount_amount:p.discount_amount},{onConflict:"marketplace_order_id"}).select("*").single();
  if(r.error&&/discount_type|discount_value|discount_amount/i.test(r.error.message||""))r=await supabase.from("fiscal_documents").upsert(base,{onConflict:"marketplace_order_id"}).select("*").single();
  if(r.error)throw new Error(r.error.message);
  if(!br.ok)return res.status(br.status).json({sucesso:false,mensagem:"Bling recusou a NF-e.",fiscal:r.data,detalhe:bd});
  res.json({sucesso:true,fiscal:{...r.data,discount_type:p.discount_type,discount_value:p.discount_value,discount_amount:p.discount_amount,discount_percent:p.discount_percent,fiscal_amount:p.fiscal_amount},bling:bd});
 }catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}
});
module.exports=router;
