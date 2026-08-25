const router = require("express").Router();
const { env } = require("../config/env");

const WHATSAPP_VERIFY_TOKEN = env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_ACCESS_TOKEN = env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = env.WHATSAPP_API_VERSION;

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
        }
      }
    }
  } catch (erro) {
    console.error("Erro processando webhook do WhatsApp:", erro);
  }
});

// Envio de mensagem de texto pela Cloud API
router.post("/whatsapp/send", async (req, res) => {
  try {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
      return res.status(500).json({
        sucesso: false,
        mensagem:
          "WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurado."
      });
    }

    const { to, message } = req.body || {};

    if (!to || !message) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Informe 'to' e 'message'."
      });
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

      return res.status(response.status).json({
        sucesso: false,
        mensagem: "WhatsApp recusou o envio.",
        detalhe: data
      });
    }

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
