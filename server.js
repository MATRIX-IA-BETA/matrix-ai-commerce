const express = require("express");
const path = require("path");

const { env } = require("./src/config/env");
const { supabase } = require("./src/db/supabase");
const { createAnalyticsRouter } = require("./src/routes/analytics");

const app = express();

app.use(express.json({ limit: "2mb" }));

// =========================================================
// INTERFACES WEB
// =========================================================

const PUBLIC_DIR = path.join(__dirname, "src", "public");

app.use(express.static(PUBLIC_DIR));

function sendPublicFile(fileName) {
  return (req, res) => {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0"
    });
    res.sendFile(path.join(PUBLIC_DIR, fileName));
  };
}

// Central SAC WhatsApp
app.get("/sac/central", sendPublicFile("sac-central.html"));
app.get("/sac/mobile", sendPublicFile("sac-central.html"));
app.get("/sac/mobile.html", sendPublicFile("sac-central.html"));

// SAC - Perguntas Mercado Livre
app.get("/sac/perguntas", sendPublicFile("mercadolivre-perguntas.html"));
app.get("/sac/perguntas-ml", sendPublicFile("mercadolivre-perguntas.html"));

// Painel executivo Mercado Livre
app.get("/mercadolivre", sendPublicFile("mercadolivre-painel.html"));
app.get("/painel/mercadolivre", sendPublicFile("mercadolivre-painel.html"));

// =========================================================
// ROTAS EXISTENTES
// =========================================================

app.use(require("./src/routes/basic"));
app.use(require("./src/routes/webhooks-mercadolivre"));
app.use(require("./src/routes/mercadolivre"));
app.use(require("./src/routes/sac"));
app.use(require("./src/routes/ml-questions-sac"));
app.use(require("./src/routes/stock"));
app.use(require("./src/routes/customers"));
app.use(require("./src/routes/fiscal"));
app.use(require("./src/routes/bling"));
app.use(require("./src/routes/whatsapp"));

// =========================================================
// MATRIX AI ANALYTICS
// =========================================================

app.use(
  "/api/analytics",
  createAnalyticsRouter({ supabase })
);

// =========================================================
// ROTA 404
// =========================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Rota não encontrada.",
    path: req.path
  });
});

// =========================================================
// ERRO GLOBAL
// =========================================================

app.use((error, req, res, next) => {
  console.error("Erro não tratado:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: error?.message || "Erro interno."
  });
});

// =========================================================
// SERVIDOR
// =========================================================

const PORT = env.PORT || process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Commerce V2 modular rodando na porta ${PORT}`);
});
