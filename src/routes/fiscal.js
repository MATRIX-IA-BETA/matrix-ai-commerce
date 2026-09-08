const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");
const { blingFetch } = require("../services/bling");

const BLING_HISTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let lastBlingHistorySyncAt = 0;
let lastBlingHistorySyncResult = null;

function summarizeOrder(order, doc, settings) {
  const raw = order.raw_data || {};
  const items = Array.isArray(raw.order_items) ? raw.order_items : [];
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
  const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
  const buyer = raw.buyer || {};
  const buyerName = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() || buyer.nickname || "Cliente Mercado Livre";
  const productTitle = items.length ? items.map(i => i?.item?.title || "Produto").join(" + ") : "Produto Mercado Livre";
  const quantity = items.reduce((sum, i) => sum + Number(i?.quantity || 0), 0);

  let suggestedValue = Number(settings?.default_discount_percent || 0);
  if (settings?.suggest_ml_commission_as_discount && gross > 0 && commission > 0) {
    suggestedValue = Number(((commission / gross) * 100).toFixed(4));
  }

  return {
    marketplace_order_id: String(order.marketplace_order_id),
    date_created: order.date_created,
    marketplace_status: order.status || raw.status || null,
    buyer_name: String(buyerName),
    product_title: productTitle,
    quantity,
    gross_amount: Number(gross.toFixed(2)),
    commission_amount: Number(commission.toFixed(2)),
    suggested_discount_type: "percent",
    suggested_discount_value: suggestedValue,
    fiscal: doc || null
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function accessKeyFrom(value) {
  const direct = digitsOnly(value);
  if (direct.length === 44) return direct;
  const match = String(value ?? "").match(/\d{44}/);
  return match ? match[0] : null;
}

function extractBlingNfeInfo(payload) {
  const d = payload?.data || payload || {};
  const situation =
    d?.situacao?.valor ??
    d?.situacao?.id ??
    d?.situacao?.descricao ??
    d?.situacao ??
    null;

  const situationText = String(situation ?? "");
  const explicitKey =
    accessKeyFrom(d?.chaveAcesso) ||
    accessKeyFrom(d?.chave) ||
    accessKeyFrom(d?.chaveAcessoNfe);

  const linkDanfe = d?.linkDanfe || d?.linkPDF || null;
  const accessKey = explicitKey || accessKeyFrom(linkDanfe);

  const authorized =
    Boolean(accessKey) ||
    [5, 6].includes(Number(situation)) ||
    /autoriz|emitida\s*danfe/i.test(situationText);

  return {
    id: d?.id == null ? null : String(d.id),
    number: d?.numero ?? null,
    series: d?.serie ?? null,
    accessKey,
    pdfUrl: linkDanfe,
    authorized,
    situation,
    blingOrderId:
      d?.pedidoVenda?.id ??
      d?.pedido?.id ??
      d?.venda?.id ??
      null
  };
}

function findOrderIdInPayload(payload, knownOrderIds) {
  if (!payload || !knownOrderIds?.size) return null;

  const d = payload?.data || payload || {};
  const directCandidates = [
    d?.numeroLoja,
    d?.numeroPedidoLoja,
    d?.pedidoLoja,
    d?.numeroPedido,
    d?.pedido?.numeroLoja,
    d?.pedido?.numero,
    d?.pedidoVenda?.numeroLoja,
    d?.pedidoVenda?.numero,
    d?.loja?.numero,
    d?.loja?.numeroPedido
  ]
    .filter(v => v != null)
    .map(v => String(v));

  for (const candidate of directCandidates) {
    if (knownOrderIds.has(candidate)) return candidate;
  }

  let text = "";
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }

  for (const orderId of knownOrderIds) {
    if (text.includes(orderId)) return orderId;
  }

  return null;
}

function formatBlingDate(date, endOfDay = false) {
  const iso = date.toISOString().slice(0, 10);
  return `${iso} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

async function getBlingNfeDetail(nfeId) {
  const response = await blingFetch(
    `/nfe/${encodeURIComponent(String(nfeId))}`,
    { method: "GET" }
  );
  const data = await readJson(response);

  if (!response.ok) {
    const e = new Error(
      `Bling recusou a consulta da NF-e ${nfeId}: ${JSON.stringify(data)}`
    );
    e.httpStatus = response.status;
    throw e;
  }

  return data;
}

async function persistAuthorizedNfe(orderId, info, rawPayload) {
  if (!info?.id) return false;

  const record = {
    marketplace_order_id: String(orderId),
    bling_nfe_id: String(info.id),
    nfe_number: info.number == null ? null : String(info.number),
    nfe_series: info.series == null ? null : String(info.series),
    nfe_access_key: info.accessKey || null,
    nfe_pdf_url: info.pdfUrl || null,
    status: "authorized",
    bling_response: {
      history_sync: rawPayload,
      synced_at: nowIso()
    },
    updated_at: nowIso()
  };

  if (info.blingOrderId != null) {
    record.bling_order_id = String(info.blingOrderId);
  }

  const { error } = await supabase
    .from("fiscal_documents")
    .upsert(record, { onConflict: "marketplace_order_id" });

  if (error) {
    throw new Error(`Erro salvando NF-e sincronizada: ${error.message}`);
  }

  return true;
}

async function syncKnownNfeIds(orderIds) {
  if (!orderIds.length) return { checked: 0, authorized: 0 };

  const { data: docs, error } = await supabase
    .from("fiscal_documents")
    .select("marketplace_order_id,bling_nfe_id,status")
    .in("marketplace_order_id", orderIds);

  if (error) throw new Error(error.message);

  let checked = 0;
  let authorized = 0;

  for (const doc of docs || []) {
    if (!doc?.bling_nfe_id || String(doc.status || "").toLowerCase() === "authorized") {
      continue;
    }

    checked += 1;

    try {
      const detail = await getBlingNfeDetail(doc.bling_nfe_id);
      const info = extractBlingNfeInfo(detail);

      if (info.authorized) {
        if (await persistAuthorizedNfe(doc.marketplace_order_id, info, detail)) {
          authorized += 1;
        }
      }
    } catch (error) {
      console.warn(
        `[Fiscal] Não foi possível sincronizar NF-e conhecida ${doc.bling_nfe_id}:`,
        error.message
      );
    }
  }

  return { checked, authorized };
}

async function listRecentBlingNfes(startDate, endDate) {
  const all = [];
  const pageSize = 100;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      pagina: String(page),
      limite: String(pageSize),
      tipo: "1",
      dataEmissaoInicial: formatBlingDate(startDate, false),
      dataEmissaoFinal: formatBlingDate(endDate, true)
    });

    const response = await blingFetch(`/nfe?${params.toString()}`, {
      method: "GET"
    });

    const payload = await readJson(response);

    if (!response.ok) {
      const e = new Error(
        `Bling recusou a listagem de NF-e: ${JSON.stringify(payload)}`
      );
      e.httpStatus = response.status;
      throw e;
    }

    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    all.push(...rows);

    if (rows.length < pageSize) break;
  }

  return all;
}

async function syncExistingBlingNfes(orders, options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (
    !force &&
    lastBlingHistorySyncAt &&
    now - lastBlingHistorySyncAt < BLING_HISTORY_SYNC_INTERVAL_MS
  ) {
    return lastBlingHistorySyncResult;
  }

  lastBlingHistorySyncAt = now;

  const orderList = Array.isArray(orders) ? orders : [];
  if (!orderList.length) {
    lastBlingHistorySyncResult = {
      synced: 0,
      matched: 0,
      listed: 0,
      known_authorized: 0
    };
    return lastBlingHistorySyncResult;
  }

  const orderIds = orderList.map(o => String(o.marketplace_order_id));
  const knownOrderIds = new Set(orderIds);

  const knownResult = await syncKnownNfeIds(orderIds);

  const dates = orderList
    .map(o => new Date(o.date_created || o.created_at || 0))
    .filter(d => Number.isFinite(d.getTime()) && d.getTime() > 0)
    .sort((a, b) => a - b);

  const startDate = dates.length
    ? new Date(dates[0].getTime() - 2 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const notes = await listRecentBlingNfes(startDate, endDate);

  let matched = 0;
  let synced = 0;

  for (const summary of notes) {
    let orderId = findOrderIdInPayload(summary, knownOrderIds);
    if (!orderId) continue;

    matched += 1;

    let rawPayload = summary;
    let info = extractBlingNfeInfo(summary);

    if ((!info.authorized || !info.accessKey) && info.id) {
      try {
        const detail = await getBlingNfeDetail(info.id);
        rawPayload = detail;
        info = extractBlingNfeInfo(detail);
        orderId = findOrderIdInPayload(detail, knownOrderIds) || orderId;
      } catch (error) {
        console.warn(
          `[Fiscal] Falha consultando detalhes da NF-e ${info.id}:`,
          error.message
        );
      }
    }

    if (!info.authorized || !info.id) continue;

    if (await persistAuthorizedNfe(orderId, info, rawPayload)) {
      synced += 1;
    }
  }

  lastBlingHistorySyncResult = {
    synced,
    matched,
    listed: notes.length,
    known_checked: knownResult.checked,
    known_authorized: knownResult.authorized,
    started_at: formatBlingDate(startDate, false),
    ended_at: formatBlingDate(endDate, true)
  };

  return lastBlingHistorySyncResult;
}

router.get("/fiscal/health", (req, res) => {
  res.json({ sucesso: true, modulo: "fiscal", painel: "/fiscal-nfe.html" });
});

router.get("/fiscal/settings", async (req, res) => {
  try {
    res.json({ sucesso: true, configuracao: await getFiscalSettings() });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.put("/fiscal/settings", async (req, res) => {
  try {
    const body = req.body || {};
    const record = {
      id: 1,
      default_discount_percent: Number(body.default_discount_percent || 0),
      suggest_ml_commission_as_discount: body.suggest_ml_commission_as_discount !== false,
      require_manual_confirmation: false,
      updated_at: nowIso()
    };
    const { data, error } = await supabase.from("fiscal_settings").upsert(record, { onConflict: "id" }).select("*").single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, configuracao: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/fiscal/sync-bling", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.body?.limit || 300)));
    const { data: orders, error } = await supabase
      .from("marketplace_orders")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    const resultado = await syncExistingBlingNfes(orders || [], { force: true });

    res.json({
      sucesso: true,
      mensagem: `Sincronização concluída. ${resultado.synced + resultado.known_authorized} NF-e(s) autorizada(s) atualizada(s).`,
      resultado
    });
  } catch (erro) {
    res.status(erro.httpStatus || 500).json({
      sucesso: false,
      mensagem: erro.message
    });
  }
});

router.get("/fiscal/queue", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const { data: orders, error: ordersError } = await supabase
      .from("marketplace_orders")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .limit(limit);
    if (ordersError) throw new Error(ordersError.message);

    let syncResult = null;
    let syncWarning = null;

    try {
      syncResult = await syncExistingBlingNfes(orders || []);
    } catch (syncError) {
      syncWarning = syncError.message;
      console.warn("[Fiscal] Sincronização histórica do Bling falhou:", syncError.message);
    }

    const ids = (orders || []).map(o => String(o.marketplace_order_id));
    let docs = [];
    if (ids.length) {
      const { data, error } = await supabase.from("fiscal_documents").select("*").in("marketplace_order_id", ids);
      if (error) throw new Error(error.message);
      docs = data || [];
    }

    const byOrder = new Map(docs.map(d => [String(d.marketplace_order_id), d]));
    const settings = await getFiscalSettings();
    const queue = (orders || []).map(order => summarizeOrder(order, byOrder.get(String(order.marketplace_order_id)) || null, settings));
    res.json({
      sucesso: true,
      total: queue.length,
      pedidos: queue,
      sincronizacao_bling: syncResult,
      aviso_sincronizacao: syncWarning
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/fiscal/preview/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const { data: order, error } = await supabase.from("marketplace_orders").select("*").eq("marketplace", "mercadolivre").eq("marketplace_order_id", orderId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return res.status(404).json({ sucesso: false, mensagem: "Pedido não encontrado." });

    const settings = await getFiscalSettings();
    const payments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];
    const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
    const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
    const freight = Number(req.body?.freight_amount || 0);

    let discountType = req.body?.discount_type;
    let discountValue = req.body?.discount_value;
    const legacyDiscountPercent = req.body?.discount_percent;
    if (discountType == null && discountValue == null && legacyDiscountPercent == null) {
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
      discountPercent: legacyDiscountPercent
    });

    const record = {
      marketplace_order_id: orderId,
      gross_amount: preview.gross_amount,
      commission_amount: preview.commission_amount,
      freight_amount: preview.freight_amount,
      operational_net_amount: preview.operational_net_amount,
      discount_type: preview.discount_type,
      discount_value: preview.discount_value,
      discount_amount: preview.discount_amount,
      discount_percent: preview.discount_percent,
      fiscal_amount: preview.fiscal_amount,
      status: "preview",
      updated_at: nowIso()
    };

    const { data: doc, error: docError } = await supabase.from("fiscal_documents").upsert(record, { onConflict: "marketplace_order_id" }).select("*").single();
    if (docError) throw new Error(docError.message);
    res.json({ sucesso: true, fiscal: doc });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

module.exports = router;
