const router = require("express").Router();
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const TARGET_ORDERS = new Set(["2000018250502448", "2000018197785500"]);

async function json(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0,500) }; }
}

function orderId(claim) {
  if (claim?.order_id != null) return String(claim.order_id);
  if (String(claim?.resource || "").toLowerCase() === "order" && claim?.resource_id != null) return String(claim.resource_id);
  return null;
}

function slimClaim(c) {
  return {
    id: c?.id ?? c?.claim_id ?? null,
    order_id: orderId(c),
    status: c?.status ?? null,
    stage: c?.stage ?? null,
    type: c?.type ?? null,
    reason_id: c?.reason_id ?? null,
    claimed_quantity: c?.claimed_quantity ?? null,
    resource: c?.resource ?? null,
    resource_id: c?.resource_id ?? null,
    related_entities: c?.related_entities ?? null,
    resolution: c?.resolution ?? null,
    date_created: c?.date_created ?? null,
    last_updated: c?.last_updated ?? null,
    players: c?.players ?? null
  };
}

async function audit() {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Mercado Livre não conectado.");
  const params = new URLSearchParams({
    "players.user_id": String(account.user_id),
    "players.role": "respondent",
    status: "opened",
    limit: "50",
    offset: "0",
    sort: "last_updated:desc"
  });
  const base = await mercadoLivreFetch(`/post-purchase/v1/claims/search?${params}`, account);
  const payload = await json(base.response);
  if (!base.response.ok) throw new Error(`Claims HTTP ${base.response.status}`);
  const claims = (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.results) ? payload.results : []))
    .filter(c => TARGET_ORDERS.has(orderId(c)));

  const rows = [];
  for (const c of claims) {
    const id = String(c.id ?? c.claim_id);
    const paths = [
      ["claim", `/post-purchase/v1/claims/${id}`],
      ["detail", `/post-purchase/v1/claims/${id}/detail`],
      ["returns_v2", `/post-purchase/v2/claims/${id}/returns`],
      ["returns_v1", `/post-purchase/v1/claims/${id}/returns`]
    ];
    const detail = { search: slimClaim(c) };
    for (const [key,path] of paths) {
      const r = await mercadoLivreFetch(path, account);
      const data = await json(r.response);
      detail[key] = { http: r.response.status, data: r.response.ok ? data : { error: data?.message || data?.error || data?.cause || null } };
    }
    rows.push(detail);
  }
  console.log("[Financeiro ML PENDING CLAIM DETAILS]", JSON.stringify(rows));
  return rows;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req,res)=>{
  try { res.json({ sucesso:true, claims: await audit() }); }
  catch (error) { res.status(502).json({ sucesso:false, mensagem:error.message }); }
});

const startup = setTimeout(()=>audit().catch(error=>console.warn("[Financeiro ML PENDING CLAIM DETAILS] falhou:", error.message)),18000);
startup.unref?.();

module.exports = router;
