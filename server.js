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

// WhatsApp Business Cloud API
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";

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

// =========================================================
// OAUTH TEMPORÁRIO
// =========================================================

const oauthSessions = new Map();

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// =========================================================
// FUNÇÕES AUXILIARES MERCADO LIVRE
// =========================================================

async function getMercadoLivreAccount(userId = null) {
  let query = supabase
    .from("marketplace_accounts")
    .select(
      "id, marketplace, account_id, user_id, access_token, refresh_token, expires_at"
    )
    .eq("marketplace", "mercadolivre");

  if (userId) {
    query = query.eq("user_id", String(userId));
  }

  const { data, error } = await query
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Erro buscando conta Mercado Livre: ${error.message}`
    );
  }

  return data;
}

async function refreshMercadoLivreToken(account) {
  if (!account) {
    throw new Error("Conta Mercado Livre não encontrada.");
  }

  if (!account.refresh_token) {
    throw new Error("Refresh token não encontrado.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: account.refresh_token
  });

  const response = await fetch(
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

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro renovando token ML:", data);

    throw new Error(
      "Mercado Livre recusou a renovação do token."
    );
  }

  const expiresAt = new Date(
    Date.now() + Number(data.expires_in) * 1000
  ).toISOString();

  const novoRefreshToken =
    data.refresh_token || account.refresh_token;

  const { error } = await supabase
    .from("marketplace_accounts")
    .update({
      access_token: data.access_token,
      refresh_token: novoRefreshToken,
      expires_at: expiresAt
    })
    .eq("id", account.id);

  if (error) {
    throw new Error(
      `Erro salvando token renovado: ${error.message}`
    );
  }

  console.log(
    `Token Mercado Livre renovado para user ${account.user_id}`
  );

  return {
    ...account,
    access_token: data.access_token,
    refresh_token: novoRefreshToken,
    expires_at: expiresAt
  };
}

async function ensureValidMercadoLivreToken(account) {
  if (!account) {
    throw new Error("Conta Mercado Livre não encontrada.");
  }

  if (!account.expires_at) {
    return refreshMercadoLivreToken(account);
  }

  const expiresAt = new Date(account.expires_at).getTime();

  // Renova se faltar menos de 5 minutos
  const limite = Date.now() + 5 * 60 * 1000;

  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= limite
  ) {
    return refreshMercadoLivreToken(account);
  }

  return account;
}

async function mercadoLivreFetch(
  path,
  account,
  options = {}
) {
  let conta = await ensureValidMercadoLivreToken(account);

  const url = path.startsWith("http")
    ? path
    : `https://api.mercadolibre.com${path}`;

  let response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
      Authorization: `Bearer ${conta.access_token}`
    }
  });

  // Se o ML devolver 401, tenta renovar uma vez
  if (response.status === 401) {
    conta = await refreshMercadoLivreToken(conta);

    response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
        Authorization: `Bearer ${conta.access_token}`
      }
    });
  }

  return {
    response,
    account: conta
  };
}

// =========================================================
// SINCRONIZA UM PEDIDO NO SUPABASE
// =========================================================

