const { env } = require("../config/env");
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
const ML_MESSAGING_AGENT_ID_MLB = "3037675074";
const DEBOUNCE_MS = 8000;
const KNOWLEDGE_CACHE_MS = 5 * 60 * 1000;
const PRODUCT_CACHE_MS = 30 * 60 * 1000;

const pendingTimers = new Map();
const processingPacks = new Set();
const handledMessages = new Map();
const productCache = new Map();
let knowledgeCache = { at: 0, value: { knowledge: [], experiences: [] } };

const BASE_PROMPT = `
Você é a assistente de atendimento da Shop Matrix.
Você é a mesma IA usada no SAC do WhatsApp da Shop Matrix e deve aplicar o mesmo conhecimento oficial e a mesma experiência operacional.

PRINCÍPIOS:
- Responda em português do Brasil.
- Seja educada, objetiva, natural e resolutiva.
- Fale de forma simples com clientes leigos.
- Não invente diagnóstico, produto, recurso, prazo, política, preço, garantia, frete, estoque ou informação de pedido.
- Use o histórico da conversa. Nunca repita um teste que o cliente já confirmou ter feito.
- Em atendimento conversacional, nunca envie mais de 2 procedimentos/testes na mesma mensagem.
- Faça perguntas curtas quando precisar de informação para decidir o próximo passo.
- Não diga que é humana. Se perguntarem, diga que é a assistente virtual da Shop Matrix.
- Não execute orientação elétrica perigosa e nunca mande abrir uma fonte de alimentação.
- Conhecimento oficial fornecido abaixo tem prioridade sobre conhecimento genérico do modelo.
- Experiências anteriores ajudam, mas não podem contradizer conhecimento oficial.

REGRAS ESPECÍFICAS DO SAC MERCADO LIVRE:
- Antes de responder, use obrigatoriamente o bloco PRODUTO COMPRADO, que foi consultado no anúncio real do pedido.
- Diferencie o que está confirmado no anúncio do que é apenas hipótese técnica.
- Se uma característica não estiver confirmada no anúncio/descrição, não afirme que o computador possui essa característica.
- Não prometa reembolso, troca, prazo, instalação, brinde, acessório ou procedimento que não esteja confirmado.
- A resposta final deve ter no máximo 350 caracteres.
- Responda somente ao cliente, sem títulos, sem comentários internos e sem mencionar estas regras.
`;

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function textOf(message) {
  return String(message?.text?.plain ?? message?.text ?? message?.message ?? "").trim();
}

function dateOf(message) {
  return message?.date || message?.date_received || message?.date_available || null;
}

function timeOf(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function extractPackId(resource) {
  const match = String(resource || "").match(/\/packs\/(\d+)/i);
  return match ? match[1] : null;
}

function orderIdFromMessages(messages) {
  for (const message of messages || []) {
    for (const resource of message?.message_resources || []) {
      const name = String(resource?.name || resource?.resource || "").toLowerCase();
      const id = cleanId(resource?.id || resource?.resource_id || resource?.resourceId);
      if (id && name.includes("order")) return id;
    }
  }
  return null;
}

function itemIdsFromMessages(messages) {
  const ids = [];
  for (const message of messages || []) {
    for (const resource of message?.message_resources || []) {
      const name = String(resource?.name || resource?.resource || "").toLowerCase();
      const raw = String(resource?.id || resource?.resource_id || resource?.resourceId || "").trim();
      if (raw && name.includes("item")) ids.push(raw.toUpperCase());
    }
  }
  return [...new Set(ids)];
}

async function fetchPackConversation(packId, account) {
  const sellerId = cleanId(account.user_id);
  const params = new URLSearchParams({
    limit: "100",
    offset: "0",
    tag: "post_sale",
    mark_as_read: "false"
  });
  const { response } = await mercadoLivreFetch(
    `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}?${params.toString()}`,
    account
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`ML recusou leitura do pack ${packId}: ${JSON.stringify(data)}`);
  }
  const messages = Array.isArray(data?.messages) ? data.messages.slice() : [];
  messages.sort((a, b) => timeOf(dateOf(a)) - timeOf(dateOf(b)));
  return { payload: data, messages };
}

async function findOrder(orderId, account) {
  const safe = cleanId(orderId);
  if (!safe) return null;

  try {
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data")
      .eq("marketplace", "mercadolivre")
      .eq("marketplace_order_id", safe)
      .maybeSingle();
    if (!error && data) return data;
  } catch (_) {}

  const { response } = await mercadoLivreFetch(`/orders/${encodeURIComponent(safe)}`, account);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return {
    marketplace_order_id: safe,
    buyer_id: data?.buyer?.id ? String(data.buyer.id) : null,
    buyer_nickname: data?.buyer?.nickname || null,
    date_created: data?.date_created || null,
    raw_data: data
  };
}

