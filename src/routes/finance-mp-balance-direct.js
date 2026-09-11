const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const MP_API = "https://api.mercadopago.com";
const MATRIX_KEY = "mp_available_balance";
const AUTO_SYNC_MS = 2 * 60 * 1000;

let lastResult = null;
let syncInFlight = null;

const money = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

async function getMercadoPagoOauthAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token,expires_at")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  return data || null;
}

async function directMpRequest(path, account) {
  if (!account?.access_token) return { ok: false, status: 0, data: null };
  const response = await fetch(`${MP_API}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${account.access_token}`
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return { ok: response.ok, status: response.status, data };
}

async function fetchBalancePayload() {
  const [mlAccount, mpAccount] = await Promise.all([
    getMercadoLivreAccount().catch(() => null),
    getMercadoPagoOauthAccount().catch(() => null)
  ]);

  const userId = String(mlAccount?.user_id || mpAccount?.user_id || mpAccount?.account_id || "").trim();
  if (!userId) {
    const err = new Error("Não foi possível identificar o user_id da Shop Matrix no Mercado Livre/Mercado Pago.");
    err.code = "MP_AUTH_REQUIRED";
    throw err;
  }

  const path = `/users/${encodeURIComponent(userId)}/mercadopago_account/balance`;
  const attempts = [];

  // Este é o endpoint de saldo usado historicamente pelo SDK oficial do
  // ecossistema Mercado Livre. Primeiro usamos o token do vendedor ML, que é
  // renovado automaticamente pelo serviço compartilhado da Matrix.
  if (mlAccount?.access_token) {
    try {
      const { response } = await mercadoLivreFetch(path, mlAccount);
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      attempts.push({ source: "mercadolibre_balance_api", status: response.status });
      if (response.ok) return { data, source: "mercadolibre_balance_api", userId };
    } catch (error) {
      attempts.push({ source: "mercadolibre_balance_api", status: error?.httpStatus || 0 });
    }
  }

  // Algumas contas aceitam o mesmo recurso no host do Mercado Pago quando o
  // OAuth financeiro possui o escopo correspondente. Testamos apenas como
  // segunda rota; nenhuma resposta inválida altera o saldo salvo.
  if (mpAccount?.access_token) {
    try {
      const result = await directMpRequest(path, mpAccount);
      attempts.push({ source: "mercadopago_balance_api", status: result.status });
      if (result.ok) return { data: result.data, source: "mercadopago_balance_api", userId };
    } catch (error) {
      attempts.push({ source: "mercadopago_balance_api", status: error?.httpStatus || 0 });
    }
  }

  const detail = attempts.map(a => `${a.source}:${a.status || "erro"}`).join(", ");
  const err = new Error(`API direta de saldo não liberada para esta conta (${detail || "sem tentativa válida"}).`);
  err.code = "MP_BALANCE_ENDPOINT_UNAVAILABLE";
  throw err;
}

function extractAvailableBalance(payload) {
  const candidates = [
    payload?.available_balance,
    payload?.availableBalance,
    payload?.available_amount,
    payload?.availableAmount,
    payload?.account?.available_balance,
    payload?.wallet?.available_balance
  ];
  for (const value of candidates) {
    const parsed = money(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractTotalBalance(payload) {
  const candidates = [
    payload?.total_amount,
    payload?.total_balance,
    payload?.totalBalance,
    payload?.account?.total_amount,
    payload?.account?.total_balance,
    payload?.wallet?.total_balance
  ];
  for (const value of candidates) {
    const parsed = money(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

async function saveDirectBalance(userId, availableBalance, totalBalance, source) {
  const now = new Date().toISOString();

  const { data: pluggyRows, error: pluggyError } = await supabase
    .from("financial_accounts")
    .select("id,name,metadata")
    .eq("source", "pluggy")
    .eq("active", true);
  if (pluggyError) throw new Error(pluggyError.message);

  const existingPluggyMp = (pluggyRows || []).find(row =>
    /mercado pago/i.test(String(row?.metadata?.institution || row?.name || ""))
  );

  const metadata = {
    ...(existingPluggyMp?.metadata || {}),
    matrix_key: MATRIX_KEY,
    institution: "Mercado Pago Empresas",
    balance_source: "mercadopago_api_direct",
    balance_endpoint: source,
    available_balance: availableBalance,
    total_balance: totalBalance,
    mp_user_id: String(userId || ""),
    last_synced_at: now
  };

  if (existingPluggyMp?.id) {
    const { error } = await supabase
      .from("financial_accounts")
      .update({
        current_balance: availableBalance,
        include_in_total: true,
        active: true,
        metadata,
        updated_at: now
      })
      .eq("id", existingPluggyMp.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("financial_accounts").insert({
      name: "Mercado Pago Empresas",
      account_type: "asset",
      category: "Banco",
      source: "mercadopago",
      current_balance: availableBalance,
      include_in_total: true,
      active: true,
      metadata,
      updated_at: now
    });
    if (error) throw new Error(error.message);
  }

  const { data: duplicateDirect } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("source", "mercadopago")
    .contains("metadata", { matrix_key: MATRIX_KEY });
  for (const row of duplicateDirect || []) {
    if (!existingPluggyMp?.id) continue;
    await supabase.from("financial_accounts").update({ include_in_total: false, active: false, updated_at: now }).eq("id", row.id);
  }

  return now;
}

async function runSync() {
  const result = await fetchBalancePayload();
  const availableBalance = extractAvailableBalance(result.data);
  const totalBalance = extractTotalBalance(result.data);

  if (availableBalance === null) {
    const keys = Object.keys(result.data || {}).slice(0, 20);
    const err = new Error(`Endpoint de saldo respondeu sem available_balance. Campos: ${keys.join(", ") || "nenhum"}.`);
    err.code = "MP_AVAILABLE_BALANCE_MISSING";
    throw err;
  }

  const syncedAt = await saveDirectBalance(result.userId, availableBalance, totalBalance, result.source);
  lastResult = {
    saldo_disponivel: availableBalance,
    saldo_total: totalBalance,
    fonte: result.source,
    atualizado_em: syncedAt
  };
  console.log("[Mercado Pago Saldo Direto] sincronizado:", lastResult);
  return lastResult;
}

async function sync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res, next) => {
  try { await sync(); }
  catch (error) { console.warn("[Mercado Pago Saldo Direto] pré-sync ML:", error.message); }
  next();
});

router.post("/api/finance/mercadopago/balance/sync", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await sync()) });
  } catch (error) {
    console.warn("[Mercado Pago Saldo Direto] falha:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({
      sucesso: false,
      mensagem: error.message,
      saldo_anterior_preservado: true
    });
  }
});

router.get("/api/finance/mercadopago/balance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,include_in_total,source,metadata,updated_at")
      .eq("active", true);
    if (error) throw new Error(error.message);
    const account = (data || []).find(row => row?.metadata?.matrix_key === MATRIX_KEY) || null;
    res.json({ sucesso: true, conta: account, ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync().catch(error => console.warn("[Mercado Pago Saldo Direto] sync inicial:", error.message)), 5000);
startup.unref?.();
const interval = setInterval(() => sync().catch(error => console.warn("[Mercado Pago Saldo Direto] sync periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
