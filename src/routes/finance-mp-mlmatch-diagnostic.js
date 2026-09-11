const router = require("express").Router();
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const SHIPMENTS = [
  { order_id: "2000018197785500", shipment_id: "47893086071", label: "mediação_com_devolucao" },
  { order_id: "2000018250502448", shipment_id: "47918195876", label: "mediação_sem_devolucao" },
  { order_id: "2000018392726278", shipment_id: "47983431613", label: "pagamento_reembolsado" }
];

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text.slice(0, 1500) }; }
}

async function get(account, path) {
  try {
    const { response } = await mercadoLivreFetch(path, account);
    const data = await readJson(response);
    return { http: response.status, ok: response.ok, data: response.ok ? data : { error: data?.message || data?.error || data?.cause || data } };
  } catch (error) {
    return { http: 0, ok: false, data: { error: error.message } };
  }
}

function slimShipment(s) {
  return {
    id: s?.id ?? null,
    status: s?.status ?? null,
    substatus: s?.substatus ?? null,
    mode: s?.mode ?? null,
    logistic_type: s?.logistic_type ?? null,
    shipping_option: s?.shipping_option ?? null,
    base_cost: s?.base_cost ?? null,
    order_cost: s?.order_cost ?? null,
    date_created: s?.date_created ?? null,
    last_updated: s?.last_updated ?? null
  };
}

async function audit() {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Mercado Livre não conectado.");
  const rows = [];
  for (const target of SHIPMENTS) {
    const shipment = await get(account, `/shipments/${target.shipment_id}`);
    const costs = await get(account, `/shipments/${target.shipment_id}/costs`);
    rows.push({
      ...target,
      shipment: { http: shipment.http, ok: shipment.ok, data: shipment.ok ? slimShipment(shipment.data) : shipment.data },
      costs
    });
  }
  console.log("[Financeiro ML ORIGINAL SHIPMENT COSTS]", JSON.stringify(rows));
  return rows;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, shipments: await audit() }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro ML ORIGINAL SHIPMENT COSTS] falhou:", error.message)), 8000);
startup.unref?.();

module.exports = router;
