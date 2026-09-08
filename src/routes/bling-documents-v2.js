const router = require("express").Router();
const { blingFetch } = require("../services/bling");

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function readError(response) {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const json = JSON.parse(text);
    return (
      json?.error?.message ||
      json?.message ||
      json?.mensagem ||
      text
    );
  } catch {
    return text;
  }
}

router.get("/bling/nfe/document/:key/:format", async (req, res) => {
  try {
    const key = digitsOnly(req.params.key);
    const format = String(req.params.format || "").toLowerCase();

    if (key.length !== 44) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Chave de acesso da NF-e inválida."
      });
    }

    if (!["pdf", "xml"].includes(format)) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Formato deve ser pdf ou xml."
      });
    }

    const upstream = await blingFetch(
      `/nfe/documento/${encodeURIComponent(key)}?formato=${encodeURIComponent(format)}`,
      { method: "GET" }
    );

    if (!upstream.ok) {
      const detail = await readError(upstream);
      return res.status(upstream.status).json({
        sucesso: false,
        mensagem: `Bling recusou o download da NF-e: ${detail}`
      });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    const contentType =
      upstream.headers.get("content-type") ||
      (format === "pdf" ? "application/pdf" : "application/xml; charset=utf-8");

    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="NFe-${key}.${format}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store"
    });

    res.send(bytes);
  } catch (error) {
    res.status(error.httpStatus || 500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

module.exports = router;