async function salvarPedidoMercadoLivre(pedido, account) {
  const orderId = String(pedido.id);

  const orderRecord = {
    marketplace: "mercadolivre",
    marketplace_order_id: orderId,

    account_id: String(
      account.account_id || account.user_id
    ),

    status: pedido.status || null,
    status_detail: pedido.status_detail || null,

    buyer_id:
      pedido.buyer?.id != null
        ? String(pedido.buyer.id)
        : null,

    buyer_nickname:
      pedido.buyer?.nickname || null,

    total_amount:
      pedido.total_amount != null
        ? pedido.total_amount
        : null,

    paid_amount:
      pedido.paid_amount != null
        ? pedido.paid_amount
        : null,

    currency_id:
      pedido.currency_id || null,

    shipping_id:
      pedido.shipping?.id != null
        ? String(pedido.shipping.id)
        : null,

    pack_id:
      pedido.pack_id != null
        ? String(pedido.pack_id)
        : null,

    date_created:
      pedido.date_created || null,

    date_closed:
      pedido.date_closed || null,

    date_last_updated:
      pedido.last_updated ||
      pedido.date_last_updated ||
      null,

    raw_data: pedido,

    updated_at: new Date().toISOString()
  };

  const {
    data: savedOrder,
    error: orderError
  } = await supabase
    .from("marketplace_orders")
    .upsert(
      orderRecord,
      {
        onConflict:
          "marketplace,marketplace_order_id"
      }
    )
    .select("id")
    .single();

  if (orderError) {
    throw new Error(
      `Erro salvando pedido ${orderId}: ${orderError.message}`
    );
  }

  const internalOrderId = savedOrder.id;

  const itens = Array.isArray(pedido.order_items)
    ? pedido.order_items
    : [];

  for (let index = 0; index < itens.length; index++) {
    const item = itens[index];

    const itemId =
      item.item?.id != null
        ? String(item.item.id)
        : "sem_item";

    const variationId =
      item.item?.variation_id != null
        ? String(item.item.variation_id)
        : "0";

    const externalLineId =
      `${itemId}:${variationId}:${index}`;

    const itemRecord = {
      order_id: internalOrderId,
      marketplace: "mercadolivre",

      item_id:
        item.item?.id != null
          ? String(item.item.id)
          : null,

      variation_id:
        item.item?.variation_id != null
          ? String(item.item.variation_id)
          : null,

      external_line_id: externalLineId,

      title:
        item.item?.title || null,

      quantity:
        item.quantity != null
          ? item.quantity
          : null,

      unit_price:
        item.unit_price != null
          ? item.unit_price
          : null,

      full_unit_price:
        item.full_unit_price != null
          ? item.full_unit_price
          : null,

      currency_id:
        item.currency_id || null,

      raw_data: item,

      updated_at: new Date().toISOString()
    };

    const { error: itemError } = await supabase
      .from("marketplace_order_items")
      .upsert(
        itemRecord,
        {
          onConflict:
            "order_id,external_line_id"
        }
      );

    if (itemError) {
      throw new Error(
        `Erro salvando item do pedido ${orderId}: ${itemError.message}`
      );
    }
  }

  return {
    marketplace_order_id: orderId,
    database_id: internalOrderId,
    itens: itens.length
  };
}

// =========================================================
// BUSCA E SALVA UM PEDIDO ESPECÍFICO
// =========================================================

async function sincronizarPedidoPorId(
  marketplaceOrderId,
  account = null
) {
  let conta =
    account || await getMercadoLivreAccount();

  if (!conta) {
    throw new Error(
      "Nenhuma conta Mercado Livre conectada."
    );
  }

  const {
    response,
    account: contaAtualizada
  } = await mercadoLivreFetch(
    `/orders/${marketplaceOrderId}`,
    conta
  );

  const pedido = await response.json();

  if (!response.ok) {
    console.error(
      "Erro buscando pedido individual:",
      pedido
    );

    throw new Error(
      `Mercado Livre recusou pedido ${marketplaceOrderId}`
    );
  }

  return salvarPedidoMercadoLivre(
    pedido,
    contaAtualizada
  );
}


// =========================================================
// FUNÇÕES AUXILIARES DE PERÍODO / TAXAS / FRETE
// =========================================================

