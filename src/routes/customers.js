const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { upsertCustomerFromMarketplaceOrder } = require("../services/customers");

router.post("/customers/from-order/:id", async (req, res) => {
  try {
    const customer = await upsertCustomerFromMarketplaceOrder(req.params.id, req.body || {});
    res.json({ sucesso: true, cliente: customer });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/customers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(Math.min(Number(req.query.limit || 100), 500));
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, clientes: data || [] });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});


module.exports = router;
