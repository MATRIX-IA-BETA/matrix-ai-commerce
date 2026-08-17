const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Página inicial
app.get("/", (req, res) => {
  res.json({
    status: "online",
    sistema: "Matrix AI Commerce",
    mensagem: "Backend funcionando 🚀"
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
});

// Webhook do Mercado Livre
app.post("/webhooks/mercadolivre", (req, res) => {
  console.log("Notificação Mercado Livre:");
  console.log(req.body);

  // Responde imediatamente ao Mercado Livre
  res.sendStatus(200);
});

// Callback de autorização do Mercado Livre
app.get("/auth/mercadolivre/callback", (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({
      sucesso: false,
      erro: error
    });
  }

  if (!code) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "Código de autorização não recebido."
    });
  }

  res.json({
    sucesso: true,
    mensagem: "Mercado Livre retornou o código de autorização.",
    codeRecebido: true,
    stateRecebido: Boolean(state)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Commerce rodando na porta ${PORT}`);
});
