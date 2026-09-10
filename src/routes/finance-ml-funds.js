const crypto = require("crypto");
const router = require("express").Router();

const { supabase } = require("../db/supabase");
const { env } = require("../config/env");

const CLIENT_ID = env.MERCADOLIVRE_CLIENT_ID;
const CLIENT_SECRET = env.MERCADOLIVRE_CLIENT_SECRET;
const REDIRECT_URI = env.MERCADOLIVRE_REDIRECT_URI;
const AUTO_SYNC_MS = 5 * 60 * 1000;
const oauthSessions = new Map();

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => Number(num(value).toFixed(2));
const base64url = buffer => buffer
  .toString("base64")
  .replace(/=/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function amountFrom(value) {
  if (Number.isFinite(Number(value))) return Math.abs(Number(value));
  if (!value || typeof value !== "object") return null;
  for (const key of ["amount", "balance", "value", "total_amount", "unavailable_balance"]) {
    if (Number.isFinite(Number(value[key]))) return Math.abs(Number(value[key]));
  }
  return null;
}

async function getMercadoPagoAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,marketplace,account_id,user_id,access_token,refresh_token,expires_at")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  return data;
}

async function saveMercadoPagoAccount(tokenData) {
  const userId = String(tokenData.user_id || tokenData.account_id || "").trim();
  if (!userId) throw new Error("Mercado Pago não retornou user_id.");
  const expiresIn = Number(tokenData.expires_in || 15552000);
  const record = {
    marketplace: "mercadopago",
    account_id: userId,
    user_id: userId,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  };

  const existing = await getMercadoPagoAccount();
  if (existing?.id) {
    const { error } = await supabase
      .from("marketplace_accounts")
      .update(record)
      .eq("id", existing.id);
    if (error) throw new Error(`Salvando token Mercado Pago: ${error.message}`);
    return { id: existing.id, ...record };
  }

  const { data, error } = await supabase
    .from("marketplace_accounts")
    .insert(record)
    .select("id")
    .single();
  if (error) throw new Error(`Criando conta Mercado Pago: ${error.message}`);
  return { id: data.id, ...record };
}

async function refreshMercadoPagoToken(account) {
  if (!account?.refresh_token) throw new Error("Refresh token Mercado Pago ausente.");
  const response = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: account.refresh_token
    })
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(`Mercado Pago recusou renovação do token (${response.status}).`);
  return saveMercadoPagoAccount({ ...data, user_id: data.user_id || account.user_id });
}

async function ensureMercadoPagoToken(account) {
  if (!account) return null;
  const expiresAt = new Date(account.expires_at || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60 * 1000) {
    return refreshMercadoPagoToken(account);
  }
  return account;
}

async function mercadoPagoFetch(path, account, options = {}) {
  let current = await ensureMercadoPagoToken(account);
  if (!current) throw new Error("Mercado Pago ainda não autorizado.");
  const url = path.startsWith("http") ? path : `https://api.mercadopago.com${path}`;
  let response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
      Authorization: `Bearer ${current.access_token}`
    }
  });
  if (response.status === 401 && current.refresh_token) {
    current = await refreshMercadoPagoToken(current);
    response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
        Authorization: `Bearer ${current.access_token}`
      }
    });
  }
  return { response, account: current };
}

router.get("/auth/mercadopago", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send("Credenciais OAuth não configuradas.");
  }

  const state = `mp_${crypto.randomBytes(24).toString("hex")}`;
  const codeVerifier = base64url(crypto.randomBytes(64));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );

  oauthSessions.set(state, { codeVerifier, createdAt: Date.now() });
  for (const [key, session] of oauthSessions.entries()) {
    if (Date.now() - session.createdAt > 15 * 60 * 1000) oauthSessions.delete(key);
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    platform_id: "mp",
    state,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  res.redirect(`https://auth.mercadopago.com/authorization?${params.toString()}`);
});

