const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");

const PLUGGY_API_BASE = "https://api.pluggy.ai";
const REQUEST_TIMEOUT_MS = 20000;
const API_KEY_CACHE_MS = 90 * 60 * 1000;
let cachedApiKey = null;
let cachedApiKeyAt = 0;

function configured() {
  return Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function pluggyRequest(path, options = {}, apiKey = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLUGGY_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { "X-API-KEY": apiKey } : {}),
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || data?.codeDescription || `Pluggy respondeu HTTP ${response.status}.`);
      error.httpStatus = response.status;
      error.detail = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getApiKey(force = false) {
  if (!configured()) throw new Error("Credenciais Pluggy ainda não configuradas no Railway.");
  if (!force && cachedApiKey && Date.now() - cachedApiKeyAt < API_KEY_CACHE_MS) return cachedApiKey;

  const data = await pluggyRequest("/auth", {
    method: "POST",
    body: JSON.stringify({
      clientId: process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET
    })
  });

  const key = data?.apiKey || data?.accessToken || data?.token;
  if (!key) throw new Error("A Pluggy autenticou, mas não devolveu uma API Key utilizável.");
  cachedApiKey = key;
  cachedApiKeyAt = Date.now();
  return key;
}

async function apiKeyRequest(path, options = {}) {
  let key = await getApiKey();
  try {
    return await pluggyRequest(path, options, key);
  } catch (error) {
    if (error.httpStatus !== 401 && error.httpStatus !== 403) throw error;
    key = await getApiKey(true);
    return pluggyRequest(path, options, key);
  }
}

async function upsertConnection(itemId, item = {}) {
  const { data: rows, error: findError } = await supabase
    .from("financial_connections")
    .select("id")
    .eq("provider", "pluggy")
    .eq("external_connection_id", itemId)
    .limit(1);
  if (findError) throw new Error(`Erro lendo conexões financeiras: ${findError.message}`);

  const connector = item?.connector || {};
  const record = {
    provider: "pluggy",
    institution_name: connector?.name || item?.name || "Instituição financeira",
    connection_type: "open_finance",
    status: "connected",
    external_connection_id: itemId,
    read_only: true,
    last_sync_at: nowIso(),
    metadata: {
      connector_id: connector?.id || null,
      connector_name: connector?.name || null,
      item_status: item?.status || item?.executionStatus || null
    },
    updated_at: nowIso()
  };

  if (rows?.[0]?.id) {
    const { error } = await supabase.from("financial_connections").update(record).eq("id", rows[0].id);
    if (error) throw new Error(`Erro atualizando conexão financeira: ${error.message}`);
  } else {
    const { error } = await supabase.from("financial_connections").insert(record);
    if (error) throw new Error(`Erro salvando conexão financeira: ${error.message}`);
  }
}

async function upsertPluggyAccounts(itemId, item, accounts) {
  const { data: existing, error: existingError } = await supabase
    .from("financial_accounts")
    .select("id,metadata")
    .eq("source", "pluggy");
  if (existingError) throw new Error(`Erro lendo contas financeiras: ${existingError.message}`);

  const byExternalId = new Map();
  for (const row of existing || []) {
    const id = row?.metadata?.pluggy_account_id;
    if (id) byExternalId.set(String(id), row.id);
  }

  let saved = 0;
  let bankBalance = 0;
  let creditBalance = 0;
  for (const account of accounts || []) {
    if (!account?.id) continue;
    if (account?.currencyCode && String(account.currencyCode).toUpperCase() !== "BRL") continue;

    const type = String(account.type || "BANK").toUpperCase();
    const isCredit = type === "CREDIT";
    const balance = Number(num(account.balance).toFixed(2));
    const record = {
      name: String(account.marketingName || account.name || `${isCredit ? "Cartão" : "Conta"} ${account.number || ""}`).trim(),
      account_type: isCredit ? "liability" : "asset",
      category: isCredit ? "Cartões" : "Banco",
      source: "pluggy",
      current_balance: Math.abs(balance),
      include_in_total: true,
      active: true,
      metadata: {
        pluggy_account_id: String(account.id),
        pluggy_item_id: String(itemId),
        account_type: type,
        subtype: account.subtype || null,
        masked_number: account.number || null,
        currency: account.currencyCode || "BRL",
        institution: item?.connector?.name || null,
        last_synced_at: nowIso()
      },
      updated_at: nowIso()
    };

    const rowId = byExternalId.get(String(account.id));
    if (rowId) {
      const { error } = await supabase.from("financial_accounts").update(record).eq("id", rowId);
      if (error) throw new Error(`Erro atualizando conta bancária: ${error.message}`);
    } else {
      const { error } = await supabase.from("financial_accounts").insert(record);
      if (error) throw new Error(`Erro salvando conta bancária: ${error.message}`);
    }

    if (isCredit) creditBalance += Math.abs(balance);
    else bankBalance += balance;
    saved += 1;
  }

  return {
    saved,
    bank_balance: Number(bankBalance.toFixed(2)),
    credit_balance: Number(creditBalance.toFixed(2))
  };
}