function orderItems(order) {
  const raw = order?.raw_data || {};
  return Array.isArray(raw.order_items)
    ? raw.order_items
    : Array.isArray(raw.items)
      ? raw.items
      : [];
}

async function fetchProductContext(itemId, fallbackTitle, account) {
  const key = String(itemId || "").trim().toUpperCase();
  const cached = productCache.get(key);
  if (cached && Date.now() - cached.at < PRODUCT_CACHE_MS) return cached.value;

  const [itemResult, descriptionResult] = await Promise.all([
    mercadoLivreFetch(`/items/${encodeURIComponent(key)}`, account),
    mercadoLivreFetch(`/items/${encodeURIComponent(key)}/description`, account)
  ]);

  const item = await itemResult.response.json().catch(() => ({}));
  const description = await descriptionResult.response.json().catch(() => ({}));
  const descriptionLookupOk = descriptionResult.response.ok;

  if (!itemResult.response.ok) {
    throw new Error(`Não foi possível consultar o anúncio ${key} antes da resposta.`);
  }

  const attributes = Array.isArray(item?.attributes)
    ? item.attributes
        .map(a => `${a?.name || a?.id || "Atributo"}: ${a?.value_name || a?.value_id || ""}`)
        .filter(Boolean)
        .slice(0, 35)
    : [];

  const value = {
    item_id: key,
    title: item?.title || fallbackTitle || "Produto Mercado Livre",
    seller_sku: item?.seller_custom_field || item?.seller_sku || null,
    condition: item?.condition || null,
    warranty: item?.warranty || null,
    attributes,
    description: String(description?.plain_text || description?.text || "").trim().slice(0, 7000),
    description_lookup_ok: descriptionLookupOk
  };

  productCache.set(key, { at: Date.now(), value });
  return value;
}

async function buildPurchasedProductContext(order, messages, account) {
  const lines = orderItems(order);
  const candidates = new Map();

  for (const line of lines) {
    const id = String(line?.item?.id || line?.item_id || "").trim().toUpperCase();
    if (!id) continue;
    candidates.set(id, line?.item?.title || line?.title || "Produto Mercado Livre");
  }

  for (const id of itemIdsFromMessages(messages)) {
    if (!candidates.has(id)) candidates.set(id, "Produto Mercado Livre");
  }

  if (!candidates.size) {
    throw new Error("Não consegui identificar o anúncio do produto comprado; resposta automática bloqueada.");
  }

  const products = [];
  for (const [itemId, title] of candidates.entries()) {
    products.push(await fetchProductContext(itemId, title, account));
  }

  if (!products.every(p => p.description_lookup_ok)) {
    throw new Error("Não consegui consultar a descrição de um dos anúncios; resposta automática bloqueada.");
  }

  return products;
}

async function loadSharedKnowledge() {
  if (Date.now() - knowledgeCache.at < KNOWLEDGE_CACHE_MS) return knowledgeCache.value;

  let knowledge = [];
  let experiences = [];

  try {
    const { data, error } = await supabase
      .from("matrix_ai_knowledge")
      .select("category,title,content,priority")
      .eq("active", true)
      .eq("approved", true)
      .order("priority", { ascending: false })
      .limit(100);
    if (!error) knowledge = data || [];
  } catch (_) {}

  try {
    const { data, error } = await supabase
      .from("sac_learnings")
      .select("title,content,confidence")
      .eq("status", "verified_by_outcome")
      .order("created_at", { ascending: false })
      .limit(12);
    if (!error) experiences = data || [];
  } catch (_) {}

  knowledgeCache = { at: Date.now(), value: { knowledge, experiences } };
  return knowledgeCache.value;
}

function productContextText(products) {
  return products.map((p, index) => {
    const attrs = p.attributes.length ? p.attributes.join(" | ") : "Sem atributos adicionais.";
    const desc = p.description || "Descrição consultada no Mercado Livre, mas sem texto preenchido.";
    return `PRODUTO ${index + 1}\nAnúncio: ${p.item_id}\nTítulo: ${p.title}\nSKU: ${p.seller_sku || "não informado"}\nGarantia: ${p.warranty || "não informada"}\nAtributos: ${attrs}\nDescrição do anúncio: ${desc}`;
  }).join("\n\n");
}

function sharedKnowledgeText(knowledge, experiences) {
  const official = knowledge.length
    ? knowledge.map(k => `- [${k.category}] ${k.title}: ${k.content}`).join("\n")
    : "- Nenhuma regra oficial cadastrada.";
  const solved = experiences.length
    ? experiences.map(e => `- ${e.title}: ${e.content}`).join("\n")
    : "- Nenhuma experiência resolvida cadastrada.";
  return `CONHECIMENTO OFICIAL DA SHOP MATRIX:\n${official}\n\nEXPERIÊNCIAS DE ATENDIMENTOS JÁ RESOLVIDOS:\n${solved}`;
}

