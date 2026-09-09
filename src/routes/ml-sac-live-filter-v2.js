const router = require("express").Router();
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

// Este router fica ANTES do ml-sac-live original. Ele assume somente a listagem
// do SAC ML e adiciona guardas rápidas para detalhe/envio de pedidos cancelados.
// O objetivo é nunca mandar venda cancelada para o navegador e evitar travas.

const CANCELLED_CACHE_MS = 24 * 60 * 60 * 1000;
const ORDER_VERIFY_CACHE_MS = 5 * 60 * 1000;
const LIST_MESSAGE_TIMEOUT_MS = 4500;
const ORDER_VERIFY_TIMEOUT_MS = 3500;

const cancelledPackCache = new Map();
const orderVerifyCache = new Map();

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCancelledRaw(raw) {
  raw = raw || {};

  const statusTexts = [
    raw.status,
    raw.order_status,
    raw.status_detail,
    raw.status_detail?.description,
    raw.status_detail?.code
  ]
    .map(normalize)
    .filter(Boolean);

  if (statusTexts.some(text =>
    text === "cancelled" ||
    text === "canceled" ||
    text === "cancelado" ||
    text === "cancelada" ||
    text.startsWith("cancel")
  )) {
    return true;
  }

  // Na operação da Matrix, pedido do ML com paid_amount explicitamente zerado
  // é venda cancelada. Só aplica quando o campo realmente veio no payload.
  if (Object.prototype.hasOwnProperty.call(raw, "paid_amount")) {
    const paid = numberOrNull(raw.paid_amount);
    if (paid === 0) return true;
  }

  const tags = Array.isArray(raw.tags) ? raw.tags.map(normalize) : [];
  if (tags.some(tag => tag.includes("cancel"))) return true;

  return false;
}

function isCancelledOrder(order) {
  return isCancelledRaw(order?.raw_data || order);
}

function packIdFromOrder(order) {
  return cleanId(order?.pack_id || order?.raw_data?.pack_id || order?.marketplace_order_id);
}

function markCancelled(packId) {
  const safe = cleanId(packId);
  if (!safe) return;
  cancelledPackCache.set(safe, Date.now() + CANCELLED_CACHE_MS);
}

function isKnownCancelled(packId) {
  const safe = cleanId(packId);
  const until = cancelledPackCache.get(safe);
  if (!until) return false;
  if (until <= Date.now()) {
    cancelledPackCache.delete(safe);
    return false;
  }
  return true;
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
  return (
    message?.date ||
    message?.date_received ||
    message?.date_available ||
    message?.date_created ||
    message?.timestamps?.created ||
    null
  );
}

