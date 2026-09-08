const express = require("express");
const path = require("path");

const { env } = require("./src/config/env");
const { installBlingRateLimitGuard } = require("./src/services/bling-rate-limit");
const { supabase } = require("./src/db/supabase");
const { createAnalyticsRouter } = require("./src/routes/analytics");
const { installBlingNfeParcelDateGuard } = require("./src/services/bling-nfe-parcel-date-guard");
const { installBlingNfeRequiredFields } = require("./src/services/bling-nfe-required-fields");

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
