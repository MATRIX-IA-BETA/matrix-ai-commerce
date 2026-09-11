const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));
const SNAPSHOT_AT = new Date("2026-09-11T00:29:00.000Z");

function netValue(p) {
  const exact = Number(p?.transaction_details?.net_received_amount);
  if (Number.isFinite(exact)) return money(Math.max(0, exact));
  const gross = Math.max(0, n(p?.transaction_amount));
  const refunded = Math.max(0, n(p?.transaction_amount_refunded));
  const fees = (Array.isArray(p?.fee_details) ? p.fee_details : [])
    .filter(f => !f?.fee_payer || String(f.fee_payer).toLowerCase() === "collector")
    .reduce((sum, f) => sum + Math.abs(n(f?.amount)), 0);
  return money(Math.max(0, gross - refunded - fees));
}

async function search(account) {
  const end = new Date(SNAPSHOT_AT.getTime() + 180 * 86400000);
  const collectorId = String(account.user_id || account.account_id || "");
  const rows = [];
  let offset = 0;
  let total = null;
  while (offset < 5000) {
    const q = new URLSearchParams({
      sort: "money_release_date",
      criteria: "asc",
      range: "money_release_date",
      begin_date: SNAPSHOT_AT.toISOString(),
      end_date: end.toISOString(),
      "collector.id": collectorId,
      limit: "100",
      offset: String(offset)
    });
    const { response, data } = await mpRequest(`/v1/payments/search?${q}`, account);
    if (!response.ok) throw new Error(`Payments HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < 100 || (Number.isFinite(total) && offset >= total)) break;
    await sleep(180);
  }
  return rows.filter(p => {
    const created = new Date(p?.date_created || 0).getTime();
    const approved = new Date(p?.date_approved || p?.date_created || 0).getTime();
    const release = new Date(p?.money_release_date || 0).getTime();
    return Number.isFinite(created) && created <= SNAPSHOT_AT.getTime() &&
      Number.isFinite(approved) && approved <= SNAPSHOT_AT.getTime() &&
      Number.isFinite(release) && release > SNAPSHOT_AT.getTime();
  });
}

function group(rows, keyFn) {
  const out = {};
  for (const p of rows) {
    const key = String(keyFn(p) ?? "missing").toLowerCase();
    if (!out[key]) out[key] = { count: 0, net: 0, gross: 0 };
    out[key].count++;
    out[key].net += netValue(p);
    out[key].gross += n(p?.transaction_amount);
  }
  for (const x of Object.values(out)) {
    x.net = money(x.net);
    x.gross = money(x.gross);
  }
  return out;
}

function summary(rows) {
  return { count: rows.length, net: money(rows.reduce((s,p)=>s+netValue(p),0)), gross: money(rows.reduce((s,p)=>s+n(p?.transaction_amount),0)) };
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");
  const rows = await search(account);
  const nonApproved = rows.filter(p => String(p?.status || "").toLowerCase() !== "approved");
  const result = {
    snapshot_at: SNAPSHOT_AT.toISOString(),
    collector_id: String(account.user_id || account.account_id || ""),
    all_future_release_rows: summary(rows),
    by_status: group(rows, p => p?.status),
    by_release_status: group(rows, p => p?.money_release_status),
    by_status_and_release: group(rows, p => `${p?.status || "missing"}|${p?.money_release_status || "missing"}`),
    by_operation: group(rows, p => p?.operation_type),
    by_status_detail: group(rows, p => p?.status_detail),
    non_approved_rows: nonApproved.map(p => ({
      id: p?.id,
      status: p?.status || null,
      status_detail: p?.status_detail || null,
      release_status: p?.money_release_status || null,
      net: netValue(p),
      gross: money(p?.transaction_amount),
      order_id: p?.order?.id || p?.order_id || null,
      description: String(p?.description || "").slice(0,100),
      date_approved: p?.date_approved || null,
      release_date: p?.money_release_date || null
    }))
  };
  console.log("[Financeiro MP SNAPSHOT STATUS AUDIT]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req,res)=>{
  try { res.json({ sucesso:true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso:false, mensagem:error.message }); }
});

const startup = setTimeout(()=>audit().catch(error=>console.warn("[Financeiro MP SNAPSHOT STATUS AUDIT] falhou:", error.message)),18000);
startup.unref?.();

module.exports = router;
