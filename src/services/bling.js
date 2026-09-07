const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");
const { upsertCustomerFromMarketplaceOrder } = require("../services/customers");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");
const {
  getBlingAccount,
  saveBlingToken,
  blingBasicAuth,
  blingFetch,
  createOrUpdateBlingContact
} = require("../services/bling");

const BLING_CLIENT_ID = env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = env.BLING_REDIRECT_URI;
const BLING_API_BASE = env.BLING_API_BASE;
const BLING_AUTH_BASE = env.BLING_AUTH_BASE;
const blingOauthSessions = new Map();

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value
      .map(cleanObject)
      .filter((v) => v !== undefined);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const cleaned = cleanObject(val);
      if (
        cleaned !== undefined &&
        cleaned !== null &&
        cleaned !== "" &&
        !(typeof cleaned === "object" &&
          !Array.isArray(cleaned) &&
          Object.keys(cleaned).length === 0)
      ) {
        out[key] = cleaned;
      }
    }
    return out;
  }

  return value;
}

function normalizeUf(value) {
  if (!value) return undefined;
  const raw = String(value).trim().toUpperCase();

  if (/^BR-[A-Z]{2}$/.test(raw)) return raw.slice(3);
  if (/^[A-Z]{2}$/.test(raw)) return raw;

  return undefined;
}

function normalizeCep(value) {
  if (!value) return undefined;
  const digits = String(value).replace(/\D/g, "");
  return digits || undefined;
}

function extractNfeData(payload) {
  const d = payload?.data || payload || {};
  const situation =
    d?.situacao?.valor ??
    d?.situacao?.descricao ??
    d?.situacao ??
    null;

  const t = situation == null ? "" : String(situation);
  let status = null;

  if (d?.chaveAcesso || /autoriz/i.test(t)) {
    status = "authorized";
  } else if (/rejeit|erro|deneg/i.test(t)) {
    status = "rejected";
  }

  return {
    number: d?.numero ?? null,
    series: d?.serie ?? null,
    accessKey: d?.chaveAcesso ?? null,
    pdfUrl: d?.linkDanfe ?? d?.linkPDF ?? null,
    status
  };
}

function blingErrorMessage(payload) {
  const error = payload?.error || payload || {};
  const fieldMessages = Array.isArray(error?.fields)
    ? error.fields
        .map((f) => f?.msg)
        .filter(Boolean)
    : [];

  return [
    error?.message,
    ...fieldMessages,
    error?.description
  ]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(" | ");
}

async function persist(orderId, values) {
  const { data, error } = await supabase
    .from("fiscal_documents")
    .upsert(
      {
        marketplace_order_id: String(orderId),
        ...values,
        updated_at: nowIso()
      },
      { onConflict: "marketplace_order_id" }
    )
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function getFiscalDocument(orderId) {
  const { data, error } = await supabase
    .from("fiscal_documents")
    .select("*")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function getBlingContact(contactId) {
  const response = await blingFetch(
    `/contatos/${encodeURIComponent(String(contactId))}`,
    { method: "GET" }
  );

  const data = await readJson(response);

  if (!response.ok) {
    const e = new Error(
      `Erro consultando contato no Bling: ${
        blingErrorMessage(data) || JSON.stringify(data)
      }`
    );
    e.httpStatus = response.status;
    e.detail = data;
    throw e;
  }

  return data?.data || data || {};
}

function buildNfeContact(blingContact, customer, contactId) {
  const geral = blingContact?.endereco?.geral || {};
  const paisRaw = geral?.pais;

  let pais;
  if (typeof paisRaw === "string") {
    pais = paisRaw;
  } else if (paisRaw && typeof paisRaw === "object") {
    pais = paisRaw.nome || paisRaw.descricao;
  }

  const indicador = Number(blingContact?.indicadorIe);

  return cleanObject({
    id: Number(contactId),
    nome:
      blingContact?.nome ||
      customer?.name ||
      "Cliente Mercado Livre",
    tipoPessoa:
      blingContact?.tipo === "J" ||
      customer?.document_type === "CNPJ"
        ? "J"
        : "F",
    numeroDocumento:
      blingContact?.numeroDocumento ||
      customer?.document_number ||
      undefined,
    ie: blingContact?.ie || undefined,
    rg: blingContact?.rg || undefined,
    contribuinte:
      Number.isFinite(indicador) && indicador > 0
        ? indicador
        : undefined,
    telefone:
      blingContact?.telefone ||
      blingContact?.celular ||
      customer?.phone ||
      undefined,
    email:
      blingContact?.email ||
      customer?.email ||
      undefined,
    endereco: {
      endereco:
        geral?.endereco ||
        customer?.address_line ||
        undefined,
      numero:
        geral?.numero ||
        customer?.address_number ||
        undefined,
      complemento:
        geral?.complemento ||
        undefined,
      bairro:
        geral?.bairro ||
        customer?.neighborhood ||
        undefined,
      cep:
        normalizeCep(geral?.cep) ||
        normalizeCep(customer?.zip_code),
      municipio:
        geral?.municipio ||
        customer?.city ||
        undefined,
      uf:
        normalizeUf(geral?.uf) ||
        normalizeUf(customer?.state),
      pais:
        pais ||
        customer?.country ||
        "BRASIL"
    }
  });
}

router.get("/auth/bling", (req, res) => {
  if (
    !BLING_CLIENT_ID ||
    !BLING_CLIENT_SECRET ||
    !BLING_REDIRECT_URI
  ) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "Variáveis do Bling não configuradas."
    });
  }

  const state = crypto.randomBytes(24).toString("hex");
  blingOauthSessions.set(state, { created_at: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: BLING_CLIENT_ID,
    state
  });

  res.redirect(
    `${BLING_AUTH_BASE}/authorize?${params.toString()}`
  );
});

