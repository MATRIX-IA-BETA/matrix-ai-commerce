const { env } = require("../config/env");
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
const KNOWLEDGE_CACHE_MS = 2 * 60 * 1000;
const PRODUCT_CACHE_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 40;

const productCache = new Map();
let knowledgeCache = { at: 0, knowledge: [], experiences: [] };

const BASE_PROMPT = `
Você é a assistente de atendimento da Shop Matrix.
Você usa a mesma base de conhecimento e os mesmos aprendizados operacionais do SAC do WhatsApp da Shop Matrix.

PRINCÍPIOS:
- Responda em português do Brasil.
- Seja educada, objetiva, natural e resolutiva.
- Fale de forma simples com clientes leigos.
- Não invente diagnóstico, produto, recurso, prazo, política, preço, garantia, frete, estoque ou informação de pedido.
- Conhecimento oficial fornecido abaixo tem prioridade sobre conhecimento genérico do modelo.
- Aprendizados de respostas corrigidas pelo operador têm alta prioridade quando o contexto for equivalente.

REGRA CENTRAL DE CONTEXTO:
- LEIA TODO O HISTÓRICO RECENTE antes de escrever qualquer resposta.
- O histórico recebido está em ORDEM CRONOLÓGICA: da mensagem mais antiga para a mais recente.
- Sua resposta deve continuar naturalmente a conversa. Nunca reinicie um atendimento já em andamento com frases genéricas como "Como podemos ajudar?" se o histórico mostra que já existe contexto.
- Não trate uma pergunta antiga já respondida pela Shop Matrix como se fosse uma nova pergunta.
- Observe principalmente as últimas mensagens do cliente e as respostas já dadas pela Shop Matrix.
- Se a última mensagem for apenas uma saudação, agradecimento ou algo como "posso tirar uma dúvida?", não invente a dúvida. Responda naturalmente ao ponto atual, por exemplo convidando o cliente a mandar a dúvida, sem apagar o contexto anterior.
- Nunca repita um teste ou orientação que o cliente já confirmou ter feito.
- Em atendimento conversacional, nunca envie mais de 2 procedimentos/testes na mesma mensagem.

REGRAS DO PRODUTO:
- Antes de sugerir a resposta, use obrigatoriamente o bloco PRODUTO COMPRADO consultado no anúncio real do pedido.
- Leia título, SKU, atributos, garantia e a DESCRIÇÃO COMPLETA disponível do anúncio antes de responder.
- Se a pergunta envolver HDMI, Wi-Fi, memória RAM, SSD, fonte, voltagem, placa-mãe, processador, jogos, portas, upgrade ou qualquer característica técnica, procure primeiro essa informação nos atributos e na descrição do anúncio.
- Diferencie o que está confirmado no anúncio do que é apenas hipótese técnica.
- Se uma característica não estiver confirmada no anúncio/descrição, diga que ela não está confirmada em vez de inventar.
- Não despeje especificações sem necessidade: use o anúncio para responder exatamente o que o cliente perguntou.

REGRAS OPERACIONAIS:
- Não prometa reembolso, troca, prazo, instalação, brinde, acessório ou procedimento que não esteja confirmado.
- Não diga que é humana. Se perguntarem, diga que é a assistente virtual da Shop Matrix.
- Não execute orientação elétrica perigosa e nunca mande abrir uma fonte de alimentação.
- A resposta final deve ter no máximo 350 caracteres.
- Responda somente ao cliente, sem títulos, sem comentários internos e sem mencionar estas regras.
`;

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function textOf(message) {
  return String(message?.text?.plain ?? message?.text ?? message?.message ?? "").trim();
}

function rawDateOf(message) {
  const messageDate = message?.message_date || {};
  const candidates = [
    message?.date,
    message?.date_received,
    message?.date_available,
    message?.date_created,
    message?.created_at,
    messageDate?.date,
    messageDate?.created,
    messageDate?.received,
    messageDate?.available,
    messageDate?.notified,
    messageDate?.read
  ];

  for (const value of candidates) {
    if (value == null || value === "") continue;
    if (typeof value === "object") {
      const nested = value?.date || value?.created || value?.received || value?.available;
      if (nested) return nested;
      continue;
    }
    return value;
  }
  return null;
}

