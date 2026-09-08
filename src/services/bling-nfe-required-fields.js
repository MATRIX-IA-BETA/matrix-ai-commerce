const blingService = require("./bling");
const { supabase } = require("../db/supabase");

const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedReference = null;
let cachedAt = 0;

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value
      .map(cleanObject)
      .filter(v => v !== undefined && v !== null);
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

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractReference(payload, nfeId) {
  const d = payload?.data || payload || {};
  const naturezaId = finiteNumber(d?.naturezaOperacao?.id);
  if (!naturezaId || naturezaId <= 0) return null;

  const lojaId = finiteNumber(d?.loja?.id);
  const finalidade = finiteNumber(d?.finalidade);

  const parcelas = Array.isArray(d?.parcelas)
    ? d.parcelas
    : Array.isArray(d?.pagamentos)
      ? d.pagamentos
      : [];

  let formaPagamentoId = null;
  for (const parcela of parcelas) {
    const id = finiteNumber(
      parcela?.formaPagamento?.id ??
      parcela?.forma_pagamento?.id ??
      parcela?.idFormaPagamento
    );
    if (id && id > 0) {
      formaPagamentoId = id;
      break;
    }
  }

  return cleanObject({
    sourceNfeId: String(nfeId),
    naturezaOperacao: { id: naturezaId },
    loja: lojaId && lojaId > 0
      ? {
          id: lojaId,
          numero: d?.loja?.numero || undefined
        }
      : undefined,
    finalidade:
      finalidade && finalidade > 0
        ? finalidade
        : undefined,
    formaPagamentoId:
      formaPagamentoId || undefined
  });
}

async function findReferenceDefaults(fetchFn) {
  if (
    cachedReference &&
    Date.now() - cachedAt < CACHE_TTL_MS
  ) {
    return cachedReference;
  }

  const { data: docs, error } = await supabase
    .from("fiscal_documents")
    .select("bling_nfe_id,updated_at")
    .eq("status", "authorized")
    .not("bling_nfe_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    const e = new Error(
      `Não foi possível consultar uma NF-e autorizada de referência: ${error.message}`
    );
    e.httpStatus = 500;
    throw e;
  }

  for (const doc of docs || []) {
    const id = String(doc?.bling_nfe_id || "").trim();
    if (!id) continue;

    try {
      const response = await fetchFn(
        `/nfe/${encodeURIComponent(id)}`,
        { method: "GET" }
      );
      if (!response.ok) continue;

      const payload = await readJson(response);
      const reference = extractReference(payload, id);
      if (!reference) continue;

      cachedReference = reference;
      cachedAt = Date.now();
      return reference;
    } catch (_) {
      // Tenta a próxima NF-e autorizada já conhecida pela Matrix.
    }
  }

  const e = new Error(
    "A Matrix não encontrou uma NF-e autorizada no Bling com Natureza de Operação para usar como referência. A nova NF-e não será criada até essa configuração fiscal estar disponível."
  );
  e.httpStatus = 422;
  throw e;
}

function isNfeCreateOrUpdate(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  if (!["POST", "PUT"].includes(method)) return false;

  const cleanPath = String(path || "").split("?")[0];
  return cleanPath === "/nfe" || /^\/nfe\/[^/]+$/.test(cleanPath);
}

function calculateItemsTotal(payload) {
  const items = Array.isArray(payload?.itens)
    ? payload.itens
    : [];

  return Number(
    items.reduce((sum, item) => {
      const q = finiteNumber(item?.quantidade) ?? 0;
      const v = finiteNumber(item?.valor) ?? 0;
      return sum + q * v;
    }, 0).toFixed(2)
  );
}

function enrichItemFiscalFields(item) {
  const ncm = String(item?.ncm || item?.classificacaoFiscal || "")
    .replace(/\D/g, "");

  return cleanObject({
    ...item,
    tipo: item?.tipo || "P",
    classificacaoFiscal:
      ncm.length === 8
        ? ncm
        : item?.classificacaoFiscal
  });
}

function buildDefaultParcel(payload, reference) {
  const value = calculateItemsTotal(payload);
  if (!(value > 0)) return null;

  const date = String(
    payload?.dataOperacao ||
    new Date().toISOString().slice(0, 10)
  ).slice(0, 10);

  return cleanObject({
    data: date,
    valor: value,
    formaPagamento:
      reference?.formaPagamentoId
        ? { id: reference.formaPagamentoId }
        : undefined
  });
}

async function enrichNfeRequiredFields(path, options, fetchFn) {
  if (!isNfeCreateOrUpdate(path, options)) return options;
  if (typeof options?.body !== "string" || !options.body.trim()) {
    return options;
  }

  let payload;
  try {
    payload = JSON.parse(options.body);
  } catch {
    return options;
  }

  const reference = await findReferenceDefaults(fetchFn);
  const defaultParcel = buildDefaultParcel(payload, reference);

  const enriched = cleanObject({
    ...payload,
    naturezaOperacao:
      payload.naturezaOperacao ||
      reference.naturezaOperacao,
    loja:
      payload.loja ||
      reference.loja,
    finalidade:
      payload.finalidade ||
      reference.finalidade,
    itens:
      Array.isArray(payload.itens)
        ? payload.itens.map(enrichItemFiscalFields)
        : payload.itens,
    parcelas:
      Array.isArray(payload.parcelas) && payload.parcelas.length
        ? payload.parcelas
        : defaultParcel
          ? [defaultParcel]
          : undefined
  });

  if (!enriched?.naturezaOperacao?.id) {
    const e = new Error(
      "NF-e sem Natureza de Operação. A Matrix bloqueou a emissão para não criar uma nota fiscal incompleta."
    );
    e.httpStatus = 422;
    throw e;
  }

  if (!Array.isArray(enriched.parcelas) || !enriched.parcelas.length) {
    const e = new Error(
      "NF-e sem parcela/pagamento. A Matrix bloqueou a emissão para não enviar uma nota incompleta ao Bling."
    );
    e.httpStatus = 422;
    throw e;
  }

  return {
    ...options,
    body: JSON.stringify(enriched)
  };
}

function installBlingNfeRequiredFields() {
  if (blingService.__nfeRequiredFieldsInstalled) return;

  const previousBlingFetch = blingService.blingFetch;

  blingService.blingFetch = async function requiredFieldsBlingFetch(
    path,
    options = {}
  ) {
    const enrichedOptions = await enrichNfeRequiredFields(
      path,
      options,
      previousBlingFetch
    );
    return previousBlingFetch(path, enrichedOptions);
  };

  Object.defineProperty(
    blingService,
    "__nfeRequiredFieldsInstalled",
    {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    }
  );
}

module.exports = {
  installBlingNfeRequiredFields
};
