// Rotas do Painel Matrix AI — V1
const express = require("express");

function createAnalyticsRouter({ supabase }) {
  const router = express.Router();
  const { createAnalyticsService } = require("../services/analytics");
  const analytics = createAnalyticsService({ supabase });

  router.get("/executive", async (req,res)=>{
    try { res.json(await analytics.executiveDashboard({days:Number(req.query.days||30)})); }
    catch(e){ console.error("dashboard executive:",e); res.status(500).json({sucesso:false,mensagem:e.message}); }
  });

  router.post("/rebuild", async (req,res)=>{
    try { res.json({sucesso:true,...await analytics.rebuildAll({days:Number(req.body?.days||30),limit:Number(req.body?.limit||3000)})}); }
    catch(e){ console.error("analytics rebuild:",e); res.status(500).json({sucesso:false,mensagem:e.message}); }
  });

  router.post("/profitability/rebuild", async (req,res)=>{
    try { res.json({sucesso:true,...await analytics.rebuildProfitability({days:Number(req.body?.days||30),limit:Number(req.body?.limit||3000)})}); }
    catch(e){ res.status(500).json({sucesso:false,mensagem:e.message}); }
  });

  router.post("/insights/rebuild", async (req,res)=>{
    try { res.json({sucesso:true,...await analytics.generateInsights({days:Number(req.body?.days||30)})}); }
    catch(e){ res.status(500).json({sucesso:false,mensagem:e.message}); }
  });

  router.post("/health/rebuild", async (req,res)=>{
    try { res.json({sucesso:true,health:await analytics.healthSnapshot({days:Number(req.body?.days||30)})}); }
    catch(e){ res.status(500).json({sucesso:false,mensagem:e.message}); }
  });

  router.get("/insights", async (req,res)=>{
    const {data,error}=await supabase.from("v_open_ai_insights").select("*").limit(Math.min(Number(req.query.limit||50),200));
    if(error) return res.status(500).json({sucesso:false,mensagem:error.message});
    res.json({sucesso:true,insights:data||[]});
  });

  router.get("/returns", async (req,res)=>{
    const {data,error}=await supabase.from("marketplace_returns").select("*").order("opened_at",{ascending:false}).limit(Math.min(Number(req.query.limit||100),500));
    if(error) return res.status(500).json({sucesso:false,mensagem:error.message});
    res.json({sucesso:true,returns:data||[]});
  });

  router.get("/audit", async (req,res)=>{
    const {data,error}=await supabase.from("ai_action_log").select("*").order("created_at",{ascending:false}).limit(Math.min(Number(req.query.limit||100),500));
    if(error) return res.status(500).json({sucesso:false,mensagem:error.message});
    res.json({sucesso:true,actions:data||[]});
  });

  return router;
}
module.exports={ createAnalyticsRouter };
