const router = require("express").Router();
const { executarComandoMatrix } = require("../services/matrix-command");
const { transcreverAudio } = require("../services/matrix-audio");

function actorKey(req) {
  const raw = String(req.body?.session_id || req.get("x-matrix-session") || "web-anonymous")
    .replace(/[^a-zA-Z0-9:_-]/g, "")
    .slice(0, 120);
  return `web:${raw || "anonymous"}`;
}

function contextFor(req, source) {
  return {
    source,
    actorKey: actorKey(req),
    actorRole: "web_public",
    page: String(req.body?.page || req.get("referer") || "").slice(0, 500),
    permissions: {
      canReadStock: true,
      canReadSales: false,
      canReadFinance: false,
      canWriteStock: false
    }
  };
}

router.get("/matrix/command/health", (req, res) => {
  res.json({
    sucesso: true,
    modulo: "Matrix Command Center",
    web_permissions: ["stock_read"],
    voice_input: true,
    whatsapp_admin_actions: true
  });
});

router.post("/matrix/command", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ sucesso: false, mensagem: "Informe o comando em 'text'." });
    if (text.length > 1000) return res.status(400).json({ sucesso: false, mensagem: "Comando muito longo." });

    const source = req.body?.source === "web_voice" ? "web_voice" : "web_text";
    const result = await executarComandoMatrix({ text, context: contextFor(req, source) });
    return res.json({ sucesso: result.ok !== false, ...result });
  } catch (error) {
    console.error("Erro /matrix/command:", error);
    return res.status(500).json({ sucesso: false, status: "error", mensagem: error.message, answer: "Não consegui executar esse comando agora." });
  }
});

router.post("/matrix/command/audio", async (req, res) => {
  try {
    const base64 = String(req.body?.audio_base64 || "").trim();
    const mimeType = String(req.body?.mime_type || "audio/webm").slice(0, 100);
    if (!base64) return res.status(400).json({ sucesso: false, mensagem: "Áudio ausente." });
    if (base64.length > 1500000) return res.status(413).json({ sucesso: false, mensagem: "Áudio muito grande. Grave um comando mais curto." });

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > 1100000) return res.status(413).json({ sucesso: false, mensagem: "Áudio inválido ou muito grande." });

    const transcript = await transcreverAudio({ buffer, mimeType });
    const result = await executarComandoMatrix({
      text: transcript,
      context: contextFor(req, "web_voice")
    });
    return res.json({ sucesso: result.ok !== false, transcript, ...result });
  } catch (error) {
    console.error("Erro /matrix/command/audio:", error);
    return res.status(500).json({ sucesso: false, status: "error", mensagem: error.message, answer: "Não consegui entender ou executar esse áudio agora." });
  }
});

module.exports = router;
