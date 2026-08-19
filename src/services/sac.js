const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { textoSeguro } = require("../utils/common");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const OPENAI_API_KEY = env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL;
const SAC_AUTO_SEND_SIMPLE = env.SAC_AUTO_SEND_SIMPLE;
const ML_MESSAGING_AGENT_ID_MLB = "3037675074";

function extrairPackId(resource) {
  const match = String(resource || "").match(/\/packs\/(\d+)/);
  return match ? match[1] : null;
}

function extrairClaimId(resource) {
  const match = String(resource || "").match(/\/claims\/(\d+)/);
  return match ? match[1] : null;
}

async function openAIText(instructions, input) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada no Railway.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
      input
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro OpenAI:", data);
    throw new Error(data?.error?.message || "OpenAI recusou a solicitação.");
  }

  if (data.output_text) return String(data.output_text).trim();

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function upsertSacThread(record) {
  const { data, error } = await supabase
    .from("sac_threads")
    .upsert(record, { onConflict: "channel,external_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Erro salvando SAC thread: ${error.message}`);
  return data;
}

async function salvarSacMensagem(record) {
  const { data, error } = await supabase
    .from("sac_messages")
    .upsert(record, { onConflict: "channel,external_message_id", ignoreDuplicates: false })
    .select("*")
    .single();
  if (error) throw new Error(`Erro salvando mensagem SAC: ${error.message}`);
  return data;
}

async function buscarPedidoLocalPorMarketplaceId(orderId) {
  if (!orderId) return null;
  const { data } = await supabase
    .from("marketplace_orders")
    .select("id,marketplace_order_id,status,total_amount,paid_amount,date_created,buyer_id,buyer_nickname,raw_data")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();
  return data || null;
}

async function sincronizarConversaML(packId, markAsRead = false) {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Conta Mercado Livre não conectada.");
  const sellerId = String(account.user_id);
  const path = `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale&mark_as_read=${markAsRead ? "true" : "false"}`;
  const { response } = await mercadoLivreFetch(path, account);
  const data = await response.json();
  if (!response.ok) throw new Error(`Erro lendo mensagens ML: ${JSON.stringify(data)}`);

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const orderId = data?.messages?.[0]?.message_resources?.find?.(x => x.name === "order")?.id || null;
  const pedido = await buscarPedidoLocalPorMarketplaceId(orderId);

  const thread = await upsertSacThread({
    channel: "mercadolivre",
    external_id: `pack:${packId}`,
    type: "message",
    pack_id: String(packId),
    seller_id: sellerId,
    order_id: orderId ? String(orderId) : null,
    buyer_id: pedido?.buyer_id || null,
    buyer_nickname: pedido?.buyer_nickname || null,
    status: data?.conversation_status?.status || "open",
    priority: "normal",
    last_message_at: messages.length ? (messages[messages.length - 1].date || messages[messages.length - 1].date_received || new Date().toISOString()) : new Date().toISOString(),
    raw_data: data,
    updated_at: new Date().toISOString()
  });

  for (const msg of messages) {
    const fromId = String(msg?.from?.user_id || "");
    await salvarSacMensagem({
      thread_id: thread.id,
      channel: "mercadolivre",
      external_message_id: String(msg.message_id),
      direction: fromId === sellerId ? "outbound" : "inbound",
      sender_role: fromId === sellerId ? "seller" : "buyer",
      text: textoSeguro(msg?.text?.plain || msg?.text || "", 10000),
      date_created: msg.date || msg.date_received || new Date().toISOString(),
      raw_data: msg
    });
  }

  return thread;
}

async function processarNotificacaoMensagemML(payload) {
  const packId = extrairPackId(payload.resource);
  if (packId) {
    const thread = await sincronizarConversaML(packId, false);
    await gerarRascunhoIA(thread.id, { regenerate: false });
  }
}

async function sincronizarClaimML(claimId) {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Conta Mercado Livre não conectada.");

  const requests = await Promise.all([
    mercadoLivreFetch(`/post-purchase/v1/claims/${claimId}`, account),
    mercadoLivreFetch(`/post-purchase/v1/claims/${claimId}/detail`, account),
    mercadoLivreFetch(`/post-purchase/v1/claims/${claimId}/affects-reputation`, account),
    mercadoLivreFetch(`/post-purchase/v1/claims/${claimId}/messages`, account)
  ]);

  const parsed = [];
  for (const item of requests) parsed.push({ response: item.response, data: await item.response.json() });
  const [claimR, detailR, reputationR, messagesR] = parsed;
  if (!claimR.response.ok) throw new Error(`Erro lendo claim ML: ${JSON.stringify(claimR.data)}`);

  const claim = claimR.data;
  const detail = detailR.response.ok ? detailR.data : {};
  const reputation = reputationR.response.ok ? reputationR.data : {};
  const messages = messagesR.response.ok && Array.isArray(messagesR.data) ? messagesR.data : [];
  const orderId = claim.resource === "order" ? String(claim.resource_id) : null;
  const pedido = await buscarPedidoLocalPorMarketplaceId(orderId);
  const sellerPlayer = (claim.players || []).find(p => p.role === "respondent");
  const availableActions = (sellerPlayer?.available_actions || []).map(a => typeof a === "string" ? a : a.action);
  const affects = reputation.affects_reputation === "affected";

  const thread = await upsertSacThread({
    channel: "mercadolivre",
    external_id: `claim:${claimId}`,
    type: "claim",
    claim_id: String(claimId),
    seller_id: String(account.user_id),
    order_id: orderId,
    buyer_id: pedido?.buyer_id || null,
    buyer_nickname: pedido?.buyer_nickname || null,
    status: claim.status || "opened",
    priority: affects || reputation.has_incentive ? "urgent" : "high",
    affects_reputation: affects,
    due_date: detail.due_date || reputation.due_date || null,
    subject: detail.title || detail.problem || `Reclamação ${claimId}`,
    available_actions: availableActions,
    last_message_at: messages.length ? (messages[messages.length - 1].message_date || messages[messages.length - 1].date_created) : (claim.last_updated || claim.date_created),
    raw_data: { claim, detail, reputation },
    updated_at: new Date().toISOString()
  });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const externalId = `${claimId}:${msg.date_created || msg.message_date || i}:${i}`;
    await salvarSacMensagem({
      thread_id: thread.id,
      channel: "mercadolivre",
      external_message_id: externalId,
      direction: msg.sender_role === "respondent" ? "outbound" : "inbound",
      sender_role: msg.sender_role || null,
      text: textoSeguro(msg.message || msg.translated_message || "", 10000),
      date_created: msg.message_date || msg.date_created || new Date().toISOString(),
      raw_data: msg
    });
  }

  return thread;
}

async function processarNotificacaoClaimML(payload) {
  const claimId = extrairClaimId(payload.resource);
  if (claimId) {
    const thread = await sincronizarClaimML(claimId);
    await gerarRascunhoIA(thread.id, { regenerate: false });
  }
}

async function contextoSac(threadId) {
  const { data: thread, error } = await supabase.from("sac_threads").select("*").eq("id", threadId).single();
  if (error || !thread) throw new Error("Atendimento SAC não encontrado.");
  const { data: messages, error: msgError } = await supabase.from("sac_messages").select("*").eq("thread_id", threadId).order("date_created", { ascending: true });
  if (msgError) throw new Error(`Erro lendo histórico SAC: ${msgError.message}`);
  const pedido = await buscarPedidoLocalPorMarketplaceId(thread.order_id);
  return { thread, messages: messages || [], pedido };
}

function instrucoesShopMatrix(tipo) {
  const limite = tipo === "message" ? "A resposta FINAL deve ter no máximo 350 caracteres." : "Seja completo, mas objetivo.";
  return `Você é o assistente de pós-venda da Shop Matrix, especializada em computadores. Escreva em português do Brasil, educado, técnico e direto. Nunca invente dados do pedido, garantia, reembolso ou procedimentos que não estejam no contexto. ${limite}\n\nREGRA OPERACIONAL IMPORTANTE: quando o sintoma for PC travando, reiniciando, desligando, sem vídeo ou não ligando, a primeira resposta deve reunir todos os testes razoáveis que o próprio cliente consegue executar, em ordem lógica, começando pelos mais simples e seguros, porque pode não existir uma segunda chance de interação. Para problemas elétricos/voltagem, não acuse o cliente sem evidência. Para reclamação, devolução, estorno, ameaça jurídica, dano de transporte ou risco de reputação, produza apenas rascunho para aprovação humana. Não prometa ação que o sistema não confirmou. Não inclua links externos, telefone, e-mail ou pedido para conversar fora do Mercado Livre.`;
}

async function gerarRascunhoIA(threadId, options = {}) {
  const { thread, messages, pedido } = await contextoSac(threadId);
  if (!options.regenerate && thread.ai_draft) return thread;
  const inbound = messages.filter(m => m.direction === "inbound");
  if (!inbound.length && thread.type === "message") return thread;

  const history = messages.slice(-12).map(m => `${m.direction === "inbound" ? "CLIENTE" : "SHOP MATRIX"}: ${m.text}`).join("\n");
  const problem = thread.raw_data?.detail?.problem || thread.raw_data?.detail?.description || "";
  const input = `TIPO: ${thread.type}\nPEDIDO: ${thread.order_id || "não identificado"}\nCOMPRADOR: ${thread.buyer_nickname || thread.buyer_id || "não informado"}\nPRODUTO/PEDIDO: ${JSON.stringify(pedido?.raw_data?.order_items || pedido?.raw_data?.items || [])}\nPROBLEMA DA RECLAMAÇÃO: ${problem}\nAFETA REPUTAÇÃO: ${thread.affects_reputation ? "SIM" : "não/indefinido"}\nPRAZO: ${thread.due_date || "não informado"}\nHISTÓRICO:\n${history}\n\nEscreva somente a resposta que deve ser enviada ao cliente, sem título e sem comentários internos.`;
  const draft = await openAIText(instrucoesShopMatrix(thread.type), input);

  const categoryPrompt = `Classifique o atendimento em UMA categoria curta entre: nao_liga, sem_video, travando_reiniciando, transporte_dano, voltagem_eletrica, devolucao, reembolso, entrega, configuracao, garantia, outro. Responda só a categoria.\nMensagem: ${textoSeguro(inbound[inbound.length-1]?.text || problem, 1500)}`;
  let category = "outro";
  try { category = textoSeguro(await openAIText("Classificador de SAC. Responda somente a categoria solicitada.", categoryPrompt), 80).toLowerCase(); } catch (_) {}

  const requiresApproval = thread.type === "claim" || thread.affects_reputation || ["devolucao","reembolso","transporte_dano","voltagem_eletrica"].includes(category);
  const { data, error } = await supabase.from("sac_threads").update({
    ai_draft: thread.type === "message" ? draft.slice(0, 350) : draft,
    ai_category: category,
    ai_requires_approval: requiresApproval || !SAC_AUTO_SEND_SIMPLE,
    ai_generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", threadId).select("*").single();
  if (error) throw new Error(`Erro salvando rascunho IA: ${error.message}`);
  return data;
}

async function enviarMensagemPosVendaML(thread, text) {
  const account = await getMercadoLivreAccount();
  const sellerId = String(account.user_id);
  const body = {
    from: { user_id: sellerId },
    to: { user_id: ML_MESSAGING_AGENT_ID_MLB },
    text: textoSeguro(text, 350)
  };
  const { response } = await mercadoLivreFetch(`/messages/packs/${thread.pack_id}/sellers/${sellerId}?tag=post_sale`, account, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ML recusou mensagem: ${JSON.stringify(data)}`);
  return data;
}

function receiverRoleClaim(thread) {
  const actions = thread.available_actions || [];
  if (actions.includes("send_message_to_mediator")) return "mediator";
  if (actions.includes("send_message_to_complainant")) return "complainant";
  return null;
}

async function enviarMensagemClaimML(thread, text) {
  const receiver_role = receiverRoleClaim(thread);
  if (!receiver_role) throw new Error("A reclamação não oferece ação de envio de mensagem neste momento.");
  const account = await getMercadoLivreAccount();
  const { response } = await mercadoLivreFetch(`/post-purchase/v1/claims/${thread.claim_id}/actions/send-message`, account, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiver_role, message: textoSeguro(text, 5000), attachments: [] })
  });
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`ML recusou mensagem da reclamação: ${JSON.stringify(data)}`);
  return data;
}

async function enviarRespostaSac(threadId, text = null) {
  const { thread } = await contextoSac(threadId);
  const resposta = textoSeguro(text || thread.ai_draft, thread.type === "message" ? 350 : 5000);
  if (!resposta) throw new Error("Não existe resposta para enviar.");
  const result = thread.type === "claim" ? await enviarMensagemClaimML(thread, resposta) : await enviarMensagemPosVendaML(thread, resposta);
  await supabase.from("sac_threads").update({ status: "responded", last_response_text: resposta, last_response_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", threadId);
  return result;
}


module.exports = {
  extrairPackId,
  extrairClaimId,
  openAIText,
  sincronizarConversaML,
  processarNotificacaoMensagemML,
  sincronizarClaimML,
  processarNotificacaoClaimML,
  contextoSac,
  gerarRascunhoIA,
  enviarRespostaSac
};
