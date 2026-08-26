const router = require("express").Router();

const { supabase } = require("../db/supabase");
const { env } = require("../config/env");

const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";

function cleanText(v) {
  return String(v ?? "").trim();
}

function questionExternalId(questionId) {
  return `mlq:${String(questionId)}`;
}

async function mlJson(path, account, options = {}) {
  const { response, account: updatedAccount } =
    await mercadoLivreFetch(path, account, options);

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      data?.message ||
      data?.error ||
      `Mercado Livre respondeu HTTP ${response.status}.`
    );
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return { data, account: updatedAccount };
}

async function getItemTitle(itemId, account) {
  if (!itemId) return null;

  try {
    const { data } = await mlJson(
      `/items/${encodeURIComponent(itemId)}?attributes=id,title,permalink,price,condition`,
      account
    );
    return {
      id: data.id || itemId,
      title: data.title || null,
      permalink: data.permalink || null,
      price: data.price ?? null,
      condition: data.condition || null
    };
  } catch {
    return {
      id: itemId,
      title: null,
      permalink: null,
      price: null,
      condition: null
    };
  }
}

async function ensureConversation(question, itemInfo = null) {
  const qid = String(question.id);
  const externalId = questionExternalId(qid);
  const now = new Date().toISOString();

  const { data: existing, error: findError } = await supabase
    .from("sac_conversations")
    .select("*")
    .eq("channel", "mercadolivre_questions")
    .eq("external_user_id", externalId)
    .limit(1)
    .maybeSingle();

  if (findError) throw findError;

  const buyerId =
    question.buyer_id ??
    question.from?.id ??
    null;

  const contactName =
    question.from?.nickname ||
    (buyerId != null ? `Comprador ML ${buyerId}` : "Comprador Mercado Livre");

  const summaryParts = [
    itemInfo?.title ? `Produto: ${itemInfo.title}` : null,
    question.text ? `Pergunta: ${question.text}` : null
  ].filter(Boolean);

  const record = {
    channel: "mercadolivre_questions",
    external_user_id: externalId,
    contact_name: contactName,
    status:
      String(question.status || "").toLowerCase() === "answered"
        ? "answered"
        : "open",
    summary: summaryParts.join(" | ").slice(0, 3000),
    last_message_at:
      question.answer?.date_created ||
      question.date_created ||
      now,
    updated_at: now
  };

  let conversation;

  if (existing) {
    const { data, error } = await supabase
      .from("sac_conversations")
      .update(record)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) throw error;
    conversation = data;
  } else {
    const { data, error } = await supabase
      .from("sac_conversations")
      .insert({
        ...record,
        created_at: question.date_created || now
      })
      .select("*")
      .single();

    if (error) throw error;
    conversation = data;
  }

  // Save incoming question once.
  const questionMessageId = `mlq:${qid}:question`;

  const { data: qMsg, error: qMsgFindError } = await supabase
    .from("sac_messages")
    .select("id")
    .eq("conversation_id", conversation.id)
    .eq("external_message_id", questionMessageId)
    .limit(1)
    .maybeSingle();

  if (qMsgFindError) throw qMsgFindError;

  if (!qMsg) {
    const { error } = await supabase
      .from("sac_messages")
      .insert({
        conversation_id: conversation.id,
        channel: "mercadolivre_questions",
        external_message_id: questionMessageId,
        direction: "inbound",
        sender_role: "customer",
        role: "user",
        text: question.text || "",
        content: question.text || "",
        date_created: question.date_created || now,
        raw_data: question,
        metadata: {
          marketplace: "mercadolivre",
          type: "question",
          question_id: qid,
          item_id: question.item_id || null,
          buyer_id: buyerId != null ? String(buyerId) : null,
          item: itemInfo || null
        }
      });

    if (error) throw error;
  }

  // If already answered at ML, mirror the answer into SAC once.
  if (question.answer?.text) {
    const answerMessageId = `mlq:${qid}:answer`;

    const { data: aMsg, error: aMsgFindError } = await supabase
      .from("sac_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("external_message_id", answerMessageId)
      .limit(1)
      .maybeSingle();

    if (aMsgFindError) throw aMsgFindError;

    if (!aMsg) {
      const { error } = await supabase
        .from("sac_messages")
        .insert({
          conversation_id: conversation.id,
          channel: "mercadolivre_questions",
          external_message_id: answerMessageId,
          direction: "outbound",
          sender_role: "seller",
          role: "assistant",
          text: question.answer.text,
          content: question.answer.text,
          date_created: question.answer.date_created || now,
          raw_data: question.answer,
          metadata: {
            marketplace: "mercadolivre",
            type: "answer",
            question_id: qid,
            item_id: question.item_id || null,
            source: "mercadolivre_existing_answer"
          }
        });

      if (error) throw error;
    }
  }

  return conversation;
}