function normalizeDateStart(value) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00-03:00`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeDateEnd(value) {
  if (!value) return null;

  const date = new Date(`${value}T23:59:59.999-03:00`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function extrairFinanceiroPedido(pedido, itens = [], shipmentCosts = null) {
  const raw = pedido?.raw_data || {};
  const payments = Array.isArray(raw.payments) ? raw.payments : [];

  let comissao = 0;
  let encontrouComissao = false;

  for (const payment of payments) {
    const marketplaceFee = Number(payment?.marketplace_fee);

    if (Number.isFinite(marketplaceFee)) {
      comissao += Math.abs(marketplaceFee);
      encontrouComissao = true;
    }
  }

  if (!encontrouComissao) {
    for (const item of itens) {
      const saleFee = Number(
        item?.raw_data?.sale_fee ??
        item?.raw_data?.item?.sale_fee
      );

      if (Number.isFinite(saleFee)) {
        comissao += Math.abs(saleFee);
        encontrouComissao = true;
      }
    }
  }

  let frete = null;

  const senderCost = Number(shipmentCosts?.sender?.cost);
  const senderSave = Number(shipmentCosts?.sender?.save);

  if (Number.isFinite(senderCost)) {
    frete = Math.max(
      0,
      senderCost - (Number.isFinite(senderSave) ? senderSave : 0)
    );
  }

  if (frete == null) {
    const shippingCostCandidates = [
      raw?.shipping?.cost,
      raw?.shipping?.seller_cost,
      raw?.shipping?.shipping_cost,
      raw?.shipping_cost
    ];

    for (const candidate of shippingCostCandidates) {
      const value = Number(candidate);

      if (Number.isFinite(value)) {
        frete = Math.abs(value);
        break;
      }
    }
  }

  let valorLiquido = null;
  let liquidoEstimado = false;

  for (const payment of payments) {
    const candidates = [
      payment?.transaction_details?.net_received_amount,
      payment?.net_received_amount
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);

      if (Number.isFinite(value)) {
        valorLiquido = (valorLiquido || 0) + value;
        break;
      }
    }
  }

  if (valorLiquido == null) {
    const pago = Number(
      pedido?.paid_amount != null
        ? pedido.paid_amount
        : pedido?.total_amount
    );

    if (Number.isFinite(pago) && encontrouComissao && frete != null) {
      valorLiquido = pago - comissao - frete;
      liquidoEstimado = true;
    }
  }

  return {
    comissao:
      encontrouComissao
        ? Number(comissao.toFixed(2))
        : null,

    frete:
      frete != null
        ? Number(frete.toFixed(2))
        : null,

    valor_liquido:
      valorLiquido != null
        ? Number(valorLiquido.toFixed(2))
        : null,

    valor_liquido_estimado:
      liquidoEstimado
  };
}

// =========================================================
// ROTAS BÁSICAS
// =========================================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    sistema: "Matrix AI Commerce",
    mensagem: "Backend funcionando 🚀"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    sistema: "Matrix AI Commerce"
  });
});

// =========================================================
// WHATSAPP BUSINESS CLOUD API
// =========================================================

// Verificação do webhook feita pela Meta ao salvar a URL de callback.
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!WHATSAPP_VERIFY_TOKEN) {
    console.error("WHATSAPP_VERIFY_TOKEN não configurado.");
    return res.sendStatus(500);
  }

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook WhatsApp verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.warn("Falha na verificação do webhook WhatsApp.");
  return res.sendStatus(403);
});

// Recebe mensagens e atualizações de status do WhatsApp.
app.post("/webhooks/whatsapp", async (req, res) => {
  // A Meta espera resposta rápida; processamos depois do 200.
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change?.value || {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        for (const message of messages) {
          console.log("WhatsApp mensagem recebida:", {
            from: message.from || null,
            id: message.id || null,
            type: message.type || null,
            text: message.text?.body || null
          });
        }

        for (const status of statuses) {
          console.log("WhatsApp status:", {
            id: status.id || null,
            status: status.status || null,
            recipient_id: status.recipient_id || null
          });
        }
      }
    }
  } catch (error) {
    console.error("Erro processando webhook WhatsApp:", error);
  }
});

// Envio de mensagem de texto pelo número configurado na Cloud API.
async function enviarMensagemWhatsApp(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID não configurados."
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to),
        type: "text",
        text: { body: String(text) }
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `WhatsApp API ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// Endpoint interno para testar envio depois que o número real/token estiverem configurados.
app.post("/whatsapp/send", async (req, res) => {
  try {
    const { to, text } = req.body || {};

    if (!to || !text) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Informe to e text."
      });
    }

    const data = await enviarMensagemWhatsApp(to, text);

    return res.json({ sucesso: true, data });
  } catch (error) {
    console.error("Erro enviando WhatsApp:", error);
    return res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

// =========================================================
// WEBHOOK MERCADO LIVRE
// =========================================================

app.post(
  "/webhooks/mercadolivre",
  async (req, res) => {

    // Responde IMEDIATAMENTE ao Mercado Livre
    res.sendStatus(200);

    const payload = req.body || {};

    console.log(
      "Notificação Mercado Livre:",
      payload.topic,
      payload.resource
    );

    try {
      const {
        data: event,
        error: eventError
      } = await supabase
        .from("marketplace_webhook_events")
        .insert({
          marketplace: "mercadolivre",

          topic:
            payload.topic || null,

          resource:
            payload.resource || null,

          user_id:
            payload.user_id != null
              ? String(payload.user_id)
              : null,

          application_id:
            payload.application_id != null
              ? String(payload.application_id)
              : null,

          payload,

          processed: false
        })
        .select("id")
        .single();

      if (eventError) {
        console.error(
          "Erro gravando webhook:",
          eventError
        );

        return;
      }

      try {
        const resource =
          String(payload.resource || "");

        // Eventos relacionados a pedidos
        if (
          resource.startsWith("/orders/") ||
          payload.topic === "orders_v2"
        ) {
          const match =
            resource.match(/\/orders\/(\d+)/);

          if (match && match[1]) {
            await sincronizarPedidoPorId(
              match[1]
            );
          }
        }

        await supabase
          .from("marketplace_webhook_events")
          .update({
            processed: true,
            processed_at:
              new Date().toISOString(),
            error_message: null
          })
          .eq("id", event.id);

      } catch (processError) {
        console.error(
          "Erro processando webhook:",
          processError
        );

        await supabase
          .from("marketplace_webhook_events")
          .update({
            processed: false,
            processed_at:
              new Date().toISOString(),
            error_message:
              String(processError.message)
                .slice(0, 1000)
          })
          .eq("id", event.id);
      }

    } catch (erro) {
      console.error(
        "Erro geral webhook ML:",
        erro
      );
    }
  }
);

// =========================================================
// OAUTH MERCADO LIVRE
// =========================================================

app.get(
  "/auth/mercadolivre",
  (req, res) => {

    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !REDIRECT_URI ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return res.status(500).json({
        sucesso: false,
        mensagem:
          "Variáveis obrigatórias não configuradas."
      });
    }

    const state =
      crypto.randomBytes(32).toString("hex");

    const codeVerifier =
      base64url(
        crypto.randomBytes(64)
      );

    const codeChallenge =
      base64url(
        crypto
          .createHash("sha256")
          .update(codeVerifier)
          .digest()
      );

    oauthSessions.set(
      state,
      {
        codeVerifier,
        criadoEm: Date.now()
      }
    );

    const params =
      new URLSearchParams({
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
  }
);

app.get(
  "/auth/mercadolivre/callback",
  async (req, res) => {

    const {
      code,
      state,
      error
    } = req.query;

    if (error) {
      return res.status(400).json({
        sucesso: false,
        erro: error
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        sucesso: false,
        mensagem:
          "Code ou state não recebido."
      });
    }

    const session =
      oauthSessions.get(state);

    if (!session) {
      return res.status(400).json({
        sucesso: false,
        mensagem:
          "State inválido ou sessão OAuth expirada."
      });
    }

    oauthSessions.delete(state);

    try {
      const body =
        new URLSearchParams({
          grant_type:
            "authorization_code",

          client_id:
            CLIENT_ID,

          client_secret:
            CLIENT_SECRET,

          code,

          redirect_uri:
            REDIRECT_URI,

          code_verifier:
            session.codeVerifier
        });

      const tokenResponse =
        await fetch(
          "https://api.mercadolibre.com/oauth/token",
          {
            method: "POST",

            headers: {
              accept:
                "application/json",

              "content-type":
                "application/x-www-form-urlencoded"
            },

            body:
              body.toString()
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        console.error(
          "Erro OAuth Mercado Livre:",
          tokenData
        );

        return res
          .status(tokenResponse.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a troca do código pelo token."
          });
      }

      const expiresAt =
        new Date(
          Date.now() +
          Number(
            tokenData.expires_in
          ) * 1000
        ).toISOString();

      const marketplaceAccount = {
        marketplace:
          "mercadolivre",

        account_id:
          String(tokenData.user_id),

        user_id:
          String(tokenData.user_id),

        access_token:
          tokenData.access_token,

        refresh_token:
          tokenData.refresh_token,

        expires_at:
          expiresAt
      };

      const {
        data: existing,
        error: searchError
      } =
        await supabase
          .from(
            "marketplace_accounts"
          )
          .select("id")
          .eq(
            "marketplace",
            "mercadolivre"
          )
          .eq(
            "account_id",
            String(
              tokenData.user_id
            )
          )
          .maybeSingle();

      if (searchError) {
        console.error(
          "Erro consultando Supabase:",
          searchError
        );

        return res
          .status(500)
          .json({
            sucesso: false,
            mensagem:
              "Erro ao consultar o banco de dados."
          });
      }

      if (existing) {
        const {
          error: updateError
        } =
          await supabase
            .from(
              "marketplace_accounts"
            )
            .update({
              access_token:
                tokenData.access_token,

              refresh_token:
                tokenData.refresh_token,

              expires_at:
                expiresAt,

              user_id:
                String(
                  tokenData.user_id
                )
            })
            .eq(
              "id",
              existing.id
            );

        if (updateError) {
          console.error(
            "Erro atualizando tokens:",
            updateError
          );

          return res
            .status(500)
            .json({
              sucesso: false,
              mensagem:
                "Erro ao atualizar a conexão no banco."
            });
        }

      } else {
        const {
          error: insertError
        } =
          await supabase
            .from(
              "marketplace_accounts"
            )
            .insert(
              marketplaceAccount
            );

        if (insertError) {
          console.error(
            "Erro salvando tokens:",
            insertError
          );

          return res
            .status(500)
            .json({
              sucesso: false,
              mensagem:
                "Erro ao salvar a conexão no banco."
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

        user_id:
          tokenData.user_id,

        expires_at:
          expiresAt
      });

    } catch (erroInterno) {
      console.error(
        "Erro interno OAuth:",
        erroInterno
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          "Erro interno durante autenticação do Mercado Livre."
      });
    }
  }
);

// =========================================================
// DADOS DO VENDEDOR
// =========================================================

app.get(
  "/mercadolivre/me",
  async (req, res) => {

    try {
      let account =
        await getMercadoLivreAccount();

      if (!account) {
        return res
          .status(404)
          .json({
            sucesso: false,
            mensagem:
              "Nenhuma conta do Mercado Livre conectada."
          });
      }

      const {
        response
      } =
        await mercadoLivreFetch(
          `/users/${account.user_id}`,
          account
        );

      const mlData =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a consulta.",
            detalhe: mlData
          });
      }

      res.json({
        sucesso: true,

        vendedor: {
          id:
            mlData.id,

          nickname:
            mlData.nickname,

          registration_date:
            mlData.registration_date,

          country_id:
            mlData.country_id,

          site_id:
            mlData.site_id,

          seller_reputation:
            mlData.seller_reputation
        }
      });

    } catch (erro) {
      console.error(
        "Erro /mercadolivre/me:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao consultar Mercado Livre."
      });
    }
  }
);

