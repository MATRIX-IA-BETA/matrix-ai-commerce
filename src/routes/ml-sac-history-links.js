const router = require("express").Router();
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const EMPTY_PACK_TTL_MS = 10 * 60 * 1000;
const emptyPackCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanId(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function messageText(message) {
  return String(
    message?.text?.plain ??
    message?.text ??
    message?.message ??
    ""
  ).trim();
}

function latestMessageText(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const last = messages[messages.length - 1];
  return messageText(last).slice(0, 240) || null;
}

function messageDate(message) {
  return (
    message?.date ||
    message?.date_received ||
    message?.date_available ||
    new Date().toISOString()
  );
}

function extractPackId(order) {
  return cleanId(
    order?.pack_id ??
    order?.raw_data?.pack_id ??
    order?.marketplace_order_id
  );
}

function isCachedEmpty(packId) {
  const until = emptyPackCache.get(packId);
  if (!until) return false;
  if (until <= Date.now()) {
    emptyPackCache.delete(packId);
    return false;
  }
  return true;
}

function markEmpty(packId) {
  emptyPackCache.set(packId, Date.now() + EMPTY_PACK_TTL_MS);
}

function orderIdFromMessages(messages, fallbackOrderId) {
  for (const message of messages || []) {
    const resources = Array.isArray(message?.message_resources)
      ? message.message_resources
      : [];

    for (const resource of resources) {
      const name = normalizeText(resource?.name || resource?.resource);
      const id = cleanId(
        resource?.id ??
        resource?.resource_id ??
        resource?.resourceId
      );

      if (id && name.includes("order")) return id;
    }
  }

  return cleanId(fallbackOrderId) || null;
}

function productLinksFromOrder(order) {
  const items = Array.isArray(order?.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];

  const seen = new Set();
  const result = [];

  for (const line of items) {
    const itemId = cleanId(line?.item?.id);
    const title = String(line?.item?.title || "Produto Mercado Livre").trim();

    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);

    result.push({
      item_id: itemId,
      title,
      url: `/mercadolivre/item/${encodeURIComponent(itemId)}/open`
    });
  }

  return result;
}

router.post("/fiscal/marketplace-links", async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.order_ids)
      ? req.body.order_ids
      : [];

    const orderIds = [...new Set(
      requested
        .map(cleanId)
        .filter(Boolean)
        .slice(0, 500)
    )];

    if (!orderIds.length) {
      return res.json({ sucesso: true, links: {} });
    }

    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,raw_data")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", orderIds);

    if (error) throw new Error(error.message);

    const links = {};

    for (const order of data || []) {
      const orderId = cleanId(order.marketplace_order_id);
      if (!orderId) continue;

      links[orderId] = {
        order_url: `/mercadolivre/order/${encodeURIComponent(orderId)}/open`,
        product_items: productLinksFromOrder(order)
      };
    }

    res.json({ sucesso: true, links });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

router.get("/mercadolivre/order/:orderId/open", (req, res) => {
  const orderId = cleanId(req.params.orderId).replace(/\D/g, "");

  if (!orderId) {
    return res.status(400).send("Pedido Mercado Livre inválido.");
  }

  return res.redirect(
    302,
    `https://www.mercadolivre.com.br/vendas/${encodeURIComponent(orderId)}/detalhe`
  );
});

router.get("/mercadolivre/item/:itemId/open", async (req, res) => {
  const itemId = cleanId(req.params.itemId).toUpperCase();

  if (!/^ML[A-Z]\d+$/.test(itemId)) {
    return res.status(400).send("Anúncio Mercado Livre inválido.");
  }

  try {
    const account = await getMercadoLivreAccount();

    if (account) {
      const { response } = await mercadoLivreFetch(
        `/items/${encodeURIComponent(itemId)}`,
        account
      );

      const data = await response.json().catch(() => ({}));
      const permalink = String(data?.permalink || "").trim();

      if (response.ok && /^https:\/\//i.test(permalink)) {
        return res.redirect(302, permalink);
      }
    }
  } catch (error) {
    console.warn(
      `[ML LINK] Não foi possível resolver permalink do item ${itemId}:`,
      error.message
    );
  }

  const fallback = itemId.startsWith("MLB")
    ? `https://produto.mercadolivre.com.br/MLB-${encodeURIComponent(itemId.slice(3))}`
    : `https://lista.mercadolivre.com.br/${encodeURIComponent(itemId)}`;

  return res.redirect(302, fallback);
});

async function fetchPackConversation(packId, account) {
  const sellerId = cleanId(account?.user_id);
  const limit = 100;
  let offset = 0;
  let firstPayload = null;
  const messages = [];

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
      const error = new Error(
        `Mercado Livre recusou mensagens do pack ${packId}: ${JSON.stringify(data)}`
      );
      error.httpStatus = response.status;
      error.detail = data;
      throw error;
    }

    if (!firstPayload) firstPayload = data;

    const pageMessages = Array.isArray(data?.messages)
      ? data.messages
      : [];

    messages.push(...pageMessages);

    const total = Number(data?.paging?.total || messages.length);
    if (!pageMessages.length || messages.length >= total || pageMessages.length < limit) {
      break;
    }

    offset += pageMessages.length;
  }

  return {
    ...(firstPayload || {}),
    messages
  };
}

