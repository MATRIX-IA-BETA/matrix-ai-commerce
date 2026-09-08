const blingService = require("./bling");

const originalBlingFetch = blingService.blingFetch;
const CACHE_TTL_MS = 10 * 60 * 1000;
const productCache = new Map();

const TARGET_FISCAL_PRODUCT = "GABINETE DE COMPUTADOR";
const TARGET_FISCAL_PRODUCT_NORMALIZED = "gabinete de computador";
const TARGET_NCM = "84733019";

// Qualquer anúncio com uma dessas expressões deve sair fiscalmente como
// GABINETE DE COMPUTADOR. A lista inclui os termos definidos pela Shop Matrix
// e variações usuais de anúncios de computadores/gabinetes.
const COMPUTER_KEYWORDS = [
  "pc",
  "gamer",
  "office",
  "officer",
  "computador",
  "cpu",
  "pc gamer",
  "cpu gamer",
  "pc home office",
  "home office",
  "desktop",
  "gabinete",
  "microcomputador",
  "micro computador",
  "workstation",
  "estacao de trabalho",
  "torre",
  "pc completo",
  "computador completo",
  "desktop gamer",
  "computador gamer"
];

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
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

function makeFiscalError(message, detail = null) {
  const error = new Error(message);
  error.httpStatus = 422;
  error.detail = detail;
  return error;
}

function isActiveProduct(row) {
  const status = String(row?.situacao ?? row?.status ?? "")
    .trim()
    .toUpperCase();
  return status === "A" || status === "ATIVO" || status === "ACTIVE";
}

function containsWholeTerm(text, term) {
  if (!text || !term) return false;
  return (` ${text} `).includes(` ${term} `);
}

function looksLikeComputerDescription(description) {
  const normalized = normalizeName(description);
  if (!normalized) return false;

  return COMPUTER_KEYWORDS.some(keyword =>
    containsWholeTerm(normalized, normalizeName(keyword))
  );
}

async function searchProductsByName(name) {
  const params = new URLSearchParams({
    pagina: "1",
    limite: "100",
    criterio: "2",
    tipo: "P",
    nome: name
  });

  const response = await originalBlingFetch(
    `/produtos?${params.toString()}`,
    { method: "GET" }
  );
  const payload = await readJson(response);

  if (!response.ok) {
    const error = new Error(
      `Bling recusou a busca do produto fiscal "${name}": ${JSON.stringify(payload)}`
    );
    error.httpStatus = response.status;
    error.detail = payload;
    throw error;
  }

  return Array.isArray(payload?.data) ? payload.data : [];
}

async function fetchProductDetail(productId, description) {
  const detailResponse = await originalBlingFetch(
    `/produtos/${encodeURIComponent(String(productId))}`,
    { method: "GET" }
  );
  const detailPayload = await readJson(detailResponse);

  if (!detailResponse.ok) {
    const error = new Error(
      `Bling recusou a consulta do produto fiscal "${description}": ${JSON.stringify(detailPayload)}`
    );
    error.httpStatus = detailResponse.status;
    error.detail = detailPayload;
    throw error;
  }

  return detailPayload?.data || detailPayload || {};
}

async function findRegisteredBlingProduct() {
  const cached = productCache.get(TARGET_FISCAL_PRODUCT_NORMALIZED);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return cached.product;
  }

  const rows = await searchProductsByName(TARGET_FISCAL_PRODUCT);
  const exact = rows
    .filter(row => normalizeName(row?.nome) === TARGET_FISCAL_PRODUCT_NORMALIZED)
    .sort((a, b) => {
      const activeDiff = Number(isActiveProduct(b)) - Number(isActiveProduct(a));
      if (activeDiff !== 0) return activeDiff;
      return Number(a?.id || 0) - Number(b?.id || 0);
    });

  if (!exact.length) {
    throw makeFiscalError(
      `Produto fiscal "${TARGET_FISCAL_PRODUCT}" não foi localizado no cadastro do Bling. A NF-e não será criada até esse vínculo estar correto.`,
      { encontrados: rows.map(row => ({ id: row?.id, nome: row?.nome, codigo: row?.codigo })) }
    );
  }

  const invalidCandidates = [];

  for (const selected of exact) {
    const detail = await fetchProductDetail(selected.id, TARGET_FISCAL_PRODUCT);
    const ncm = digitsOnly(detail?.tributacao?.ncm);

    if (ncm !== TARGET_NCM) {
      invalidCandidates.push({
        id: detail?.id || selected.id,
        nome: detail?.nome || selected?.nome,
        codigo: detail?.codigo || selected?.codigo || null,
        ncm: detail?.tributacao?.ncm || null
      });
      continue;
    }

    const product = {
      id: String(detail?.id || selected.id),
      nome: TARGET_FISCAL_PRODUCT,
      codigo: detail?.codigo || selected?.codigo || null,
      unidade: detail?.unidade || selected?.unidade || null,
      ncm: TARGET_NCM
    };

    if (exact.length > 1) {
      console.warn(
        `[Bling fiscal product] ${TARGET_FISCAL_PRODUCT}: ${exact.length} cadastros exatos encontrados; usando ID ${product.id}.`
      );
    }

    productCache.set(TARGET_FISCAL_PRODUCT_NORMALIZED, {
      savedAt: Date.now(),
      product
    });

    return product;
  }

  throw makeFiscalError(
    `O produto "${TARGET_FISCAL_PRODUCT}" foi encontrado no Bling, mas nenhum cadastro possui o NCM ${TARGET_NCM}.`,
    { encontrados: invalidCandidates }
  );
}

function isNfeCreateOrUpdate(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  if (!["POST", "PUT"].includes(method)) return false;

  const cleanPath = String(path || "").split("?")[0];
  return cleanPath === "/nfe" || /^\/nfe\/[^/]+$/.test(cleanPath);
}

async function enrichNfeOptions(path, options = {}) {
  if (!isNfeCreateOrUpdate(path, options)) return options;
  if (typeof options.body !== "string" || !options.body.trim()) return options;

  let payload;
  try {
    payload = JSON.parse(options.body);
  } catch {
    return options;
  }

  if (!Array.isArray(payload?.itens) || !payload.itens.length) {
    return options;
  }

  let product = null;
  let changed = false;
  const itens = [];

  for (const item of payload.itens) {
    const description = String(item?.descricao || "").trim();

    if (!looksLikeComputerDescription(description)) {
      itens.push(item);
      continue;
    }

    if (!product) {
      product = await findRegisteredBlingProduct();
    }

    // Todos os anúncios identificados como computador passam a usar o mesmo
    // produto fiscal cadastrado no Bling. O código interno vem do próprio
    // cadastro; se ele estiver vazio, não reaproveitamos o código MLB do anúncio.
    itens.push({
      ...item,
      codigo: product.codigo || undefined,
      descricao: TARGET_FISCAL_PRODUCT,
      unidade: product.unidade || item.unidade || "UN",
      ncm: TARGET_NCM
    });
    changed = true;
  }

  if (!changed) return options;

  return {
    ...options,
    body: JSON.stringify({
      ...payload,
      itens
    })
  };
}

function installBlingFiscalProductLink() {
  if (blingService.__fiscalProductLinkInstalled) return;

  blingService.blingFetch = async function linkedBlingFetch(path, options = {}) {
    const enrichedOptions = await enrichNfeOptions(path, options);
    return originalBlingFetch(path, enrichedOptions);
  };

  Object.defineProperty(blingService, "__fiscalProductLinkInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

module.exports = {
  installBlingFiscalProductLink,
  findRegisteredBlingProduct,
  looksLikeComputerDescription
};
