const router = require("express").Router();
const { supabase } = require("../db/supabase");

const BASE = "https://api.pluggy.ai";
const CLIENT_USER_ID = "matrix-ai-commerce";
const POLL_MS = 2500;
const POLL_LIMIT = 18;
const FORCED_REFRESH_GUARD_MS = 55 * 60 * 1000;
let keyCache = null;
let keyAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function configured() {
  return Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
}

async function rawRequest(path, options = {}, apiKey = null) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body != null ? { "Content-Type": "application/json" } : {}),
      ...(apiKey ? { "X-API-KEY": apiKey } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  return { response, data };
}

async function apiKey(force = false) {
  if (!configured()) throw new Error("Pluggy não configurada.");
  if (!force && keyCache && Date.now() - keyAt < 80 * 60 * 1000) return keyCache;
  const { response, data } = await rawRequest("/auth", {
    method: "POST",
    body: JSON.stringify({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET })
  });
  if (!response.ok) throw new Error(`Pluggy auth HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
  keyCache = data?.apiKey || data?.accessToken || data?.token;
  if (!keyCache) throw new Error("Pluggy não retornou API Key.");
  keyAt = Date.now();
  return keyCache;
}

async function request(path, options = {}) {
  let key = await apiKey(false);
  let result = await rawRequest(path, options, key);
  if (result.response.status === 401 || result.response.status === 403) {
    key = await apiKey(true);
    result = await rawRequest(path, options, key);
  }
  return result;
}

function itemStatus(item) {
  return String(item?.status || item?.executionStatus || "UNKNOWN").toUpperCase();
}

function isUpdating(status) {
  return ["UPDATING", "LOGIN_IN_PROGRESS", "CREATING", "WAITING_USER_INPUT", "WAITING_USER_ACTION"].includes(status);
}

async function triggerRefresh(itemId) {
  const { response, data } = await request(`/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({ clientUserId: CLIENT_USER_ID })
  });
  if (response.ok) return { triggered: true, status: itemStatus(data), detail: null };

  const code = String(data?.code || data?.error || data?.message || "");
  const tolerated = response.status === 409 ||
    /ITEM_ALREADY_UPDATING|BEFORE_ALLOWED_FREQUENCY|CLIENT_IS_UPDATING|UPDATE_NOT_ALLOWED/i.test(code);
  if (tolerated) return { triggered: false, status: null, detail: code || `HTTP ${response.status}` };
  throw new Error(`Pluggy update HTTP ${response.status}: ${data?.message || data?.error || data?.codeDescription || "erro"}`);
}

async function waitRefresh(itemId) {
  let item = null;
  for (let i = 0; i < POLL_LIMIT; i++) {
    const { response, data } = await request(`/items/${encodeURIComponent(itemId)}`);
    if (!response.ok) throw new Error(`Pluggy item HTTP ${response.status}`);
    item = data;
    const status = itemStatus(item);
    if (!isUpdating(status)) return item;
    await sleep(POLL_MS);
  }
  return item;
}

