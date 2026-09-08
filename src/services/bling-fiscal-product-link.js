const blingService = require("./bling");

const originalBlingFetch = blingService.blingFetch;
const CACHE_TTL_MS = 10 * 60 * 1000;
const productCache = new Map();

// Estas são as descrições fiscais que a Matrix já gera a partir dos anúncios.
// Em vez de manter NCM fixo no código, localizamos o produto cadastrado no
// próprio Bling e usamos os dados fiscais desse cadastro como fonte oficial.
const LINKED_FISCAL_PRODUCTS = new Set([
  "gabinete gamer",
  "gabinete officer"
]);

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

async function findRegisteredBlingProduct(description) {
  const normalized = normalizeName(description);
  const cached = productCache.get(normalized);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return cached.product;
  }

  const params = new URLSearchParams({
    pagina: "1",
    limite: "100",
    criterio: "2",
    tipo: "P",
    nome: description
  });

  const searchResponse = await originalBlingFetch(
    `/produtos?${params.toString()}`,
    { method: "GET" }
  );
  const searchPayload = await readJson(searchResponse);

  if (!searchResponse.ok) {
    const error = new Error(
      `Bling recusou a busca do produto fiscal "${description}": ${JSON.stringify(searchPayload)}`
    );
    error.httpStatus = searchResponse.status;
    error.detail = searchPayload;
    throw error;
  }

  const rows = Array.isArray(searchPayload?.data)
    ? searchPayload.data
    : [];

  const exact = rows.filter(
    row => normalizeName(row?.nome) === normalized
  );

  let selected = null;

  if (exact.length === 1) {
    selected = exact[0];
  } else if (exact.length > 1) {
    // Se houver duplicados com o mesmo nome, privilegia um único ativo.
    const active = exact.filter(
      row => String(row?.situacao || "").toUpperCase() === "A"
    );
    if (active.length === 1) selected = active[0];
  }

  if (!selected) {
    const close = rows.filter(row => {
      const name = normalizeName(row?.nome);
      return name.includes(normalized) || normalized.includes(name);
    });
    if (close.length === 1) selected = close[0];
  }

  if (!selected?.id) {
    throw makeFiscalError(
      `Produto fiscal "${description}" não foi localizado de forma única no cadastro do Bling. A NF-e não será criada até esse vínculo estar correto.`,
      { encontrados: rows.map(row => ({ id: row?.id, nome: row?.nome, codigo: row?.codigo })) }
    );
  }

  const detailResponse = await originalBlingFetch(
    `/produtos/${encodeURIComponent(String(selected.id))}`,
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

  const detail = detailPayload?.data || detailPayload || {};
  const ncm = digitsOnly(detail?.tributacao?.ncm);

  if (ncm.length !== 8) {
    throw makeFiscalError(
      `O produto "${detail?.nome || description}" foi encontrado no Bling, mas o cadastro não possui um NCM válido de 8 dígitos.`,
      { produto_id: detail?.id || selected.id, ncm: detail?.tributacao?.ncm || null }
    );
  }

  const product = {
    id: String(detail?.id || selected.id),
    nome: detail?.nome || selected?.nome || description,
    codigo: detail?.codigo || selected?.codigo || null,
    unidade: detail?.unidade || selected?.unidade || null,
    ncm
  };

  productCache.set(normalized, {
    savedAt: Date.now(),
    product
  });

  return product;
}

function isNfeCreateOrUpdate(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  if (!['POST', 'PUT'].includes(method)) return false;

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

    // Replica pela API o que a Larissa faz na tela do Bling: parte da
    // descrição, encontra o produto já cadastrado e passa a usar código,
    // descrição, unidade e principalmente o NCM desse cadastro.
    itens.push({
      ...item,
      codigo: product.codigo || item.codigo,
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
