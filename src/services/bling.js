const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");

const BLING_CLIENT_ID = env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = env.BLING_CLIENT_SECRET;
const BLING_API_BASE = env.BLING_API_BASE;

async function getBlingAccount() {
  const { data, error } = await supabase
    .from("bling_accounts")
    .select("*")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Erro buscando conta Bling: ${error.message}`);
  return data;
}

async function saveBlingToken(tokenData) {
  const expiresAt = new Date(
    Date.now() + Number(tokenData.expires_in || 21600) * 1000
  ).toISOString();

  const current = await getBlingAccount();

  const record = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || current?.refresh_token || null,
    token_type: tokenData.token_type || "Bearer",
    scope: tokenData.scope || null,
    expires_at: expiresAt,
    active: true,
    updated_at: nowIso()
  };

  if (current) {
    const { data, error } = await supabase
      .from("bling_accounts")
      .update(record)
      .eq("id", current.id)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Erro atualizando token Bling: ${error.message}`);
    }

    return data;
  }

  const { data, error } = await supabase
    .from("bling_accounts")
    .insert(record)
    .select("*")
    .single();

  if (error) throw new Error(`Erro salvando token Bling: ${error.message}`);
  return data;
}

function blingBasicAuth() {
  return Buffer.from(
    `${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`
  ).toString("base64");
}

async function refreshBlingToken(account) {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET) {
    throw new Error(
      "BLING_CLIENT_ID/BLING_CLIENT_SECRET não configurados."
    );
  }

  if (!account?.refresh_token) {
    throw new Error("Refresh token do Bling não encontrado.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refresh_token
  });

  const response = await fetch(`${BLING_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${blingBasicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "enable-jwt": "1"
    },
    body: body.toString()
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Bling recusou refresh: ${JSON.stringify(data)}`);
  }

  return saveBlingToken(data);
}

async function ensureValidBlingAccount() {
  let account = await getBlingAccount();

  if (!account) {
    throw new Error("Bling ainda não conectado.");
  }

  const expiresAt = new Date(account.expires_at || 0).getTime();

  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + 5 * 60 * 1000
  ) {
    account = await refreshBlingToken(account);
  }

  return account;
}

async function blingFetch(path, options = {}) {
  let account = await ensureValidBlingAccount();

  let response = await fetch(`${BLING_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "enable-jwt": "1",
      ...(options.headers || {}),
      Authorization: `Bearer ${account.access_token}`
    }
  });

  if (response.status === 401) {
    account = await refreshBlingToken(account);

    response = await fetch(`${BLING_API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "enable-jwt": "1",
        ...(options.headers || {}),
        Authorization: `Bearer ${account.access_token}`
      }
    });
  }

  return response;
}

function normalizeUf(value) {
  if (!value) return undefined;

  const raw = String(value).trim().toUpperCase();

  if (/^BR-[A-Z]{2}$/.test(raw)) {
    return raw.slice(3);
  }

  if (/^[A-Z]{2}$/.test(raw)) {
    return raw;
  }

  return undefined;
}