async function syncItem(itemId) {
  const safeItemId = String(itemId || "").trim();
  if (!safeItemId) throw new Error("itemId da conexão bancária não informado.");

  const [item, accountsPayload] = await Promise.all([
    apiKeyRequest(`/items/${encodeURIComponent(safeItemId)}`),
    apiKeyRequest(`/accounts?itemId=${encodeURIComponent(safeItemId)}`)
  ]);

  const accounts = Array.isArray(accountsPayload?.results)
    ? accountsPayload.results
    : Array.isArray(accountsPayload?.data)
      ? accountsPayload.data
      : Array.isArray(accountsPayload)
        ? accountsPayload
        : [];

  await upsertConnection(safeItemId, item || {});
  const result = await upsertPluggyAccounts(safeItemId, item || {}, accounts);
  return {
    item_id: safeItemId,
    institution: item?.connector?.name || item?.name || "Instituição financeira",
    item_status: item?.status || item?.executionStatus || null,
    accounts: accounts.length,
    ...result
  };
}

router.get("/api/finance/open-finance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_connections")
      .select("id,institution_name,status,external_connection_id,last_sync_at")
      .eq("provider", "pluggy")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);

    res.json({
      sucesso: true,
      provider: "pluggy",
      configured: configured(),
      mode: "read_only",
      connections: data || [],
      required_env: configured() ? [] : ["PLUGGY_CLIENT_ID", "PLUGGY_CLIENT_SECRET"]
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/open-finance/connect-token", async (req, res) => {
  try {
    if (!configured()) {
      return res.status(503).json({
        sucesso: false,
        configured: false,
        mensagem: "Faltam PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Railway."
      });
    }
    const key = await getApiKey();
    const payload = await pluggyRequest("/connect_token", {
      method: "POST",
      body: JSON.stringify({
        options: {
          clientUserId: "matrix-ai-commerce",
          avoidDuplicates: true
        }
      })
    }, key);
    const accessToken = payload?.accessToken || payload?.connectToken || payload?.token;
    if (!accessToken) throw new Error("A Pluggy não devolveu o Connect Token.");
    res.json({ sucesso: true, accessToken, provider: "pluggy", mode: "read_only" });
  } catch (error) {
    res.status(error.httpStatus || 500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/open-finance/connected", async (req, res) => {
  try {
    const itemId = req.body?.itemId || req.body?.item_id || req.body?.item?.id;
    const result = await syncItem(itemId);
    res.json({ sucesso: true, mensagem: "Banco conectado e saldos importados com sucesso.", resultado: result });
  } catch (error) {
    res.status(error.httpStatus || 500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/open-finance/sync", async (req, res) => {
  try {
    if (!configured()) return res.status(503).json({ sucesso: false, configured: false, mensagem: "Pluggy ainda não configurada." });
    const { data, error } = await supabase
      .from("financial_connections")
      .select("external_connection_id,institution_name,status")
      .eq("provider", "pluggy")
      .not("external_connection_id", "is", null);
    if (error) throw new Error(error.message);

    const results = [];
    for (const connection of data || []) {
      try {
        results.push({ sucesso: true, ...(await syncItem(connection.external_connection_id)) });
      } catch (error) {
        results.push({ sucesso: false, item_id: connection.external_connection_id, institution: connection.institution_name, mensagem: error.message });
      }
    }
    res.json({ sucesso: true, connections: results.length, resultados: results });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
