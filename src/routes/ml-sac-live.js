const router = require("express").Router();
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const CACHE_MS = 90 * 1000;
const EMPTY_CACHE_MS = 15 * 60 * 1000;
const ML_MESSAGING_AGENT_ID_MLB = "3037675074";
const conversationCache = new Map();
const emptyCache = new Map();

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function textOf(message) {
  return String(
    message?.text?.plain ??
    message?.text ??
    message?.message ??
    ""
  ).trim();
}

function dateOf(message) {
  return message?.date || message?.date_received || message?.date_available || null;
}

function timeOf(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function packIdFromOrder(order) {
  return cleanId(order?.pack_id || order?.raw_data?.pack_id || order?.marketplace_order_id);
}

function orderIdFromMessages(messages, fallback) {
  for (const message of messages || []) {
    for (const resource of message?.message_resources || []) {
      const name = String(resource?.name || resource?.resource || "").toLowerCase();
      const id = cleanId(resource?.id || resource?.resource_id || resource?.resourceId);
      if (id && name.includes("order")) return id;
    }
  }
  return cleanId(fallback) || null;
}

function buyerName(order) {
  const buyer = order?.raw_data?.buyer || {};
  const full = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim();
  return full || buyer.nickname || order?.buyer_nickname || "Cliente Mercado Livre";
}

function productTitle(order) {
  const items = Array.isArray(order?.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];
  const titles = items
    .map(line => line?.item?.title || line?.title)
    .filter(Boolean);
  return titles.join(" + ") || "Produto Mercado Livre";
}

async function fetchPackConversation(packId, account) {
  const sellerId = cleanId(account?.user_id);
  const limit = 100;
  const messages = [];
  let offset = 0;
  let first = null;

  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      tag: "post_sale",
      mark_as_read: "false"
    });

    const { response } = await mercadoLivreFetch(
      `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}?${params.toString()}`,
      account
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(`ML recusou mensagens do pack ${packId}: ${JSON.stringify(data)}`);
      error.httpStatus = response.status;
      throw error;
    }

    if (!first) first = data;
    const pageMessages = Array.isArray(data?.messages) ? data.messages : [];
    messages.push(...pageMessages);

    const total = Number(data?.paging?.total || messages.length);
    if (!pageMessages.length || pageMessages.length < limit || messages.length >= total) break;
    offset += pageMessages.length;
  }

  return { ...(first || {}), messages };
}

function normalizeConversation(packId, order, account, payload) {
  const sellerId = cleanId(account?.user_id);
  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!rawMessages.length) return null;

  const messages = rawMessages
    .map((message, index) => {
      const fromId = cleanId(message?.from?.user_id);
      const direction = fromId === sellerId ? "outbound" : "inbound";
      return {
        id: String(message?.message_id || `${packId}:${index}:${dateOf(message) || ""}`),
        direction,
        sender_role: direction === "outbound" ? "seller" : "buyer",
        text: textOf(message),
        date_created: dateOf(message),
        raw_data: message
      };
    })
    .sort((a, b) => timeOf(a.date_created) - timeOf(b.date_created));

  const last = messages[messages.length - 1];
  const orderId = orderIdFromMessages(rawMessages, order?.marketplace_order_id);

  return {
    id: `pack:${packId}`,
    pack_id: String(packId),
    order_id: orderId,
    buyer_id: order?.buyer_id ? String(order.buyer_id) : null,
    buyer_nickname: order?.buyer_nickname || null,
    buyer_name: buyerName(order),
    product_title: productTitle(order),
    status: payload?.conversation_status?.status || "open",
    last_message_at: last?.date_created || order?.date_created || null,
    last_message_text: last?.text || "Mensagem pós-venda",
    messages
  };
}

function getCached(packId) {
  const cached = conversationCache.get(packId);
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_MS) {
    conversationCache.delete(packId);
    return null;
  }
  return cached.value;
}

function isCachedEmpty(packId) {
  const until = emptyCache.get(packId);
  if (!until) return false;
  if (until <= Date.now()) {
    emptyCache.delete(packId);
    return false;
  }
  return true;
}

