const router = require("express").Router();

const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");
const {
  sincronizarClaimML,
  contextoSac,
  enviarRespostaSac
} = require("../services/sac");

const LIST_CACHE_MS = 45 * 1000;
const PAGE_SIZE = 50;
const MAX_CLAIMS = 9500;
let listCache = { at: 0, payload: null };

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function claimCategory(claim) {
  const status = normalize(claim?.status);
  const stage = normalize(claim?.stage);
  if (status === "closed" || status === "encerrada" || status === "encerrado") return "closed";
  if (stage === "dispute") return "mediation";
  return "open";
}

function isoTime(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buyerName(order) {
  const buyer = order?.raw_data?.buyer || {};
  const full = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim();
  return full || buyer.nickname || order?.buyer_nickname || "Cliente Mercado Livre";
}

function productInfo(order) {
  const raw = order?.raw_data || {};
  const items = Array.isArray(raw.order_items)
    ? raw.order_items
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  if (!items.length) {
    return {
      title: "Produto Mercado Livre",
      quantity: null,
      itemId: null,
      sellerSku: null
    };
  }

  const titles = items
    .map(item => item?.item?.title || item?.title)
    .filter(Boolean);

  return {
    title: titles.join(" + ") || "Produto Mercado Livre",
    quantity: items.reduce((sum, item) => sum + Number(item?.quantity || 0), 0) || null,
    itemId: items[0]?.item?.id || items[0]?.item_id || null,
    sellerSku:
      items[0]?.item?.seller_sku ||
      items[0]?.seller_sku ||
      items[0]?.item?.seller_custom_field ||
      null
  };
}

async function fetchClaimsByStatus(account, status) {
  const claims = [];
  let offset = 0;
  let total = null;

  while (claims.length < MAX_CLAIMS) {
    const limit = Math.min(PAGE_SIZE, MAX_CLAIMS - claims.length);
    const params = new URLSearchParams({
      "players.user_id": String(account.user_id),
      "players.role": "respondent",
      status,
      limit: String(limit),
      offset: String(offset),
      sort: "last_updated:desc"
    });

    const { response } = await mercadoLivreFetch(
      `/post-purchase/v1/claims/search?${params.toString()}`,
      account
    );
    const data = await readJson(response);

    if (!response.ok) {
      const error = new Error(
        `Erro buscando reclamações ${status} no Mercado Livre: ${JSON.stringify(data)}`
      );
      error.httpStatus = response.status;
      throw error;
    }

    const page = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.results)
        ? data.results
        : [];

    if (total == null && Number.isFinite(Number(data?.paging?.total))) {
      total = Number(data.paging.total);
    }

    claims.push(...page);
    offset += page.length;

    if (!page.length || page.length < limit) break;
    if (total != null && offset >= total) break;
  }

  return {
    claims,
    reportedTotal: total == null ? claims.length : total,
    truncated: total != null && claims.length < total
  };
}

async function fetchAllClaims(account) {
  // A API de Claims exige pelo menos um filtro funcional além da paginação.
  // Para montar a visão "Todas" sem perder encerradas, fazemos duas buscas
  // válidas (opened e closed), ambas restritas ao vendedor/respondent, e unimos.
  const batches = [];
  for (const status of ["opened", "closed"]) {
    batches.push(await fetchClaimsByStatus(account, status));
  }

  const dedup = new Map();
  for (const batch of batches) {
    for (const claim of batch.claims) {
      const id = claim?.id ?? claim?.claim_id;
      if (id == null) continue;
      dedup.set(String(id), claim);
    }
  }

  const list = [...dedup.values()].sort((a, b) =>
    isoTime(b.last_updated || b.date_created) - isoTime(a.last_updated || a.date_created)
  );

  return {
    claims: list,
    reportedTotal: batches.reduce((sum, batch) => sum + Number(batch.reportedTotal || 0), 0),
    truncated: batches.some(batch => batch.truncated)
  };
}

async function loadOrders(orderIds) {
  const map = new Map();
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,buyer_id,buyer_nickname,total_amount,paid_amount,raw_data")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", chunk);

    if (error) throw new Error(error.message);
    for (const order of data || []) map.set(String(order.marketplace_order_id), order);
  }

  return map;
}

async function loadThreads(claimIds) {
  const map = new Map();
  const ids = [...new Set(claimIds.filter(Boolean).map(String))];

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("sac_threads")
      .select("id,claim_id,subject,due_date,affects_reputation,available_actions,raw_data")
      .eq("channel", "mercadolivre")
      .eq("type", "claim")
      .in("claim_id", chunk);

    if (error) throw new Error(error.message);
    for (const thread of data || []) map.set(String(thread.claim_id), thread);
  }

  return map;
}

function summarizeClaim(claim, order, thread) {
  const id = String(claim.id ?? claim.claim_id);
  const orderId = claim.resource === "order"
    ? String(claim.resource_id || "") || null
    : claim.order_id != null
      ? String(claim.order_id)
      : null;
  const product = productInfo(order);
  const localDetail = thread?.raw_data?.detail || {};
  const category = claimCategory(claim);

  return {
    claim_id: id,
    order_id: orderId,
    buyer_name: buyerName(order),
    buyer_nickname: order?.buyer_nickname || null,
    product_title: product.title,
    product_quantity: product.quantity,
    product_item_id: product.itemId,
    seller_sku: product.sellerSku,
    status: claim.status || null,
    stage: claim.stage || null,
    type: claim.type || null,
    category,
    reason_id: claim.reason_id || null,
    subject:
      thread?.subject ||
      localDetail.title ||
      localDetail.problem ||
      (claim.reason_id ? `Reclamação ${claim.reason_id}` : `Reclamação ${id}`),
    affects_reputation: Boolean(thread?.affects_reputation),
    due_date: thread?.due_date || null,
    date_created: claim.date_created || null,
    last_updated: claim.last_updated || claim.date_created || null,
    available_actions: thread?.available_actions || [],
    order_url: orderId ? `https://www.mercadolivre.com.br/vendas/${encodeURIComponent(orderId)}/detalhe` : null
  };
}