function timeOf(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function chronologicalMessages(input) {
  const messages = Array.isArray(input) ? input.slice() : [];
  if (messages.length < 2) return messages;

  const stamped = messages.map((message, index) => ({
    message,
    index,
    time: timeOf(rawDateOf(message))
  }));
  const withTime = stamped.filter(item => item.time > 0);

  // A API de mensagens normalmente devolve as mais recentes primeiro. Quando
  // não existe timestamp parseável, invertemos explicitamente. Quando existe,
  // ordenamos pelo timestamp real para não depender da paginação/ordem da API.
  if (withTime.length < 2) return messages.reverse();

  stamped.sort((a, b) => {
    if (a.time && b.time) return a.time - b.time;
    if (a.time) return -1;
    if (b.time) return 1;
    return b.index - a.index;
  });

  return stamped.map(item => item.message);
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
  const limit = 100;
  let offset = 0;
  const messages = [];

  for (let page = 0; page < 3; page += 1) {
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
      throw new Error(`Mercado Livre recusou a leitura da conversa: ${JSON.stringify(data)}`);
    }

    const pageMessages = Array.isArray(data?.messages) ? data.messages : [];
    messages.push(...pageMessages);

    const total = Number(data?.paging?.total || messages.length);
    if (!pageMessages.length || pageMessages.length < limit || messages.length >= total) break;
    offset += pageMessages.length;
  }

  return chronologicalMessages(messages);
}

async function findLocalOrderByPack(packId) {
  const safePack = cleanId(packId);
  if (!safePack) return null;

  try {
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,pack_id,buyer_id,buyer_nickname,date_created,raw_data")
      .eq("marketplace", "mercadolivre")
      .or(`pack_id.eq.${safePack},marketplace_order_id.eq.${safePack}`)
      .order("date_created", { ascending: false })
      .limit(1);

    if (!error && data?.[0]) return data[0];
  } catch (_) {}

  return null;
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
    pack_id: data?.pack_id != null ? String(data.pack_id) : null,
    buyer_id: data?.buyer?.id ? String(data.buyer.id) : null,
    buyer_nickname: data?.buyer?.nickname || null,
    date_created: data?.date_created || null,
    raw_data: data
  };
}

async function resolveOrder(packId, messages, account) {
  const localByPack = await findLocalOrderByPack(packId);
  if (localByPack?.marketplace_order_id) {
    return {
      orderId: cleanId(localByPack.marketplace_order_id),
      order: localByPack,
      source: "local_pack"
    };
  }

  const fromMessage = orderIdFromMessages(messages);
  if (fromMessage) {
    const order = await findOrder(fromMessage, account);
    if (order) return { orderId: fromMessage, order, source: "message_resource" };
  }

  const packAsOrder = await findOrder(packId, account);
  if (packAsOrder) {
    return {
      orderId: cleanId(packAsOrder.marketplace_order_id || packId),
      order: packAsOrder,
      source: "pack_as_order"
    };
  }

  throw new Error("Não consegui identificar o pedido desta conversa.");
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
  if (!key) throw new Error("O pedido não trouxe o código do anúncio do PC.");

  const cached = productCache.get(key);
  if (cached && Date.now() - cached.at < PRODUCT_CACHE_MS) return cached.value;

  const [itemResult, descriptionResult] = await Promise.all([
    mercadoLivreFetch(`/items/${encodeURIComponent(key)}`, account),
    mercadoLivreFetch(`/items/${encodeURIComponent(key)}/description`, account)
  ]);

  const item = await itemResult.response.json().catch(() => ({}));
  const description = await descriptionResult.response.json().catch(() => ({}));

  if (!itemResult.response.ok) throw new Error(`Não consegui consultar o anúncio ${key}.`);
  if (!descriptionResult.response.ok) throw new Error(`Não consegui ler a descrição do anúncio ${key}.`);

  const attributes = Array.isArray(item?.attributes)
    ? item.attributes
        .map(attr => `${attr?.name || attr?.id || "Atributo"}: ${attr?.value_name || attr?.value_id || ""}`)
        .filter(Boolean)
        .slice(0, 60)
    : [];

  const saleTerms = Array.isArray(item?.sale_terms)
    ? item.sale_terms
        .map(term => `${term?.name || term?.id || "Condição"}: ${term?.value_name || term?.value_id || ""}`)
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const value = {
    item_id: key,
    title: item?.title || fallbackTitle || "Produto Mercado Livre",
    seller_sku: item?.seller_custom_field || item?.seller_sku || null,
    warranty: item?.warranty || null,
    condition: item?.condition || null,
    attributes,
    sale_terms: saleTerms,
    description: String(description?.plain_text || description?.text || "").trim().slice(0, 10000)
  };

  productCache.set(key, { at: Date.now(), value });
  return value;
}