async function liveConversation(packId, order, account, force = false) {
  if (!force) {
    const cached = getCached(packId);
    if (cached) return cached;
    if (isCachedEmpty(packId)) return null;
  }

  const payload = await fetchPackConversation(packId, account);
  const normalized = normalizeConversation(packId, order, account, payload);

  if (!normalized) {
    emptyCache.set(packId, Date.now() + EMPTY_CACHE_MS);
    conversationCache.delete(packId);
    return null;
  }

  emptyCache.delete(packId);
  conversationCache.set(packId, { at: Date.now(), value: normalized });
  return normalized;
}

async function findLocalOrderForPack(packId) {
  const safe = cleanId(packId);
  if (!safe) return null;

  const { data, error } = await supabase
    .from("marketplace_orders")
    .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data")
    .eq("marketplace", "mercadolivre")
    .or(`pack_id.eq.${safe},marketplace_order_id.eq.${safe}`)
    .order("date_created", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

router.get("/api/sac/ml/live", async (req, res) => {
  try {
    const offset = Math.max(0, Math.trunc(Number(req.query.offset || 0)));
    const batch = Math.max(10, Math.min(100, Math.trunc(Number(req.query.batch || 60))));
    const force = String(req.query.refresh || "") === "1";

    const account = await getMercadoLivreAccount();
    if (!account) {
      return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });
    }

    const { data: orders, error, count } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data", { count: "exact" })
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .range(offset, offset + batch - 1);

    if (error) throw new Error(error.message);

    const packMap = new Map();
    for (const order of orders || []) {
      const packId = packIdFromOrder(order);
      if (packId && !packMap.has(packId)) packMap.set(packId, order);
    }

    const entries = [...packMap.entries()];
    const conversations = [];
    const errors = [];
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= entries.length) return;
        const [packId, order] = entries[index];
        try {
          const conversation = await liveConversation(packId, order, account, force);
          if (conversation) conversations.push(conversation);
        } catch (err) {
          errors.push(`${packId}: ${err.message}`);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(6, entries.length || 1) }, () => worker())
    );

    conversations.sort((a, b) => timeOf(b.last_message_at) - timeOf(a.last_message_at));

    const nextOffset = offset + (orders || []).length;
    const hasMore = count != null
      ? nextOffset < Number(count)
      : (orders || []).length === batch;

    res.json({
      sucesso: true,
      conversas: conversations,
      pedidos_lidos: (orders || []).length,
      pedidos_total: count == null ? null : Number(count),
      offset,
      next_offset: nextOffset,
      has_more: hasMore,
      erros: errors.length,
      detalhes_erros: errors.slice(0, 8)
    });
  } catch (error) {
    console.error("[SAC ML LIVE] list:", error);
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/sac/ml/live/:packId", async (req, res) => {
  try {
    const packId = cleanId(req.params.packId);
    if (!packId) return res.status(400).json({ sucesso: false, mensagem: "pack_id inválido." });

    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });

    const order = await findLocalOrderForPack(packId);
    const conversation = await liveConversation(packId, order, account, true);

    if (!conversation) {
      return res.status(404).json({ sucesso: false, mensagem: "Nenhuma mensagem pós-venda encontrada para este pedido." });
    }

    res.json({ sucesso: true, conversa: conversation });
  } catch (error) {
    console.error("[SAC ML LIVE] detail:", error);
    res.status(error.httpStatus || 500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/sac/ml/live/:packId/send", async (req, res) => {
  try {
    const packId = cleanId(req.params.packId);
    const text = String(req.body?.text || "").trim().slice(0, 350);
    if (!packId) return res.status(400).json({ sucesso: false, mensagem: "pack_id inválido." });
    if (!text) return res.status(400).json({ sucesso: false, mensagem: "Digite uma mensagem antes de enviar." });

    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });

    const sellerId = cleanId(account.user_id);
    const { response } = await mercadoLivreFetch(
      `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}?tag=post_sale`,
      account,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: { user_id: sellerId },
          to: { user_id: ML_MESSAGING_AGENT_ID_MLB },
          text
        })
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        sucesso: false,
        mensagem: `Mercado Livre recusou a mensagem: ${JSON.stringify(data)}`
      });
    }

    conversationCache.delete(packId);
    emptyCache.delete(packId);

    let conversation = null;
    try {
      const order = await findLocalOrderForPack(packId);
      conversation = await liveConversation(packId, order, account, true);
    } catch (_) {}

    res.json({ sucesso: true, resultado: data, conversa: conversation });
  } catch (error) {
    console.error("[SAC ML LIVE] send:", error);
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
