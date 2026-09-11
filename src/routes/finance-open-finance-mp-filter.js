const router = require("express").Router();
const { supabase } = require("../db/supabase");

function pluggyConfigured() {
  return Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
}

function isMercadoPago(name) {
  return /mercado pago/i.test(String(name || ""));
}

async function connectionByItemId(itemId) {
  if (!itemId) return null;
  const { data, error } = await supabase
    .from("financial_connections")
    .select("id,institution_name,status,external_connection_id,last_sync_at")
    .eq("provider", "pluggy")
    .eq("external_connection_id", String(itemId))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// A Matrix não usa mais a conexão Open Finance do Mercado Pago. Se a Pluggy
// mandar um webhook antigo dessa conexão, confirmamos o recebimento e paramos
// aqui para impedir que ela volte a gravar um saldo atrasado no Financeiro.
router.post("/api/finance/open-finance/webhook", async (req, res, next) => {
  try {
    const itemId = req.body?.itemId ? String(req.body.itemId) : null;
    if (!itemId) return next();
    const connection = await connectionByItemId(itemId);
    if (!connection || !isMercadoPago(connection.institution_name)) return next();
    return res.status(200).json({
      received: true,
      ignored: true,
      reason: "mercadopago_uses_release_report"
    });
  } catch (error) {
    console.warn("[Open Finance MP Filter] webhook:", error.message);
    next();
  }
});

// Para a interface, a Pluggy passa a mostrar somente as conexões que ainda são
// realmente usadas por Open Finance. Hoje isso significa Cora.
router.get("/api/finance/open-finance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_connections")
      .select("id,institution_name,status,external_connection_id,last_sync_at")
      .eq("provider", "pluggy")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);

    const connections = (data || []).filter(row => !isMercadoPago(row.institution_name));
    res.json({
      sucesso: true,
      provider: "pluggy",
      configured: pluggyConfigured(),
      mode: "read_only",
      connections,
      required_env: pluggyConfigured() ? [] : ["PLUGGY_CLIENT_ID", "PLUGGY_CLIENT_SECRET"]
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