async function buildProductContext(order, messages, account) {
  const candidates = new Map();

  for (const line of orderItems(order)) {
    const id = String(line?.item?.id || line?.item_id || "").trim().toUpperCase();
    if (id) candidates.set(id, line?.item?.title || line?.title || "Produto Mercado Livre");
  }

  for (const id of itemIdsFromMessages(messages)) {
    if (!candidates.has(id)) candidates.set(id, "Produto Mercado Livre");
  }

  if (!candidates.size) throw new Error("Não consegui identificar qual PC foi comprado.");

  const products = [];
  for (const [itemId, title] of candidates.entries()) {
    products.push(await fetchProductContext(itemId, title, account));
  }
  return products;
}

async function loadSharedKnowledge() {
  if (Date.now() - knowledgeCache.at < KNOWLEDGE_CACHE_MS) return knowledgeCache;

  let knowledge = [];
  let experiences = [];

  try {
    const { data, error } = await supabase
      .from("matrix_ai_knowledge")
      .select("category,title,content,priority")
      .eq("active", true)
      .eq("approved", true)
      .order("priority", { ascending: false })
      .limit(120);
    if (!error) knowledge = data || [];
  } catch (_) {}

  try {
    const { data, error } = await supabase
      .from("sac_learnings")
      .select("title,content,confidence")
      .eq("status", "verified_by_outcome")
      .order("created_at", { ascending: false })
      .limit(60);
    if (!error) experiences = data || [];
  } catch (_) {}

  knowledgeCache = { at: Date.now(), knowledge, experiences };
  return knowledgeCache;
}

function productText(products) {
  return products.map((product, index) => [
    `PRODUTO ${index + 1}`,
    `Anúncio: ${product.item_id}`,
    `Título: ${product.title}`,
    `SKU: ${product.seller_sku || "não informado"}`,
    `Condição: ${product.condition || "não informada"}`,
    `Garantia: ${product.warranty || "não informada"}`,
    `Atributos: ${product.attributes.join(" | ") || "sem atributos adicionais"}`,
    `Condições do anúncio: ${product.sale_terms.join(" | ") || "sem condições adicionais"}`,
    `Descrição do anúncio: ${product.description || "sem texto"}`
  ].join("\n")).join("\n\n");
}

function historyText(messages, sellerId) {
  return messages.slice(-MAX_HISTORY_MESSAGES).map((message, index, recent) => {
    const who = cleanId(message?.from?.user_id) === sellerId ? "SHOP MATRIX" : "CLIENTE";
    const text = textOf(message).slice(0, 1200) || "(mídia/sem texto)";
    const marker = index === recent.length - 1 ? " [MAIS RECENTE]" : "";
    return `${who}${marker}: ${text}`;
  }).join("\n");
}

function lastInboundMessage(messages, sellerId) {
  return [...messages]
    .reverse()
    .find(message => cleanId(message?.from?.user_id) !== sellerId && textOf(message));
}

