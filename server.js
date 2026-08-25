const express = require("express");
const { env } = require("./src/config/env");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(require("./src/routes/basic"));
app.use(require("./src/routes/webhooks-mercadolivre"));
app.use(require("./src/routes/mercadolivre"));
app.use(require("./src/routes/sac"));
app.use(require("./src/routes/stock"));
app.use(require("./src/routes/customers"));
app.use(require("./src/routes/fiscal"));
app.use(require("./src/routes/bling"));
app.use(require("./src/routes/whatsapp"));
app.use(require("./src/routes/analytics"));
app.use((req, res) => {
  res.status(404).json({
    sucesso: false,
    mensagem: "Rota não encontrada.",
    path: req.path
  });
});

app.use((erro, req, res, next) => {
  console.error("Erro não tratado:", erro);
  if (res.headersSent) return next(erro);

  res.status(500).json({
    sucesso: false,
    mensagem: erro?.message || "Erro interno."
  });
});

const PORT = env.PORT || process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Commerce V2 modular rodando na porta ${PORT}`);
});