// =========================================================
// LISTA PEDIDOS DO MERCADO LIVRE
// =========================================================

app.get(
  "/mercadolivre/orders",
  async (req, res) => {

    try {
      const requested =
        Number(req.query.limit || 20);

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(requested)
              ? requested
              : 20,
            1
          ),
          50
        );

      const account =
        await getMercadoLivreAccount();

      if (!account) {
        return res
          .status(404)
          .json({
            sucesso: false,
            mensagem:
              "Nenhuma conta Mercado Livre conectada."
          });
      }

      const params =
        new URLSearchParams({
          seller:
            String(
              account.user_id
            ),

          sort:
            "date_desc",

          limit:
            String(limit)
        });

      const {
        response
      } =
        await mercadoLivreFetch(
          `/orders/search?${params.toString()}`,
          account
        );

      const data =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a consulta de pedidos.",
            detalhe:
              data
          });
      }

      res.json({
        sucesso: true,
        quantidade:
          data.results?.length || 0,

        paging:
          data.paging || null,

        pedidos:
          data.results || []
      });

    } catch (erro) {
      console.error(
        "Erro orders:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message
      });
    }
  }
);

// =========================================================
// DETALHE DE UM PEDIDO
// =========================================================

app.get(
  "/mercadolivre/orders/:id",
  async (req, res) => {
    try {
      const marketplaceOrderId = String(req.params.id);

      const {
        data: pedido,
        error: pedidoError
      } = await supabase
        .from("marketplace_orders")
        .select("*")
        .eq("marketplace", "mercadolivre")
        .eq("marketplace_order_id", marketplaceOrderId)
        .maybeSingle();

      if (pedidoError) {
        throw new Error(
          `Erro buscando pedido: ${pedidoError.message}`
        );
      }

      if (!pedido) {
        return res.status(404).json({
          sucesso: false,
          mensagem: "Pedido não encontrado."
        });
      }

      const {
        data: itens,
        error: itensError
      } = await supabase
        .from("marketplace_order_items")
        .select("*")
        .eq("order_id", pedido.id)
        .order("id", { ascending: true });

      if (itensError) {
        throw new Error(
          `Erro buscando itens do pedido: ${itensError.message}`
        );
      }

      let shipmentCosts = null;

      if (pedido.shipping_id) {
        try {
          const account =
            await getMercadoLivreAccount();

          if (account) {
            const {
              response: shipmentResponse
            } = await mercadoLivreFetch(
              `/shipments/${pedido.shipping_id}/costs`,
              account
            );

            const shipmentData =
              await shipmentResponse.json();

            if (shipmentResponse.ok) {
              shipmentCosts = shipmentData;
            }
          }
        } catch (shipmentError) {
          console.warn(
            "Não foi possível obter custo de frete:",
            shipmentError.message
          );
        }
      }

      const financeiro =
        extrairFinanceiroPedido(
          pedido,
          itens || [],
          shipmentCosts
        );

      const buyerJson =
        pedido.raw_data?.buyer || {
          id: pedido.buyer_id || null,
          nickname: pedido.buyer_nickname || null
        };

      res.json({
        sucesso: true,
        pedido: {
          ...pedido,
          buyer_json: buyerJson
        },
        itens: itens || [],
        financeiro
      });

    } catch (erro) {
      console.error(
        "Erro detalhe do pedido:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao consultar pedido."
      });
    }
  }
);