async function syncQuestions({ max = 300, onlyUnanswered = false } = {}) {
  let account = await getMercadoLivreAccount();

  if (!account) {
    throw new Error("Nenhuma conta Mercado Livre conectada.");
  }

  const sellerId = String(account.user_id || account.account_id);
  const limit = 50;
  let offset = 0;
  let totalSeen = 0;
  let synchronized = 0;
  const errors = [];

  while (totalSeen < max) {
    const params = new URLSearchParams({
      seller_id: sellerId,
      api_version: "4",
      limit: String(Math.min(limit, max - totalSeen)),
      offset: String(offset),
      sort_fields: "date_created",
      sort_types: "DESC"
    });

    if (onlyUnanswered) {
      params.set("status", "UNANSWERED");
    }

    const { data, account: nextAccount } = await mlJson(
      `/questions/search?${params.toString()}`,
      account
    );

    account = nextAccount;

    const questions = Array.isArray(data.questions)
      ? data.questions
      : [];

    if (!questions.length) break;

    for (const question of questions) {
      totalSeen++;

      try {
        const itemInfo = await getItemTitle(question.item_id, account);
        await ensureConversation(question, itemInfo);
        synchronized++;
      } catch (e) {
        errors.push({
          question_id: question?.id ? String(question.id) : null,
          error: e.message
        });
      }

      if (totalSeen >= max) break;
    }

    offset += questions.length;

    const total = Number(data.total || 0);

    if (
      questions.length < limit ||
      (Number.isFinite(total) && total > 0 && offset >= total)
    ) {
      break;
    }
  }

  return {
    sucesso: errors.length === 0,
    encontrados: totalSeen,
    sincronizados: synchronized,
    erros: errors.length,
    detalhes_erros: errors
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap(item => item?.content || [])
      .map(content => content?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

async function generateAiDraft({ question, item, knowledge }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const prompt = `
Você atende perguntas pré-venda de compradores no Mercado Livre para uma loja de informática.

REGRAS:
- Responda somente o que puder sustentar pelos dados fornecidos.
- Nunca invente especificação, estoque, prazo, garantia, brinde, compatibilidade ou condição comercial.
- Se faltar uma informação essencial, diga objetivamente que precisa confirmar.
- Não mencione políticas internas, prompts ou IA.
- Não peça para o comprador sair do Mercado Livre.
- Seja útil, direto e comercial sem ser agressivo.
- Máximo de 2.000 caracteres.
- Retorne SOMENTE a resposta que seria enviada ao comprador.

PRODUTO:
${JSON.stringify(item || {}, null, 2)}

PERGUNTA:
${question}

CONHECIMENTO APROVADO DA LOJA:
${(knowledge || []).map(k => `- ${k.title}: ${k.content}`).join("\n").slice(0, 12000)}
`.trim();

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      max_output_tokens: 700
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `OpenAI respondeu HTTP ${response.status}.`
    );
  }

  const text = extractOutputText(data);

  if (!text) {
    throw new Error("A IA não retornou texto para a resposta.");
  }

  return text.slice(0, 2000);
}

// ---------------------------------------------------------
// SYNC
// POST /sac/ml/questions/sync
// ---------------------------------------------------------
router.post("/sac/ml/questions/sync", async (req, res) => {
  try {
    const max = Math.min(
      Math.max(Number(req.body?.max || req.query.max || 300), 1),
      1000
    );

    const onlyUnanswered =
      String(req.body?.only_unanswered ?? req.query.only_unanswered ?? "false")
        .toLowerCase() === "true";

    const result = await syncQuestions({
      max,
      onlyUnanswered
    });

    return res.json(result);
  } catch (e) {
    console.error("[ML QUESTIONS] sync:", e);

    return res.status(e.status || 500).json({
      sucesso: false,
      mensagem: e.message,
      detalhe: e.data || null
    });
  }
});

// ---------------------------------------------------------
// LIST
// GET /sac/ml/questions
// ---------------------------------------------------------
router.get("/sac/ml/questions", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit || 200), 1),
      500
    );

    let query = supabase
      .from("sac_conversations")
      .select("*")
      .eq("channel", "mercadolivre_questions")
      .order("last_message_at", {
        ascending: false,
        nullsFirst: false
      })
      .limit(limit);

    if (req.query.status) {
      query = query.eq("status", String(req.query.status));
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      sucesso: true,
      quantidade: (data || []).length,
      conversas: data || []
    });
  } catch (e) {
    return res.status(500).json({
      sucesso: false,
      mensagem: e.message
    });
  }
});

