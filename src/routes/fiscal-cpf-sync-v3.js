const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings } = require("../services/fiscal");
const { blingFetch } = require("../services/bling");
const { upsertCustomerFromMarketplaceOrder } = require("../services/customers");

const BLING_DELAY_MS = 360;
const RESYNC_INTERVAL_MS = 10 * 60 * 1000;
const MAX_NFE_PAGES = 8;
const NFE_PAGE_SIZE = 100;
const ML_ENRICH_CONCURRENCY = 6;

let syncState = {
  running: false,
  phase: "idle",
  started_at: null,
  finished_at: null,
  orders: 0,
  cpf_loaded: 0,
  cpf_failed: 0,
  nfe_listed: 0,
  details_checked: 0,
  matched: 0,
  authorized: 0,
  last_error: null
};
let syncPromise = null;
let lastCompletedAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
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

function recursiveFindAccessKey(value, depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    const digits = digitsOnly(s);
    if (digits.length === 44) return digits;
    const match = s.match(/(?:^|\D)(\d{44})(?:\D|$)/);
    return match ? match[1] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindAccessKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const preferred = [
      "chaveAcesso",
      "chave",
      "accessKey",
      "chaveNfe",
      "chaveAcessoNfe",
      "linkDanfe",
      "linkPDF",
      "xml",
      "linkXml"
    ];

    for (const key of preferred) {
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

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractNfeInfo(payload) {
  const d = payload?.data || payload || {};
  const contact = d?.contato || d?.cliente || d?.destinatario || {};
  const totals = d?.totais || {};
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

  let amount = safeNumber(firstValue(
    d?.valorNota,
    d?.valorTotal,
    d?.totalNota,
    totals?.valorNota,
    totals?.valorTotal,
    totals?.totalNota
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
    authorized:
      Boolean(key) ||
      [5, 6, 9].includes(Number(situation)) ||
      /autoriz|emitid|aprovad|processad/.test(situationText),
    contactDocument: digitsOnly(firstValue(
      contact?.numeroDocumento,
      contact?.cpfCnpj,
      contact?.cpf,
      contact?.cnpj,
      d?.cpfCnpj
    )) || null,
    contactName: firstValue(contact?.nome, contact?.razaoSocial, d?.nomeCliente),
    amount,
    issueDate: parseDate(firstValue(
      d?.dataEmissao,
      d?.dataOperacao,
      d?.data,
      d?.createdAt,
      d?.dataCriacao
    )),
    blingOrderId: firstValue(d?.pedidoVenda?.id, d?.pedido?.id, d?.venda?.id),
    raw: d
  };
}

function orderBuyerName(order) {
  const buyer = order?.raw_data?.buyer || {};
  return [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() ||
    buyer.nickname ||
    order?.buyer_nickname ||
    "";
}

function findDirectOrderId(payload, knownOrderIds) {
  let text = "";
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

function nameScore(noteName, names) {
  const n = normalizeText(noteName);
  if (!n) return 0;

  let best = 0;
  for (const raw of names) {
    const candidate = normalizeText(raw);
    if (!candidate) continue;
    if (candidate === n) best = Math.max(best, 35);
    else if (candidate.includes(n) || n.includes(candidate)) best = Math.max(best, 24);
    else {
      const a = new Set(candidate.split(" ").filter(x => x.length > 2));
      const b = new Set(n.split(" ").filter(x => x.length > 2));
      const common = [...a].filter(x => b.has(x)).length;
      if (common >= 2) best = Math.max(best, 18);
    }
  }
  return best;
}

function amountMatches(noteAmount, amounts) {
  if (noteAmount == null) return false;
  return amounts.some(v => Math.abs(v - noteAmount) <= 0.06);
}

function chooseContext(info, payload, contexts, knownOrderIds, knownNfeMap, assigned) {
  if (info?.id && knownNfeMap.has(String(info.id))) {
    return {
      orderId: knownNfeMap.get(String(info.id)),
      score: 1000,
      reason: "bling_nfe_id"
    };
  }

  const direct = findDirectOrderId(payload, knownOrderIds);
  if (direct) {
    return { orderId: direct, score: 900, reason: "pedido_no_payload" };
  }

  const scored = [];
  for (const ctx of contexts) {
    if (assigned.has(ctx.orderId)) continue;

    let score = 0;
    const reasons = [];

    if (info.contactDocument && ctx.documents.has(info.contactDocument)) {
      score += 120;
      reasons.push("cpf_cnpj");
    }

    const ns = nameScore(info.contactName, ctx.names);
    if (ns) {
      score += ns;
      reasons.push("nome");
    }

    if (amountMatches(info.amount, ctx.amounts)) {
      score += 35;
      reasons.push("valor");
    }

    const dd = dayDistance(info.issueDate, ctx.date);
    if (dd === 0) {
      score += 25;
      reasons.push("mesmo_dia");
    } else if (dd === 1) {
      score += 12;
      reasons.push("1_dia");
    } else if (dd != null && dd <= 3) {
      score += 5;
      reasons.push("ate_3_dias");
    }

    scored.push({ orderId: ctx.orderId, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best) return null;

  const hasDocument = best.reasons.includes("cpf_cnpj");
  const minimum = hasDocument ? 120 : 78;
  if (best.score < minimum) return null;

  if (second && best.score - second.score < 8) return null;

  return {
    orderId: best.orderId,
    score: best.score,
    reason: best.reasons.join("+")
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

async function enrichCustomersWithCpf(orders) {
  const buyerIds = [...new Set(
    orders
      .map(o => o.buyer_id || o.raw_data?.buyer?.id)
      .filter(Boolean)
      .map(String)
  )];

  let existing = [];
  if (buyerIds.length) {
    const { data, error } = await supabase
      .from("customers")
      .select("id,marketplace_buyer_id,document_number")
      .in("marketplace_buyer_id", buyerIds);
    if (error) throw new Error(error.message);
    existing = data || [];
  }

  const withDocument = new Set(
    existing
      .filter(c => digitsOnly(c.document_number).length >= 11)
      .map(c => String(c.marketplace_buyer_id || ""))
      .filter(Boolean)
  );

  const missing = orders.filter(order => {
    const buyerId = String(order.buyer_id || order.raw_data?.buyer?.id || "");
    const embedded = digitsOnly(
      order.raw_data?.buyer?.billing_info?.identification?.number ||
      order.raw_data?.buyer?.identification?.number
    );
    return embedded.length < 11 && (!buyerId || !withDocument.has(buyerId));
  });

  let loaded = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= missing.length) return;
      const order = missing[index];
      try {
        await upsertCustomerFromMarketplaceOrder(String(order.marketplace_order_id));
        loaded += 1;
      } catch (error) {
        failed += 1;
        console.warn(
          `[Fiscal V3] CPF/CNPJ não carregado para pedido ${order.marketplace_order_id}:`,
          error.message
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(ML_ENRICH_CONCURRENCY, missing.length) },
    () => worker()
  );
  await Promise.all(workers);

  return { loaded, failed, attempted: missing.length };
}

async function buildContexts(orders) {
  const orderIds = orders.map(o => String(o.marketplace_order_id));
  let docs = [];
  if (orderIds.length) {
    const { data, error } = await supabase
      .from("fiscal_documents")
      .select("*")
      .in("marketplace_order_id", orderIds);
    if (error) throw new Error(error.message);
    docs = data || [];
  }

  const docsByOrder = new Map(docs.map(d => [String(d.marketplace_order_id), d]));
  const buyerIds = [...new Set(
    orders
      .map(o => o.buyer_id || o.raw_data?.buyer?.id)
      .filter(Boolean)
      .map(String)
  )];

  let customers = [];
  if (buyerIds.length) {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .in("marketplace_buyer_id", buyerIds);
    if (error) throw new Error(error.message);
    customers = data || [];
  }

  const customersByBuyer = new Map(
    customers
      .filter(c => c.marketplace_buyer_id)
      .map(c => [String(c.marketplace_buyer_id), c])
  );

  const contexts = orders.map(order => {
    const orderId = String(order.marketplace_order_id);
    const doc = docsByOrder.get(orderId) || null;
    const buyer = order.raw_data?.buyer || {};
    const buyerId = String(order.buyer_id || buyer?.id || "");
    const customer = customersByBuyer.get(buyerId) || null;

    const documents = new Set([
      customer?.document_number,
      buyer?.billing_info?.identification?.number,
      buyer?.identification?.number
    ].map(digitsOnly).filter(v => v.length >= 11));

    const names = [
      orderBuyerName(order),
      customer?.name,
      buyer?.nickname,
      order?.buyer_nickname
    ].filter(Boolean);

    const amounts = [
      safeNumber(doc?.fiscal_amount),
      safeNumber(doc?.gross_amount),
      safeNumber(order?.paid_amount),
      safeNumber(order?.total_amount)
    ].filter(v => v != null && v > 0);

    return {
      orderId,
      order,
      doc,
      customer,
      documents,
      names,
      amounts,
      date: parseDate(order.date_created || order.created_at)
    };
  });

  return { contexts, docs, docsByOrder };
}

async function listRecentNfes() {
  const rows = [];
  for (let page = 1; page <= MAX_NFE_PAGES; page += 1) {
    if (page > 1) await sleep(BLING_DELAY_MS);

    const params = new URLSearchParams({
      pagina: String(page),
      limite: String(NFE_PAGE_SIZE),
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
    if (pageRows.length < NFE_PAGE_SIZE) break;
  }
  return rows;
}

async function getNfeDetail(id) {
  await sleep(BLING_DELAY_MS);
  const response = await blingFetch(
    `/nfe/${encodeURIComponent(String(id))}`,
    { method: "GET" }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    const e = new Error(`Falha consultando NF-e ${id}: ${JSON.stringify(payload)}`);
    e.httpStatus = response.status;
    throw e;
  }
  return payload;
}

async function persistNfe(orderId, info, payload, match) {
  if (!info?.id || !info?.authorized || !info?.accessKey) return false;

  const record = {
    marketplace_order_id: String(orderId),
    bling_nfe_id: String(info.id),
    nfe_number: info.number == null ? null : String(info.number),
    nfe_series: info.series == null ? null : String(info.series),
    nfe_access_key: info.accessKey,
    nfe_pdf_url: info.pdfUrl || null,
    status: "authorized",
    bling_response: {
      history_sync_v3: payload,
      match: match || null,
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

  if (error) throw new Error(`Erro salvando NF-e sincronizada: ${error.message}`);
  return true;
}

async function runDeepSync(orders) {
  syncState = {
    running: true,
    phase: "cpf",
    started_at: nowIso(),
    finished_at: null,
    orders: orders.length,
    cpf_loaded: 0,
    cpf_failed: 0,
    nfe_listed: 0,
    details_checked: 0,
    matched: 0,
    authorized: 0,
    last_error: null
  };

  try {
    const enrich = await enrichCustomersWithCpf(orders);
    syncState.cpf_loaded = enrich.loaded;
    syncState.cpf_failed = enrich.failed;

    syncState.phase = "context";
    const { contexts, docs } = await buildContexts(orders);
    const knownOrderIds = new Set(contexts.map(c => c.orderId));
    const knownNfeMap = new Map(
      docs
        .filter(d => d.bling_nfe_id)
        .map(d => [String(d.bling_nfe_id), String(d.marketplace_order_id)])
    );

    const assigned = new Set(
      docs
        .filter(d => String(d.status || "").toLowerCase() === "authorized")
        .map(d => String(d.marketplace_order_id))
    );

    syncState.phase = "list_bling";
    const summaries = await listRecentNfes();
    syncState.nfe_listed = summaries.length;

    const pendingDetails = [];
    for (const summary of summaries) {
      const info = extractNfeInfo(summary);
      if (!info.id) continue;

      const knownOrderId = knownNfeMap.get(String(info.id));
      const existingKnown = knownOrderId && docs.find(
        d => String(d.marketplace_order_id) === String(knownOrderId)
      );

      if (
        existingKnown &&
        String(existingKnown.status || "").toLowerCase() === "authorized" &&
        digitsOnly(existingKnown.nfe_access_key).length === 44
      ) {
        continue;
      }

      const match = chooseContext(
        info,
        summary,
        contexts,
        knownOrderIds,
        knownNfeMap,
        assigned
      );

      if (match && info.authorized && info.accessKey) {
        if (await persistNfe(match.orderId, info, summary, match)) {
          assigned.add(String(match.orderId));
          syncState.matched += 1;
          syncState.authorized += 1;
        }
      } else {
        pendingDetails.push(summary);
      }
    }

    syncState.phase = "details";
    for (const summary of pendingDetails) {
      const summaryInfo = extractNfeInfo(summary);
      if (!summaryInfo.id) continue;

      try {
        const detail = await getNfeDetail(summaryInfo.id);
        syncState.details_checked += 1;

        const info = extractNfeInfo(detail);
        if (!info.authorized || !info.accessKey) continue;

        const match = chooseContext(
          info,
          detail,
          contexts,
          knownOrderIds,
          knownNfeMap,
          assigned
        );
        if (!match) continue;

        if (await persistNfe(match.orderId, info, detail, match)) {
          assigned.add(String(match.orderId));
          syncState.matched += 1;
          syncState.authorized += 1;
        }

        if (syncState.authorized >= orders.length) break;
      } catch (error) {
        console.warn(
          `[Fiscal V3] Falha lendo NF-e ${summaryInfo.id}:`,
          error.message
        );
      }
    }

    syncState.phase = "done";
    syncState.running = false;
    syncState.finished_at = nowIso();
    lastCompletedAt = Date.now();
  } catch (error) {
    syncState.phase = "error";
    syncState.running = false;
    syncState.finished_at = nowIso();
    syncState.last_error = error.message;
    lastCompletedAt = Date.now();
    console.error("[Fiscal V3] Sincronização profunda falhou:", error);
  }
}

function startDeepSync(orders, force = false) {
  if (syncPromise) return syncPromise;
  if (!force && lastCompletedAt && Date.now() - lastCompletedAt < RESYNC_INTERVAL_MS) {
    return null;
  }

  syncPromise = runDeepSync(orders)
    .catch(error => {
      console.error("[Fiscal V3] Erro não tratado na sincronização:", error);
    })
    .finally(() => {
      syncPromise = null;
    });

  return syncPromise;
}

function summarizeOrder(order, doc, settings) {
  const raw = order.raw_data || {};
  const items = Array.isArray(raw.order_items) ? raw.order_items : [];
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
  const commission = payments.reduce(
    (sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)),
    0
  );
  const buyer = raw.buyer || {};
  const buyerName =
    [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() ||
    buyer.nickname ||
    "Cliente Mercado Livre";
  const productTitle = items.length
    ? items.map(i => i?.item?.title || "Produto").join(" + ")
    : "Produto Mercado Livre";
  const quantity = items.reduce((sum, i) => sum + Number(i?.quantity || 0), 0);

  let suggestedValue = Number(settings?.default_discount_percent || 0);
  if (
    settings?.suggest_ml_commission_as_discount &&
    gross > 0 &&
    commission > 0
  ) {
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

router.post("/fiscal/sync-bling", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.body?.limit || 300)));
    const orders = await getOrders(limit);
    startDeepSync(orders, true);

    res.status(202).json({
      sucesso: true,
      mensagem: syncState.running
        ? "Sincronização por CPF/CNPJ iniciada."
        : "Sincronização já estava em andamento.",
      resultado: syncState
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/fiscal/queue", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 300)));
    const orders = await getOrders(limit);

    startDeepSync(orders, false);

    const ids = orders.map(o => String(o.marketplace_order_id));
    let docs = [];
    if (ids.length) {
      const { data, error } = await supabase
        .from("fiscal_documents")
        .select("*")
        .in("marketplace_order_id", ids);
      if (error) throw new Error(error.message);
      docs = data || [];
    }

    const byOrder = new Map(
      docs.map(d => [String(d.marketplace_order_id), d])
    );
    const settings = await getFiscalSettings();
    const queue = orders.map(order =>
      summarizeOrder(
        order,
        byOrder.get(String(order.marketplace_order_id)) || null,
        settings
      )
    );

    res.json({
      sucesso: true,
      total: queue.length,
      pedidos: queue,
      bling_sync: syncState
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
