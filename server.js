const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.MERCADOLIVRE_CLIENT_ID;
const CLIENT_SECRET = process.env.MERCADOLIVRE_CLIENT_SECRET;
const REDIRECT_URI = process.env.MERCADOLIVRE_REDIRECT_URI;

// Armazena temporariamente state + PKCE.
// Depois vamos substituir por banco de dados/Redis para produção.
const oauthSessions = new Map();

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

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

// Inicia autorização REAL do Mercado Livre
app.get("/auth/mercadolivre", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "Variáveis do Mercado Livre não configuradas."
    });
  }

  const state = crypto.randomBytes(32).toString("hex");

  const codeVerifier = base64url(
    crypto.randomBytes(64)
  );

  const codeChallenge = base64url(
    crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest()
  );

  oauthSessions.set(state, {
    codeVerifier,
    criadoEm: Date.now()
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  const authorizationUrl =
    `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

  res.redirect(authorizationUrl);
});

// Callback do Mercado Livre
app.get("/auth/mercadolivre/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({
      sucesso: false,
      erro: error
    });
  }

  if (!code || !state) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "Code ou state não recebido."
    });
  }

  const session = oauthSessions.get(state);

  if (!session) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "State inválido ou sessão OAuth expirada."
    });
  }

  oauthSessions.delete(state);

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      code_verifier: session.codeVerifier
    });

    const tokenResponse = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("Erro ao obter token:", tokenData);

      return res.status(tokenResponse.status).json({
        sucesso: false,
        mensagem: "Mercado Livre recusou a troca do código pelo token.",
        detalhe: tokenData
      });
    }

    // NÃO exibimos access_token nem refresh_token no navegador/log.
    console.log(
      `Mercado Livre conectado. User ID: ${tokenData.user_id}`
    );

    res.json({
      sucesso: true,
      mensagem: "Mercado Livre conectado à Matrix AI Commerce 🚀",
      user_id: tokenData.user_id,
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
      scope: tokenData.scope
    });

  } catch (erro) {
    console.error("Erro OAuth Mercado Livre:", erro);

    res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno durante autenticação do Mercado Livre."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Commerce rodando na porta ${PORT}`);
});
