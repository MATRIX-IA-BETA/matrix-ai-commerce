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

// Todas as chamadas para a API do Bling passam por uma fila única, com
// espaçamento mínimo entre requisições e retry automático quando houver 429.
// Isso evita que sync de histórico, consulta de contato/produto e emissão de
// NF-e estourem juntos o limite por segundo da API.
installBlingRateLimitGuard();

const app = express();

app.use(express.json({ limit: "2mb" }));

// Instala primeiro a guarda de vencimento. A camada de campos obrigatórios
// cria a parcela e, ao encaminhar o payload, a guarda garante que a data nunca
// fique anterior à data fiscal corrente (evita rejeição SEFAZ 900).
installBlingNfeParcelDateGuard();

// Completa cabeçalho fiscal/pagamento usando uma NF-e autorizada da própria
// conta como referência. Depois carregamos o vínculo do produto fiscal.
installBlingNfeRequiredFields();
const { installBlingFiscalProductLink } = require("./src/services/bling-fiscal-product-link");
installBlingFiscalProductLink();

// PUT /nfe/{id} substitui o recurso e exige os identificadores da nota.
// Antes da atualização, consulta a NF-e existente e preserva número/série.
installBlingNfePutPreserve();

// =========================================================
// INTERFACES WEB
// =========================================================

const PUBLIC_DIR = path.join(__dirname, "src", "public");
const MATRIX_NAV_ASSETS = `\n<link rel="stylesheet" href="/matrix-global-nav.css?v=4">\n<script defer src="/matrix-global-nav.js?v=4"></script>\n`;

function sendMatrixPage(fileName) {
  return (req, res, next) => {
    const filePath = path.join(PUBLIC_DIR, fileName);

    fs.readFile(filePath, "utf8", (error, source) => {
      if (error) return next(error);

      let html = source;

      if (!html.includes("matrix-global-nav.css")) {
        html = html.replace("</head>", `${MATRIX_NAV_ASSETS}</head>`);
      }

      if (
        fileName === "fiscal-nfe.html" &&
        !html.includes("fiscal-marketplace-links.js")
      ) {
        html = html.replace(
          "</head>",
          `\n<script defer src="/fiscal-marketplace-links.js?v=1"></script>\n</head>`
        );
      }

      if (
        fileName === "sac-ml.html" &&
        !html.includes("sac-ml-ai-review.js")
      ) {
        html = html.replace(
          "</head>",
          `\n<script defer src="/sac-ml-ai-review.js?v=2"></script>\n</head>`
        );
      }

      res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0"
      });

      res.type("html").send(html);
    });
  };
}

// Home / hub principal Matrix AI.
app.get("/", sendMatrixPage("index.html"));
app.get("/index.html", sendMatrixPage("index.html"));

// Central Fiscal.
app.get("/fiscal-nfe.html", sendMatrixPage("fiscal-nfe.html"));

// Central SAC WhatsApp.
app.get("/sac/central", sendMatrixPage("sac-central.html"));
app.get("/sac/mobile", sendMatrixPage("sac-central.html"));
app.get("/sac/mobile.html", sendMatrixPage("sac-central.html"));
app.get("/sac-central.html", sendMatrixPage("sac-central.html"));

// SAC Mercado Livre - mensagens pós-compra.
app.get("/sac/ml", sendMatrixPage("sac-ml.html"));
app.get("/sac-ml.html", sendMatrixPage("sac-ml.html"));

// Central dedicada às reclamações/claims do Mercado Livre.
app.get("/sac/reclamacoes", sendMatrixPage("reclamacoes-ml.html"));
app.get("/reclamacoes-ml.html", sendMatrixPage("reclamacoes-ml.html"));

// Perguntas pré-venda dos anúncios Mercado Livre.
app.get("/sac/perguntas", sendMatrixPage("mercadolivre-perguntas.html"));
app.get("/sac/perguntas-ml", sendMatrixPage("mercadolivre-perguntas.html"));
app.get("/mercadolivre-perguntas.html", sendMatrixPage("mercadolivre-perguntas.html"));

// Painel executivo Mercado Livre.
app.get("/mercadolivre", sendMatrixPage("mercadolivre-painel.html"));
app.get("/painel/mercadolivre", sendMatrixPage("mercadolivre-painel.html"));
app.get("/mercadolivre-painel.html", sendMatrixPage("mercadolivre-painel.html"));

// Arquivos estáticos auxiliares (CSS/JS/etc.). O index fica desativado aqui
// porque a rota / acima injeta a navegação global antes de entregar a home.
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
app.use(require("./src/routes/stock"));
app.use(require("./src/routes/customers"));

// V3: prioriza CPF/CNPJ do billing-info do Mercado Livre para localizar
// NF-es que já foram emitidas manualmente no Bling.
app.use(require("./src/routes/fiscal-cpf-sync-v3"));

// Mantida como fallback para compatibilidade com as rotas fiscais anteriores.
app.use(require("./src/routes/fiscal-queue-v2"));
app.use(require("./src/routes/fiscal"));

// Corrige o download DANFE/XML usando a rota oficial atual do Bling.
app.use(require("./src/routes/bling-documents-v2"));

// Antes de tentar atualizar/emitir, consulta o ID conhecido no Bling.
// Se a NF-e já estiver autorizada, apenas sincroniza a Matrix e encerra.
app.use(require("./src/routes/bling-emit-guard"));

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
