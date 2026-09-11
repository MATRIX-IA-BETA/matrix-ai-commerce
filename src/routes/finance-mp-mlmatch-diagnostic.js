const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const IDS = [175963503433, 175480687905, 175481616175, 178328526116];

function pickCharge(c) {
  return {
    id: c?.id ?? null,
    name: c?.name ?? c?.type ?? null,
    type: c?.type ?? null,
    amount: c?.amounts?.original ?? c?.amount ?? null,
    refunded: c?.amounts?.refunded ?? null,
    reserve_id: c?.reserve_id ?? null,
    date_created: c?.date_created ?? null,
    last_updated: c?.last_updated ?? null
  };
}

function project(p) {
  return {
    id: p?.id,
    status: p?.status,
    status_detail: p?.status_detail,
    operation_type: p?.operation_type,
    transaction_amount: p?.transaction_amount,
    transaction_amount_refunded: p?.transaction_amount_refunded,
    taxes_amount: p?.taxes_amount,
    shipping_amount: p?.shipping_amount,
    marketplace_fee: p?.marketplace_fee,
    money_release_status: p?.money_release_status,
    money_release_date: p?.money_release_date,
    money_release_schema: p?.money_release_schema ?? null,
    net_received_amount: p?.transaction_details?.net_received_amount ?? null,
    total_paid_amount: p?.transaction_details?.total_paid_amount ?? null,
    installment_amount: p?.transaction_details?.installment_amount ?? p?.installment_amount ?? null,
    overpaid_amount: p?.transaction_details?.overpaid_amount ?? p?.overpaid_amount ?? null,
    financial_institution: p?.transaction_details?.financial_institution ?? null,
    payable_deferral_period: p?.transaction_details?.payable_deferral_period ?? null,
    order: p?.order ?? null,
    external_reference: p?.external_reference ?? null,
    fee_details: p?.fee_details ?? [],
    charges_details: Array.isArray(p?.charges_details) ? p.charges_details.map(pickCharge) : [],
    accounts_info: p?.accounts_info ?? null,
    point_of_interaction: p?.point_of_interaction ?? null,
    date_created: p?.date_created,
    date_approved: p?.date_approved,
    date_last_updated: p?.date_last_updated ?? p?.date_last_modified ?? null,
    description: p?.description ?? null
  };
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");
  const out = [];
  for (const id of IDS) {
    const { response, data } = await mpRequest(`/v1/payments/${id}`, account);
    out.push(response.ok ? project(data) : { id, status_http: response.status, error: data?.message || data?.error || null });
  }
  console.log("[Financeiro MP MEDIATION DETAILS]", JSON.stringify(out));
  return out;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req,res)=>{
  try { res.json({ sucesso:true, pagamentos: await audit() }); }
  catch (error) { res.status(502).json({ sucesso:false, mensagem:error.message }); }
});

const startup = setTimeout(()=>audit().catch(error=>console.warn("[Financeiro MP MEDIATION DETAILS] falhou:", error.message)),18000);
startup.unref?.();

module.exports = router;
