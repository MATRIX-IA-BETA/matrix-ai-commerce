const express = require("express");
const path = require("path");
const fs = require("fs");

const { env } = require("./src/config/env");
const { installBlingRateLimitGuard } = require("./src/services/bling-rate-limit");
const { supabase } = require("./src/db/supabase");
const { createAnalyticsRouter } = require("./src/routes/analytics");
const { installBlingNfeParcelDateGuard } = require("./src/services/bling-nfe-parcel-date-guard");
const { installBlingNfeRequiredFields } = require("./src/services/bling-nfe-required-fields");
const { installBlingNfePutPreserve } = require("./src/services/bling-nfe-put-preserve");

installBlingRateLimitGuard();
const app = express();
app.use(express.json({ limit: "2mb" }));
installBlingNfeParcelDateGuard();
installBlingNfeRequiredFields();
const { installBlingFiscalProductLink } = require("./src/services/bling-fiscal-product-link");
installBlingFiscalProductLink();
installBlingNfePutPreserve();

// =========================================================
// INTERFACES WEB
// =========================================================
const PUBLIC_DIR = path.join(__dirname, "src", "public");
const MATRIX_NAV_ASSETS = `\n<link rel="stylesheet" href="/matrix-global-nav.css?v=4">\n<script defer src="/matrix-global-nav.js?v=8"></script>\n`;
function sendMatrixPage(fileName) {
  return (req, res, next) => {
    const filePath = path.join(PUBLIC_DIR, fileName);
    fs.readFile(filePath, "utf8", (error, source) => {
      if (error) return next(error);
      let html = source;
      if (!html.includes("matrix-global-nav.css")) html = html.replace("</head>", `${MATRIX_NAV_ASSETS}</head>`);
      if (fileName === "fiscal-nfe.html" && !html.includes("fiscal-marketplace-links.js")) html = html.replace("</head>", `\n<script defer src="/fiscal-marketplace-links.js?v=1"></script>\n</head>`);
      if (fileName === "sac-ml.html" && !html.includes("sac-ml-ai-review.js")) html = html.replace("</head>", `\n<script defer src="/sac-ml-ai-review.js?v=2"></script>\n</head>`);
      if (fileName === "finance.html" && !html.includes("finance-pluggy.js")) html = html.replace("</head>", `\n<script defer src="/finance-pluggy.js?v=1"></script>\n</head>`);
      if (fileName === "stock.html" && !html.includes("stock-bom-substitutions.js")) html = html.replace("</head>", `\n<script defer src="/stock-bom-substitutions.js?v=1"></script>\n</head>`);
      res.set({ "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate", Pragma: "no-cache", Expires: "0" });
      res.type("html").send(html);
    });
  };
}

app.get("/", sendMatrixPage("index.html"));
app.get("/index.html", sendMatrixPage("index.html"));
app.get("/fiscal-nfe.html", sendMatrixPage("fiscal-nfe.html"));
app.get("/sac/central", sendMatrixPage("sac-central.html"));
app.get("/sac/mobile", sendMatrixPage("sac-central.html"));
app.get("/sac/mobile.html", sendMatrixPage("sac-central.html"));
app.get("/sac-central.html", sendMatrixPage("sac-central.html"));
app.get("/sac/ml", sendMatrixPage("sac-ml.html"));
app.get("/sac-ml.html", sendMatrixPage("sac-ml.html"));
app.get("/sac/reclamacoes", sendMatrixPage("reclamacoes-ml.html"));
app.get("/reclamacoes-ml.html", sendMatrixPage("reclamacoes-ml.html"));
app.get("/sac/perguntas", sendMatrixPage("mercadolivre-perguntas.html"));
app.get("/sac/perguntas-ml", sendMatrixPage("mercadolivre-perguntas.html"));
app.get("/mercadolivre-perguntas.html", sendMatrixPage("mercadolivre-perguntas.html"));
app.get("/finance", sendMatrixPage("finance.html"));
app.get("/finance.html", sendMatrixPage("finance.html"));
app.get("/stock", sendMatrixPage("stock.html"));
app.get("/stock.html", sendMatrixPage("stock.html"));
app.get("/erp", sendMatrixPage("erp.html"));
app.get("/erp.html", sendMatrixPage("erp.html"));
app.get("/ml/xml", sendMatrixPage("xml-ml.html"));
app.get("/xml-ml.html", sendMatrixPage("xml-ml.html"));
app.get("/mercadolivre", sendMatrixPage("mercadolivre-painel.html"));
app.get("/painel/mercadolivre", sendMatrixPage("mercadolivre-painel.html"));
app.get("/mercadolivre-painel.html", sendMatrixPage("mercadolivre-painel.html"));
app.use(express.static(PUBLIC_DIR, { index: false }));

// =========================================================
// ROTAS EXISTENTES
// =========================================================
app.use(require("./src/routes/basic"));
app.use(require("./src/routes/webhooks-mercadolivre"));
app.use(require("./src/routes/mercadolivre"));
app.use(require("./src/routes/sac"));
app.use(require("./src/routes/ml-sac-history-links"));
app.use(require("./src/routes/ml-sac-live-filter-v2"));
app.use(require("./src/routes/ml-sac-live"));
app.use(require("./src/routes/ml-sac-ai-review"));
app.use(require("./src/routes/ml-questions-sac"));
app.use(require("./src/routes/ml-claims-center"));
app.use(require("./src/routes/ml-xml-upload"));
app.use(require("./src/routes/finance"));
app.use(require("./src/routes/finance-open-finance"));
app.use(require("./src/routes/stock-dashboard"));
app.use(require("./src/routes/stock"));
app.use(require("./src/routes/erp"));
app.use(require("./src/routes/customers"));
app.use(require("./src/routes/fiscal-cpf-sync-v3"));
app.use(require("./src/routes/fiscal-queue-v2"));
app.use(require("./src/routes/fiscal"));
app.use(require("./src/routes/bling-documents-v2"));
app.use(require("./src/routes/bling-emit-guard"));
app.use(require("./src/routes/bling"));
app.use(require("./src/routes/whatsapp"));

app.use("/api/analytics", createAnalyticsRouter({ supabase }));
app.use((req, res) => res.status(404).json({ success: false, message: "Rota não encontrada.", path: req.path }));
app.use((error, req, res, next) => {
  console.error("Erro não tratado:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ success: false, message: error?.message || "Erro interno." });
});

const PORT = env.PORT || process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Matrix AI Commerce V2 modular rodando na porta ${PORT}`));