async function saveConversation(packId, order, account, payload) {
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : [];

  if (!messages.length) {
    markEmpty(packId);
    return { thread: null, messages: 0 };
  }

  emptyPackCache.delete(packId);

  const sellerId = cleanId(account?.user_id);
  const orderId = orderIdFromMessages(
    messages,
    order?.marketplace_order_id
  );

  const latest = latestMessageText(messages);
  const lastMessageAt = messages.reduce((best, message) => {
    const current = messageDate(message);
    if (!best) return current;
    const a = new Date(best).getTime();
    const b = new Date(current).getTime();
    return Number.isFinite(b) && (!Number.isFinite(a) || b > a)
      ? current
      : best;
  }, null) || new Date().toISOString();

  const { data: thread, error: threadError } = await supabase
    .from("sac_threads")
    .upsert(
      {
        channel: "mercadolivre",
        external_id: `pack:${packId}`,
        type: "message",
        pack_id: String(packId),
        seller_id: sellerId,
        order_id: orderId ? String(orderId) : null,
        buyer_id: order?.buyer_id ? String(order.buyer_id) : null,
        buyer_nickname: order?.buyer_nickname || null,
        status: payload?.conversation_status?.status || "open",
        priority: "normal",
        subject: latest || "Mensagem pós-venda Mercado Livre",
        last_message_at: lastMessageAt,
        raw_data: payload,
        updated_at: new Date().toISOString()
      },
      { onConflict: "channel,external_id" }
    )
    .select("*")
    .single();

  if (threadError) {
    throw new Error(`Erro salvando conversa SAC ML: ${threadError.message}`);
  }

  const records = messages
    .filter(message => message?.message_id)
    .map(message => {
      const fromId = cleanId(message?.from?.user_id);
      return {
        thread_id: thread.id,
        channel: "mercadolivre",
        external_message_id: String(message.message_id),
        direction: fromId === sellerId ? "outbound" : "inbound",
        sender_role: fromId === sellerId ? "seller" : "buyer",
        text: messageText(message).slice(0, 10000),
        date_created: messageDate(message),
        raw_data: message
      };
    });

  if (records.length) {
    const { error: messagesError } = await supabase
      .from("sac_messages")
      .upsert(records, {
        onConflict: "channel,external_message_id",
        ignoreDuplicates: false
      });

    if (messagesError) {
      throw new Error(`Erro salvando mensagens SAC ML: ${messagesError.message}`);
    }
  }

  return {
    thread,
    messages: records.length
  };
}

async function syncPack(packId, order, account) {
  const payload = await fetchPackConversation(packId, account);
  return saveConversation(packId, order, account, payload);
}

router.post("/sac/ml/history/sync", async (req, res) => {
  try {
    const limit = Math.max(
      1,
      Math.min(1000, Number(req.body?.limit || 600))
    );
    const batch = Math.max(
      1,
      Math.min(200, Number(req.body?.batch || 120))
    );
    const concurrency = Math.max(
      1,
      Math.min(6, Number(req.body?.concurrency || 4))
    );

    const account = await getMercadoLivreAccount();
    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Conta Mercado Livre não conectada."
      });
    }

    const { data: orders, error: ordersError } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data")
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .limit(limit);

    if (ordersError) throw new Error(ordersError.message);

    const { data: existing, error: existingError } = await supabase
      .from("sac_threads")
      .select("pack_id,external_id,raw_data")
      .eq("channel", "mercadolivre")
      .eq("type", "message")
      .limit(2000);

    if (existingError) throw new Error(existingError.message);

    const alreadyWithMessages = new Set();
    for (const thread of existing || []) {
      const packId = cleanId(
        thread.pack_id ||
        String(thread.external_id || "").replace(/^pack:/, "")
      );
      const messages = Array.isArray(thread?.raw_data?.messages)
        ? thread.raw_data.messages
        : [];
      if (packId && messages.length) alreadyWithMessages.add(packId);
    }

    const candidateMap = new Map();
    for (const order of orders || []) {
      const packId = extractPackId(order);
      if (!packId) continue;
      if (alreadyWithMessages.has(packId)) continue;
      if (isCachedEmpty(packId)) continue;
      if (!candidateMap.has(packId)) candidateMap.set(packId, order);
    }

    const candidates = [...candidateMap.entries()].slice(0, batch);
    let cursor = 0;
    let synced = 0;
    let messagesFound = 0;
    let empty = 0;
    let failed = 0;
    const errors = [];

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= candidates.length) return;

        const [packId, order] = candidates[index];

        try {
          const result = await syncPack(packId, order, account);
          if (result.messages > 0) {
            synced += 1;
            messagesFound += result.messages;
          } else {
            empty += 1;
          }
        } catch (error) {
          failed += 1;
          errors.push(`${packId}: ${error.message}`);
        }

        await sleep(80);
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, candidates.length || 1) },
        () => worker()
      )
    );

    res.json({
      sucesso: true,
      pedidos_considerados: (orders || []).length,
      analisados: candidates.length,
      sincronizados: synced,
      mensagens_encontradas: messagesFound,
      sem_mensagens: empty,
      erros: failed,
      restantes: Math.max(0, candidateMap.size - candidates.length),
      detalhes_erros: errors.slice(0, 12)
    });
  } catch (error) {
    console.error("[SAC ML] Falha na sincronização histórica:", error);
    res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

module.exports = router;