// =========================================================
// PEDIDOS SALVOS / FILTROS POR PERÍODO
// =========================================================

app.get(
  "/dashboard/orders",
  async (req, res) => {
    try {
      const requested =
        Number(req.query.limit || 100);

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(requested)
              ? requested
              : 100,
            1
          ),
          500
        );

      const start =
        normalizeDateStart(req.query.start);

      const end =
        normalizeDateEnd(req.query.end);

      const status =
        req.query.status
          ? String(req.query.status)
          : null;

      const q =
        req.query.q
          ? String(req.query.q).trim()
          : "";

      let query = supabase
        .from("marketplace_orders")
        .select(
          "id,marketplace_order_id,status,total_amount,paid_amount,date_created,buyer_id,buyer_nickname"
        )
        .eq("marketplace", "mercadolivre")
        .order("date_created", { ascending: false })
        .limit(limit);

      if (start) {
        query = query.gte("date_created", start);
      }

      if (end) {
        query = query.lte("date_created", end);
      }

      if (status) {
        query = query.eq("status", status);
      }

      if (q) {
        query = query.or(
          `marketplace_order_id.ilike.%${q}%,buyer_nickname.ilike.%${q}%`
        );
      }

      const {
        data,
        error
      } = await query;

      if (error) {
        throw new Error(
          `Erro filtrando pedidos: ${error.message}`
        );
      }

      res.json({
        sucesso: true,
        quantidade: data?.length || 0,
        filtros: {
          start: req.query.start || null,
          end: req.query.end || null,
          status,
          q: q || null
        },
        pedidos: data || []
      });

    } catch (erro) {
      console.error(
        "Erro /dashboard/orders:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao filtrar pedidos."
      });
    }
  }
);

