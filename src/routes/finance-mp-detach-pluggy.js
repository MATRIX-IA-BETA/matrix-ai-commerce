const router = require("express").Router();
const { supabase } = require("../db/supabase");

async function detachMercadoPagoFromPluggy() {
  const now = new Date().toISOString();

  const { data: accounts, error: accountError } = await supabase
    .from("financial_accounts")
    .select("id,name,source,metadata")
    .eq("account_type", "asset");
  if (accountError) throw new Error(accountError.message);

  for (const account of accounts || []) {
    const isMp = account?.metadata?.matrix_key === "mp_available_balance" ||
      /mercado pago/i.test(String(account?.metadata?.institution || account?.name || ""));
    if (!isMp) continue;

    const metadata = {
      ...(account.metadata || {}),
      balance_provider: "mercadopago_api",
      pluggy_disabled_for_balance: true,
      detached_from_pluggy_at: account?.metadata?.detached_from_pluggy_at || now
    };

    const { error } = await supabase
      .from("financial_accounts")
      .update({ source: "mercadopago", metadata, updated_at: now })
      .eq("id", account.id);
    if (error) throw new Error(error.message);
  }

  const { data: connections, error: connectionError } = await supabase
    .from("financial_connections")
    .select("id,institution_name,metadata")
    .eq("provider", "pluggy");
  if (connectionError) throw new Error(connectionError.message);

  for (const connection of connections || []) {
    if (!/mercado pago/i.test(String(connection.institution_name || ""))) continue;
    const metadata = {
      ...(connection.metadata || {}),
      ignored_by_matrix: true,
      ignored_reason: "mercadopago_uses_direct_api",
      ignored_at: connection?.metadata?.ignored_at || now
    };
    const { error } = await supabase
      .from("financial_connections")
      .update({ status: "ignored", metadata, updated_at: now })
      .eq("id", connection.id);
    if (error) throw new Error(error.message);
  }

  return true;
}

router.post("/api/finance/mercadopago/detach-pluggy", async (req, res) => {
  try {
    await detachMercadoPagoFromPluggy();
    res.json({ sucesso: true, mensagem: "Mercado Pago desvinculado da Pluggy para saldo." });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => {
  detachMercadoPagoFromPluggy()
    .then(() => console.log("[Mercado Pago] saldo desvinculado da Pluggy; fonte direta ativa."))
    .catch(error => console.warn("[Mercado Pago] falha ao desvincular Pluggy:", error.message));
}, 2500);
startup.unref?.();

module.exports = router;