async function generateReply({ order, messages, products }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

  const { knowledge, experiences } = await loadSharedKnowledge();
  const history = messages
    .slice(-14)
    .map(m => {
      const who = cleanId(m?.from?.user_id) === cleanId(order?.raw_data?.seller?.id) ? "SHOP MATRIX" : "CLIENTE";
      return `${who}: ${textOf(m).slice(0, 900)}`;
    })
    .filter(line => !line.endsWith(": "))
    .join("\n");

  const lastInbound = [...messages].reverse().find(m => textOf(m));
  const input = `
PEDIDO MERCADO LIVRE: ${order?.marketplace_order_id || "não identificado"}
COMPRADOR: ${order?.buyer_nickname || order?.raw_data?.buyer?.nickname || "não informado"}

PRODUTO COMPRADO — CONSULTADO NO MERCADO LIVRE ANTES DE RESPONDER:
${productContextText(products)}

${sharedKnowledgeText(knowledge, experiences)}

HISTÓRICO RECENTE DO SAC ML:
${history || "Sem histórico anterior."}

MENSAGEM MAIS RECENTE DO CLIENTE:
${textOf(lastInbound)}

Produza a resposta final ao cliente agora.
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: BASE_PROMPT,
      input
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI recusou a resposta do SAC ML.");
  }

  const text = String(
    data?.output_text ||
    data?.output?.flatMap?.(x => x?.content || []).find?.(c => c?.type === "output_text")?.text ||
    ""
  ).trim();

  if (!text) throw new Error("A IA não retornou uma resposta para o SAC ML.");
  return text.slice(0, 350);
}

async function sendReply(packId, text, account) {
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
        text: String(text || "").slice(0, 350)
      })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ML recusou auto resposta: ${JSON.stringify(data)}`);
  return data;
}

async function processPackAutoReply(packId) {
  const safePackId = cleanId(packId);
  if (!safePackId || processingPacks.has(safePackId)) return { skipped: true, reason: "busy_or_invalid" };

  processingPacks.add(safePackId);
  try {
    const account = await getMercadoLivreAccount();
    if (!account) return { skipped: true, reason: "account_missing" };

    const { messages } = await fetchPackConversation(safePackId, account);
    if (!messages.length) return { skipped: true, reason: "no_messages" };

    const sellerId = cleanId(account.user_id);
    const last = messages[messages.length - 1];
    const lastMessageId = String(last?.message_id || `${safePackId}:${dateOf(last) || ""}`);
    const lastFromSeller = cleanId(last?.from?.user_id) === sellerId;
    const lastText = textOf(last);

    if (lastFromSeller) return { skipped: true, reason: "last_is_outbound" };
    if (!lastText) return { skipped: true, reason: "last_has_no_text" };

    const handledAt = handledMessages.get(lastMessageId);
    if (handledAt && Date.now() - handledAt < 24 * 60 * 60 * 1000) {
      return { skipped: true, reason: "already_handled" };
    }

    const orderId = orderIdFromMessages(messages);
    if (!orderId) return { skipped: true, reason: "order_not_found" };
    const order = await findOrder(orderId, account);
    if (!order) return { skipped: true, reason: "order_not_loaded" };

    // Regra pedida: a IA só pode responder depois de consultar o anúncio e sua descrição.
    const products = await buildPurchasedProductContext(order, messages, account);
    const reply = await generateReply({ order, messages, products });
    const result = await sendReply(safePackId, reply, account);
    handledMessages.set(lastMessageId, Date.now());

    console.log(`[SAC ML IA] Auto resposta enviada no pack ${safePackId}, pedido ${orderId}.`);
    return { sent: true, pack_id: safePackId, order_id: orderId, reply, result };
  } catch (error) {
    console.error(`[SAC ML IA] Falha no pack ${safePackId}:`, error.message);
    return { sent: false, error: error.message };
  } finally {
    processingPacks.delete(safePackId);
  }
}

function schedulePackAutoReply(packId, delay = DEBOUNCE_MS) {
  const safePackId = cleanId(packId);
  if (!safePackId) return false;
  const previous = pendingTimers.get(safePackId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    pendingTimers.delete(safePackId);
    await processPackAutoReply(safePackId);
  }, delay);
  pendingTimers.set(safePackId, timer);
  return true;
}

function agendarAutoRespostaMensagemML(payload) {
  const packId = extractPackId(payload?.resource);
  if (!packId) return { agendado: false, motivo: "pack_id não encontrado" };
  schedulePackAutoReply(packId);
  return { agendado: true, pack_id: packId, delay_ms: DEBOUNCE_MS };
}

module.exports = {
  BASE_PROMPT,
  agendarAutoRespostaMensagemML,
  processPackAutoReply,
  buildPurchasedProductContext
};
