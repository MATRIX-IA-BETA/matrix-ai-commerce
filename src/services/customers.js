const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const UF_BY_NAME = {
  ACRE: "AC",
  ALAGOAS: "AL",
  AMAPA: "AP",
  AMAZONAS: "AM",
  BAHIA: "BA",
  CEARA: "CE",
  "DISTRITO FEDERAL": "DF",
  "ESPIRITO SANTO": "ES",
  GOIAS: "GO",
  MARANHAO: "MA",
  "MATO GROSSO": "MT",
  "MATO GROSSO DO SUL": "MS",
  "MINAS GERAIS": "MG",
  PARA: "PA",
  PARAIBA: "PB",
  PARANA: "PR",
  PERNAMBUCO: "PE",
  PIAUI: "PI",
  "RIO DE JANEIRO": "RJ",
  "RIO GRANDE DO NORTE": "RN",
  "RIO GRANDE DO SUL": "RS",
  RONDONIA: "RO",
  RORAIMA: "RR",
  "SANTA CATARINA": "SC",
  "SAO PAULO": "SP",
  SERGIPE: "SE",
  TOCANTINS: "TO"
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function normalizeUf(value) {
  if (!value) return null;

  const raw = String(value).trim().toUpperCase();

  if (/^[A-Z]{2}$/.test(raw)) return raw;
  if (/^BR-[A-Z]{2}$/.test(raw)) return raw.slice(3);

  return UF_BY_NAME[normalizeText(value)] || null;
}

function digitsOnly(value) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits || null;
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getBillingInfoId(orderData) {
  return (
    orderData?.buyer?.billing_info?.id ||
    orderData?.billing_info?.id ||
    null
  );
}

async function getMercadoLivreBillingInfo(
  marketplaceOrderId,
  storedOrder
) {
  let account = await getMercadoLivreAccount();

  if (!account) {
    const e = new Error(
      "Nenhuma conta Mercado Livre conectada para consultar os dados fiscais do comprador."
    );
    e.httpStatus = 503;
    throw e;
  }

  let orderData = storedOrder?.raw_data || {};
  let billingInfoId = getBillingInfoId(orderData);

  // Pedidos antigos gravados antes desta correção podem não ter billing_info.id.
  // Nesse caso buscamos o pedido atualizado diretamente no Mercado Livre.
  if (!billingInfoId) {
    const orderFetch = await mercadoLivreFetch(
      `/orders/${encodeURIComponent(String(marketplaceOrderId))}`,
      account
    );

    account = orderFetch.account || account;
    orderData = await readResponseJson(orderFetch.response);

    if (!orderFetch.response.ok) {
      const e = new Error(
        `Mercado Livre recusou a consulta do pedido para faturamento: ${
          orderData?.message || JSON.stringify(orderData)
        }`
      );
      e.httpStatus = orderFetch.response.status;
      throw e;
    }

    billingInfoId = getBillingInfoId(orderData);
  }

  if (!billingInfoId) {
    const e = new Error(
      "O Mercado Livre não retornou billing_info.id para este pedido. A NF-e não foi criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  const siteId =
    orderData?.site_id ||
    storedOrder?.raw_data?.site_id ||
    "MLB";

  const billingFetch = await mercadoLivreFetch(
    `/orders/billing-info/${encodeURIComponent(
      String(siteId)
    )}/${encodeURIComponent(String(billingInfoId))}`,
    account
  );

  const data = await readResponseJson(billingFetch.response);

  if (!billingFetch.response.ok) {
    const e = new Error(
      `Mercado Livre recusou a consulta dos dados fiscais do comprador: ${
        data?.message || JSON.stringify(data)
      }`
    );
    e.httpStatus = billingFetch.response.status;
    throw e;
  }

  const billing =
    data?.buyer?.billing_info ||
    data?.billing_info ||
    null;

  if (!billing) {
    const e = new Error(
      "O Mercado Livre não retornou os dados fiscais do comprador. A NF-e não foi criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  return {
    data,
    billing,
    billingInfoId: String(billingInfoId),
    siteId: String(siteId),
    orderData
  };
}

function validateBrazilianFiscalDocument(type, number, siteId) {
  if (String(siteId).toUpperCase() !== "MLB") return;

  const normalizedType = String(type || "").toUpperCase();
  const digits = digitsOnly(number);

  if (!digits) {
    const e = new Error(
      "O Mercado Livre não retornou CPF/CNPJ do comprador no billing-info. A NF-e não foi criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  if (normalizedType === "CPF" && digits.length !== 11) {
    const e = new Error(
      "O Mercado Livre retornou um CPF com quantidade de dígitos inválida. A NF-e não foi criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  if (normalizedType === "CNPJ" && digits.length !== 14) {
    const e = new Error(
      "O Mercado Livre retornou um CNPJ com quantidade de dígitos inválida. A NF-e não foi criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  if (!["CPF", "CNPJ"].includes(normalizedType)) {
    const e = new Error(
      `O Mercado Livre retornou o documento fiscal do tipo ${
        normalizedType || "desconhecido"
      }, mas para a NF-e brasileira a Matrix exige CPF ou CNPJ.`
    );
    e.httpStatus = 422;
    throw e;
  }
}

async function upsertCustomerFromMarketplaceOrder(
  marketplaceOrderId,
  overrides = {}
) {
  const { data: order, error } = await supabase
    .from("marketplace_orders")
    .select("marketplace_order_id,buyer_id,buyer_nickname,raw_data")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(marketplaceOrderId))
    .maybeSingle();

  if (error) {
    throw new Error(`Erro lendo pedido para cliente: ${error.message}`);
  }

  if (!order) {
    const e = new Error("Pedido não encontrado.");
    e.httpStatus = 404;
    throw e;
  }

  const billingResult = await getMercadoLivreBillingInfo(
    marketplaceOrderId,
    order
  );

  const billing = billingResult.billing || {};
  const identification = billing.identification || {};
  const fiscalAddress = billing.address || {};

  const buyer = order.raw_data?.buyer || {};
  const shipping = order.raw_data?.shipping || {};
  const receiver = shipping?.receiver_address || {};

  const fiscalName = [billing.name, billing.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  const documentType = String(
    overrides.document_type || identification.type || ""
  )
    .trim()
    .toUpperCase() || null;

  const documentNumber = digitsOnly(
    overrides.document_number || identification.number
  );

  validateBrazilianFiscalDocument(
    documentType,
    documentNumber,
    billingResult.siteId
  );

  const state =
    normalizeUf(overrides.state) ||
    normalizeUf(
      fiscalAddress?.state?.code ||
      fiscalAddress?.state?.name
    ) ||
    normalizeUf(
      receiver?.state?.id ||
      receiver?.state?.name
    );

  const customer = {
    source: "mercadolivre",

    marketplace_buyer_id:
      String(
        order.buyer_id ||
        buyer.id ||
        billingResult?.data?.buyer?.cust_id ||
        ""
      ) || null,

    marketplace_nickname:
      order.buyer_nickname || buyer.nickname || null,

    name:
      overrides.name ||
      fiscalName ||
      buyer.first_name ||
      buyer.nickname ||
      order.buyer_nickname ||
      "Cliente Mercado Livre",

    email:
      overrides.email ||
      billing?.attributes?.email ||
      buyer.email ||
      null,

    phone:
      overrides.phone ||
      buyer.phone?.number ||
      null,

    document_type: documentType,
    document_number: documentNumber,

    // Para NF-e priorizamos SEMPRE o endereço fiscal do billing-info.
    address_line:
      overrides.address_line ||
      fiscalAddress.street_name ||
      receiver.address_line ||
      receiver.street_name ||
      null,

    address_number:
      overrides.address_number ||
      fiscalAddress.street_number ||
      receiver.street_number ||
      null,

    neighborhood:
      overrides.neighborhood ||
      fiscalAddress.neighborhood ||
      receiver.neighborhood?.name ||
      null,

    city:
      overrides.city ||
      fiscalAddress.city_name ||
      fiscalAddress.city ||
      receiver.city?.name ||
      null,

    state,

    zip_code:
      digitsOnly(overrides.zip_code) ||
      digitsOnly(fiscalAddress.zip_code) ||
      digitsOnly(receiver.zip_code),

    country:
      overrides.country ||
      fiscalAddress.country_id ||
      "BR",

    raw_data: {
      buyer,
      shipping,
      overrides,
      billing_info_id: billingResult.billingInfoId,
      billing_site_id: billingResult.siteId,
      billing_info: billingResult.data
    },

    updated_at: nowIso()
  };

  let existing = null;

  // Documento é a chave mais segura para não duplicar o mesmo cliente.
  if (customer.document_number) {
    const found = await supabase
      .from("customers")
      .select("id")
      .eq("document_number", customer.document_number)
      .limit(1)
      .maybeSingle();

    if (found.error) {
      throw new Error(
        `Erro buscando cliente por documento: ${found.error.message}`
      );
    }

    existing = found.data;
  }

  // Compatibilidade com clientes já criados antes de termos CPF/CNPJ.
  if (!existing && customer.marketplace_buyer_id) {
    const found = await supabase
      .from("customers")
      .select("id")
      .eq("marketplace_buyer_id", customer.marketplace_buyer_id)
      .limit(1)
      .maybeSingle();

    if (found.error) {
      throw new Error(
        `Erro buscando cliente por buyer_id: ${found.error.message}`
      );
    }

    existing = found.data;
  }

  if (existing) {
    const { data, error: updateError } = await supabase
      .from("customers")
      .update(customer)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (updateError) {
      throw new Error(`Erro atualizando cliente: ${updateError.message}`);
    }

    return data;
  }

  const { data, error: insertError } = await supabase
    .from("customers")
    .insert(customer)
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`Erro criando cliente: ${insertError.message}`);
  }

  return data;
}

module.exports = {
  upsertCustomerFromMarketplaceOrder,
  getMercadoLivreBillingInfo
};
