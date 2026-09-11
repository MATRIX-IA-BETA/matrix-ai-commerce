const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const TARGETS = [
  {
    claim_id: "5573590736",
    order_id: "2000018250502448",
    payment_ids: [175963503433]
  },
  {
    claim_id: "5572889286",
    order_id: "2000018197785500",
    payment_ids: [175480687905, 175481616175],
    return_shipment_id: "47963436618"
  }
];

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text.slice(0, 1500) }; }
}

async function mlGet(account, path) {
  try {
    const { response } = await mercadoLivreFetch(path, account);
    const data = await readJson(response);
    return {
      http: response.status,
      ok: response.ok,
      data: response.ok ? data : { error: data?.message || data?.error || data?.cause || data }
    };
  } catch (error) {
    return { http: 0, ok: false, data: { error: error.message } };
  }
}

function slimPayment(p) {
  return {
    id: p?.id ?? null,
    status: p?.status ?? null,
    status_detail: p?.status_detail ?? null,
    operation_type: p?.operation_type ?? null,
    collector_id: p?.collector?.id ?? p?.collector_id ?? null,
    order: p?.order ?? null,
    external_reference: p?.external_reference ?? null,
    transaction_amount: p?.transaction_amount ?? null,
    transaction_amount_refunded: p?.transaction_amount_refunded ?? null,
    net_received_amount: p?.transaction_details?.net_received_amount ?? null,
    total_paid_amount: p?.transaction_details?.total_paid_amount ?? null,
    money_release_status: p?.money_release_status ?? null,
    money_release_date: p?.money_release_date ?? null,
    date_created: p?.date_created ?? null,
    date_approved: p?.date_approved ?? null,
    date_last_updated: p?.date_last_updated ?? p?.date_last_modified ?? null,
    charges_details: Array.isArray(p?.charges_details)
      ? p.charges_details.map(c => ({
          id: c?.id ?? null,
          name: c?.name ?? null,
          type: c?.type ?? null,
          amount: c?.amounts?.original ?? c?.amount ?? null,
          refunded: c?.amounts?.refunded ?? c?.refunded ?? null,
          reserve_id: c?.reserve_id ?? null,
          date_created: c?.date_created ?? null,
          last_updated: c?.last_updated ?? null
        }))
      : []
  };
}

async function mpPayment(account, id) {
  try {
    const { response, data } = await mpRequest(`/v1/payments/${id}`, account);
    return response.ok
      ? { http: response.status, ok: true, data: slimPayment(data) }
      : { http: response.status, ok: false, data: { error: data?.message || data?.error || data } };
  } catch (error) {
    return { http: 0, ok: false, data: { error: error.message } };
  }
}

async function inspectTarget(mlAccount, mpAccount, target) {
  const claim = await mlGet(mlAccount, `/post-purchase/v1/claims/${target.claim_id}`);
  const detail = await mlGet(mlAccount, `/post-purchase/v1/claims/${target.claim_id}/detail`);
  const expectedResolutions = await mlGet(mlAccount, `/post-purchase/v1/claims/${target.claim_id}/expected-resolutions`);
  const resolutions = await mlGet(mlAccount, `/post-purchase/v1/claims/${target.claim_id}/resolutions`);
  const offers = await mlGet(mlAccount, `/post-purchase/v1/claims/${target.claim_id}/offers`);
  const returnInfo = await mlGet(mlAccount, `/post-purchase/v2/claims/${target.claim_id}/returns`);
  const order = await mlGet(mlAccount, `/orders/${target.order_id}`);
  const payments = [];
  for (const id of target.payment_ids) payments.push(await mpPayment(mpAccount, id));

  let returnShipment = null;
  let returnShipmentCosts = null;
  if (target.return_shipment_id) {
    returnShipment = await mlGet(mlAccount, `/shipments/${target.return_shipment_id}`);
    returnShipmentCosts = await mlGet(mlAccount, `/shipments/${target.return_shipment_id}/costs`);
  }

  return {
    target,
    claim,
    detail,
    expected_resolutions: expectedResolutions,
    resolutions,
    offers,
    return_info: returnInfo,
    order,
    payments,
    return_shipment: returnShipment,
    return_shipment_costs: returnShipmentCosts
  };
}

async function audit() {
  const [mlAccount, mpAccount] = await Promise.all([
    getMercadoLivreAccount(),
    getMercadoPagoAccount()
  ]);
  if (!mlAccount) throw new Error("Mercado Livre não conectado.");
  if (!mpAccount?.access_token) throw new Error("Mercado Pago não conectado.");

  const rows = [];
  for (const target of TARGETS) rows.push(await inspectTarget(mlAccount, mpAccount, target));

  const result = {
    objetivo: "descobrir o bloqueio/valor parcial que explica os R$ 774,29 residuais do A receber",
    targets: rows
  };
  console.log("[Financeiro MP CLAIM RESOLUTION AUDIT]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro MP CLAIM RESOLUTION AUDIT] falhou:", error.message)), 18000);
startup.unref?.();

module.exports = router;
