const { env } = require("../config/env");

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || "marin";

function extensaoAudioPorMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("amr")) return "amr";
  return "webm";
}

async function transcreverAudio({ buffer, mimeType = "audio/webm" }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");
  if (!buffer?.length) throw new Error("Áudio vazio.");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `matrix-audio.${extensaoAudioPorMime(mimeType)}`);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("language", "pt");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Falha na transcrição (${response.status}).`);
  }
  const text = String(data?.text || data?.transcript || "").trim();
  if (!text) throw new Error("A transcrição veio vazia.");
  return text;
}

async function gerarAudioResposta(text) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");
  const input = String(text || "").trim().slice(0, 4096);
  if (!input) throw new Error("Resposta vazia para síntese de voz.");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input,
      voice: TTS_VOICE,
      response_format: "opus",
      instructions: "Fale em português do Brasil, com voz natural, objetiva e cordial. Para números e valores, articule com clareza."
    })
  });

  if (!response.ok) {
    let message = `Falha gerando áudio (${response.status}).`;
    try {
      const data = await response.json();
      message = data?.error?.message || message;
    } catch {}
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: "audio/ogg",
    filename: "matrix-resposta.ogg"
  };
}

module.exports = {
  transcreverAudio,
  gerarAudioResposta,
  TTS_MODEL,
  TTS_VOICE,
  TRANSCRIBE_MODEL
};
