const blingService = require("./bling");

const originalBlingFetch = blingService.blingFetch;
const CACHE_TTL_MS = 10 * 60 * 1000;
const productCache = new Map();

// Descrições fiscais geradas pela Matrix e aliases aceitos no cadastro do Bling.
// "GABINETE OFFICER" ficou mantido por compatibilidade com o fluxo atual,
// mas também aceitamos "GABINETE OFFICE", que é uma grafia comum no cadastro.
const FISCAL_PRODUCT_ALIASES = new Map([
  ["gabinete gamer", ["gabinete gamer"]],
  ["gabinete officer", ["gabinete officer", "gabinete office"]]
]);

const LINKED_FISCAL_PRODUCTS = new Set(FISCAL_PRODUCT_ALIASES.keys());

// Código interno usado pela Shop Matrix no Bling para os itens fiscais.
// Atenção: este campo é o CÓDIGO DO PRODUTO exibido no DANFE; ele não altera
// o CFOP tributário da operação, que continua sendo definido pela Natureza de Operação.
const MATRIX_FISCAL_ITEM_CODE = "CFOP5102";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

function candidateScore(row, wanted, aliases) {
  const name = normalizeName(row?.nome);
  const code = String(row?.codigo || "").trim().toUpperCase();
  let score = 0;

  if (name === wanted) score += 1000;
  else if (aliases.includes(name)) score += 800;
  else if (aliases.some(alias => name.includes(alias) || alias.includes(name))) score += 500;

  if (isActiveProduct(row)) score += 100;
  if (code === MATRIX_FISCAL_ITEM_CODE) score += 10000;
  else if (row?.codigo) score += 10;

  return score;
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

async function findRegisteredBlingProduct(description) {
  const normalized = normalizeName(description);
  const cached = productCache.get(normalized);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return cached.product;
  }

  const aliases = (FISCAL_PRODUCT_ALIASES.get(normalized) || [normalized])
    .map(normalizeName)
    .filter(Boolean);

  // Pesquisa tanto pela descrição original quanto pelos aliases.
  // Deduplicamos pelo ID porque o mesmo cadastro pode aparecer em mais de uma busca.
  const candidatesById = new Map();

  for (const alias of aliases) {
    const rows = await searchProductsByName(alias);
    for (const row of rows) {
      if (row?.id == null) continue;
      candidatesById.set(String(row.id), row);
    }
  }

  const candidates = [...candidatesById.values()]
    .map(row => ({
      row,
      score: candidateScore(row, normalized, aliases)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Number(a.row?.id || 0) - Number(b.row?.id || 0);
    });

  if (!candidates.length) {
    throw makeFiscalError(
      `Produto fiscal "${description}" não foi localizado no cadastro do Bling. A NF-e não será criada até esse vínculo estar correto.`,
      { aliases_procurados: aliases }
    );
  }

  // Não bloqueamos mais só porque existem duplicados com o mesmo nome.
  // Tentamos, na ordem de melhor correspondência, o primeiro cadastro com NCM válido.
  const invalidCandidates = [];

  for (const candidate of candidates) {
    const selected = candidate.row;
    const detail = await fetchProductDetail(selected.id, description);
    const ncm = digitsOnly(detail?.tributacao?.ncm);

    if (ncm.length !== 8) {
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
      nome: detail?.nome || selected?.nome || description,
      codigo: MATRIX_FISCAL_ITEM_CODE,
      unidade: detail?.unidade || selected?.unidade || null,
      ncm
    };

    if (candidates.length > 1) {
      console.warn(
        `[Bling fiscal product] ${description}: ${candidates.length} candidatos encontrados; usando ID ${product.id} (${product.nome}) com código ${MATRIX_FISCAL_ITEM_CODE}.`
      );
    }

    productCache.set(normalized, {
      savedAt: Date.now(),
      product
    });

    return product;
  }

  throw makeFiscalError(
    `Os cadastros encontrados para "${description}" no Bling não possuem NCM válido de 8 dígitos.`,
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

  let changed = false;
  const resolved = new Map();
  const itens = [];

  for (const item of payload.itens) {
    const description = String(item?.descricao || "").trim();
    const normalized = normalizeName(description);

    if (!LINKED_FISCAL_PRODUCTS.has(normalized)) {
      itens.push(item);
      continue;
    }

    let product = resolved.get(normalized);
    if (!product) {
      product = await findRegisteredBlingProduct(description);
      resolved.set(normalized, product);
    }

    // Replica pela API o cadastro fiscal usado pela Shop Matrix no Bling.
    // Nunca deixa o SKU/MLB do Mercado Livre escapar para o campo Código do DANFE.
    itens.push({
      ...item,
      codigo: MATRIX_FISCAL_ITEM_CODE,
      descricao: product.nome,
      unidade: product.unidade || item.unidade || "UN",
      ncm: product.ncm
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
  findRegisteredBlingProduct
};