router.get("/auth/bling/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({
        sucesso: false,
        erro: error
      });
    }

    if (
      !code ||
      !state ||
      !blingOauthSessions.has(state)
    ) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Code/state inválido no OAuth Bling."
      });
    }

    blingOauthSessions.delete(state);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code)
    });

    const tokenResponse = await fetch(
      `${BLING_API_BASE}/oauth/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${blingBasicAuth()}`,
          "Content-Type":
            "application/x-www-form-urlencoded",
          "enable-jwt": "1"
        },
        body: body.toString()
      }
    );

    const tokenData = await readJson(tokenResponse);

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        sucesso: false,
        mensagem: "Bling recusou o token.",
        detalhe: tokenData
      });
    }

    const account = await saveBlingToken(tokenData);

    res.json({
      sucesso: true,
      mensagem:
        "Bling conectado à Matrix AI Commerce.",
      expires_at: account.expires_at
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: erro.message
    });
  }
});

router.get("/bling/status", async (req, res) => {
  try {
    const account = await getBlingAccount();

    res.json({
      sucesso: true,
      conectado: Boolean(account),
      expires_at: account?.expires_at || null,
      token_expirado: account?.expires_at
        ? new Date(account.expires_at).getTime() <=
          Date.now()
        : null
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: erro.message
    });
  }
});

