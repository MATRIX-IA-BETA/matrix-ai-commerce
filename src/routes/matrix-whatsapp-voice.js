const router = require("express").Router();
const { env } = require("../config/env");
const {
  ehComandoMatrix,
  ehConfirmacao,
  ehCancelamento,
  buscarPendente,
  executarComandoMatrix,
  normalizarTexto
} = require("../services/matrix-command");
const { transcreverAudio, gerarAudioResposta } = require("../services/matrix-audio");

const WHATSAPP_ACCESS_TOKEN = env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = env.WHATSAPP_API_VERSION || process.env.WHATSAPP_API_VERSION || "v26.0";
const MATRIX_ADMIN_WHATSAPPS = process.env.MATRIX_ADMIN_WHATSAPPS || process.env.MATRIX_ADMIN_WHATSAPP || "";
const MATRIX_FAMILY_WHATSAPPS = process.env.MATRIX_FAMILY_WHATSAPPS || "";

function limparNumero(value) {
  return String(value || "").replace(/\D/g, "");
}

function listaNumeros(value) {
  return String(value || "").split(",").map(limparNumero).filter(Boolean);
}

function roleFor(phone) {
  const number = limparNumero(phone);
  if (listaNumeros(MATRIX_ADMIN_WHATSAPPS).includes(number)) return "admin";
  if (listaNumeros(MATRIX_FAMILY_WHATSAPPS).includes(number)) return "family";
  return "customer";
}

function permissionsFor(role) {
  if (role === "admin") {
    return { canReadStock: true, canReadSales: true, canReadFinance: true, canWriteStock: true };
  }
  if (role === "family") {
    return { canReadStock: true, canReadSales: true, canReadFinance: false, canWriteStock: false };
  }
  return { canReadStock: false, canReadSales: false, canReadFinance: false, canWriteStock: false };
}

async function obterMidiaWhatsApp(mediaId) {
  const metadataResponse = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}?phone_number_id=${encodeURIComponent(WHATSAPP_PHONE_NUMBER_ID || "")}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || !metadata?.url) {
    throw new Error(metadata?.error?.message || "Não consegui localizar o áudio do WhatsApp.");
  }

  const mediaResponse = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
  });
  if (!mediaResponse.ok) throw new Error("Não consegui baixar o áudio do WhatsApp.");
  return {
    buffer: Buffer.from(await mediaResponse.arrayBuffer()),
    mimeType: metadata.mime_type || mediaResponse.headers.get("content-type") || "audio/ogg"
  };
}

async function enviarPayloadWhatsApp(to, payload) {
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
        to: limparNumero(to),
        ...payload
      })
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "WhatsApp recusou o envio.");
  return data;
}

async function enviarTextoWhatsApp(to, text) {
  return enviarPayloadWhatsApp(to, {
    type: "text",
    text: { preview_url: false, body: String(text) }
  });
}

async function uploadAudioWhatsApp(audio) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([audio.buffer], { type: audio.mimeType || "audio/ogg" }), audio.filename || "matrix-resposta.ogg");

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
      body: form
    }
  );
  const data = await response.json();
  if (!response.ok || !data?.id) throw new Error(data?.error?.message || "WhatsApp recusou o upload do áudio.");
  return data.id;
}

async function enviarAudioWhatsApp(to, text) {
  const audio = await gerarAudioResposta(text);
  const mediaId = await uploadAudioWhatsApp(audio);
  return enviarPayloadWhatsApp(to, {
    type: "audio",
    audio: { id: mediaId, voice: true }
  });
}

function querAudio(text, originalType) {
  if (originalType === "audio") return true;
  const t = normalizarTexto(text);
  return /\b(responde|responda|responder)\b.*\b(audio|voz)\b/.test(t) || /\b(audio|voz)\b.*\b(responde|responda)\b/.test(t);
}

async function responder(to, answer, asAudio) {
  if (!asAudio) return enviarTextoWhatsApp(to, answer);
  try {
    return await enviarAudioWhatsApp(to, answer);
  } catch (error) {
    console.error("Falha no áudio Matrix; usando texto:", error.message);
    return enviarTextoWhatsApp(to, `${answer}\n\n(Áudio indisponível neste envio; respondi em texto.)`);
  }
}

function firstMessage(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value?.messages || []) {
        return { message, value };
      }
    }
  }
  return null;
}

router.post("/webhooks/whatsapp", async (req, res, next) => {
  const found = firstMessage(req.body);
  if (!found?.message?.from) return next();

  const { message } = found;
  const role = roleFor(message.from);
  if (role !== "admin" && role !== "family") return next();

  let text = "";
  const originalType = message.type;

  try {
    if (message.type === "text") {
      text = String(message?.text?.body || "").trim();
    } else if (message.type === "audio") {
      const mediaId = message?.audio?.id;
      if (!mediaId) return next();
      const media = await obterMidiaWhatsApp(mediaId);
      text = await transcreverAudio(media);
    } else {
      return next();
    }

    const actorKey = `whatsapp:${limparNumero(message.from)}`;
    const pending = await buscarPendente(actorKey);
    const isConfirmation = Boolean(pending && (ehConfirmacao(text) || ehCancelamento(text)));
    if (!ehComandoMatrix(text) && !isConfirmation) return next();

    const result = await executarComandoMatrix({
      text,
      context: {
        source: "whatsapp",
        actorKey,
        actorRole: role,
        page: "whatsapp",
        permissions: permissionsFor(role)
      }
    });

    res.sendStatus(200);
    await responder(message.from, result.answer || "Comando processado.", querAudio(text, originalType));

    console.log("Comando Matrix via WhatsApp processado:", {
      from: limparNumero(message.from),
      role,
      original_type: originalType,
      transcript: originalType === "audio" ? text : undefined,
      status: result.status,
      command_type: result.command_type || null,
      response_audio: querAudio(text, originalType)
    });
  } catch (error) {
    console.error("Erro no comando Matrix via WhatsApp:", error);
    if (!res.headersSent) res.sendStatus(200);
    try {
      await enviarTextoWhatsApp(message.from, `Não consegui executar esse comando agora: ${error.message}`);
    } catch {}
  }
});

module.exports = router;
