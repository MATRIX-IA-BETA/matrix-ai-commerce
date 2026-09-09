const router = require("express").Router();
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");
const { sincronizarConversaML } = require("../services/sac");

const scannedEmptyPacks = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanId(value) {
  return String(value == null ? "" : value).trim();
}

function rawMessages(thread) {
  return Array.isArray(thread?.raw_data?.messages)
    ? thread.raw_data.messages
    : [];
}

function latestMessageText(messages) {
  const last = Array.isArray(messages) && messages.length
    ? messages[messages.length - 1]
    : null;

  const value =
    last?.text?.plain ??
    last?.text ??
    last?.message ??
    "";

  return String(value || "").trim().slice(0, 240) || null;
}

function extractPackId(order) {
  return cleanId(
    order?.pack_id ??
    order?.raw_data?.pack_id ??
    order?.marketplace_order_id
  );
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

      if (
        response.ok &&
        /^https:\/\//i.test(permalink)
      ) {
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

router.post("/sac/ml/history/sync", async (req, res) => {
  try {
    const limit = Math.max(
      1,
      Math.min(500, Number(req.body?.limit || 300))
    );
    const batch = Math.max(
      1,
      Math.min(60, Number(req.body?.batch || 40))
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
      .select("id,pack_id,external_id,raw_data")
      .eq("channel", "mercadolivre")
      .eq("type", "message")
      .limit(1000);

    if (existingError) throw new Error(existingError.message);

    const alreadyWithMessages = new Set();
    for (const thread of existing || []) {
      const packId = cleanId(
        thread.pack_id ||
        String(thread.external_id || "").replace(/^pack:/, "")
      );

      if (packId && rawMessages(thread).length) {
        alreadyWithMessages.add(packId);
      }
    }

    const candidateMap = new Map();
    for (const order of orders || []) {
      const packId = extractPackId(order);
      if (!packId) continue;
      if (alreadyWithMessages.has(packId)) continue;
      if (scannedEmptyPacks.has(packId)) continue;
      if (!candidateMap.has(packId)) candidateMap.set(packId, order);
    }

    const candidates = [...candidateMap.entries()].slice(0, batch);
    let synced = 0;
    let empty = 0;
    let failed = 0;
    const errors = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const [packId, order] = candidates[index];

      try {
        const thread = await sincronizarConversaML(packId, false);
        const messages = rawMessages(thread);

        if (!messages.length) {
          scannedEmptyPacks.add(packId);
          empty += 1;
        } else {
          const update = {};
          const latest = latestMessageText(messages);

          if (!thread.order_id && order?.marketplace_order_id) {
            update.order_id = cleanId(order.marketplace_order_id);
          }
          if (!thread.buyer_id && order?.buyer_id) {
            update.buyer_id = cleanId(order.buyer_id);
          }
          if (!thread.buyer_nickname && order?.buyer_nickname) {
            update.buyer_nickname = String(order.buyer_nickname);
          }
          if (latest) update.subject = latest;
          update.updated_at = new Date().toISOString();

          const { error: updateError } = await supabase
            .from("sac_threads")
            .update(update)
            .eq("id", thread.id);

          if (updateError) {
            console.warn(
              `[SAC ML] Conversa ${packId} sincronizada, mas não foi possível completar metadados:`,
              updateError.message
            );
          }

          synced += 1;
        }
      } catch (error) {
        failed += 1;
        errors.push(`${packId}: ${error.message}`);
      }

      if (index < candidates.length - 1) {
        await sleep(120);
      }
    }

    res.json({
      sucesso: true,
      analisados: candidates.length,
      sincronizados: synced,
      sem_mensagens: empty,
      erros: failed,
      restantes: Math.max(0, candidateMap.size - candidates.length),
      detalhes_erros: errors.slice(0, 10)
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