router.post(
  "/bling/customers/:customerId/sync",
  async (req, res) => {
    try {
      const { data: customer, error } =
        await supabase
          .from("customers")
          .select("*")
          .eq("id", req.params.customerId)
          .single();

      if (error) throw new Error(error.message);

      res.json({
        sucesso: true,
        bling_contact_id:
          await createOrUpdateBlingContact(customer)
      });
    } catch (erro) {
      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);


function isPcTitle(title) {
  const t = String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    /\bpc\b/.test(t) ||
    t.includes("computador") ||
    t.includes("desktop")
  );
}

function fiscalDescriptionFromTitle(title) {
  const t = String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (t.includes("pc gamer")) {
    return "GABINETE GAMER";
  }

  if (
    t.includes("pc home") ||
    t.includes("home office")
  ) {
    return "GABINETE OFFICER";
  }

  return String(title || "GABINETE").trim();
}


async function buildNfeContext(orderId, body = {}) {
  const { data: order, error } = await supabase
    .from("marketplace_orders")
    .select("*")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!order) {
    const e = new Error("Pedido não encontrado.");
    e.httpStatus = 404;
    throw e;
  }

  const customer =
    await upsertCustomerFromMarketplaceOrder(
      String(orderId),
      body.customer || {}
    );

  const contactId =
    await createOrUpdateBlingContact(customer);

  /*
   * IMPORTANTE:
   * Para a NF-e não enviamos apenas contato:{id}.
   * Consultamos o contato no próprio Bling e enviamos
   * o snapshot completo do destinatário na NF-e.
   */
  const blingContact =
    await getBlingContact(contactId);

  const nfeContact = buildNfeContact(
    blingContact,
    customer,
    contactId
  );

  const settings = await getFiscalSettings();

  const payments = Array.isArray(
    order.raw_data?.payments
  )
    ? order.raw_data.payments
    : [];

  const commission = payments.reduce(
    (sum, p) =>
      sum +
      Math.abs(Number(p?.marketplace_fee || 0)),
    0
  );

  const gross = Number(
    order.paid_amount ??
      order.total_amount ??
      0
  );

  const freight = Number(
    body.freight_amount || 0
  );

  let discountType = body.discount_type;
  let discountValue = body.discount_value;
  const legacy = body.discount_percent;

  if (
    discountType == null &&
    discountValue == null &&
    legacy == null
  ) {
    discountType = "percent";
    discountValue =
      settings.suggest_ml_commission_as_discount &&
      gross > 0 &&
      commission > 0
        ? (commission / gross) * 100
        : Number(
            settings.default_discount_percent || 0
          );
  }

  const preview = calculateFiscalPreview({
    grossAmount: gross,
    commissionAmount: commission,
    freightAmount: freight,
    discountType,
    discountValue,
    discountPercent: legacy
  });

  const items = Array.isArray(
    order.raw_data?.order_items
  )
    ? order.raw_data.order_items
    : [];

  if (!items.length) {
    const e = new Error(
      "Pedido sem itens para emissão fiscal."
    );
    e.httpStatus = 400;
    throw e;
  }

  const sourceTotal = items.reduce(
    (sum, item) =>
      sum +
      Number(item.unit_price || 0) *
        Number(item.quantity || 1),
    0
  );

  const factor =
    sourceTotal > 0
      ? preview.fiscal_amount / sourceTotal
      : 0;

  let remaining = preview.fiscal_amount;

  const fiscalItems = items.map(
    (item, index) => {
      const quantity = Math.max(
        1,
        Number(item.quantity || 1)
      );

      const originalLine =
        Number(item.unit_price || 0) *
        quantity;

      let lineFinal;

      if (index === items.length - 1) {
        lineFinal = Number(
          Math.max(0, remaining).toFixed(2)
        );
      } else {
        lineFinal = Number(
          (originalLine * factor).toFixed(2)
        );
        remaining = Number(
          (remaining - lineFinal).toFixed(2)
        );
      }

      const sourceTitle =
        item.item?.title ||
        "Produto Mercado Livre";

      return cleanObject({
        codigo:
          item.item?.seller_sku ||
          item.item?.id ||
          undefined,

        descricao:
          fiscalDescriptionFromTitle(sourceTitle),

        // Regras fiscais definidas pela Shop Matrix.
        // NCM 84733019 somente para anúncios de PCs/computadores.
        ncm: isPcTitle(sourceTitle) ? "84733019" : undefined,
        unidade: "UN",

        quantidade: quantity,
        valor: Number(
          (lineFinal / quantity).toFixed(4)
        )
      });
    }
  );

  /*
   * Regra fiscal Matrix:
   * - o Bling recebe somente o valor final dos itens;
   * - não enviamos desconto no payload da NF-e;
   * - não mencionamos valor original ou percentual
   *   nas observações.
   */
  const payload = cleanObject({
    tipo: 1,
    contato: nfeContact,
    dataOperacao: new Date(
      order.date_created || Date.now()
    )
      .toISOString()
      .slice(0, 10),
    itens: fiscalItems,
    observacoes:
      `Pedido Mercado Livre ${orderId}.`
  });

  return {
    order,
    customer,
    contactId: String(contactId),
    blingContact,
    preview,
    payload
  };
}

