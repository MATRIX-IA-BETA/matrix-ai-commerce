const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { blingFetch } = require("../services/bling");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function recursiveFindAccessKey(value, depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    const onlyDigits = digitsOnly(text);
    if (onlyDigits.length === 44) return onlyDigits;
    const match = text.match(/(?:^|\D)(\d{44})(?:\D|$)/);
    return match ? match[1] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindAccessKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const preferred = [
      "chaveAcesso",
      "chave",
      "accessKey",
      "chaveNfe",
      "chaveAcessoNfe",
      "linkDanfe",
      "linkPDF",
      "linkXml"
    ];

    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = recursiveFindAccessKey(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const child of Object.values(value)) {
      const found = recursiveFindAccessKey(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function extractInfo(payload) {
  const d = payload?.data || payload || {};
  const candidates = [
    d?.situacao?.valor,
    d?.situacao?.id,
    d?.situacao?.descricao,
    d?.situacao,
    d?.status?.valor,
    d?.status?.id,
    d?.status?.descricao,
    d?.status
  ].filter(v => v !== undefined && v !== null && v !== "");

  const situationText = normalizeText(candidates.join(" "));
  const numericSituations = candidates
    .map(Number)
    .filter(Number.isFinite);

  const authorized =
    numericSituations.some(v => [5, 6, 9].includes(v)) ||
    /autoriz|emitid|aprovad/.test(situationText);

  const rejected =
    /rejeit|erro|deneg|cancel|falh/.test(situationText);

  return {
    number: d?.numero ?? d?.numeroNota ?? null,
    series: d?.serie ?? d?.serieNota ?? null,
    accessKey: recursiveFindAccessKey(d),
    pdfUrl: d?.linkDanfe ?? d?.linkPDF ?? d?.danfe ?? null,
    authorized,
    rejected,
    situationText
  };
}

function marketplaceCancellationInfo(order) {
  const status = normalizeText(order?.status);
  const statusDetail = normalizeText(
    order?.status_detail ??
    order?.status_detail?.description ??
    order?.status_detail?.code
  );
  const tags = Array.isArray(order?.tags)
    ? order.tags.map(normalizeText)
    : [];

  const paidAmount = finiteNumber(order?.paid_amount);
  const totalAmount = finiteNumber(order?.total_amount);

  const explicitlyCancelled =
    /cancel/.test(status) ||
    /cancel/.test(statusDetail) ||
    tags.some(tag => /cancel/.test(tag));

  const zeroedSale =
    paidAmount != null && paidAmount <= 0;

  return {
    cancelled: explicitlyCancelled || zeroedSale,
    explicitlyCancelled,
    zeroedSale,
    status: order?.status || null,
    statusDetail: order?.status_detail || null,
    paidAmount,
    totalAmount
  };
}

async function saveFreshMarketplaceOrder(orderId, order) {
  const update = {
    status: order?.status || null,
    paid_amount: finiteNumber(order?.paid_amount),
    total_amount: finiteNumber(order?.total_amount),
    raw_data: order,
    updated_at: nowIso()
  };

  const { error } = await supabase
    .from("marketplace_orders")
    .update(update)
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(orderId));

  if (error) {
    console.warn(
      `[ML fiscal guard] Pedido ${orderId} consultado no ML, mas falhou ao atualizar cache local:`,
      error.message
    );
  }
}

async function checkMarketplaceOrderBeforeNfe(orderId) {
  const account = await getMercadoLivreAccount();
  if (!account) {
    const e = new Error(
      "Conta Mercado Livre não conectada. A Matrix não conseguiu confirmar se a venda continua válida e bloqueou a NF-e por segurança."
    );
    e.httpStatus = 503;
    throw e;
  }

  const { response } = await mercadoLivreFetch(
    `/orders/${encodeURIComponent(String(orderId))}`,
    account
  );
  const order = await readJson(response);

  if (!response.ok) {
    const e = new Error(
      `Mercado Livre recusou a conferência do pedido antes da NF-e. A emissão foi bloqueada por segurança. ${
        order?.message || order?.error || `HTTP ${response.status}`
      }`
    );
    e.httpStatus = response.status >= 500 ? 503 : response.status;
    e.detail = order;
    throw e;
  }

  await saveFreshMarketplaceOrder(orderId, order);

  return {
    order,
    ...marketplaceCancellationInfo(order)
  };
}

async function syncAuthorizedFiscal(orderId, fiscal, detail, info) {
  const { data: updated, error: updateError } = await supabase
    .from("fiscal_documents")
    .upsert(
      {
        marketplace_order_id: orderId,
        bling_nfe_id: String(fiscal.bling_nfe_id),
        status: "authorized",
        nfe_number: info.number == null ? fiscal.nfe_number : String(info.number),
        nfe_series: info.series == null ? fiscal.nfe_series : String(info.series),
        nfe_access_key: info.accessKey || fiscal.nfe_access_key || null,
        nfe_pdf_url: info.pdfUrl || fiscal.nfe_pdf_url || null,
        bling_response: {
          authorized_guard: detail,
          synced_at: nowIso()
        },
        updated_at: nowIso()
      },
      { onConflict: "marketplace_order_id" }
    )
    .select("*")
    .single();

  if (updateError) throw new Error(updateError.message);
  return updated;
}

async function downgradeFalseAuthorized(fiscal, detail, info) {
  const status = info.rejected ? "send_error" : "created_bling";

  const { data: updated, error } = await supabase
    .from("fiscal_documents")
    .update({
      status,
      nfe_access_key: null,
      nfe_pdf_url: null,
      bling_response: {
        false_authorized_guard: detail,
        previous_status: fiscal.status,
        situation: info.situationText,
        corrected_at: nowIso()
      },
      updated_at: nowIso()
    })
    .eq("marketplace_order_id", String(fiscal.marketplace_order_id))
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return updated;
}

async function inspectFiscal(fiscal) {
  const response = await blingFetch(
    `/nfe/${encodeURIComponent(String(fiscal.bling_nfe_id))}`,
    { method: "GET" }
  );

  if (!response.ok) return { checked: false, fiscal };

  const detail = await readJson(response);
  const info = extractInfo(detail);

  if (info.authorized) {
    const updated = await syncAuthorizedFiscal(
      String(fiscal.marketplace_order_id),
      fiscal,
      detail,
      info
    );
    return { checked: true, authorized: true, fiscal: updated };
  }

  if (String(fiscal.status || "").toLowerCase() === "authorized") {
    const updated = await downgradeFalseAuthorized(fiscal, detail, info);
    return {
      checked: true,
      authorized: false,
      downgraded: true,
      fiscal: updated
    };
  }

  return { checked: true, authorized: false, fiscal };
}

router.post("/bling/nfe/revalidate/recent", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(20, Number(req.body?.limit || 10)));

    const { data: docs, error } = await supabase
      .from("fiscal_documents")
      .select("*")
      .eq("status", "authorized")
      .not("bling_nfe_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    let checked = 0;
    let downgraded = 0;
    const correctedOrders = [];

    for (const fiscal of docs || []) {
      try {
        const result = await inspectFiscal(fiscal);
        if (result.checked) checked += 1;
        if (result.downgraded) {
          downgraded += 1;
          correctedOrders.push(String(fiscal.marketplace_order_id));
        }
      } catch (error) {
        console.warn(
          `[Bling emit guard] Falha revalidando ${fiscal.marketplace_order_id}:`,
          error.message
        );
      }
    }

    res.json({
      sucesso: true,
      analisadas: checked,
      corrigidas: downgraded,
      pedidos_corrigidos: correctedOrders
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

router.post("/bling/nfe/emit/from-order/:orderId", async (req, res, next) => {
  const orderId = String(req.params.orderId);

  try {
    // Regra de segurança principal: antes de tocar no Bling, consulta o pedido
    // diretamente no Mercado Livre. Não confiamos apenas no valor/status salvo
    // localmente porque o cliente pode ter cancelado depois da última sincronização.
    const marketplace = await checkMarketplaceOrderBeforeNfe(orderId);

    if (marketplace.cancelled) {
      return res.status(409).json({
        sucesso: false,
        cancelada: true,
        marketplace_status: marketplace.status,
        paid_amount: marketplace.paidAmount,
        mensagem:
          marketplace.explicitlyCancelled
            ? "Venda cancelada no Mercado Livre. A Matrix bloqueou a emissão da NF-e."
            : "Venda com valor pago zerado no Mercado Livre. A Matrix tratou o pedido como cancelado e bloqueou a emissão da NF-e."
      });
    }

    const { data: fiscal, error } = await supabase
      .from("fiscal_documents")
      .select("*")
      .eq("marketplace_order_id", orderId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!fiscal?.bling_nfe_id) return next();

    const result = await inspectFiscal(fiscal);

    if (result.authorized) {
      return res.json({
        sucesso: true,
        mensagem: "A NF-e já está realmente autorizada no Bling. A Matrix sincronizou o status e não criou outra nota.",
        fiscal: result.fiscal
      });
    }

    // Se a Matrix havia marcado a nota como autorizada apenas porque o Bling
    // já tinha gerado uma chave, inspectFiscal rebaixa o status antes de seguir.
    // A rota principal poderá então atualizar a NF-e com os dados corrigidos e
    // tentar o envio novamente.
    return next();
  } catch (error) {
    console.warn(`[Bling emit guard] Pré-check bloqueou o pedido ${orderId}:`, error.message);

    // Diferente do guard antigo, falha na consulta ao ML NÃO pode cair em next().
    // Se não conseguimos confirmar que a venda segue válida, não emitimos.
    return res.status(error.httpStatus || 503).json({
      sucesso: false,
      mensagem: error.message,
      detalhe: error.detail || null
    });
  }
});

module.exports = router;