function normalizeDocument(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildGeneralAddress(customer) {
  const general = {
    endereco: customer.address_line || undefined,
    numero: customer.address_number || undefined,
    bairro: customer.neighborhood || undefined,
    cep: customer.zip_code
      ? String(customer.zip_code).replace(/\D/g, "")
      : undefined,
    municipio: customer.city || undefined,
    uf: normalizeUf(customer.state)
  };

  return Object.fromEntries(
    Object.entries(general).filter(([, value]) => value !== undefined && value !== "")
  );
}

async function readBlingJson(response) {
  const text = await response.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isDuplicateDocumentError(data) {
  const fields =
    data?.error?.fields ||
    data?.fields ||
    [];

  if (
    Array.isArray(fields) &&
    fields.some(field =>
      /(?:CPF|CNPJ).+já está cadastrado/i.test(String(field?.msg || ""))
    )
  ) {
    return true;
  }

  return /(?:CPF|CNPJ).+já está cadastrado/i.test(
    JSON.stringify(data || {})
  );
}

async function findBlingContactByDocument(documentNumber) {
  const document = normalizeDocument(documentNumber);

  if (!document) return null;

  const params = new URLSearchParams({
    pagina: "1",
    limite: "100",
    criterio: "1",
    numeroDocumento: document
  });

  const response = await blingFetch(
    `/contatos?${params.toString()}`,
    { method: "GET" }
  );

  const data = await readBlingJson(response);

  if (!response.ok) {
    const e = new Error(
      `Erro procurando contato por CPF/CNPJ no Bling: ${JSON.stringify(data)}`
    );
    e.httpStatus = response.status;
    e.detail = data;
    throw e;
  }

  const rows = Array.isArray(data?.data) ? data.data : [];

  return (
    rows.find(
      row => normalizeDocument(row?.numeroDocumento) === document
    ) ||
    rows[0] ||
    null
  );
}

async function saveCustomerBlingContactId(customer, blingId) {
  const normalizedId = String(blingId);

  if (String(customer?.bling_contact_id || "") === normalizedId) {
    return;
  }

  const { error } = await supabase
    .from("customers")
    .update({
      bling_contact_id: normalizedId,
      updated_at: nowIso()
    })
    .eq("id", customer.id);

  if (error) {
    throw new Error(
      `Contato localizado no Bling, mas falhou ao salvar bling_contact_id na Matrix: ${error.message}`
    );
  }

  customer.bling_contact_id = normalizedId;
}

async function updateBlingContact(contactId, payload) {
  const response = await blingFetch(
    `/contatos/${encodeURIComponent(String(contactId))}`,
    {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  );

  const data = await readBlingJson(response);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function useContactFoundByDocument(customer, contact, payload) {
  const contactId = contact?.id;

  if (!contactId) {
    throw new Error(
      "Bling retornou um contato para o CPF/CNPJ, mas sem ID."
    );
  }

  const updated = await updateBlingContact(contactId, payload);

  if (!updated.ok) {
    const e = new Error(
      `Erro atualizando contato correto no Bling: ${JSON.stringify(updated.data)}`
    );
    e.httpStatus = updated.status;
    e.detail = updated.data;
    throw e;
  }

  await saveCustomerBlingContactId(customer, contactId);

  return String(contactId);
}

async function createOrUpdateBlingContact(customer) {
  const generalAddress = buildGeneralAddress(customer);
  const document = normalizeDocument(customer.document_number);

  if (!document) {
    const e = new Error(
      "Cliente sem CPF/CNPJ. O contato não será enviado ao Bling e a NF-e não será criada."
    );
    e.httpStatus = 422;
    throw e;
  }

  const payload = {
    nome: customer.name || "Cliente Mercado Livre",
    situacao: "A",
    tipo: customer.document_type === "CNPJ" ? "J" : "F",
    numeroDocumento: document,
    email: customer.email || undefined,
    celular: customer.phone || undefined,
    endereco:
      Object.keys(generalAddress).length > 0
        ? { geral: generalAddress }
        : undefined
  };

  const cleanPayload = JSON.parse(JSON.stringify(payload));

  // Antes de criar/atualizar, procura pelo CPF/CNPJ. Se o contato já
  // existe no Bling, ele é a referência correta e a Matrix reaponta o ID.
  const contactByDocument = await findBlingContactByDocument(document);

  if (contactByDocument?.id) {
    return useContactFoundByDocument(
      customer,
      contactByDocument,
      cleanPayload
    );
  }

  if (customer.bling_contact_id) {
    const existingId = String(customer.bling_contact_id);
    const updated = await updateBlingContact(
      existingId,
      cleanPayload
    );

    if (updated.ok) {
      return existingId;
    }

    if (isDuplicateDocumentError(updated.data)) {
      const recovered = await findBlingContactByDocument(document);

      if (recovered?.id) {
        return useContactFoundByDocument(
          customer,
          recovered,
          cleanPayload
        );
      }
    }

    if (updated.status !== 404) {
      const e = new Error(
        `Erro atualizando contato no Bling: ${JSON.stringify(updated.data)}`
      );
      e.httpStatus = updated.status;
      e.detail = updated.data;
      throw e;
    }
  }

  const response = await blingFetch("/contatos", {
    method: "POST",
    body: JSON.stringify(cleanPayload)
  });

  const data = await readBlingJson(response);

  if (!response.ok) {
    if (isDuplicateDocumentError(data)) {
      const recovered = await findBlingContactByDocument(document);

      if (recovered?.id) {
        return useContactFoundByDocument(
          customer,
          recovered,
          cleanPayload
        );
      }
    }

    const e = new Error(
      `Erro criando contato no Bling: ${JSON.stringify(data)}`
    );
    e.httpStatus = response.status;
    e.detail = data;
    throw e;
  }

  const blingId = data?.data?.id || data?.id;

  if (!blingId) {
    throw new Error(
      `Bling criou contato sem retornar ID. Resposta: ${JSON.stringify(data)}`
    );
  }

  await saveCustomerBlingContactId(customer, blingId);

  return String(blingId);
}

module.exports = {
  getBlingAccount,
  saveBlingToken,
  blingBasicAuth,
  refreshBlingToken,
  ensureValidBlingAccount,
  blingFetch,
  createOrUpdateBlingContact,
  findBlingContactByDocument
};
