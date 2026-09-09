const blingService = require("./bling");
const { supabase } = require("../db/supabase");

const originalBlingFetch = blingService.blingFetch;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CUSTOMER_FISCAL_CACHE_TTL_MS = 5 * 60 * 1000;
const productCache = new Map();
const customerFiscalCache = new Map();

const TARGET_FISCAL_PRODUCT = "GABINETE DE COMPUTADOR";
const TARGET_FISCAL_PRODUCT_NORMALIZED = "gabinete de computador";
const TARGET_NCM = "84733019";

// Termos definidos pela Shop Matrix + variações comuns dos anúncios.
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

function hasComputerHardwareSignature(normalized) {
  // Há anúncios em que o título não contém literalmente PC/computador, mas
  // descreve claramente uma máquina completa, como "Intel Core i5 480 GB".
  // Nesses casos exigimos assinatura de processador + memória/armazenamento,
  // reduzindo o risco de classificar um componente avulso como gabinete.
  const processor =
    /\bintel\s+core\b/.test(normalized) ||
    /\bcore\s+i[3579]\b/.test(normalized) ||
    /\bi[3579]\s*[- ]?\d{3,5}[a-z]{0,2}\b/.test(normalized) ||
    /\bryzen\s*[3579]?\b/.test(normalized) ||
    /\bathlon\b/.test(normalized) ||
    /\bceleron\b/.test(normalized) ||
    /\bpentium\b/.test(normalized) ||
    /\bxeon\b/.test(normalized);

  const memory =
    /\b(?:4|6|8|12|16|24|32|48|64|128)\s*gb\b/.test(normalized) ||
    /\bram\b/.test(normalized);

  const storage =
    /\b(?:ssd|hdd|nvme|hd)\b/.test(normalized) ||
    /\b\d{2,4}\s*gb\b/.test(normalized) ||
    /\b\d+(?:[.,]\d+)?\s*tb\b/.test(normalized);

  const operatingSystem = /\bwindows\s*(?:10|11)?\b/.test(normalized);

  return processor && (memory || storage || operatingSystem);
}

function looksLikeComputerDescription(description) {
  const normalized = normalizeName(description);
  if (!normalized) return false;

  if (
    COMPUTER_KEYWORDS.some(keyword =>
      containsWholeTerm(normalized, normalizeName(keyword))
    )
  ) {
    return true;
  }

  return hasComputerHardwareSignature(normalized);
}

function getNestedBillingInfo(customer) {
  const raw = customer?.raw_data || {};
  const billingRoot = raw?.billing_info || raw?.billingInfo || null;

  return (
    billingRoot?.buyer?.billing_info ||
    billingRoot?.buyer?.billingInfo ||
    billingRoot?.billing_info ||
    billingRoot?.billingInfo ||
    null
  );
}

function additionalInfoValue(billing, type) {
  const rows = Array.isArray(billing?.additional_info)
    ? billing.additional_info
    : Array.isArray(billing?.additionalInfo)
      ? billing.additionalInfo
      : [];

  const found = rows.find(
    row => String(row?.type || "").toUpperCase() === String(type).toUpperCase()
  );

  return found?.value == null ? null : String(found.value).trim();
}

function extractCustomerFiscalData(customer) {
  const billing = getNestedBillingInfo(customer) || {};
  const taxes = billing?.taxes || {};

  const stateRegistration = String(
    taxes?.inscriptions?.state_registration ||
    taxes?.inscriptions?.stateRegistration ||
    additionalInfoValue(billing, "STATE_REGISTRATION") ||
    ""
  ).trim();

  const taxpayerDescription = String(
    taxes?.taxpayer_type?.description ||
    taxes?.taxpayerType?.description ||
    additionalInfoValue(billing, "TAXPAYER_TYPE_ID") ||
    ""
  ).trim();

  return {
    stateRegistration: stateRegistration || null,
    taxpayerDescription: taxpayerDescription || null
  };
}

async function findCustomerFiscalByDocument(documentNumber) {
  const document = digitsOnly(documentNumber);
  if (!document) return null;

  const cached = customerFiscalCache.get(document);
  if (cached && Date.now() - cached.savedAt < CUSTOMER_FISCAL_CACHE_TTL_MS) {
    return cached.value;
  }

  const { data, error } = await supabase
    .from("customers")
    .select("document_type,document_number,raw_data")
    .eq("document_number", document)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      `[Bling fiscal customer] Não foi possível consultar dados fiscais do CNPJ ${document}:`,
      error.message
    );
    return null;
  }

  const value = data
    ? {
        documentType: String(data.document_type || "").toUpperCase(),
        ...extractCustomerFiscalData(data)
      }
    : null;

  customerFiscalCache.set(document, {
    savedAt: Date.now(),
    value
  });

  return value;
}

function taxpayerIndicator(fiscal) {
  if (!fiscal) return null;
  if (fiscal.stateRegistration) return 1;

  const normalized = normalizeName(fiscal.taxpayerDescription);
  if (!normalized) return null;

  if (
    normalized.includes("nao contribuinte") ||
    normalized.includes("consumidor final")
  ) {
    return 9;
  }

  if (normalized.includes("contribuinte")) return 1;
  return null;
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

  let changed = false;
  let contact = payload?.contato;

  // Mercado Livre entrega a IE da pessoa jurídica em
  // buyer.billing_info.taxes.inscriptions.state_registration. A Matrix já
  // guarda o Billing Info integral no cliente; aqui recolocamos a IE no
  // snapshot da NF-e mesmo se o cadastro do contato no Bling estiver vazio.
  const contactDocument = digitsOnly(contact?.numeroDocumento);
  if (contact && contactDocument.length === 14) {
    const fiscal = await findCustomerFiscalByDocument(contactDocument);
    const indicator = taxpayerIndicator(fiscal);

    if (fiscal?.stateRegistration || indicator) {
      contact = {
        ...contact,
        ie: contact?.ie || fiscal?.stateRegistration || undefined,
        contribuinte:
          Number(contact?.contribuinte) > 0
            ? Number(contact.contribuinte)
            : indicator || undefined
      };
      changed = true;
    }
  }

  let product = null;
  let itens = payload?.itens;

  if (Array.isArray(payload?.itens) && payload.itens.length) {
    itens = [];

    for (const item of payload.itens) {
      const description = String(item?.descricao || "").trim();

      if (!looksLikeComputerDescription(description)) {
        itens.push(item);
        continue;
      }

      if (!product) {
        product = await findRegisteredBlingProduct();
      }

      itens.push({
        ...item,
        codigo: product.codigo || item.codigo || String(product.id),
        descricao: TARGET_FISCAL_PRODUCT,
        produto: { id: Number(product.id) },
        unidade: product.unidade || item.unidade || "UN",
        ncm: TARGET_NCM,
        classificacaoFiscal: TARGET_NCM
      });
      changed = true;
    }
  }

  if (!changed) return options;

  return {
    ...options,
    body: JSON.stringify({
      ...payload,
      contato: contact,
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
  looksLikeComputerDescription,
  extractCustomerFiscalData
};