// =========================================================
// SINCRONIZA PEDIDOS PARA SUPABASE
// =========================================================

app.get(
  "/mercadolivre/sync-orders",
  async (req, res) => {
    try {
      // Lotes curtos evitam timeout/upstream error no Railway.
      // O offset permite continuar a sincronização na chamada seguinte.
      const requested = Number(req.query.limit || 200);
      const requestedOffset = Number(req.query.offset || 0);

      const totalDesejado = Math.min(
        Math.max(Number.isFinite(requested) ? requested : 200, 1),
        300
      );

      const offsetInicial = Math.max(
        Number.isFinite(requestedOffset) ? requestedOffset : 0,
        0
      );

      let account = await getMercadoLivreAccount();

      if (!account) {
        return res.status(404).json({
          sucesso: false,
          mensagem: "Nenhuma conta Mercado Livre conectada."
        });
      }

      account = await ensureValidMercadoLivreToken(account);

      const resultados = [];
      let offset = offsetInicial;
      let encontrados = 0;
      let terminou = false;

      // A API do ML entrega no máximo 50 por página.
      // Aqui fazemos paginação automática.
      while (!terminou && encontrados < totalDesejado) {
        const pageLimit = Math.min(50, totalDesejado - encontrados);

        const params = new URLSearchParams({
          seller: String(account.user_id),
          sort: "date_desc",
          limit: String(pageLimit),
          offset: String(offset)
        });

        const {
          response,
          account: contaAtualizada
        } = await mercadoLivreFetch(
          `/orders/search?${params.toString()}`,
          account
        );

        account = contaAtualizada;

        const data = await response.json();

        if (!response.ok) {
          return res.status(response.status).json({
            sucesso: false,
            mensagem: "Mercado Livre recusou a sincronização.",
            detalhe: data,
            encontrados,
            sincronizados: resultados.filter(item => item.sucesso).length
          });
        }

        const pedidos = Array.isArray(data.results)
          ? data.results
          : [];

        if (pedidos.length === 0) {
          terminou = true;
          break;
        }

        encontrados += pedidos.length;

        for (const pedido of pedidos) {
          try {
            const salvo = await salvarPedidoMercadoLivre(
              pedido,
              account
            );

            resultados.push({
              sucesso: true,
              ...salvo
            });
          } catch (erroPedido) {
            console.error(
              `Erro pedido ${pedido.id}:`,
              erroPedido
            );

            resultados.push({
              sucesso: false,
              marketplace_order_id: String(pedido.id),
              erro: erroPedido.message
            });
          }
        }

        offset += pedidos.length;

        const totalDisponivel = Number(data.paging?.total || 0);

        if (
          pedidos.length < pageLimit ||
          (totalDisponivel > 0 && offset >= totalDisponivel)
        ) {
          terminou = true;
        }
      }

      const comSucesso = resultados.filter(
        item => item.sucesso
      ).length;

      const comErro = resultados.length - comSucesso;

      res.json({
        sucesso: comErro === 0,
        mensagem: "Sincronização paginada concluída.",
        solicitados: totalDesejado,
        offset_inicial: offsetInicial,
        encontrados,
        sincronizados: comSucesso,
        erros: comErro,
        proximo_offset: offset,
        terminou,
        proxima_url: terminou
          ? null
          : `/mercadolivre/sync-orders?limit=${totalDesejado}&offset=${offset}`,
        resultados
      });
    } catch (erro) {
      console.error("Erro sync-orders:", erro);

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno na sincronização."
      });
    }
  }
);
// =========================================================
// SINCRONIZA UM PEDIDO ESPECÍFICO
// =========================================================

