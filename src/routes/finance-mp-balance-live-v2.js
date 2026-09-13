const router = require("express").Router();
const { supabase } = require("../db/supabase");

const ML_API = "https://api.mercadolibre.com";
const MATRIX_KEY = "mp_available_balance";
const AUTO_SYNC_MS = 60 * 1000;
const FORCE_GUARD_MS = 10 * 1000;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;

const money = value => Number((Number(value) || 0).toFixed(2));
const finiteOrNull = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

async function getMercadoLivreAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token,expires_at")
    .eq("marketplace", "mercadolivre")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Livre: ${error.message}`);
  if (!data?.access_token) {
    const e = new Error("Conta Mercado Livre não conectada.");
    e.code = "ML_AUTH_REQUIRED";
    throw e;
  }
  return data;
}

async function fetchBalance(account) {
  const userId = String(account.user_id || account.account_id || "").trim();
  if (!userId) throw new Error("Conta Mercado Livre sem user_id.");
  const response = await fetch(
    `${ML_API}/users/${encodeURIComponent(userId)}/mercadopago_account/balance`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.access_token}`
      },
      signal: AbortSignal.timeout(20000)
    }
  );
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const e = new Error(`Saldo Mercado Pago via Mercado Livre HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    e.httpStatus = response.status;
    throw e;
  }

  const available = finiteOrNull(data?.available_balance ?? data?.available_amount);
  if (available == null) throw new Error("A API do Mercado Livre não retornou available_balance.");
  return {
    available_balance: money(Math.max(0, available)),
    unavailable_balance: finiteOrNull(data?.unavailable_balance),
    total_amount: finiteOrNull(data?.total_amount),
    user_id: userId
  };
}

async function saveBalance(snapshot) {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from("financial_accounts")
    .select("id,name,metadata")
    .eq("account_type", "asset");
  if (error) throw new Error(error.message);

  const isMp = row => row?.metadata?.matrix_key === MATRIX_KEY || /mercado pago/i.test(String(row?.metadata?.institution || row?.name || ""));
  const existing = (rows || []).find(isMp) || null;
  const metadata = {
    ...(existing?.metadata || {}),
    matrix_key: MATRIX_KEY,
    institution: "Mercado Pago Empresas",
    balance_source: "mercadolivre_mercadopago_account_balance",
    balance_provider: "mercadolivre_api",
    available_balance: snapshot.available_balance,
    unavailable_balance: snapshot.unavailable_balance,
    total_amount: snapshot.total_amount,
    mp_user_id: snapshot.user_id,
    pluggy_disabled_for_balance: true,
    last_synced_at: now,
    report_file_name: null,
    report_begin_at: null,
    report_end_at: null
  };

  const record = {
    name: "Mercado Pago Empresas",
    account_type: "asset",
    category: "Banco",
    source: "mercadopago",
    current_balance: snapshot.available_balance,
    include_in_total: true,
    active: true,
    metadata,
    updated_at: now
  };

  let accountId = existing?.id || null;
  if (accountId) {
    const { error: updateError } = await supabase.from("financial_accounts").update(record).eq("id", accountId);
    if (updateError) throw new Error(updateError.message);
  } else {
    const { data: inserted, error: insertError } = await supabase.from("financial_accounts").insert(record).select("id").single();
    if (insertError) throw new Error(insertError.message);
    accountId = inserted?.id || null;
  }

  for (const row of rows || []) {
    if (!row?.id || row.id === accountId || !isMp(row)) continue;
    await supabase.from("financial_accounts").update({ include_in_total: false, active: false, updated_at: now }).eq("id", row.id);
  }

  return now;
}

async function runSync() {
  const account = await getMercadoLivreAccount();
  const snapshot = await fetchBalance(account);
  const syncedAt = await saveBalance(snapshot);
  lastSyncAt = Date.now();
  lastResult = {
    saldo_disponivel: snapshot.available_balance,
    saldo_indisponivel: snapshot.unavailable_balance,
    saldo_total: snapshot.total_amount,
    fonte: "mercadolivre_mercadopago_account_balance",
    atualizado_em: syncedAt
  };
  console.log("[Mercado Pago Saldo V2] sincronizado:", lastResult);
  return lastResult;
}

async function sync(force = false) {
  if (syncInFlight) return syncInFlight;
  const guard = force ? FORCE_GUARD_MS : AUTO_SYNC_MS;
  if (lastResult && Date.now() - lastSyncAt < guard) return lastResult;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res, next) => {
  try { await sync(true); }
  catch (error) {
    console.warn("[Mercado Pago Saldo V2] pré-sync falhou; saldo anterior preservado:", error.message);
  }
  next();
});

router.post("/api/finance/mercadopago/balance/sync", async (req, res) => {
  try { res.json({ sucesso: true, ...(await sync(true)) }); }
  catch (error) {
    res.status(error.code === "ML_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message, saldo_anterior_preservado: true });
  }
});

router.get("/api/finance/mercadopago/balance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,source,metadata,updated_at")
      .contains("metadata", { matrix_key: MATRIX_KEY })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, conta: data || null, ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync(true).catch(error => console.warn("[Mercado Pago Saldo V2] inicial:", error.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Mercado Pago Saldo V2] periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;