async function prepareNfe(orderId, body = {}) {
  const context =
    await buildNfeContext(orderId, body);

  const existing =
    await getFiscalDocument(orderId);

  const commonPersist = {
    customer_id:
      context.customer.id == null
        ? null
        : String(context.customer.id),
    gross_amount:
      context.preview.gross_amount,
    commission_amount:
      context.preview.commission_amount,
    freight_amount:
      context.preview.freight_amount,
    operational_net_amount:
      context.preview.operational_net_amount,
    discount_type:
      context.preview.discount_type,
    discount_value:
      context.preview.discount_value,
    discount_amount:
      context.preview.discount_amount,
    discount_percent:
      context.preview.discount_percent,
    fiscal_amount:
      context.preview.fiscal_amount,
    bling_contact_id:
      String(context.contactId),
    bling_request:
      context.payload
  };

  /*
   * IDEMPOTÊNCIA:
   * se a Matrix já possui ID de NF-e do Bling,
   * nunca cria outra nota para o mesmo pedido.
   * Atualiza a nota existente e continua o envio.
   */
  if (existing?.bling_nfe_id) {
    const nfeId = String(
      existing.bling_nfe_id
    );

    if (existing.status === "authorized") {
      return {
        fiscal: existing,
        nfeId,
        prepareData:
          existing.bling_response || {},
        reused: true,
        alreadyAuthorized: true
      };
    }

    const response = await blingFetch(
      `/nfe/${encodeURIComponent(nfeId)}`,
      {
        method: "PUT",
        body: JSON.stringify(context.payload)
      }
    );

    const data = await readJson(response);

    const fiscal = await persist(
      orderId,
      {
        ...commonPersist,
        bling_nfe_id: nfeId,
        status: response.ok
          ? "created_bling"
          : "bling_update_error",
        bling_response: {
          update: data
        }
      }
    );

    if (!response.ok) {
      const e = new Error(
        `Bling recusou a atualização da NF-e existente: ${
          blingErrorMessage(data) ||
          JSON.stringify(data)
        }`
      );
      e.httpStatus = response.status;
      e.detail = data;
      e.fiscal = fiscal;
      throw e;
    }

    return {
      fiscal,
      nfeId,
      prepareData: data,
      reused: true,
      alreadyAuthorized: false
    };
  }

  const response = await blingFetch(
    "/nfe",
    {
      method: "POST",
      body: JSON.stringify(context.payload)
    }
  );

  const data = await readJson(response);
  const nfeId =
    data?.data?.id ||
    data?.id ||
    null;

  const fiscal = await persist(
    orderId,
    {
      ...commonPersist,
      bling_nfe_id:
        nfeId ? String(nfeId) : null,
      status: response.ok
        ? "created_bling"
        : "bling_error",
      bling_response: {
        create: data
      }
    }
  );

  if (!response.ok) {
    const e = new Error(
      `Bling recusou a criação da NF-e: ${
        blingErrorMessage(data) ||
        JSON.stringify(data)
      }`
    );
    e.httpStatus = response.status;
    e.detail = data;
    e.fiscal = fiscal;
    throw e;
  }

  if (!nfeId) {
    const e = new Error(
      "Bling não retornou o ID da NF-e."
    );
    e.httpStatus = 502;
    e.detail = data;
    e.fiscal = fiscal;
    throw e;
  }

  return {
    fiscal,
    nfeId: String(nfeId),
    prepareData: data,
    reused: false,
    alreadyAuthorized: false
  };
}

router.post(
  "/bling/nfe/from-order/:orderId",
  async (req, res) => {
    try {
      const result = await prepareNfe(
        String(req.params.orderId),
        req.body || {}
      );

      res.json({
        sucesso: true,
        reutilizada: result.reused,
        fiscal: result.fiscal,
        bling: result.prepareData
      });
    } catch (erro) {
      res
        .status(erro.httpStatus || 500)
        .json({
          sucesso: false,
          mensagem: erro.message,
          fiscal: erro.fiscal || null,
          detalhe: erro.detail || null
        });
    }
  }
);

