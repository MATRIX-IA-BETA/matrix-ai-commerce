const router = require("express").Router();
const { env } = require("../config/env");

const WHATSAPP_VERIFY_TOKEN = env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_ACCESS_TOKEN = env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = env.WHATSAPP_API_VERSION;

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";

const MATRIX_SAC_SYSTEM_PROMPT = `
Você é a assistente de atendimento da Shop Matrix, especializada em computadores e pós-venda.

REGRAS DE ATENDIMENTO:
- Responda sempre em português do Brasil.
- Seja educada, objetiva e resolutiva.
- Fale com linguagem simples para clientes leigos.
- Nunca invente diagnóstico, prazo, política, preço, garantia, frete, estoque ou informação de pedido.
- Se faltarem dados essenciais, peça apenas o mínimo necessário.
- Em suporte técnico, organize testes do mais simples e seguro para o mais avançado.
- Quando o sintoma envolver computador que não liga, fonte ou energia, priorize verificar alimentação elétrica, cabo, tomada e seletor 115/230 V quando aplicável.
- Não orientar o cliente a abrir fonte de alimentação ou executar procedimento elétrico perigoso.
- Quando houver risco de perda de dados, avise antes de qualquer procedimento.
- Se for uma situação que exige análise humana (financeiro sensível, ameaça, questão jurídica, reembolso fora de regra, suspeita de fraude, garantia controversa), diga que encaminhará para um atendente humano e não tome decisão por conta própria.
- Não diga que é humana. Se perguntarem, explique que é a assistente virtual da Shop Matrix.
- Tente resolver o problema na primeira resposta sempre que for seguro e houver informação suficiente.
- Não escreva textos enormes sem necessidade.
`;



async function gerarRespostaIA({ mensagem, nomeCliente }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const input = [
    `Nome do cliente: ${nomeCliente || "não informado"}`,
    `Mensagem do cliente: ${mensagem}`
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: MATRIX_SAC_SYSTEM_PROMPT,
      input
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro OpenAI:", data);
    throw new Error(
      data?.error?.message ||
      "OpenAI recusou a geração da resposta."
    );
  }

  const outputText =
    data.output_text ||
    (Array.isArray(data.output)
      ? data.output
          .flatMap(item => item?.content || [])
          .map(content => content?.text || "")
          .filter(Boolean)
          .join("\n")
      : "");

  if (!outputText || !outputText.trim()) {
    throw new Error("OpenAI retornou resposta vazia.");
  }

  return outputText.trim();
}

async function enviarMensagemWhatsApp(to, message) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurado."
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to),
        type: "text",
        text: {
          preview_url: false,
          body: String(message)
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro enviando WhatsApp:", data);
    throw new Error(
      data?.error?.message ||
      "WhatsApp recusou o envio."
    );
  }

  return data;
}


// Validação do webhook pela Meta
router.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    WHATSAPP_VERIFY_TOKEN &&
    token === WHATSAPP_VERIFY_TOKEN
  ) {
    console.log("Webhook do WhatsApp verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.warn("Falha na verificação do webhook do WhatsApp.");
  return res.sendStatus(403);
});

// Recebe mensagens e atualizações de status
router.post("/webhooks/whatsapp", async (req, res) => {
  // A Meta exige resposta rápida
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body?.object !== "whatsapp_business_account") {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        for (const status of value.statuses || []) {
          console.log("Status WhatsApp:", {
            id: status.id,
            status: status.status,
            recipient_id: status.recipient_id,
            timestamp: status.timestamp
          });
        }

        for (const message of value.messages || []) {
          const contact =
            Array.isArray(value.contacts) && value.contacts.length
              ? value.contacts[0]
              : null;

          const messageText =
            message?.text?.body ||
            message?.button?.text ||
            message?.interactive?.button_reply?.title ||
            message?.interactive?.list_reply?.title ||
            null;

          console.log("Mensagem WhatsApp recebida:", {
            from: message.from,
            id: message.id,
            type: message.type,
            text: messageText,
            contact_name: contact?.profile?.name || null,
            phone_number_id: value?.metadata?.phone_number_id || null,
            display_phone_number: value?.metadata?.display_phone_number || null
          });

          // V1 do SAC IA: responde automaticamente mensagens de texto.
          // Outros tipos ficam registrados no log até adicionarmos tratamento próprio.
          if (
            message.from &&
            messageText &&
            ["text", "button", "interactive"].includes(message.type)
          ) {
            try {
              const respostaIA = await gerarRespostaIA({
                mensagem: messageText,
                nomeCliente: contact?.profile?.name || null
              });

              console.log("Resposta IA gerada:", {
                to: message.from,
                resposta: respostaIA
              });

              const envio = await enviarMensagemWhatsApp(
                message.from,
                respostaIA
              );

              console.log("Resposta WhatsApp enviada:", {
                to: message.from,
                message_id: envio?.messages?.[0]?.id || null
              });
            } catch (erroIA) {
              console.error(
                "Erro no fluxo automático do SAC IA:",
                erroIA
              );
            }
          }
        }
      }
    }
  } catch (erro) {
    console.error("Erro processando webhook do WhatsApp:", erro);
  }
});

// Envio manual de mensagem de texto pela Cloud API
router.post("/whatsapp/send", async (req, res) => {
  try {
    const { to, message } = req.body || {};

    if (!to || !message) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Informe 'to' e 'message'."
      });
    }

    const data = await enviarMensagemWhatsApp(to, message);

    return res.json({
      sucesso: true,
      resposta: data
    });
  } catch (erro) {
    console.error("Erro /whatsapp/send:", erro);

    return res.status(500).json({
      sucesso: false,
      mensagem: erro.message || "Erro interno ao enviar WhatsApp."
    });
  }
});

module.exports = router;