async function loadAccounts(itemId) {
  const { response, data } = await request(`/accounts?itemId=${encodeURIComponent(itemId)}`);
  if (!response.ok) throw new Error(`Pluggy accounts HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
  return Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
}

async function saveAccounts(itemId, item, accounts) {
  const { data: existing, error } = await supabase
    .from("financial_accounts")
    .select("id,metadata")
    .eq("source", "pluggy");
  if (error) throw new Error(`Erro lendo contas Pluggy: ${error.message}`);

  const byExternal = new Map();
  for (const row of existing || []) {
    const id = row?.metadata?.pluggy_account_id;
    if (id) byExternal.set(String(id), row.id);
  }

  const saved = [];
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
      current_balance: isCredit ? Math.abs(balance) : balance,
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
        last_synced_at: nowIso(),
        balance_source: "pluggy_after_item_update"
      },
      updated_at: nowIso()
    };
    const rowId = byExternal.get(String(account.id));
    if (rowId) {
      const { error: updateError } = await supabase.from("financial_accounts").update(record).eq("id", rowId);
      if (updateError) throw new Error(`Erro atualizando conta Pluggy: ${updateError.message}`);
    } else {
      const { error: insertError } = await supabase.from("financial_accounts").insert(record);
      if (insertError) throw new Error(`Erro salvando conta Pluggy: ${insertError.message}`);
    }
    saved.push({ id: String(account.id), name: record.name, balance, type });
  }
  return saved;
}

async function updateConnection(itemId, item, refreshInfo) {
  const { data: rows } = await supabase
    .from("financial_connections")
    .select("id,metadata")
    .eq("provider", "pluggy")
    .eq("external_connection_id", String(itemId))
    .limit(1);
  if (!rows?.[0]?.id) return;
  const metadata = {
    ...(rows[0].metadata || {}),
    item_status: itemStatus(item),
    connector_id: item?.connector?.id || rows[0]?.metadata?.connector_id || null,
    connector_name: item?.connector?.name || rows[0]?.metadata?.connector_name || null,
    matrix_last_live_refresh_at: nowIso(),
    matrix_last_forced_refresh_at: refreshInfo?.triggered ? nowIso() : rows[0]?.metadata?.matrix_last_forced_refresh_at || null,
    matrix_refresh_detail: refreshInfo?.detail || null
  };
  await supabase.from("financial_connections").update({
    status: itemStatus(item) === "UPDATED" ? "connected" : String(itemStatus(item)).toLowerCase(),
    last_sync_at: nowIso(),
    metadata,
    updated_at: nowIso()
  }).eq("id", rows[0].id);
}

async function refreshAndSync(itemId) {
  const refreshInfo = await triggerRefresh(itemId);
  const item = await waitRefresh(itemId);
  const accounts = await loadAccounts(itemId);
  const saved = await saveAccounts(itemId, item || {}, accounts);
  await updateConnection(itemId, item || {}, refreshInfo);
  return {
    item_id: String(itemId),
    institution: item?.connector?.name || "Instituição financeira",
    item_status: itemStatus(item),
    refresh_triggered: refreshInfo.triggered,
    refresh_detail: refreshInfo.detail,
    accounts: saved
  };
}

async function allConnections() {
  const { data, error } = await supabase
    .from("financial_connections")
    .select("external_connection_id,institution_name,metadata")
    .eq("provider", "pluggy")
    .not("external_connection_id", "is", null);
  if (error) throw new Error(error.message);
  return data || [];
}

function recentlyForced(connection) {
  const last = new Date(connection?.metadata?.matrix_last_forced_refresh_at || 0).getTime();
  return Number.isFinite(last) && last > 0 && Date.now() - last < FORCED_REFRESH_GUARD_MS;
}

router.post("/api/finance/open-finance/sync", async (req, res) => {
  try {
    if (!configured()) return res.status(503).json({ sucesso: false, mensagem: "Pluggy ainda não configurada." });
    const connections = await allConnections();
    const results = [];

    // Atualiza instituição por instituição. Evita duas execuções concorrentes na
    // Pluggy e garante que Cora, Mercado Pago e futuras conexões usem o mesmo
    // fluxo: PATCH do Item -> aguarda conclusão -> lê e grava o saldo novo.
    for (const connection of connections) {
      try {
        results.push({ sucesso: true, ...(await refreshAndSync(connection.external_connection_id)) });
      } catch (error) {
        results.push({
          sucesso: false,
          item_id: connection.external_connection_id,
          institution: connection.institution_name,
          mensagem: error.message
        });
      }
    }

    res.json({ sucesso: true, connections: results.length, resultados: results });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

// Na inicialização, todas as conexões Pluggy recebem o mesmo tratamento de
// atualização em tempo real. A trava individual de 55 minutos evita que novos
// deploys forcem a mesma instituição repetidamente.
const startup = setTimeout(async () => {
  try {
    if (!configured()) return;
    const connections = await allConnections();

    for (const connection of connections) {
      const institution = connection.institution_name || "Instituição financeira";
      if (recentlyForced(connection)) {
        console.log(`[Pluggy Live Refresh] ${institution}: ignorado, atualização forçada recente.`);
        continue;
      }

      try {
        const result = await refreshAndSync(connection.external_connection_id);
        console.log(`[Pluggy Live Refresh] ${institution}:`, result);
      } catch (error) {
        console.warn(`[Pluggy Live Refresh] ${institution}: atualização inicial falhou:`, error.message);
      }

      await sleep(500);
    }
  } catch (error) {
    console.warn("[Pluggy Live Refresh] atualização inicial das conexões falhou:", error.message);
  }
}, 10000);
startup.unref?.();

module.exports = router;
