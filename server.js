const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.MERCADOLIVRE_CLIENT_ID;
const CLIENT_SECRET = process.env.MERCADOLIVRE_CLIENT_SECRET;
const REDIRECT_URI = process.env.MERCADOLIVRE_REDIRECT_URI;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Temporário.
// Depois vamos mover isso para Redis/banco.
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
  console.log("Notificação recebida do Mercado Livre");

  res.sendStatus(200);
});

// Inicia autorização do Mercado Livre
app.get("/auth/mercadolivre", (req, res) => {
  if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !REDIRECT_URI ||
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "Variáveis obrigatórias não configuradas."
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
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  const authorizationUrl =
    `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

  res.redirect(authorizationUrl);
});

// Callback OAuth do Mercado Livre
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
      code,
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
      console.error("Erro OAuth Mercado Livre:", tokenData);

      return res.status(tokenResponse.status).json({
        sucesso: false,
        mensagem: "Mercado Livre recusou a troca do código pelo token."
      });
    }

    const expiresAt = new Date(
      Date.now() + Number(tokenData.expires_in) * 1000
    ).toISOString();

    const marketplaceAccount = {
      marketplace: "mercadolivre",
      account_id: String(tokenData.user_id),
      user_id: String(tokenData.user_id),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt
    };

    const { data: existing, error: searchError } =
      await supabase
        .from("marketplace_accounts")
        .select("id")
        .eq("marketplace", "mercadolivre")
        .eq("account_id", String(tokenData.user_id))
        .maybeSingle();

    if (searchError) {
      console.error("Erro consultando Supabase:", searchError);

      return res.status(500).json({
        sucesso: false,
        mensagem: "Erro ao consultar o banco de dados."
      });
    }

    if (existing) {
      const { error: updateError } =
        await supabase
          .from("marketplace_accounts")
          .update({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: expiresAt,
            user_id: String(tokenData.user_id)
          })
          .eq("id", existing.id);

      if (updateError) {
        console.error("Erro atualizando tokens:", updateError);

        return res.status(500).json({
          sucesso: false,
          mensagem: "Erro ao atualizar a conexão no banco."
        });
      }

    } else {
      const { error: insertError } =
        await supabase
          .from("marketplace_accounts")
          .insert(marketplaceAccount);

      if (insertError) {
        console.error("Erro salvando tokens:", insertError);

        return res.status(500).json({
          sucesso: false,
          mensagem: "Erro ao salvar a conexão no banco."
        });
      }
    }

    console.log(
      `Mercado Livre conectado e salvo. User ID: ${tokenData.user_id}`
    );

    res.json({
      sucesso: true,
      mensagem:
        "Mercado Livre conectado e salvo na Matrix AI Commerce 🚀",
      user_id: tokenData.user_id,
      expires_at: expiresAt
    });

  } catch (erro) {
    console.error("Erro interno OAuth:", erro);

    res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno durante autenticação do Mercado Livre."
    });
  }
});

// Consulta dados da conta conectada do Mercado Livre
app.get("/mercadolivre/me", async (req, res) => {
  try {
    const { data: account, error } = await supabase
      .from("marketplace_accounts")
      .select("access_token, user_id")
      .eq("marketplace", "mercadolivre")
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Erro buscando conta no Supabase:", error);

      return res.status(500).json({
        sucesso: false,
        mensagem: "Erro ao buscar conta do Mercado Livre no banco."
      });
    }

    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Nenhuma conta do Mercado Livre conectada."
      });
    }

    const mlResponse = await fetch(
      `https://api.mercadolibre.com/users/${account.user_id}`,
      {
        headers: {
          Authorization: `Bearer ${account.access_token}`
        }
      }
    );

    const mlData = await mlResponse.json();

    if (!mlResponse.ok) {
      console.error("Erro API Mercado Livre:", mlData);

      return res.status(mlResponse.status).json({
        sucesso: false,
        mensagem: "Mercado Livre recusou a consulta.",
        detalhe: mlData
      });
    }

    res.json({
      sucesso: true,
      vendedor: {
        id: mlData.id,
        nickname: mlData.nickname,
        registration_date: mlData.registration_date,
        country_id: mlData.country_id,
        site_id: mlData.site_id,
        seller_reputation: mlData.seller_reputation
      }
    });

  } catch (erro) {
    console.error("Erro /mercadolivre/me:", erro);

    res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno ao consultar Mercado Livre."
    });
  }
});

// Consulta pedidos/vendas recentes do Mercado Livre
app.get("/mercadolivre/orders", async (req, res) => {
  try {
    const limiteSolicitado = Number(req.query.limit || 20);
    const limit = Math.min(
      Math.max(limiteSolicitado, 1),
      50
    );

    const { data: account, error } = await supabase
      .from("marketplace_accounts")
      .select("access_token, user_id")
      .eq("marketplace", "mercadolivre")
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Erro buscando conta no Supabase:", error);

      return res.status(500).json({
        sucesso: false,
        mensagem: "Erro ao buscar conta do Mercado Livre no banco."
      });
    }

    if (!account) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Nenhuma conta do Mercado Livre conectada."
      });
    }

    const params = new URLSearchParams({
      seller: String(account.user_id),
      sort: "date_desc",
      limit: String(limit)
    });

    const mlResponse = await fetch(
      `https://api.mercadolibre.com/orders/search?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          accept: "application/json"
        }
      }
    );

    const mlData = await mlResponse.json();

    if (!mlResponse.ok) {
      console.error("Erro buscando pedidos no Mercado Livre:", mlData);

      return res.status(mlResponse.status).json({
        sucesso: false,
        mensagem: "Mercado Livre recusou a consulta de pedidos.",
        detalhe: mlData
      });
    }

    const pedidos = Array.isArray(mlData.results)
      ? mlData.results.map((pedido) => ({
          id: pedido.id,
          status: pedido.status,
          date_created: pedido.date_created,
          date_closed: pedido.date_closed,
          total_amount: pedido.total_amount,
          currency_id: pedido.currency_id,

          comprador: pedido.buyer
            ? {
                id: pedido.buyer.id,
                nickname: pedido.buyer.nickname
              }
            : null,

          itens: Array.isArray(pedido.order_items)
            ? pedido.order_items.map((item) => ({
                item_id: item.item?.id,
                titulo: item.item?.title,
                quantidade: item.quantity,
                preco_unitario: item.unit_price,
                moeda: item.currency_id
              }))
            : [],

          shipping_id: pedido.shipping?.id || null,
          pack_id: pedido.pack_id || null
        }))
      : [];

    res.json({
      sucesso: true,
      vendedor_id: account.user_id,
      quantidade: pedidos.length,
      paging: mlData.paging || null,
      pedidos
    });

  } catch (erro) {
    console.error("Erro /mercadolivre/orders:", erro);

    res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno ao consultar pedidos do Mercado Livre."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Commerce rodando na porta ${PORT}`);
});
