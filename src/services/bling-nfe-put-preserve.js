const blingService = require("./bling");

function cleanPath(path) {
  return String(path || "").split("?")[0];
}

function extractNfeId(path) {
  const match = cleanPath(path).match(/^\/nfe\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isNfePut(path, options) {
  return (
    String(options?.method || "GET").toUpperCase() === "PUT" &&
    Boolean(extractNfeId(path))
  );
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

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

async function enrichExistingNfePut(path, options, fetchFn) {
  if (!isNfePut(path, options)) return options;
  if (typeof options?.body !== "string" || !options.body.trim()) return options;

  let payload;
  try {
    payload = JSON.parse(options.body);
  } catch {
    return options;
  }

  const nfeId = extractNfeId(path);
  const detailResponse = await fetchFn(
    `/nfe/${encodeURIComponent(String(nfeId))}`,
    { method: "GET" }
  );

  const detailPayload = await readJson(detailResponse);

  if (!detailResponse.ok) {
    const error = new Error(
      `Não foi possível consultar a NF-e ${nfeId} antes de atualizá-la no Bling.`
    );
    error.httpStatus = detailResponse.status;
    error.detail = detailPayload;
    throw error;
  }

  const existing = detailPayload?.data || detailPayload || {};

  const numero = hasValue(payload.numero)
    ? payload.numero
    : existing.numero;

  const serie = hasValue(payload.serie)
    ? payload.serie
    : existing.serie;

  if (!hasValue(numero)) {
    const error = new Error(
      `A NF-e ${nfeId} existe no Bling, mas não possui número para permitir a atualização via API.`
    );
    error.httpStatus = 422;
    error.detail = {
      bling_nfe_id: String(nfeId),
      numero: existing?.numero ?? null,
      serie: existing?.serie ?? null
    };
    throw error;
  }

  return {
    ...options,
    body: JSON.stringify({
      ...payload,
      numero,
      ...(hasValue(serie) ? { serie } : {})
    })
  };
}

function installBlingNfePutPreserve() {
  if (blingService.__nfePutPreserveInstalled) return;

  const previousBlingFetch = blingService.blingFetch;

  blingService.blingFetch = async function preserveExistingNfeFetch(
    path,
    options = {}
  ) {
    const enrichedOptions = await enrichExistingNfePut(
      path,
      options,
      previousBlingFetch
    );

    return previousBlingFetch(path, enrichedOptions);
  };

  Object.defineProperty(blingService, "__nfePutPreserveInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

module.exports = {
  installBlingNfePutPreserve
};