function makeStats(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.category === "mediation") acc.mediation += 1;
      else if (row.category === "closed") acc.closed += 1;
      else acc.open += 1;
      return acc;
    },
    { open: 0, mediation: 0, closed: 0, total: 0 }
  );
}

async function buildList(force = false) {
  if (!force && listCache.payload && Date.now() - listCache.at < LIST_CACHE_MS) {
    return listCache.payload;
  }

  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Conta Mercado Livre não conectada.");

  const live = await fetchAllClaims(account);
  const claimIds = live.claims.map(c => String(c.id ?? c.claim_id)).filter(Boolean);
  const orderIds = live.claims
    .map(c => c.resource === "order" ? c.resource_id : c.order_id)
    .filter(Boolean)
    .map(String);

  let orders = new Map();
  let threads = new Map();

  try {
    orders = await loadOrders(orderIds);
  } catch (error) {
    console.warn("[Reclamações ML] Falha enriquecendo pedidos locais:", error.message);
  }

  try {
    threads = await loadThreads(claimIds);
  } catch (error) {
    console.warn("[Reclamações ML] Falha enriquecendo threads locais:", error.message);
  }

  const rows = live.claims.map(claim => {
    const claimId = String(claim.id ?? claim.claim_id);
    const orderId = claim.resource === "order"
      ? String(claim.resource_id || "")
      : String(claim.order_id || "");
    return summarizeClaim(
      claim,
      orders.get(orderId) || null,
      threads.get(claimId) || null
    );
  });

  const payload = {
    reclamacoes: rows,
    stats: makeStats(rows),
    total_mercado_livre: live.reportedTotal,
    truncado: live.truncated,
    atualizado_em: new Date().toISOString()
  };

  listCache = { at: Date.now(), payload };
  return payload;
}

function normalizeDetail(thread, messages, order) {
  const claim = thread?.raw_data?.claim || {};
  const detail = thread?.raw_data?.detail || {};
  const reputation = thread?.raw_data?.reputation || {};
  const product = productInfo(order);
  const category = claimCategory(claim);
  const orderId = thread?.order_id || (claim.resource === "order" ? claim.resource_id : null);

  return {
    thread_id: thread.id,
    claim_id: String(thread.claim_id || claim.id || ""),
    order_id: orderId == null ? null : String(orderId),
    order_url: orderId ? `https://www.mercadolivre.com.br/vendas/${encodeURIComponent(String(orderId))}/detalhe` : null,
    buyer_name: buyerName(order),
    buyer_nickname: order?.buyer_nickname || null,
    product_title: product.title,
    product_quantity: product.quantity,
    product_item_id: product.itemId,
    seller_sku: product.sellerSku,
    status: claim.status || thread.status || null,
    stage: claim.stage || null,
    type: claim.type || null,
    category,
    reason_id: claim.reason_id || null,
    subject: detail.title || thread.subject || detail.problem || `Reclamação ${thread.claim_id}`,
    problem: detail.problem || detail.description || null,
    description: detail.description || null,
    action_responsible: detail.action_responsible || null,
    due_date: detail.due_date || thread.due_date || reputation.due_date || null,
    affects_reputation: Boolean(thread.affects_reputation),
    available_actions: thread.available_actions || [],
    date_created: claim.date_created || null,
    last_updated: claim.last_updated || thread.last_message_at || claim.date_created || null,
    resolution: claim.resolution || null,
    messages: (messages || []).map(message => ({
      id: message.id,
      direction: message.direction,
      sender_role: message.sender_role,
      text: message.text || "",
      date_created: message.date_created,
      raw_data: message.raw_data || null
    }))
  };
}

router.get("/api/reclamacoes/ml", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const payload = await buildList(force);
    res.json({ sucesso: true, ...payload });
  } catch (error) {
    res.status(error.httpStatus || 500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

router.get("/api/reclamacoes/ml/:claimId", async (req, res) => {
  try {
    const claimId = String(req.params.claimId || "").trim();
    if (!claimId) return res.status(400).json({ sucesso: false, mensagem: "claim_id obrigatório." });

    const thread = await sincronizarClaimML(claimId);
    const context = await contextoSac(thread.id);
    const detail = normalizeDetail(context.thread, context.messages, context.pedido);

    res.json({ sucesso: true, reclamacao: detail });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/reclamacoes/ml/:claimId/send", async (req, res) => {
  try {
    const claimId = String(req.params.claimId || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!claimId) return res.status(400).json({ sucesso: false, mensagem: "claim_id obrigatório." });
    if (!text) return res.status(400).json({ sucesso: false, mensagem: "Digite uma resposta antes de enviar." });

    const thread = await sincronizarClaimML(claimId);
    await enviarRespostaSac(thread.id, text);
    const refreshedThread = await sincronizarClaimML(claimId);
    const context = await contextoSac(refreshedThread.id);
    const detail = normalizeDetail(context.thread, context.messages, context.pedido);

    listCache = { at: 0, payload: null };
    res.json({
      sucesso: true,
      mensagem: "Resposta enviada na reclamação do Mercado Livre.",
      reclamacao: detail
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
