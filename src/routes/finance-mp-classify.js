const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => Number(n(value).toFixed(2));

async function classify() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Conta Mercado Pago não conectada.");

  const now = new Date();
  const begin = new Date(now.getTime() - 120 * 86400000);
  const limit = 100;
  let offset = 0;
  let total = null;
  const buckets = {};

  const add = (key, p) => {
    if (!buckets[key]) buckets[key] = { count: 0, net: 0, gross: 0, total_paid: 0 };
    const refunded = Math.max(0, n(p?.transaction_amount_refunded));
    buckets[key].count++;
    buckets[key].gross += Math.max(0, n(p?.transaction_amount) - refunded);
    buckets[key].total_paid += Math.max(0, n(p?.transaction_details?.total_paid_amount ?? p?.transaction_amount) - refunded);
    buckets[key].net += Math.max(0, n(p?.transaction_details?.net_received_amount));
  };

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
    if (!response.ok) throw new Error(`Payment Search HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    const rows = Array.isArray(data?.results) ? data.results : [];
    total = Number(data?.paging?.total ?? total);

    for (const p of rows) {
      const status = String(p?.money_release_status || "missing").toLowerCase();
      const ts = new Date(p?.money_release_date || 0).getTime();
      const timing = Number.isFinite(ts) && ts > now.getTime() ? "future" : "past_or_missing";
      add(`${status}_${timing}`, p);
      if (status === "pending") add("pending_all", p);
      if (timing === "future") add("future_all", p);
    }

    offset += rows.length;
    if (!rows.length || rows.length < limit || (Number.isFinite(total) && offset >= total)) break;
    await sleep(250);
  }

  for (const value of Object.values(buckets)) {
    value.net = money(value.net);
    value.gross = money(value.gross);
    value.total_paid = money(value.total_paid);
  }

  return { fetched: offset, reported_total: Number.isFinite(total) ? total : null, buckets, checked_at: now.toISOString() };
}

router.get("/api/finance/mercadopago/classify", async (req, res) => {
  try { res.json({ sucesso: true, ...(await classify()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => classify()
  .then(result => console.log("[Financeiro MP Classify]", JSON.stringify(result)))
  .catch(error => console.warn("[Financeiro MP Classify] falhou:", error.message)), 22000);
startup.unref?.();

module.exports = router;
