const router = require("express").Router();
const { supabase } = require("../db/supabase");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => Number(n(value).toFixed(2));

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
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
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
    last = { response, data };
    if (response.ok || (response.status !== 429 && response.status < 500)) return last;
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt));
  }
  return last;
}

async function probeLegacyBalance(account) {
  const userId = String(account.user_id || account.account_id || "");
  if (!userId) return { ok: false, reason: "missing_user_id" };
  const urls = [
    `https://api.mercadopago.com/users/${encodeURIComponent(userId)}/mercadopago_account/balance`,
    `https://api.mercadolibre.com/users/${encodeURIComponent(userId)}/mercadopago_account/balance`
  ];
  const attempts = [];
  for (const url of urls) {
    const { response, data } = await mpRequest(url, account);
    attempts.push({
      host: new URL(url).host,
      status: response.status,
      ok: response.ok,
      balance: response.ok ? {
        total_amount: data?.total_amount ?? null,
        available_balance: data?.available_balance ?? null,
        unavailable_balance: data?.unavailable_balance ?? null
      } : null,
      error: response.ok ? null : (data?.message || data?.error || data?.cause || null)
    });
    if (response.ok) break;
  }
  return { ok: attempts.some(x => x.ok), attempts };
}

async function probePendingPayments(account) {
  const now = new Date();
  const begin = new Date(now.getTime() - 120 * 86400000);
  const limit = 100;
  let offset = 0;
  let reportedTotal = null;
  const rows = [];

  while (offset < 5000) {
    const params = new URLSearchParams({
      sort: "date_created",
      criteria: "desc",
      range: "date_created",
      begin_date: begin.toISOString(),
      end_date: now.toISOString(),
      status: "approved",
      limit: String(limit),
      offset: String(offset)
    });
    const { response, data } = await mpRequest(`/v1/payments/search?${params}`, account);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data?.message || data?.error || data?.cause || null,
        fetched: rows.length
      };
    }
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    reportedTotal = Number(data?.paging?.total ?? reportedTotal);
    offset += page.length;
    if (!page.length || page.length < limit || (Number.isFinite(reportedTotal) && offset >= reportedTotal)) break;
    await sleep(250);
  }

  const releaseStatuses = {};
  const statusDetails = {};
  let futureCount = 0;
  let futureGross = 0;
  let futureTotalPaid = 0;
  let futureNet = 0;
  let futureNetKnown = 0;
  let futureRefunded = 0;

  for (const p of rows) {
    const releaseStatus = String(p?.money_release_status || "missing").toLowerCase();
    releaseStatuses[releaseStatus] = (releaseStatuses[releaseStatus] || 0) + 1;
    const detail = String(p?.status_detail || "missing").toLowerCase();
    statusDetails[detail] = (statusDetails[detail] || 0) + 1;

    const releaseTs = new Date(p?.money_release_date || 0).getTime();
    if (!Number.isFinite(releaseTs) || releaseTs <= now.getTime()) continue;
    futureCount++;
    const refunded = Math.max(0, n(p?.transaction_amount_refunded));
    const gross = Math.max(0, n(p?.transaction_amount) - refunded);
    const totalPaid = Math.max(0, n(p?.transaction_details?.total_paid_amount ?? p?.transaction_amount) - refunded);
    const netRaw = Number(p?.transaction_details?.net_received_amount);
    futureGross += gross;
    futureTotalPaid += totalPaid;
    futureRefunded += refunded;
    if (Number.isFinite(netRaw)) {
      futureNet += Math.max(0, netRaw);
      futureNetKnown++;
    }
  }

  return {
    ok: true,
    fetched: rows.length,
    reported_total: Number.isFinite(reportedTotal) ? reportedTotal : null,
    future_count: futureCount,
    future_gross: money(futureGross),
    future_total_paid: money(futureTotalPaid),
    future_net: money(futureNet),
    future_net_known: futureNetKnown,
    future_refunded: money(futureRefunded),
    release_statuses: releaseStatuses,
    status_details: statusDetails,
    begin_date: begin.toISOString(),
    checked_at: now.toISOString()
  };
}

async function probeReleaseReports(accountArg = null) {
  const account = accountArg || await getMercadoPagoAccount();
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

async function fullDiagnostic() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) return { connected: false };
  const release_report = await probeReleaseReports(account);
  const balance = await probeLegacyBalance(account);
  const payments = await probePendingPayments(account);
  return { connected: true, release_report, balance, payments };
}

router.get("/api/finance/mercadopago/release-report/status", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await probeReleaseReports()) });
  } catch (error) {
    res.status(502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadopago/diagnostic", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await fullDiagnostic()) });
  } catch (error) {
    res.status(502).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(async () => {
  try {
    const result = await fullDiagnostic();
    console.log("[Financeiro MP] diagnóstico:", JSON.stringify(result));
  } catch (error) {
    console.warn("[Financeiro MP] diagnóstico falhou:", error.message);
  }
}, 12000);
startup.unref?.();

module.exports = { router, getMercadoPagoAccount, mpRequest, probeReleaseReports, probeLegacyBalance, probePendingPayments };