app.get(
  "/mercadolivre/sync-order/:id",
  async (req, res) => {

    try {
      const resultado =
        await sincronizarPedidoPorId(
          req.params.id
        );

      res.json({
        sucesso: true,
        resultado
      });

    } catch (erro) {
      console.error(
        "Erro sync-order:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message
      });
    }
  }
);

// =========================================================
// DASHBOARD / RESUMO AVANÇADO
// =========================================================

app.get(
  "/dashboard/summary",
  async (req, res) => {
    try {
      const pageSize = 1000;
      let offset = 0;
      let terminou = false;
      const pedidos = [];

      const start =
        normalizeDateStart(req.query.start);

      const end =
        normalizeDateEnd(req.query.end);

      while (!terminou) {
        let query = supabase
          .from("marketplace_orders")
          .select(
            "id,status,total_amount,paid_amount,date_created,marketplace_order_id"
          )
          .eq("marketplace", "mercadolivre")
          .order("date_created", { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (start) {
          query = query.gte("date_created", start);
        }

        if (end) {
          query = query.lte("date_created", end);
        }

        const { data, error } =
          await query;

        if (error) {
          throw new Error(`Erro dashboard: ${error.message}`);
        }

        const lote = data || [];
        pedidos.push(...lote);

        if (lote.length < pageSize) {
          terminou = true;
        } else {
          offset += pageSize;
        }
      }

      const porStatus = {};
      const vendasPorDia = {};
      let faturamentoTotal = 0;
      let faturamentoPago = 0;
      let pedidosPagos = 0;
      let pedidosCancelados = 0;

      for (const pedido of pedidos) {
        const status = pedido.status || "sem_status";
        porStatus[status] = (porStatus[status] || 0) + 1;

        const total = Number(pedido.total_amount || 0);
        const pago = Number(
          pedido.paid_amount != null
            ? pedido.paid_amount
            : pedido.total_amount || 0
        );

        if (Number.isFinite(total)) {
          faturamentoTotal += total;
        }

        if (status === "paid") {
          pedidosPagos += 1;

          if (Number.isFinite(pago)) {
            faturamentoPago += pago;
          }

          if (pedido.date_created) {
            const dia = String(pedido.date_created).slice(0, 10);

            if (!vendasPorDia[dia]) {
              vendasPorDia[dia] = {
                pedidos: 0,
                faturamento: 0
              };
            }

            vendasPorDia[dia].pedidos += 1;
            vendasPorDia[dia].faturamento +=
              Number.isFinite(pago) ? pago : 0;
          }
        }

        if (status === "cancelled") {
          pedidosCancelados += 1;
        }
      }

      const ticketMedio = pedidosPagos > 0
        ? faturamentoPago / pedidosPagos
        : 0;

      const taxaCancelamento = pedidos.length > 0
        ? (pedidosCancelados / pedidos.length) * 100
        : 0;

      // Ranking dos produtos usando os itens já sincronizados.
      const { data: itens, error: itensError } = await supabase
        .from("marketplace_order_items")
        .select(
          "order_id,item_id,title,quantity,unit_price,full_unit_price"
        )
        .eq("marketplace", "mercadolivre");

      if (itensError) {
        throw new Error(
          `Erro buscando itens do dashboard: ${itensError.message}`
        );
      }

      const idsPedidosPagos = new Set(
        pedidos
          .filter(p => p.status === "paid")
          .map(p => String(p.id))
      );

      const produtos = {};

      for (const item of itens || []) {
        if (!idsPedidosPagos.has(String(item.order_id))) {
          continue;
        }

        const chave = item.item_id || item.title || "sem_item";
        const quantidade = Number(item.quantity || 0);
        const preco = Number(
          item.unit_price != null
            ? item.unit_price
            : item.full_unit_price || 0
        );

        if (!produtos[chave]) {
          produtos[chave] = {
            item_id: item.item_id || null,
            titulo: item.title || "Sem título",
            quantidade: 0,
            faturamento: 0
          };
        }

        produtos[chave].quantidade += quantidade;

        if (Number.isFinite(preco)) {
          produtos[chave].faturamento += quantidade * preco;
        }
      }

      const rankingProdutos = Object.values(produtos)
        .map(produto => ({
          ...produto,
          faturamento: Number(produto.faturamento.toFixed(2))
        }))
        .sort((a, b) => b.quantidade - a.quantidade)
        .slice(0, 20);

      const serieDiaria = Object.entries(vendasPorDia)
        .map(([data, valores]) => ({
          data,
          pedidos: valores.pedidos,
          faturamento: Number(valores.faturamento.toFixed(2))
        }))
        .sort((a, b) => a.data.localeCompare(b.data));

      const ultimoPedido = pedidos.length
        ? pedidos[0]
        : null;

      res.json({
        sucesso: true,
        marketplace: "mercadolivre",
        periodo: {
          start: req.query.start || null,
          end: req.query.end || null
        },
        pedidos: pedidos.length,
        pedidos_pagos: pedidosPagos,
        pedidos_cancelados: pedidosCancelados,
        faturamento: Number(faturamentoTotal.toFixed(2)),
        faturamento_pago: Number(faturamentoPago.toFixed(2)),
        ticket_medio: Number(ticketMedio.toFixed(2)),
        taxa_cancelamento_percentual:
          Number(taxaCancelamento.toFixed(2)),
        por_status: porStatus,
        vendas_por_dia: serieDiaria,
        top_produtos: rankingProdutos,
        ultimo_pedido: ultimoPedido
          ? {
              id: ultimoPedido.marketplace_order_id,
              status: ultimoPedido.status,
              valor: ultimoPedido.total_amount,
              data: ultimoPedido.date_created
            }
          : null
      });
    } catch (erro) {
      console.error("Erro dashboard:", erro);

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);
// =========================================================
// STATUS DA INTEGRAÇÃO
// =========================================================

app.get(
  "/mercadolivre/status",
  async (req, res) => {

    try {
      const account =
        await getMercadoLivreAccount();

      if (!account) {
        return res.json({
          sucesso: true,
          conectado: false
        });
      }

      res.json({
        sucesso: true,
        conectado: true,

        user_id:
          account.user_id,

        expires_at:
          account.expires_at,

        token_expirado:
          account.expires_at
            ? new Date(
                account.expires_at
              ).getTime() <=
              Date.now()
            : null
      });

    } catch (erro) {
      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message
      });
    }
  }
);

// =========================================================
// SERVIDOR
// =========================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Matrix AI Commerce rodando na porta ${PORT}`
    );
  }
);
