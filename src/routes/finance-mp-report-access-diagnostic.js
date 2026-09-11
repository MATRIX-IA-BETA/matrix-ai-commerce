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

async function raw(path, account) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${account.access_token}` },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { response, data };
}

async function runProbe() {
  const account = await getAccount();
  const configResult = await raw("/v1/account/release_report/config", account);
  const listResult = await raw("/v1/account/release_report/list", account);

  const config = configResult.response.ok && configResult.data && typeof configResult.data === "object"
    ? {
        file_name_prefix: configResult.data.file_name_prefix || null,
        display_timezone: configResult.data.display_timezone || null,
        separator: configResult.data.separator || null,
        frequency: configResult.data.frequency || null,
        scheduled: configResult.data.scheduled ?? null,
        columns: Array.isArray(configResult.data.columns) ? configResult.data.columns : []
      }
    : null;

  const reports = Array.isArray(listResult.data)
    ? listResult.data.slice(0, 10).map(row => ({
        id: row?.id || null,
        report_id: row?.report_id || null,
        status: row?.status || null,
        file_name: row?.file_name || null,
        begin_date: row?.begin_date || null,
        end_date: row?.end_date || null,
        generation_date: row?.generation_date || null,
        last_modified: row?.last_modified || null,
        format: row?.format || null,
        created_from: row?.created_from || null
      }))
    : [];

  const result = {
    config_http: configResult.response.status,
    list_http: listResult.response.status,
    config,
    reports
  };
  console.log("[MP Release Report Metadata]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/reports/access", async (req, res) => {
  try { res.json({ sucesso: true, ...(await runProbe()) }); }
  catch (error) { res.status(500).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => runProbe().catch(error => console.warn("[MP Release Report Metadata] probe:", error.message)), 9000);
startup.unref?.();

module.exports = router;
