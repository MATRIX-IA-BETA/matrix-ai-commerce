const { supabase } = require("../db/supabase");
const { env } = require("../config/env");

const CLIENT_ID = env.MERCADOLIVRE_CLIENT_ID;
const CLIENT_SECRET = env.MERCADOLIVRE_CLIENT_SECRET;
const REDIRECT_URI = env.MERCADOLIVRE_REDIRECT_URI;

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



module.exports = {
  getMercadoLivreAccount,
  refreshMercadoLivreToken,
  ensureValidMercadoLivreToken,
  mercadoLivreFetch,
  salvarPedidoMercadoLivre,
  sincronizarPedidoPorId,
  extrairFinanceiroPedido
};
