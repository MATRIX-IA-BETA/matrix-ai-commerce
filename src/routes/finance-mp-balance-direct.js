const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const MATRIX_KEY = "mp_available_balance";
const AUTO_SYNC_MS = 2 * 60 * 1000;

let lastResult = null;
let syncInFlight = null;

const money = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token,expires_at")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  if (!data?.access_token) {
    const err = new Error("Conta Mercado Pago não conectada.");
    err.code = "MP_AUTH_REQUIRED";
    throw err;
  }
  return data;
}

async function mpGet(path, account, label) {
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
  if (!response.ok) {
    const err = new Error(`${label} HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    err.httpStatus = response.status;
    throw err;
  }
  return data;
}

function extractAvailableBalance(payload) {
  const candidates = [
    payload?.available_balance,
    payload?.availableBalance,
    payload?.account?.available_balance,
    payload?.account?.availableBalance,
    payload?.wallet?.available_balance,
    payload?.wallet?.availableBalance
  ];
  for (const value of candidates) {
    const parsed = money(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractTotalBalance(payload) {
  const candidates = [
    payload?.total_balance,
    payload?.totalBalance,
    payload?.account?.total_balance,
    payload?.account?.totalBalance,
    payload?.wallet?.total_balance,
    payload?.wallet?.totalBalance
  ];
  for (const value of candidates) {
    const parsed = money(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

async function saveDirectBalance(account, availableBalance, totalBalance) {
  const now = new Date().toISOString();

  // Reaproveita o próprio card/registro bancário que já era exibido para o
  // Mercado Pago via Pluggy. A origem lógica do saldo passa a ser a API direta
  // do MP, sem criar uma segunda conta e sem duplicar o patrimônio.
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
    available_balance: availableBalance,
    total_balance: totalBalance,
    mp_user_id: String(account.user_id || account.account_id || ""),
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

  // Caso uma versão anterior já tenha criado uma conta direta separada,
  // desativa-a para garantir que o saldo do MP entre uma única vez no caixa.
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
  const account = await getAccount();
  const profile = await mpGet("/users/me", account, "Saldo disponível Mercado Pago");
  const availableBalance = extractAvailableBalance(profile);
  const totalBalance = extractTotalBalance(profile);

  if (availableBalance === null) {
    const keys = Object.keys(profile || {}).slice(0, 25);
    const err = new Error(`A API do Mercado Pago respondeu, mas não informou available_balance. Campos recebidos: ${keys.join(", ") || "nenhum"}.`);
    err.code = "MP_AVAILABLE_BALANCE_MISSING";
    throw err;
  }

  const syncedAt = await saveDirectBalance(account, availableBalance, totalBalance);
  lastResult = {
    saldo_disponivel: availableBalance,
    saldo_total: totalBalance,
    fonte: "mercadopago_api_direct",
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

// Toda atualização financeira do Mercado Livre atualiza primeiro o saldo
// disponível do Mercado Pago pela API direta e depois segue para a rotina de
// a receber/retidos. Se a consulta direta falhar, preservamos o saldo anterior.
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
    res.json({ sucesso: true, conectado: Boolean(await getAccount().catch(() => null)), conta: account, ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync().catch(error => console.warn("[Mercado Pago Saldo Direto] sync inicial:", error.message)), 5000);
startup.unref?.();
const interval = setInterval(() => sync().catch(error => console.warn("[Mercado Pago Saldo Direto] sync periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