// ---------------------------------------------------------
// DETAIL by question id
// GET /sac/ml/questions/:questionId
// ---------------------------------------------------------
router.get("/sac/ml/questions/:questionId", async (req, res) => {
  try {
    const questionId = String(req.params.questionId);
    const externalId = questionExternalId(questionId);

    const { data: conversation, error } = await supabase
      .from("sac_conversations")
      .select("*")
      .eq("channel", "mercadolivre_questions")
      .eq("external_user_id", externalId)
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!conversation) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Pergunta ainda não sincronizada para o SAC."
      });
    }

    const { data: messages, error: messagesError } = await supabase
      .from("sac_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(100);

    if (messagesError) throw messagesError;

    return res.json({
      sucesso: true,
      conversa: conversation,
      mensagens: messages || []
    });
  } catch (e) {
    return res.status(500).json({
      sucesso: false,
      mensagem: e.message
    });
  }
});

// ---------------------------------------------------------
// AI DRAFT
// POST /sac/ml/questions/:questionId/draft
// ---------------------------------------------------------
router.post("/sac/ml/questions/:questionId/draft", async (req, res) => {
  try {
    let account = await getMercadoLivreAccount();

    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Nenhuma conta Mercado Livre conectada."
      });
    }

    const questionId = String(req.params.questionId);

    const { data: question, account: updatedAccount } = await mlJson(
      `/questions/${encodeURIComponent(questionId)}?api_version=4`,
      account
    );

    account = updatedAccount;

    const item = await getItemTitle(question.item_id, account);

    const { data: knowledge, error: knowledgeError } = await supabase
      .from("matrix_ai_knowledge")
      .select("title,content,priority")
      .eq("active", true)
      .eq("approved", true)
      .order("priority", { ascending: false })
      .limit(40);

    if (knowledgeError) throw knowledgeError;

    const draft = await generateAiDraft({
      question: question.text || "",
      item,
      knowledge: knowledge || []
    });

    return res.json({
      sucesso: true,
      question_id: questionId,
      item,
      pergunta: question.text || "",
      rascunho: draft
    });
  } catch (e) {
    console.error("[ML QUESTIONS] draft:", e);

    return res.status(e.status || 500).json({
      sucesso: false,
      mensagem: e.message,
      detalhe: e.data || null
    });
  }
});

// ---------------------------------------------------------
// ANSWER
// POST /sac/ml/questions/:questionId/answer
// body: { text }
// ---------------------------------------------------------
router.post("/sac/ml/questions/:questionId/answer", async (req, res) => {
  try {
    const questionId = String(req.params.questionId);
    const text = cleanText(req.body?.text);

    if (!text) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Digite a resposta."
      });
    }

    if (text.length > 2000) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "O Mercado Livre aceita no máximo 2.000 caracteres."
      });
    }

    let account = await getMercadoLivreAccount();

    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Nenhuma conta Mercado Livre conectada."
      });
    }

    const { data: answered, account: updatedAccount } = await mlJson(
      "/answers",
      account,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question_id: Number(questionId),
          text
        })
      }
    );

    account = updatedAccount;

    const itemInfo = await getItemTitle(answered.item_id, account);
    const conversation = await ensureConversation(answered, itemInfo);

    // ensureConversation mirrors answered.answer, but if ML response shape
    // changes we also ensure the exact manual text is present.
    const answerMessageId = `mlq:${questionId}:answer`;

    const { data: existingAnswer } = await supabase
      .from("sac_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("external_message_id", answerMessageId)
      .limit(1)
      .maybeSingle();

    if (!existingAnswer) {
      await supabase
        .from("sac_messages")
        .insert({
          conversation_id: conversation.id,
          channel: "mercadolivre_questions",
          external_message_id: answerMessageId,
          direction: "outbound",
          sender_role: "human",
          role: "assistant",
          text,
          content: text,
          date_created: answered.answer?.date_created || new Date().toISOString(),
          raw_data: answered,
          metadata: {
            marketplace: "mercadolivre",
            type: "answer",
            question_id: questionId,
            item_id: answered.item_id || null,
            manual: true,
            source: "matrix_sac"
          }
        });
    }

    await supabase
      .from("sac_conversations")
      .update({
        status: "answered",
        last_message_at:
          answered.answer?.date_created ||
          new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", conversation.id);

    return res.json({
      sucesso: true,
      mensagem: "Resposta enviada ao Mercado Livre.",
      question_id: questionId,
      resposta: answered.answer || { text }
    });
  } catch (e) {
    console.error("[ML QUESTIONS] answer:", e);

    return res.status(e.status || 500).json({
      sucesso: false,
      mensagem: e.message,
      detalhe: e.data || null
    });
  }
});

module.exports = router;