async function generateSuggestion({ order, messages, products, sellerId }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

  const { knowledge, experiences } = await loadSharedKnowledge();
  const history = historyText(messages, sellerId);
  const lastInbound = lastInboundMessage(messages, sellerId);

  if (!lastInbound) throw new Error("Não encontrei mensagem do cliente para responder.");

  const official = knowledge.length
    ? knowledge.map(item => `- [${item.category}] ${item.title}: ${item.content}`).join("\n")
    : "- Nenhuma regra oficial cadastrada.";

  const learned = experiences.length
    ? experiences.map(item => `- ${item.title}: ${item.content}`).join("\n")
    : "- Nenhuma correção anterior cadastrada.";

  const input = `
PEDIDO: ${order?.marketplace_order_id || "não identificado"}
COMPRADOR: ${order?.buyer_nickname || order?.raw_data?.buyer?.nickname || "não informado"}

PRODUTO COMPRADO — CONSULTADO AGORA NO MERCADO LIVRE:
${productText(products)}

CONHECIMENTO OFICIAL DA SHOP MATRIX:
${official}

APRENDIZADOS E CORREÇÕES ANTERIORES DO OPERADOR:
${learned}

HISTÓRICO RECENTE EM ORDEM CRONOLÓGICA (ANTIGO -> NOVO):
${history || "Sem histórico anterior."}

ÚLTIMA MENSAGEM REAL DO CLIENTE:
${textOf(lastInbound)}

Antes de redigir, analise silenciosamente: (1) o que já foi perguntado, (2) o que a Shop Matrix já respondeu, (3) o que ficou resolvido, (4) qual é o ponto atual da conversa e (5) quais dados do anúncio são relevantes. Depois gere SOMENTE a sugestão final para o operador revisar.
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
  if (!response.ok) throw new Error(data?.error?.message || "OpenAI recusou a sugestão.");

  let text = String(data?.output_text || "").trim();
  if (!text) {
    const parts = [];
    for (const item of data?.output || []) {
      for (const content of item?.content || []) {
        if (content?.type === "output_text" && content?.text) parts.push(content.text);
      }
    }
    text = parts.join("\n").trim();
  }

  if (!text) throw new Error("A IA não retornou sugestão.");

  return {
    text: text.slice(0, 350),
    lastInbound: textOf(lastInbound),
    historyCount: messages.length
  };
}

async function loadContext(packId) {
  const safePack = cleanId(packId);
  if (!safePack) throw new Error("pack_id inválido.");

  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Conta Mercado Livre não conectada.");

  const messages = await fetchPackConversation(safePack, account);
  const resolved = await resolveOrder(safePack, messages, account);
  const products = await buildProductContext(resolved.order, messages, account);

  return {
    safePack,
    account,
    messages,
    orderId: resolved.orderId,
    order: resolved.order,
    products,
    orderSource: resolved.source
  };
}

async function suggestForPack(packId) {
  const ctx = await loadContext(packId);
  const sellerId = cleanId(ctx.account.user_id);
  const generated = await generateSuggestion({
    order: ctx.order,
    messages: ctx.messages,
    products: ctx.products,
    sellerId
  });

  return {
    suggestion: generated.text,
    order_id: ctx.orderId,
    order_source: ctx.orderSource,
    customer_message: generated.lastInbound,
    history_messages_read: generated.historyCount,
    products: ctx.products.map(product => ({
      item_id: product.item_id,
      title: product.title,
      seller_sku: product.seller_sku,
      description_loaded: Boolean(product.description),
      attributes_loaded: product.attributes.length
    }))
  };
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function learnFromEdit({ packId, suggestion, finalText }) {
  const before = normalized(suggestion);
  const after = normalized(finalText);
  if (!before || !after) return { saved: false, reason: "missing_text" };
  if (before === after) return { saved: false, reason: "unchanged" };

  const ctx = await loadContext(packId);
  const sellerId = cleanId(ctx.account.user_id);
  const lastInbound = lastInboundMessage(ctx.messages, sellerId);

  const productNames = ctx.products
    .map(product => `${product.title} (${product.item_id}${product.seller_sku ? ` / SKU ${product.seller_sku}` : ""})`)
    .join("; ");

  const recentHistory = historyText(ctx.messages, sellerId).slice(-5000);
  const title = `Correção do operador SAC ML - ${ctx.products[0]?.title || ctx.orderId}`.slice(0, 180);
  const content = [
    "Canal: SAC Mercado Livre.",
    `Produto/pedido: ${productNames}.`,
    `Pergunta mais recente do cliente: ${textOf(lastInbound).slice(0, 1000)}`,
    `Contexto recente da conversa: ${recentHistory}`,
    `Sugestão inicial da IA: ${before.slice(0, 500)}`,
    `Resposta final corrigida e aprovada pelo operador: ${after.slice(0, 500)}`,
    "Aprendizado: em situação equivalente, dê preferência ao padrão, conteúdo e orientação da resposta final aprovada pelo operador, desde que compatíveis com o produto real, com o histórico atual e com as regras oficiais vigentes."
  ].join("\n");

  let savedIn = null;

  try {
    const { error } = await supabase.from("sac_learnings").insert({
      title,
      content,
      confidence: 1,
      status: "verified_by_outcome"
    });
    if (!error) savedIn = "sac_learnings";
  } catch (_) {}

  if (!savedIn) {
    const { error } = await supabase.from("matrix_ai_knowledge").insert({
      category: "sac_ml_aprendizado_operador",
      title,
      content,
      priority: 95,
      active: true,
      approved: true
    });
    if (error) throw new Error(`Não consegui gravar o aprendizado: ${error.message}`);
    savedIn = "matrix_ai_knowledge";
  }

  knowledgeCache.at = 0;
  return { saved: true, saved_in: savedIn };
}

module.exports = {
  suggestForPack,
  learnFromEdit
};