router.post(
  "/bling/nfe/emit/from-order/:orderId",
  async (req, res) => {
    try {
      const orderId =
        String(req.params.orderId);

      const prepared = await prepareNfe(
        orderId,
        req.body || {}
      );

      if (prepared.alreadyAuthorized) {
        return res.json({
          sucesso: true,
          mensagem:
            "Esta NF-e já está autorizada. Nenhuma nova nota foi criada.",
          fiscal: prepared.fiscal
        });
      }

      await persist(orderId, {
        status: "sending"
      });

      const sendResponse = await blingFetch(
        `/nfe/${encodeURIComponent(
          prepared.nfeId
        )}/enviar?enviarEmail=false`,
        { method: "POST" }
      );

      const sendData =
        await readJson(sendResponse);

      let detailData = {};

      try {
        const detailResponse =
          await blingFetch(
            `/nfe/${encodeURIComponent(
              prepared.nfeId
            )}`,
            { method: "GET" }
          );

        detailData =
          await readJson(detailResponse);
      } catch (_) {}

      if (!sendResponse.ok) {
        const fiscal = await persist(
          orderId,
          {
            status: "send_error",
            bling_response: {
              prepare: prepared.prepareData,
              send: sendData,
              detail: detailData
            }
          }
        );

        const reason =
          blingErrorMessage(sendData);

        return res
          .status(sendResponse.status)
          .json({
            sucesso: false,
            mensagem:
              `${
                prepared.reused
                  ? "NF-e existente atualizada no Bling"
                  : "NF-e criada no Bling"
              }, mas houve erro no envio${
                reason ? `: ${reason}` : "."
              }`,
            fiscal,
            detalhe: sendData
          });
      }

      const info =
        extractNfeData(detailData);

      const fiscal = await persist(
        orderId,
        {
          status:
            info.status ||
            "sent_to_sefaz",
          nfe_number:
            info.number
              ? String(info.number)
              : prepared.fiscal?.nfe_number ||
                null,
          nfe_series:
            info.series
              ? String(info.series)
              : prepared.fiscal?.nfe_series ||
                null,
          nfe_access_key:
            info.accessKey
              ? String(info.accessKey)
              : prepared.fiscal
                  ?.nfe_access_key ||
                null,
          nfe_pdf_url:
            info.pdfUrl ||
            prepared.fiscal
              ?.nfe_pdf_url ||
            null,
          bling_response: {
            prepare:
              prepared.prepareData,
            send: sendData,
            detail: detailData
          }
        }
      );

      res.json({
        sucesso: true,
        mensagem:
          fiscal.status === "authorized"
            ? "NF-e autorizada."
            : prepared.reused
              ? "NF-e existente atualizada e enviada para emissão."
              : "NF-e criada e enviada para emissão.",
        fiscal
      });
    } catch (erro) {
      res
        .status(erro.httpStatus || 500)
        .json({
          sucesso: false,
          mensagem: erro.message,
          fiscal: erro.fiscal || null,
          detalhe: erro.detail || null
        });
    }
  }
);

router.post(
  "/bling/nfe/:blingNfeId/refresh",
  async (req, res) => {
    try {
      const id = String(
        req.params.blingNfeId
      );

      const { data: fiscal, error } =
        await supabase
          .from("fiscal_documents")
          .select("*")
          .eq("bling_nfe_id", id)
          .maybeSingle();

      if (error) {
        throw new Error(error.message);
      }

      if (!fiscal) {
        return res.status(404).json({
          sucesso: false,
          mensagem:
            "NF-e não encontrada na Matrix."
        });
      }

      const response = await blingFetch(
        `/nfe/${encodeURIComponent(id)}`,
        { method: "GET" }
      );

      const detail =
        await readJson(response);

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Erro consultando NF-e no Bling.",
            detalhe: detail
          });
      }

      const info =
        extractNfeData(detail);

      const updated = await persist(
        fiscal.marketplace_order_id,
        {
          status:
            info.status ||
            fiscal.status ||
            "sent_to_sefaz",
          nfe_number:
            info.number
              ? String(info.number)
              : fiscal.nfe_number,
          nfe_series:
            info.series
              ? String(info.series)
              : fiscal.nfe_series,
          nfe_access_key:
            info.accessKey
              ? String(info.accessKey)
              : fiscal.nfe_access_key,
          nfe_pdf_url:
            info.pdfUrl ||
            fiscal.nfe_pdf_url,
          bling_response: detail
        }
      );

      res.json({
        sucesso: true,
        fiscal: updated,
        bling: detail
      });
    } catch (erro) {
      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);

router.get(
  "/bling/nfe/document/:accessKey/:format",
  async (req, res) => {
    try {
      const key = String(
        req.params.accessKey || ""
      );

      const format = String(
        req.params.format || ""
      ).toLowerCase();

      if (!/^\d{44}$/.test(key)) {
        return res.status(400).json({
          sucesso: false,
          mensagem:
            "Chave de acesso inválida."
        });
      }

      if (
        !["pdf", "xml"].includes(format)
      ) {
        return res.status(400).json({
          sucesso: false,
          mensagem:
            "Formato deve ser pdf ou xml."
        });
      }

      const response = await blingFetch(
        `/nfe/documento/${encodeURIComponent(
          key
        )}?formato=${format}`,
        { method: "GET" }
      );

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Documento ainda não disponível no Bling."
          });
      }

      const buffer = Buffer.from(
        await response.arrayBuffer()
      );

      res.setHeader(
        "Content-Type",
        format === "pdf"
          ? "application/pdf"
          : "application/xml"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="NFe-${key}.${format}"`
      );

      res.send(buffer);
    } catch (erro) {
      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);

module.exports = router;
