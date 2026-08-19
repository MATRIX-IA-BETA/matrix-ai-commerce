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
  const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || 21600) * 1000).toISOString();

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
    if (error) throw new Error(`Erro atualizando token Bling: ${error.message}`);
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
  return Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64");
}

async function refreshBlingToken(account) {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET) {
    throw new Error("BLING_CLIENT_ID/BLING_CLIENT_SECRET não configurados.");
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

  const data = await response.json();
  if (!response.ok) throw new Error(`Bling recusou refresh: ${JSON.stringify(data)}`);
  return saveBlingToken(data);
}

async function ensureValidBlingAccount() {
  let account = await getBlingAccount();
  if (!account) throw new Error("Bling ainda não conectado.");

  const expiresAt = new Date(account.expires_at || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60 * 1000) {
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

async function createOrUpdateBlingContact(customer) {
  if (customer.bling_contact_id) return customer.bling_contact_id;

  const payload = {
    nome: customer.name,
    tipo: customer.document_type === "CNPJ" ? "J" : "F",
    numeroDocumento: customer.document_number || undefined,
    email: customer.email || undefined,
    celular: customer.phone || undefined,
    endereco: {
      endereco: customer.address_line || undefined,
      numero: customer.address_number || undefined,
      bairro: customer.neighborhood || undefined,
      cep: customer.zip_code || undefined,
      municipio: customer.city || undefined,
      uf: customer.state || undefined
    }
  };

  const response = await blingFetch("/contatos", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Erro criando contato no Bling: ${JSON.stringify(data)}`);
  }

  const blingId = data?.data?.id || data?.id;
  if (!blingId) throw new Error("Bling criou contato sem retornar ID.");

  await supabase
    .from("customers")
    .update({ bling_contact_id: String(blingId), updated_at: nowIso() })
    .eq("id", customer.id);

  return String(blingId);
}


module.exports = {
  getBlingAccount,
  saveBlingToken,
  blingBasicAuth,
  refreshBlingToken,
  ensureValidBlingAccount,
  blingFetch,
  createOrUpdateBlingContact
};
