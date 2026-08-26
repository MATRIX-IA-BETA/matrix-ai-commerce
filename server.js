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
app.use(express.static(path.join(__dirname, "public")));

// =========================================================
// ROTAS EXISTENTES
// =========================================================
app.use(require("./src/routes/basic"));
app.use(require("./src/routes/webhooks-mercadolivre"));
app.use(require("./src/routes/mercadolivre"));
app.use(require("./src/routes/sac"));
app.use(require("./src/routes/stock"));
app.use(require("./src/routes/customers"));
app.use(require("./src/routes/fiscal"));
app.use(require("./src/routes/bling"));
app.use(require("./src/routes/whatsapp"));

// =========================================================
// MATRIX AI ANALYTICS
// =========================================================
app.use("/api/analytics", createAnalyticsRouter({ supabase }));

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
