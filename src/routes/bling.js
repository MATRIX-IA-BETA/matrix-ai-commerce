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

router.get("/auth/bling", (req, res) => {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET || !BLING_REDIRECT_URI) {
    return res.status(500).json({ sucesso: false, mensagem: "Variáveis do Bling não configuradas." });
  }

  const state = crypto.randomBytes(24).toString("hex");
  blingOauthSessions.set(state, { created_at: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: BLING_CLIENT_ID,
    state
  });

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

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code)
    });

    const tokenResponse = await fetch(`${BLING_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${blingBasicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "enable-jwt": "1"
      },
      body: body.toString()
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({ sucesso: false, mensagem: "Bling recusou o token.", detalhe: tokenData });
    }

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
    const { data: customer, error } = await supabase
      .from("customers")
      .select("*")
      .eq("id", req.params.customerId)
      .single();
    if (error) throw new Error(error.message);

    const blingContactId = await createOrUpdateBlingContact(customer);
    res.json({ sucesso: true, bling_contact_id: blingContactId });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

// Cria rascunho fiscal no Matrix e, quando solicitado, envia uma NF-e ao Bling.
// O payload fiscal completo pode ser sobrescrito em req.body.bling_payload para adequar CFOP/NCM/tributação da empresa.
router.post("/bling/nfe/from-order/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);

    const { data: order, error: orderError } = await supabase
      .from("marketplace_orders")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .eq("marketplace_order_id", orderId)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message);
    if (!order) return res.status(404).json({ sucesso: false, mensagem: "Pedido não encontrado." });

    const customer = await upsertCustomerFromMarketplaceOrder(orderId, req.body?.customer || {});
    const blingContactId = await createOrUpdateBlingContact(customer);

    const settings = await getFiscalSettings();
    const payments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];
    const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
    const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
    const freight = Number(req.body?.freight_amount || 0);

    let discount = req.body?.discount_percent;
    if (discount == null) {
      discount = settings.suggest_ml_commission_as_discount && gross > 0 && commission > 0
        ? (commission / gross) * 100
        : Number(settings.default_discount_percent || 0);
    }

    const preview = calculateFiscalPreview({
      grossAmount: gross,
      commissionAmount: commission,
      freightAmount: freight,
      discountPercent: discount
    });

    const items = Array.isArray(order.raw_data?.order_items) ? order.raw_data.order_items : [];
    const fiscalFactor = gross > 0 ? preview.fiscal_amount / gross : 1;

    const defaultPayload = {
      tipo: 1,
      contato: { id: Number(blingContactId) },
      dataOperacao: new Date(order.date_created || Date.now()).toISOString().slice(0, 10),
      itens: items.map(item => ({
        codigo: item.item?.seller_sku || item.item?.id || undefined,
        descricao: item.item?.title || "Produto Mercado Livre",
        quantidade: Number(item.quantity || 1),
        valor: Number((Number(item.unit_price || 0) * fiscalFactor).toFixed(2))
      })),
      observacoes: `Pedido Mercado Livre ${orderId}. Valor bruto ${preview.gross_amount.toFixed(2)}. Desconto fiscal ${preview.discount_percent.toFixed(4)}%.`
    };

    const payload = req.body?.bling_payload || defaultPayload;

    const response = await blingFetch("/nfe", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    const blingNfeId = data?.data?.id || data?.id || null;

    const { data: fiscalDoc, error: fiscalError } = await supabase
      .from("fiscal_documents")
      .upsert({
        marketplace_order_id: orderId,
        customer_id: customer.id,
        gross_amount: preview.gross_amount,
        commission_amount: preview.commission_amount,
        freight_amount: preview.freight_amount,
        operational_net_amount: preview.operational_net_amount,
        discount_percent: preview.discount_percent,
        fiscal_amount: preview.fiscal_amount,
        bling_contact_id: String(blingContactId),
        bling_nfe_id: blingNfeId ? String(blingNfeId) : null,
        status: response.ok ? "sent_to_bling" : "bling_error",
        bling_request: payload,
        bling_response: data,
        updated_at: nowIso()
      }, { onConflict: "marketplace_order_id" })
      .select("*")
      .single();

    if (fiscalError) throw new Error(fiscalError.message);

    if (!response.ok) {
      return res.status(response.status).json({ sucesso: false, mensagem: "Bling recusou a NF-e.", fiscal: fiscalDoc, detalhe: data });
    }

    res.json({ sucesso: true, fiscal: fiscalDoc, bling: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});


module.exports = router;
