const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings } = require("../services/fiscal");
const { blingFetch } = require("../services/bling");

const SYNC_CACHE_MS = 2 * 60 * 1000;
let lastSyncAt = 0;
let lastSyncResult = null;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function safeNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function firstValue(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "") ?? null;
}

function recursiveFindAccessKey(value, depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    const direct = digitsOnly(s);
    if (direct.length === 44) return direct;
    const m = s.match(/(?:^|\D)(\d{44})(?:\D|$)/);
    return m ? m[1] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindAccessKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "chaveAcesso", "chave", "accessKey", "chaveNfe",
      "chaveAcessoNfe", "linkDanfe", "linkPDF", "xml", "linkXml"
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = recursiveFindAccessKey(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const child of Object.values(value)) {
      const found = recursiveFindAccessKey(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function dayDistance(a, b) {
  if (!a || !b) return null;
  const aa = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bb = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round(Math.abs(aa - bb) / 86400000);
}

function extractNfeInfo(payload) {
  const d = payload?.data || payload || {};
  const contact = d?.contato || d?.cliente || d?.destinatario || {};
  const totals = d?.totais || d?.total || {};
  const situation = firstValue(
    d?.situacao?.valor,
    d?.situacao?.id,
    d?.situacao?.descricao,
    d?.situacao,
    d?.status?.valor,
    d?.status?.descricao,
    d?.status
  );

  const key = recursiveFindAccessKey(d);
  const situationText = normalizeText(situation);
  const authorized = Boolean(key) ||
    [5, 6, 9].includes(Number(situation)) ||
    /autoriz|emitid|aprovad|processad/.test(situationText);

  let amount = safeNumber(firstValue(
    d?.valorNota,
    d?.valorTotal,
    d?.totalNota,
    d?.total,
    totals?.valorNota,
    totals?.valorTotal,
    totals?.totalNota,
    totals?.total
  ));

  if (amount == null && Array.isArray(d?.itens)) {
    amount = d.itens.reduce((sum, item) => {
      const q = safeNumber(item?.quantidade) ?? 1;
      const v = safeNumber(firstValue(item?.valor, item?.valorUnitario, item?.preco)) ?? 0;
      return sum + q * v;
    }, 0);
  }

  return {
    id: firstValue(d?.id, payload?.id) == null ? null : String(firstValue(d?.id, payload?.id)),
    number: firstValue(d?.numero, d?.numeroNota, d?.numeroDocumento),
    series: firstValue(d?.serie, d?.serieNota),
    accessKey: key,
    pdfUrl: firstValue(d?.linkDanfe, d?.linkPDF, d?.danfe),
    authorized,
    situation,
    contactDocument: digitsOnly(firstValue(
      contact?.numeroDocumento,
      contact?.cpfCnpj,
      contact?.cpf,
      contact?.cnpj,
      d?.numeroDocumento,
      d?.cpfCnpj
    )) || null,
    contactName: firstValue(contact?.nome, contact?.razaoSocial, d?.nomeCliente),
    amount,
    issueDate: parseDate(firstValue(d?.dataEmissao, d?.dataOperacao, d?.data, d?.createdAt, d?.dataCriacao)),
    blingOrderId: firstValue(d?.pedidoVenda?.id, d?.pedido?.id, d?.venda?.id),
    raw: d
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

async function getNfeDetail(id) {
  const response = await blingFetch(`/nfe/${encodeURIComponent(String(id))}`, { method: "GET" });
  const payload = await readJson(response);
  if (!response.ok) {
    const e = new Error(`Falha consultando NF-e ${id} no Bling: ${JSON.stringify(payload)}`);
    e.httpStatus = response.status;
    throw e;
  }
  return payload;
}

async function listRecentNfes() {
  const rows = [];
  const pageSize = 100;
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      pagina: String(page),
      limite: String(pageSize),
      tipo: "1"
    });

    const response = await blingFetch(`/nfe?${params.toString()}`, { method: "GET" });
    const payload = await readJson(response);
    if (!response.ok) {
      const e = new Error(`Falha listando NF-es do Bling: ${JSON.stringify(payload)}`);
      e.httpStatus = response.status;
      throw e;
    }

    const pageRows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows;
}

function orderBuyerName(order) {
  const buyer = order?.raw_data?.buyer || {};
  return [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() ||
    buyer.nickname ||
    order?.buyer_nickname ||
    "";
}

function orderAmount(order, doc) {
  const candidates = [
    safeNumber(doc?.fiscal_amount),
    safeNumber(doc?.gross_amount),
    safeNumber(order?.paid_amount),
    safeNumber(order?.total_amount)
  ].filter(v => v != null && v > 0);
  return candidates;
}

function findDirectOrderId(payload, knownOrderIds) {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload || "");
  }

  for (const orderId of knownOrderIds) {
    if (text.includes(orderId)) return orderId;
  }
  return null;
}

function amountMatches(noteAmount, amounts) {
  if (noteAmount == null) return false;
  return amounts.some(v => Math.abs(v - noteAmount) <= 0.06);
}

function nameScore(noteName, names) {
  const n = normalizeText(noteName);
  if (!n) return 0;

  let best = 0;
  for (const raw of names) {
    const candidate = normalizeText(raw);
    if (!candidate) continue;
    if (candidate === n) best = Math.max(best, 40);
    else if (candidate.includes(n) || n.includes(candidate)) best = Math.max(best, 28);
    else {
      const a = new Set(candidate.split(" ").filter(x => x.length > 2));
      const b = new Set(n.split(" ").filter(x => x.length > 2));
      const common = [...a].filter(x => b.has(x)).length;
      if (common >= 2) best = Math.max(best, 20);
    }
  }
  return best;
}

function chooseOrderForNfe(info, rawPayload, contexts, knownOrderIds, knownNfeMap) {
  if (info?.id && knownNfeMap.has(String(info.id))) {
    return { orderId: knownNfeMap.get(String(info.id)), score: 200, reason: "bling_nfe_id" };
  }

  const direct = findDirectOrderId(rawPayload, knownOrderIds);
  if (direct) return { orderId: direct, score: 180, reason: "pedido_no_payload" };

  const scored = [];
  for (const ctx of contexts) {
    let score = 0;
    const reasons = [];

    if (info.contactDocument && ctx.documents.has(info.contactDocument)) {
      score += 95;
      reasons.push("documento");
    }

    const ns = nameScore(info.contactName, ctx.names);
    if (ns) {
      score += ns;
      reasons.push("nome");
    }

    if (amountMatches(info.amount, ctx.amounts)) {
      score += 40;
      reasons.push("valor");
    }

    const dd = dayDistance(info.issueDate, ctx.date);
    if (dd === 0) {
      score += 18;
      reasons.push("mesmo_dia");
    } else if (dd === 1) {
      score += 10;
      reasons.push("1_dia");
    } else if (dd != null && dd <= 3) {
      score += 4;
      reasons.push("ate_3_dias");
    }

    scored.push({ orderId: ctx.orderId, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best) return null;

  // Exige combinação suficientemente forte e evita escolher quando há empate.
  if (best.score < 68) return null;
  if (second && best.score - second.score < 12) return null;

  return {
    orderId: best.orderId,
    score: best.score,
    reason: best.reasons.join("+")
  };
}

async function persistNfe(orderId, info, payload, match) {
  if (!info?.id || !info?.authorized) return false;

  const record = {
    marketplace_order_id: String(orderId),
    bling_nfe_id: String(info.id),
    nfe_number: info.number == null ? null : String(info.number),
    nfe_series: info.series == null ? null : String(info.series),
    nfe_access_key: info.accessKey || null,
    nfe_pdf_url: info.pdfUrl || null,
    status: "authorized",
    bling_response: {
      history_sync_v2: payload,
      match: match || null,
      synced_at: nowIso()
    },
    updated_at: nowIso()
  };

  if (info.blingOrderId != null) record.bling_order_id = String(info.blingOrderId);

  const { error } = await supabase
    .from("fiscal_documents")
    .upsert(record, { onConflict: "marketplace_order_id" });

  if (error) throw new Error(`Erro salvando NF-e sincronizada: ${error.message}`);
  return true;
}

async function buildContexts(orders) {
  const orderIds = orders.map(o => String(o.marketplace_order_id));
  const { data: docs, error: docsError } = await supabase
    .from("fiscal_documents")
    .select("*")
    .in("marketplace_order_id", orderIds);
  if (docsError) throw new Error(docsError.message);

  const docsByOrder = new Map((docs || []).map(d => [String(d.marketplace_order_id), d]));
  const customerIds = [...new Set((docs || []).map(d => d.customer_id).filter(Boolean).map(String))];
  const buyerIds = [...new Set(orders.map(o => o.buyer_id || o.raw_data?.buyer?.id).filter(Boolean).map(String))];

  let customers = [];
  if (customerIds.length) {
    const { data, error } = await supabase.from("customers").select("*").in("id", customerIds);
    if (error) throw new Error(error.message);
    customers.push(...(data || []));
  }
  if (buyerIds.length) {
    const { data, error } = await supabase.from("customers").select("*").in("marketplace_buyer_id", buyerIds);
    if (error) throw new Error(error.message);
    customers.push(...(data || []));
  }

  const customersById = new Map(customers.map(c => [String(c.id), c]));
  const customersByBuyer = new Map(customers.filter(c => c.marketplace_buyer_id).map(c => [String(c.marketplace_buyer_id), c]));

  const contexts = orders.map(order => {
    const orderId = String(order.marketplace_order_id);
    const doc = docsByOrder.get(orderId) || null;
    const buyerId = String(order.buyer_id || order.raw_data?.buyer?.id || "");
    const customer = (doc?.customer_id && customersById.get(String(doc.customer_id))) || customersByBuyer.get(buyerId) || null;
    const buyer = order.raw_data?.buyer || {};
    const billing = buyer?.billing_info || {};

    const documents = new Set([
      customer?.document_number,
      billing?.identification?.number,
      buyer?.identification?.number
    ].map(digitsOnly).filter(v => v.length >= 11));

    const names = [
      orderBuyerName(order),
      customer?.name,
      buyer?.nickname,
      order?.buyer_nickname
    ].filter(Boolean);

    return {
      orderId,
      order,
      doc,
      customer,
      documents,
      names,
      amounts: orderAmount(order, doc),
      date: parseDate(order.date_created || order.created_at)
    };
  });

  return { contexts, docs: docs || [], docsByOrder };
}

async function syncExistingNfes(orders, force = false) {
  const now = Date.now();
  if (!force && lastSyncAt && now - lastSyncAt < SYNC_CACHE_MS) return lastSyncResult;
  lastSyncAt = now;

  const { contexts, docs } = await buildContexts(orders);
  const knownOrderIds = new Set(contexts.map(c => c.orderId));
  const knownNfeMap = new Map(
    docs.filter(d => d.bling_nfe_id).map(d => [String(d.bling_nfe_id), String(d.marketplace_order_id)])
  );

  let knownChecked = 0;
  let knownAuthorized = 0;

  // Primeiro resolve notas cujo ID do Bling a Matrix já conhece.
  for (const [nfeId, orderId] of knownNfeMap.entries()) {
    const existing = docs.find(d => String(d.marketplace_order_id) === orderId);
    if (String(existing?.status || "").toLowerCase() === "authorized" && existing?.nfe_access_key) continue;
    knownChecked += 1;
    try {
      const detail = await getNfeDetail(nfeId);
      const info = extractNfeInfo(detail);
      if (info.authorized && info.id) {
        await persistNfe(orderId, info, detail, { score: 200, reason: "bling_nfe_id" });
        knownAuthorized += 1;
      }
    } catch (e) {
      console.warn(`[Fiscal V2] Falha sincronizando NF-e conhecida ${nfeId}:`, e.message);
    }
  }

  const summaries = await listRecentNfes();
  let matched = 0;
  let synced = 0;
  let detailsFetched = 0;

  for (const summary of summaries) {
    let payload = summary;
    let info = extractNfeInfo(summary);
    let match = chooseOrderForNfe(info, payload, contexts, knownOrderIds, knownNfeMap);

    // Para notas manuais o resumo muitas vezes não traz CPF/nome/chave suficientes.
    // Buscamos o detalhe das mais recentes antes de desistir do casamento.
    if ((!match || !info.accessKey || !info.contactDocument || !info.contactName) && info.id && detailsFetched < 120) {
      try {
        payload = await getNfeDetail(info.id);
        detailsFetched += 1;
        info = extractNfeInfo(payload);
        match = chooseOrderForNfe(info, payload, contexts, knownOrderIds, knownNfeMap);
      } catch (e) {
        console.warn(`[Fiscal V2] Falha lendo detalhe da NF-e ${info.id}:`, e.message);
      }
    }

    if (!match || !info.authorized || !info.id) continue;
    matched += 1;

    try {
      if (await persistNfe(match.orderId, info, payload, match)) synced += 1;
    } catch (e) {
      console.warn(`[Fiscal V2] Falha persistindo NF-e ${info.id}:`, e.message);
    }
  }

  lastSyncResult = {
    listed: summaries.length,
    details_fetched: detailsFetched,
    matched,
    synced,
    known_checked: knownChecked,
    known_authorized: knownAuthorized,
    at: nowIso()
  };
  return lastSyncResult;
}

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

async function getOrders(limit) {
  const { data, error } = await supabase
    .from("marketplace_orders")
    .select("*")
    .eq("marketplace", "mercadolivre")
    .order("date_created", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

router.post("/fiscal/sync-bling", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.body?.limit || 300)));
    const orders = await getOrders(limit);
    const resultado = await syncExistingNfes(orders, true);
    res.json({
      sucesso: true,
      mensagem: `Sincronização V2 concluída: ${resultado.synced + resultado.known_authorized} NF-e(s) atualizada(s).`,
      resultado
    });
  } catch (erro) {
    res.status(erro.httpStatus || 500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/fiscal/queue", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const orders = await getOrders(limit);

    let syncResult = null;
    let syncWarning = null;
    try {
      syncResult = await syncExistingNfes(orders, false);
    } catch (e) {
      syncWarning = e.message;
      console.warn("[Fiscal V2] Sincronização histórica falhou:", e.message);
    }

    const ids = orders.map(o => String(o.marketplace_order_id));
    let docs = [];
    if (ids.length) {
      const { data, error } = await supabase.from("fiscal_documents").select("*").in("marketplace_order_id", ids);
      if (error) throw new Error(error.message);
      docs = data || [];
    }

    const byOrder = new Map(docs.map(d => [String(d.marketplace_order_id), d]));
    const settings = await getFiscalSettings();
    const queue = orders.map(order => summarizeOrder(order, byOrder.get(String(order.marketplace_order_id)) || null, settings));

    res.json({
      sucesso: true,
      total: queue.length,
      pedidos: queue,
      bling_sync: syncResult,
      bling_sync_warning: syncWarning
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

module.exports = router;
