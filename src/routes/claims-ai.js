const router=require('express').Router();
const {suggestClaimResponse}=require('../services/ml-claims-ai');
router.post('/api/claims-ai-suggest',async(req,res)=>{
 try{res.json({sucesso:true,...await suggestClaimResponse(req.body?.detail,req.body?.mode)});}
 catch(e){res.status(500).json({sucesso:false,mensagem:e.message});}
});
router.use(require('./sales-center'));
module.exports=router;