function timeOf(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function orderIdFromMessages(messages, fallback) {
  for (const message of messages || []) {
    for (const resource of message?.message_resources || []) {
      const name = normalize(resource?.name || resource?.resource);
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

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPackSummary(packId, account) {
  const sellerId = cleanId(account?.user_id);
  const params = new URLSearchParams({
    limit: "20",
    offset: "0",
    tag: "post_sale",
    mark_as_read: "false"
  });

  const result = await withTimeout(
    mercadoLivreFetch(
      `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}?${params.toString()}`,
      account
    ),
    LIST_MESSAGE_TIMEOUT_MS,
    `Leitura do pack ${packId}`
  );

  const data = await result.response.json().catch(() => ({}));

  if (!result.response.ok) {
    const serialized = JSON.stringify(data);
    if (/blocked_by_cancelled_order|cancelled_order|canceled_order/i.test(serialized)) {
      markCancelled(packId);
      return { cancelled: true, messages: [] };
    }
    const error = new Error(`ML recusou mensagens do pack ${packId}: ${serialized}`);
    error.httpStatus = result.response.status;
    throw error;
  }

  return {
    ...data,
    cancelled: false,
    messages: Array.isArray(data?.messages) ? data.messages : []
  };
}

async function verifyOrderActive(orderId, account) {
  const safe = cleanId(orderId);
  if (!safe) return { known: false, cancelled: false };

  const cached = orderVerifyCache.get(safe);
  if (cached && Date.now() - cached.at < ORDER_VERIFY_CACHE_MS) return cached.value;

  try {
    const result = await withTimeout(
      mercadoLivreFetch(`/orders/${encodeURIComponent(safe)}`, account),
      ORDER_VERIFY_TIMEOUT_MS,
      `Validação do pedido ${safe}`
    );
    const data = await result.response.json().catch(() => ({}));

    if (!result.response.ok) {
      const value = { known: false, cancelled: false };
      orderVerifyCache.set(safe, { at: Date.now(), value });
      return value;
    }

    const value = { known: true, cancelled: isCancelledRaw(data) };
    orderVerifyCache.set(safe, { at: Date.now(), value });
    return value;
  } catch (_) {
    const value = { known: false, cancelled: false };
    orderVerifyCache.set(safe, { at: Date.now(), value });
    return value;
  }
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

// Substitui somente a LISTAGEM do router antigo. Pedidos cancelados são
// eliminados antes de consultar mensagens sempre que a base local já souber
// disso; para conversas encontradas, o status do pedido é confirmado ao vivo.
router.get("/api/sac/ml/live", async (req, res) => {
  try {
    const offset = Math.max(0, Math.trunc(Number(req.query.offset || 0)));
    const batch = Math.max(10, Math.min(100, Math.trunc(Number(req.query.batch || 60))));

    const account = await getMercadoLivreAccount();
    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Conta Mercado Livre não conectada."
      });
    }

    const { data: orders, error, count } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data", { count: "exact" })
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .range(offset, offset + batch - 1);

    if (error) throw new Error(error.message);

    const packMap = new Map();
    let cancelledLocal = 0;

    for (const order of orders || []) {
      const packId = packIdFromOrder(order);
      if (!packId) continue;

      if (isKnownCancelled(packId) || isCancelledOrder(order)) {
        markCancelled(packId);
        cancelledLocal += 1;
        continue;
      }

      if (!packMap.has(packId)) packMap.set(packId, order);
    }

    const entries = [...packMap.entries()];
    const conversations = [];
    const errors = [];
    let cancelledLive = 0;
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= entries.length) return;
        const [packId, order] = entries[index];

        try {
          if (isKnownCancelled(packId)) {
            cancelledLive += 1;
            continue;
          }

          const payload = await fetchPackSummary(packId, account);
          if (payload.cancelled) {
            cancelledLive += 1;
            continue;
          }

          const conversation = normalizeConversation(packId, order, account, payload);
          if (!conversation) continue;

          const orderId = conversation.order_id || order?.marketplace_order_id;
          const verification = await verifyOrderActive(orderId, account);

          if (verification.known && verification.cancelled) {
            markCancelled(packId);
            cancelledLive += 1;
            continue;
          }

          conversations.push(conversation);
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
      cancelados_ignorados: cancelledLocal + cancelledLive,
      erros: errors.length,
      detalhes_erros: errors.slice(0, 8)
    });
  } catch (error) {
    console.error("[SAC ML FILTER V2] list:", error);
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

// Guarda rápida: se uma venda cancelada antiga ainda estiver selecionada no
// navegador, não deixa a rota pesada de detalhe nem a de envio chegar no ML.
router.get("/api/sac/ml/live/:packId", async (req, res, next) => {
  try {
    const packId = cleanId(req.params.packId);
    if (!packId) return next();

    if (isKnownCancelled(packId)) {
      return res.status(410).json({
        sucesso: false,
        code: "blocked_by_cancelled_order",
        cancelado: true,
        mensagem: "Pedido cancelado. Esta conversa foi removida do SAC ML."
      });
    }

    const order = await findLocalOrderForPack(packId);
    if (order && isCancelledOrder(order)) {
      markCancelled(packId);
      return res.status(410).json({
        sucesso: false,
        code: "blocked_by_cancelled_order",
        cancelado: true,
        mensagem: "Pedido cancelado. Esta conversa foi removida do SAC ML."
      });
    }

    return next();
  } catch (_) {
    return next();
  }
});

router.post("/api/sac/ml/live/:packId/send", async (req, res, next) => {
  try {
    const packId = cleanId(req.params.packId);
    if (!packId) return next();

    if (isKnownCancelled(packId)) {
      return res.status(409).json({
        sucesso: false,
        code: "blocked_by_cancelled_order",
        cancelado: true,
        mensagem: "blocked_by_cancelled_order: pedido cancelado pelo Mercado Livre; novas mensagens não são permitidas."
      });
    }

    const order = await findLocalOrderForPack(packId);
    if (order && isCancelledOrder(order)) {
      markCancelled(packId);
      return res.status(409).json({
        sucesso: false,
        code: "blocked_by_cancelled_order",
        cancelado: true,
        mensagem: "blocked_by_cancelled_order: pedido cancelado pelo Mercado Livre; novas mensagens não são permitidas."
      });
    }

    return next();
  } catch (_) {
    return next();
  }
});

module.exports = router;