async function handleMercadoPagoCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`/finance?mercadopago=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state) {
    return res.redirect("/finance?mercadopago=error&reason=missing_code");
  }

  const session = oauthSessions.get(String(state));
  if (!session) {
    return res.redirect("/finance?mercadopago=error&reason=expired_state");
  }
  oauthSessions.delete(String(state));

  try {
    const response = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: session.codeVerifier,
        test_token: false
      })
    });
    const data = await readJson(response);
    if (!response.ok) {
      console.error("[Mercado Pago OAuth] troca recusada:", response.status, data);
      return res.redirect(`/finance?mercadopago=error&reason=${encodeURIComponent(`token_${response.status}`)}`);
    }
    await saveMercadoPagoAccount(data);
    lastSyncAt = 0;
    lastResult = null;
    return res.redirect("/finance?mercadopago=connected");
  } catch (callbackError) {
    console.error("[Mercado Pago OAuth] callback:", callbackError.message);
    return res.redirect(`/finance?mercadopago=error&reason=${encodeURIComponent(callbackError.message)}`);
  }
}

// Reaproveita exatamente a redirect URI já cadastrada para o OAuth do ML.
// Como esta rota é montada antes da rota original do Mercado Livre, ela só
// captura estados iniciados por mp_; os demais seguem normalmente via next().
router.get("/auth/mercadolivre/callback", async (req, res, next) => {
  if (!String(req.query?.state || "").startsWith("mp_")) return next();
  return handleMercadoPagoCallback(req, res);
});
router.get("/auth/mercadopago/callback", handleMercadoPagoCallback);

async function fetchBalance(account) {
  const sellerId = String(account.user_id || account.account_id || "").trim();
  if (!sellerId) throw new Error("Conta Mercado Pago sem user_id.");
  const { response } = await mercadoPagoFetch(
    `/users/${encodeURIComponent(sellerId)}/mercadopago_account/balance`,
    account
  );
  const data = await readJson(response);
  if (!response.ok) {
    const error = new Error(`Saldo Mercado Pago HTTP ${response.status}`);
    error.details = data;
    throw error;
  }
  return data;
}

function reasonRows(balance) {
  const raw = balance?.unavailable_balance_by_reason;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([reason, value]) => {
      if (value && typeof value === "object") return { reason, ...value };
      return { reason, amount: value };
    });
  }
  return [];
}

function splitUnavailableBalance(balance) {
  const unavailable = money(Math.max(0, num(balance?.unavailable_balance)));
  const rows = reasonRows(balance);
  let held = 0;
  const matched = [];

  for (const row of rows) {
    const text = [
      row?.reason,
      row?.type,
      row?.cause,
      row?.detail,
      row?.description,
      row?.status_detail
    ].filter(Boolean).join(" ").toLowerCase();

    if (!/(claim|disput|chargeback|mediat|reclama|contest)/i.test(text)) continue;
    const amount = amountFrom(row);
    if (amount == null) continue;
    held += amount;
    matched.push({ reason: text.slice(0, 160), amount: money(amount) });
  }

  held = money(Math.min(unavailable, held));
  const receivable = money(Math.max(0, unavailable - held));
  return {
    unavailable,
    held,
    receivable,
    breakdown_available: rows.length > 0,
    matched_reasons: matched,
    all_reason_count: rows.length
  };
}

async function saveAccount(matrixKey, name, category, balance, metadata) {
  const { data: existing, error: findError } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: matrixKey })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`Conta financeira ML: ${findError.message}`);

  const record = {
    name,
    account_type: "asset",
    category,
    source: "mercadolivre",
    current_balance: money(balance),
    include_in_total: true,
    active: true,
    metadata: { matrix_key: matrixKey, ...metadata },
    updated_at: new Date().toISOString()
  };

  if (existing?.id) {
    const { error } = await supabase.from("financial_accounts").update(record).eq("id", existing.id);
    if (error) throw new Error(`Atualizando ${name}: ${error.message}`);
    return existing.id;
  }

  const { data, error } = await supabase.from("financial_accounts").insert(record).select("id").single();
  if (error) throw new Error(`Criando ${name}: ${error.message}`);
  return data.id;
}

async function performSync() {
  const mpAccount = await getMercadoPagoAccount();
  if (!mpAccount) {
    const error = new Error("Autorize o Mercado Pago para consultar os valores financeiros com precisão.");
    error.code = "MP_AUTH_REQUIRED";
    throw error;
  }

  const balance = await fetchBalance(mpAccount);
  const split = splitUnavailableBalance(balance);
  const available = money(Math.max(0, num(balance?.available_balance)));
  const total = money(Math.max(0, num(balance?.total_amount)));
  const pendingReview = money(Math.max(0, num(balance?.pending_to_review)));
  const syncedAt = new Date().toISOString();
  const common = {
    seller_id: String(mpAccount.user_id || mpAccount.account_id || ""),
    synced_at: syncedAt,
    source_precision: "mercadopago_balance_api",
    ml_total_amount: total,
    ml_available_balance: available,
    ml_unavailable_balance: split.unavailable,
    pending_to_review: pendingReview,
    breakdown_available: split.breakdown_available,
    balance_keys: Object.keys(balance || {}).sort()
  };

  await saveAccount(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    split.receivable,
    { ...common, component: "receivable" }
  );
  await saveAccount(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Valores retidos",
    split.held,
    {
      ...common,
      component: "claims_held",
      matched_reasons: split.matched_reasons,
      reason_count: split.all_reason_count
    }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: split.receivable,
    retido_reclamacoes: split.held,
    indisponivel_total: split.unavailable,
    saldo_disponivel: available,
    saldo_total_mp: total,
    pending_to_review: pendingReview,
    fonte: "mercadopago_balance_api",
    breakdown_available: split.breakdown_available,
    atualizado_em: syncedAt
  };
  return lastResult;
}

async function syncMercadoLivreFunds(force = false) {
  if (syncInFlight) return syncInFlight;
  if (!force && lastResult && Date.now() - lastSyncAt < AUTO_SYNC_MS) return lastResult;
  syncInFlight = performSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res) => {
  try {
    const result = await syncMercadoLivreFunds(true);
    res.json({ sucesso: true, ...result });
  } catch (error) {
    console.error("[Financeiro ML] sincronização:", error.message);
    const status = error.code === "MP_AUTH_REQUIRED" ? 428 : 502;
    res.status(status).json({
      sucesso: false,
      authorization_required: error.code === "MP_AUTH_REQUIRED",
      mensagem: error.message
    });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  try {
    const mpAccount = await getMercadoPagoAccount();
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,metadata,updated_at")
      .eq("source", "mercadolivre")
      .eq("active", true);
    if (error) throw new Error(error.message);
    res.json({
      sucesso: true,
      mercadopago_connected: Boolean(mpAccount),
      mercadopago_user_id: mpAccount?.user_id || null,
      contas: data || [],
      ultima_sincronizacao: lastResult
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/liabilities/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Obrigação inválida." });
    }

    const { data: account, error: accountError } = await supabase
      .from("financial_accounts")
      .select("id,name,category,account_type,current_balance,active")
      .eq("id", id)
      .single();
    if (accountError) throw new Error(accountError.message);
    if (account.account_type !== "liability") {
      return res.status(400).json({ sucesso: false, mensagem: "A conta selecionada não é um passivo." });
    }

    const current = money(Math.max(0, num(account.current_balance)));
    if (current <= 0) {
      return res.json({ sucesso: true, mensagem: "Obrigação já está quitada.", novo_saldo: 0, valor_pago: 0 });
    }

    const payFull = req.body?.pay_full === true;
    const requested = payFull ? current : money(Math.abs(num(req.body?.amount)));
    if (requested <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Informe um valor de pagamento maior que zero." });
    }

    const paid = money(Math.min(current, requested));
    const newBalance = money(current - paid);
    const occurredAt = req.body?.occurred_at || new Date().toISOString();

    const { data: updatedRows, error: updateError } = await supabase
      .from("financial_accounts")
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("current_balance", account.current_balance)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    if (!updatedRows?.length) {
      return res.status(409).json({ sucesso: false, mensagem: "O saldo dessa obrigação mudou. Atualize a tela e tente novamente." });
    }

    const { error: entryError } = await supabase.from("financial_entries").insert({
      account_id: id,
      entry_type: "adjustment",
      amount: paid,
      description: payFull ? `Quitação: ${account.name}` : `Pagamento parcial: ${account.name}`,
      source: "liability_payment",
      reference_type: "liability_payment",
      reference_id: String(id),
      occurred_at: occurredAt,
      metadata: {
        signed_delta: -paid,
        previous_balance: current,
        new_balance: newBalance,
        payment_mode: payFull ? "full" : "partial",
        bank_balance_managed_by_open_finance: true
      }
    });
    if (entryError) {
      console.error("[Financeiro] obrigação baixada, mas falhou log:", entryError.message);
    }

    res.json({
      sucesso: true,
      mensagem: newBalance === 0 ? "Obrigação quitada." : "Pagamento parcial registrado.",
      valor_pago: paid,
      novo_saldo: newBalance
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

// Após a autorização, mantém os valores atualizados sem precisar abrir a tela.
const startupTimer = setTimeout(async () => {
  try {
    if (await getMercadoPagoAccount()) await syncMercadoLivreFunds(false);
  } catch (error) {
    console.warn("[Financeiro ML] sync inicial:", error.message);
  }
}, 5000);
startupTimer.unref?.();

const interval = setInterval(async () => {
  try {
    if (await getMercadoPagoAccount()) await syncMercadoLivreFunds(false);
  } catch (error) {
    console.warn("[Financeiro ML] sync periódico:", error.message);
  }
}, AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
