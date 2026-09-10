const router = require("express").Router();
const { supabase } = require("../db/supabase");

async function getMercadoPagoAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,marketplace,account_id,user_id,access_token,refresh_token,expires_at")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  return data;
}

async function mpRequest(path, account, options = {}) {
  const response = await fetch(
    path.startsWith("http") ? path : `https://api.mercadopago.com${path}`,
    {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${account.access_token}`
      },
      signal: options.signal || AbortSignal.timeout(20000)
    }
  );
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text.slice(0, 500) }; }
  return { response, data };
}

async function probeReleaseReports() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) {
    return { connected: false, configured: false, list_status: null };
  }

  const configResult = await mpRequest("/v1/account/release_report/config", account);
  const listResult = await mpRequest("/v1/account/release_report/list", account);

  const list = Array.isArray(listResult.data) ? listResult.data : [];
  const latest = list
    .slice()
    .sort((a, b) => new Date(b?.generation_date || b?.last_modified || 0) - new Date(a?.generation_date || a?.last_modified || 0))
    .slice(0, 3)
    .map(row => ({
      id: row?.id ?? null,
      report_id: row?.report_id ?? null,
      status: row?.status ?? null,
      begin_date: row?.begin_date ?? null,
      end_date: row?.end_date ?? null,
      file_name: row?.file_name ?? null,
      format: row?.format ?? null
    }));

  return {
    connected: true,
    config_status: configResult.response.status,
    configured: configResult.response.ok,
    config_keys: configResult.response.ok ? Object.keys(configResult.data || {}).sort() : [],
    config_error: configResult.response.ok ? null : (configResult.data?.message || configResult.data?.error || configResult.data?.cause || null),
    list_status: listResult.response.status,
    list_ok: listResult.response.ok,
    reports_count: list.length,
    latest
  };
}

router.get("/api/finance/mercadopago/release-report/status", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await probeReleaseReports()) });
  } catch (error) {
    res.status(502).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(async () => {
  try {
    const result = await probeReleaseReports();
    console.log("[Financeiro MP Report] probe:", result);
  } catch (error) {
    console.warn("[Financeiro MP Report] probe falhou:", error.message);
  }
}, 12000);
startup.unref?.();

module.exports = { router, getMercadoPagoAccount, mpRequest, probeReleaseReports };
