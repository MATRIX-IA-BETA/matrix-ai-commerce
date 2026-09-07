const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");
const { upsertCustomerFromMarketplaceOrder } = require("../services/customers");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");
const {
  getBlingAccount,
  saveBlingToken,
  blingBasicAuth,
  blingFetch,
  createOrUpdateBlingContact
} = require("../services/bling");

const BLING_CLIENT_ID = env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = env.BLING_REDIRECT_URI;
const BLING_API_BASE = env.BLING_API_BASE;
const BLING_AUTH_BASE = env.BLING_AUTH_BASE;
const blingOauthSessions = new Map();

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function extractNfeData(payload) {
  const d = payload?.data || payload || {};
  const situation = d?.situacao?.valor ?? d?.situacao?.descricao ?? d?.situacao ?? null;
  const t = situation == null ? "" : String(situation);
  let status = null;
  if (d?.chaveAcesso || /autoriz/i.test(t)) status = "authorized";
  else if (/rejeit|erro|deneg/i.test(t)) status = "rejected";
  return {
    number: d?.numero ?? null,
    series: d?.serie ?? null,
    accessKey: d?.chaveAcesso ?? null,
    pdfUrl: d?.linkDanfe ?? d?.linkPDF ?? null,
    status
  };
}

async function persist(orderId, values) {
  const { data, error } = await supabase
    .from("fiscal_documents")
    .upsert({ marketplace_order_id: String(orderId), ...values, updated_at: nowIso() }, { onConflict: "marketplace_order_id" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

router.get("/auth/bling", (req, res) => {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET || !BLING_REDIRECT_URI) {
    return res.status(500).json({ sucesso: false, mensagem: "Variáveis do Bling não configuradas." });
  }
  const state = crypto.randomBytes(24).toString("hex");
  blingOauthSessions.set(state, { created_at: Date.now() });
  const params = new URLSearchParams({ response_type: "code", client_id: BLING_CLIENT_ID, state });
  res.redirect(`${BLING_AUTH_BASE}/authorize?${params.toString()}`);
});

router.get("/auth/bling/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).json({ sucesso: false, erro: error });
    if (!code || !state || !blingOauthSessions.has(state)) {
      return res.status(400).json({ sucesso: false, mensagem: "Code/state inválido no OAuth Bling." });
    }
    blingOauthSessions.delete(state);
    const body = new URLSearchParams({ grant_type: "authorization_code", code: String(code) });
    const tokenResponse = await fetch(`${BLING_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${blingBasicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "enable-jwt": "1"
      },
      body: body.toString()
    });
    const tokenData = await readJson(tokenResponse);
    if (!tokenResponse.ok) return res.status(tokenResponse.status).json({ sucesso: false, mensagem: "Bling recusou o token.", detalhe: tokenData });
    const account = await saveBlingToken(tokenData);
    res.json({ sucesso: true, mensagem: "Bling conectado à Matrix AI Commerce.", expires_at: account.expires_at });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/bling/status", async (req, res) => {
  try {
    const account = await getBlingAccount();
    res.json({
      sucesso: true,
      conectado: Boolean(account),
      expires_at: account?.expires_at || null,
      token_expirado: account?.expires_at ? new Date(account.expires_at).getTime() <= Date.now() : null
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/bling/customers/:customerId/sync", async (req, res) => {
  try {
    const { data: customer, error } = await supabase.from("customers").select("*").eq("id", req.params.customerId).single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, bling_contact_id: await createOrUpdateBlingContact(customer) });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

async function createNfe(orderId, body = {}) {
  const { data: order, error } = await supabase
    .from("marketplace_orders")
    .select("*")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) { const e = new Error("Pedido não encontrado."); e.httpStatus = 404; throw e; }

  const customer = await upsertCustomerFromMarketplaceOrder(String(orderId), body.customer || {});
  const contactId = await createOrUpdateBlingContact(customer);
  const settings = await getFiscalSettings();
  const payments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];
  const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
  const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
  const freight = Number(body.freight_amount || 0);

  let discountType = body.discount_type;
  let discountValue = body.discount_value;
  const legacy = body.discount_percent;
  if (discountType == null && discountValue == null && legacy == null) {
    discountType = "percent";
    discountValue = settings.suggest_ml_commission_as_discount && gross > 0 && commission > 0
      ? (commission / gross) * 100
      : Number(settings.default_discount_percent || 0);
  }

  const preview = calculateFiscalPreview({
    grossAmount: gross,
    commissionAmount: commission,
    freightAmount: freight,
    discountType,
    discountValue,
    discountPercent: legacy
  });

  const items = Array.isArray(order.raw_data?.order_items) ? order.raw_data.order_items : [];
  if (!items.length) { const e = new Error("Pedido sem itens para emissão fiscal."); e.httpStatus = 400; throw e; }

  const sourceTotal = items.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 1), 0);
  const factor = sourceTotal > 0 ? preview.fiscal_amount / sourceTotal : 0;
  let remaining = preview.fiscal_amount;

  const fiscalItems = items.map((item, index) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const originalLine = Number(item.unit_price || 0) * quantity;
    let lineFinal;
    if (index === items.length - 1) lineFinal = Number(Math.max(0, remaining).toFixed(2));
    else {
      lineFinal = Number((originalLine * factor).toFixed(2));
      remaining = Number((remaining - lineFinal).toFixed(2));
    }
    return {
      codigo: item.item?.seller_sku || item.item?.id || undefined,
      descricao: item.item?.title || "Produto Mercado Livre",
      quantidade: quantity,
      valor: Number((lineFinal / quantity).toFixed(4))
    };
  });

  const payload = body.bling_payload || {
    tipo: 1,
    contato: { id: Number(contactId) },
    dataOperacao: new Date(order.date_created || Date.now()).toISOString().slice(0, 10),
    itens: fiscalItems,
    observacoes: `Pedido Mercado Livre ${orderId}.`
  };

  const response = await blingFetch("/nfe", { method: "POST", body: JSON.stringify(payload) });
  const data = await readJson(response);
  const nfeId = data?.data?.id || data?.id || null;

  const fiscal = await persist(orderId, {
    customer_id: customer.id == null ? null : String(customer.id),
    gross_amount: preview.gross_amount,
    commission_amount: preview.commission_amount,
    freight_amount: preview.freight_amount,
    operational_net_amount: preview.operational_net_amount,
    discount_type: preview.discount_type,
    discount_value: preview.discount_value,
    discount_amount: preview.discount_amount,
    discount_percent: preview.discount_percent,
    fiscal_amount: preview.fiscal_amount,
    bling_contact_id: String(contactId),
    bling_nfe_id: nfeId ? String(nfeId) : null,
    status: response.ok ? "created_bling" : "bling_error",
    bling_request: payload,
    bling_response: data
  });

  if (!response.ok) { const e = new Error("Bling recusou a criação da NF-e."); e.httpStatus = response.status; e.detail = data; e.fiscal = fiscal; throw e; }
  if (!nfeId) { const e = new Error("Bling não retornou o ID da NF-e."); e.httpStatus = 502; e.detail = data; e.fiscal = fiscal; throw e; }
  return { fiscal, nfeId: String(nfeId), createData: data };
}

router.post("/bling/nfe/from-order/:orderId", async (req, res) => {
  try {
    const result = await createNfe(String(req.params.orderId), req.body || {});
    res.json({ sucesso: true, fiscal: result.fiscal, bling: result.createData });
  } catch (erro) {
    res.status(erro.httpStatus || 500).json({ sucesso: false, mensagem: erro.message, fiscal: erro.fiscal || null, detalhe: erro.detail || null });
  }
});

router.post("/bling/nfe/emit/from-order/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const created = await createNfe(orderId, req.body || {});
    await persist(orderId, { status: "sending" });

    const sendResponse = await blingFetch(`/nfe/${encodeURIComponent(created.nfeId)}/enviar?enviarEmail=false`, { method: "POST" });
    const sendData = await readJson(sendResponse);
    if (!sendResponse.ok) {
      const fiscal = await persist(orderId, { status: "send_error", bling_response: { create: created.createData, send: sendData } });
      return res.status(sendResponse.status).json({ sucesso: false, mensagem: "NF-e criada no Bling, mas houve erro no envio.", fiscal, detalhe: sendData });
    }

    let detailData = {};
    try {
      const detailResponse = await blingFetch(`/nfe/${encodeURIComponent(created.nfeId)}`, { method: "GET" });
      detailData = await readJson(detailResponse);
    } catch (_) {}

    const info = extractNfeData(detailData);
    const fiscal = await persist(orderId, {
      status: info.status || "sent_to_sefaz",
      nfe_number: info.number ? String(info.number) : null,
      nfe_series: info.series ? String(info.series) : null,
      nfe_access_key: info.accessKey ? String(info.accessKey) : null,
      nfe_pdf_url: info.pdfUrl || null,
      bling_response: { create: created.createData, send: sendData, detail: detailData }
    });

    res.json({ sucesso: true, mensagem: fiscal.status === "authorized" ? "NF-e autorizada." : "NF-e enviada para emissão.", fiscal });
  } catch (erro) {
    res.status(erro.httpStatus || 500).json({ sucesso: false, mensagem: erro.message, fiscal: erro.fiscal || null, detalhe: erro.detail || null });
  }
});

router.post("/bling/nfe/:blingNfeId/refresh", async (req, res) => {
  try {
    const id = String(req.params.blingNfeId);
    const { data: fiscal, error } = await supabase.from("fiscal_documents").select("*").eq("bling_nfe_id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!fiscal) return res.status(404).json({ sucesso: false, mensagem: "NF-e não encontrada na Matrix." });

    const response = await blingFetch(`/nfe/${encodeURIComponent(id)}`, { method: "GET" });
    const detail = await readJson(response);
    if (!response.ok) return res.status(response.status).json({ sucesso: false, mensagem: "Erro consultando NF-e no Bling.", detalhe: detail });

    const info = extractNfeData(detail);
    const updated = await persist(fiscal.marketplace_order_id, {
      status: info.status || fiscal.status || "sent_to_sefaz",
      nfe_number: info.number ? String(info.number) : fiscal.nfe_number,
      nfe_series: info.series ? String(info.series) : fiscal.nfe_series,
      nfe_access_key: info.accessKey ? String(info.accessKey) : fiscal.nfe_access_key,
      nfe_pdf_url: info.pdfUrl || fiscal.nfe_pdf_url,
      bling_response: detail
    });
    res.json({ sucesso: true, fiscal: updated, bling: detail });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/bling/nfe/document/:accessKey/:format", async (req, res) => {
  try {
    const key = String(req.params.accessKey || "");
    const format = String(req.params.format || "").toLowerCase();
    if (!/^\d{44}$/.test(key)) return res.status(400).json({ sucesso: false, mensagem: "Chave de acesso inválida." });
    if (!["pdf", "xml"].includes(format)) return res.status(400).json({ sucesso: false, mensagem: "Formato deve ser pdf ou xml." });

    const response = await blingFetch(`/nfe/documento/${encodeURIComponent(key)}?formato=${format}`, { method: "GET" });
    if (!response.ok) return res.status(response.status).json({ sucesso: false, mensagem: "Documento ainda não disponível no Bling." });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", format === "pdf" ? "application/pdf" : "application/xml");
    res.setHeader("Content-Disposition", `inline; filename="NFe-${key}.${format}"`);
    res.send(buffer);
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

module.exports = router;
