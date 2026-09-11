const router = require("express").Router();
const { supabase } = require("../db/supabase");

const BASE = "https://api.mercadopago.com";

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("access_token,user_id,account_id")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) throw new Error("Mercado Pago OAuth não conectado");
  return data;
}

async function probe(path, account) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${account.access_token}` },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return {
    path,
    status: response.status,
    ok: response.ok,
    count: Array.isArray(data) ? data.length : null,
    keys: data && !Array.isArray(data) && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
    statuses: Array.isArray(data) ? [...new Set(data.slice(0, 50).map(row => row?.status).filter(Boolean))] : []
  };
}

async function runProbe() {
  const account = await getAccount();
  const results = [];
  for (const path of ["/v1/account/release_report/config", "/v1/account/release_report/list"]) {
    try { results.push(await probe(path, account)); }
    catch (error) { results.push({ path, status: 0, ok: false, error: error.message }); }
  }
  console.log("[MP Release Report Access]", JSON.stringify(results));
  return results;
}

router.get("/api/finance/mercadopago/reports/access", async (req, res) => {
  try { res.json({ sucesso: true, resultados: await runProbe() }); }
  catch (error) { res.status(500).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => runProbe().catch(error => console.warn("[MP Release Report Access] probe:", error.message)), 9000);
startup.unref?.();

module.exports = router;
