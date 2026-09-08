const blingService = require("./bling");

function isNfeCreateOrUpdate(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  if (!["POST", "PUT"].includes(method)) return false;

  const cleanPath = String(path || "").split("?")[0];
  return cleanPath === "/nfe" || /^\/nfe\/[^/]+$/.test(cleanPath);
}

function saoPauloToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const map = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );

  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function normalizeParcelDates(payload) {
  if (!Array.isArray(payload?.parcelas) || !payload.parcelas.length) {
    return payload;
  }

  const today = saoPauloToday();

  return {
    ...payload,
    parcelas: payload.parcelas.map(parcela => {
      const informed = normalizeDate(
        parcela?.data ??
        parcela?.dataVencimento ??
        parcela?.vencimento
      );

      // A SEFAZ rejeita a NF-e quando o vencimento fica antes da data de emissão.
      // Como as vendas do ML já estão pagas, usamos vencimento à vista na data
      // corrente da operação fiscal. Isso também corrige rascunhos criados ontem.
      const dueDate = !informed || informed < today
        ? today
        : informed;

      const cleaned = { ...parcela, data: dueDate };
      delete cleaned.dataVencimento;
      delete cleaned.vencimento;
      return cleaned;
    })
  };
}

function installBlingNfeParcelDateGuard() {
  if (blingService.__nfeParcelDateGuardInstalled) return;

  const previousBlingFetch = blingService.blingFetch;

  blingService.blingFetch = async function parcelDateGuardBlingFetch(
    path,
    options = {}
  ) {
    if (!isNfeCreateOrUpdate(path, options)) {
      return previousBlingFetch(path, options);
    }

    if (typeof options?.body !== "string" || !options.body.trim()) {
      return previousBlingFetch(path, options);
    }

    let payload;
    try {
      payload = JSON.parse(options.body);
    } catch {
      return previousBlingFetch(path, options);
    }

    const normalized = normalizeParcelDates(payload);

    return previousBlingFetch(path, {
      ...options,
      body: JSON.stringify(normalized)
    });
  };

  Object.defineProperty(
    blingService,
    "__nfeParcelDateGuardInstalled",
    {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    }
  );
}

module.exports = {
  installBlingNfeParcelDateGuard
};
