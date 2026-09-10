const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(num(value).toFixed(2));
}

function isMissingTable(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("does not exist") || text.includes("relation") && text.includes("financial_");
}

async function safeTable(table, select = "*") {
  const { data, error } = await supabase.from(table).select(select);
  if (error) {
    if (isMissingTable(error)) return { data: [], missing: true, error: null };
    throw new Error(`${table}: ${error.message}`);
  }
  return { data: data || [], missing: false, error: null };
}

function accountBucket(account) {
  const c = String(account?.category || "").toLowerCase();
  if (/banco|bank|caixa|cash/.test(c)) return "cash";
  if (/mercado livre|marketplace/.test(c)) return "marketplace";
  if (/receber|receivable/.test(c)) return "receivable";
  if (/pagar|fornecedor|payable/.test(c)) return "payable";
  if (/emprest|loan|financ/.test(c)) return "loan";
  if (/imposto|tax/.test(c)) return "tax";
  if (/cart[aã]o|card/.test(c)) return "card";
  return account?.account_type === "asset" ? "other_asset" : "other_liability";
}

async function buildSummary() {
  const [stockResult, accountsResult, entriesResult] = await Promise.all([
    safeTable("inventory_stock", "product_id,sku,name,stock_value,active"),
    safeTable("financial_accounts", "id,name,account_type,category,source,current_balance,include_in_total,active,updated_at,metadata"),
    safeTable("financial_entries", "id,account_id,entry_type,amount,description,source,occurred_at,reference_type,reference_id")
  ]);

  const stockRows = (stockResult.data || []).filter(r => r.active !== false);
  const stockTotal = money(stockRows.reduce((sum, r) => sum + num(r.stock_value), 0));

  const accounts = (accountsResult.data || []).filter(a => a.active !== false);
  const included = accounts.filter(a => a.include_in_total !== false && String(a.source || "").toLowerCase() !== "stock_matrix");

  let financialAssets = 0;
  let liabilities = 0;
  const buckets = {
    cash: 0,
    marketplace: 0,
    receivable: 0,
    payable: 0,
    loan: 0,
    tax: 0,
    card: 0,
    other_asset: 0,
    other_liability: 0
  };

  for (const account of included) {
    const balance = money(account.current_balance);
    const bucket = accountBucket(account);
    buckets[bucket] = money(buckets[bucket] + balance);
    if (account.account_type === "asset") financialAssets += balance;
    else liabilities += balance;
  }

  const assetTotal = money(financialAssets + stockTotal);
  const liabilityTotal = money(liabilities);
  const netWorth = money(assetTotal - liabilityTotal);
  const cashTotal = money(buckets.cash);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let incomeMonth = 0;
  let expenseMonth = 0;
  const recent = (entriesResult.data || [])
    .sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0));

  for (const e of recent) {
    const t = new Date(e.occurred_at || 0).getTime();
    if (!Number.isFinite(t) || t < monthStart) continue;
    if (e.entry_type === "income") incomeMonth += num(e.amount);
    if (e.entry_type === "expense") expenseMonth += num(e.amount);
  }

  return {
    generated_at: nowIso(),
    database_ready: !accountsResult.missing,
    stock_ready: !stockResult.missing,
    totals: {
      assets: assetTotal,
      liabilities: liabilityTotal,
      net_worth: netWorth,
      cash: cashTotal,
      stock: stockTotal,
      marketplace_receivable: money(buckets.marketplace),
      accounts_receivable: money(buckets.receivable),
      accounts_payable: money(buckets.payable),
      month_result: money(incomeMonth - expenseMonth),
      month_income: money(incomeMonth),
      month_expense: money(expenseMonth)
    },
    buckets,
    accounts,
    stock_top: stockRows
      .map(r => ({ name: r.name, sku: r.sku, value: money(r.stock_value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    recent_entries: recent.slice(0, 20)
  };
}

router.get("/api/finance/health", async (req, res) => {
  try {
    const summary = await buildSummary();
    res.json({
      sucesso: true,
      modulo: "Financeiro & Patrimônio",
      database_ready: summary.database_ready,
      open_finance_provider_configured: Boolean(process.env.OPEN_FINANCE_PROVIDER && process.env.OPEN_FINANCE_API_KEY)
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/summary", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await buildSummary()) });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/history", async (req, res) => {
  try {
    const days = Math.max(7, Math.min(365, Number(req.query.days || 30)));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    let query = supabase
      .from("financial_snapshots")
      .select("snapshot_date,asset_total,liability_total,net_worth,cash_total,stock_total")
      .gte("snapshot_date", since)
      .order("snapshot_date", { ascending: true });
    const { data, error } = await query;
    if (error) {
      if (isMissingTable(error)) return res.json({ sucesso: true, database_ready: false, snapshots: [] });
      throw new Error(error.message);
    }
    res.json({ sucesso: true, database_ready: true, snapshots: data || [] });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/accounts", async (req, res) => {
  try {
    const body = req.body || {};
    const accountType = String(body.account_type || "").toLowerCase();
    if (!body.name || !body.category || !["asset", "liability"].includes(accountType)) {
      return res.status(400).json({ sucesso: false, mensagem: "Nome, categoria e tipo (asset/liability) são obrigatórios." });
    }
    const record = {
      name: String(body.name).trim(),
      account_type: accountType,
      category: String(body.category).trim(),
      source: String(body.source || "manual").trim(),
      current_balance: money(body.current_balance),
      include_in_total: body.include_in_total !== false,
      active: body.active !== false,
      metadata: body.metadata || {},
      updated_at: nowIso()
    };
    const { data, error } = await supabase.from("financial_accounts").insert(record).select("*").single();
    if (error) {
      if (isMissingTable(error)) return res.status(503).json({ sucesso: false, database_ready: false, mensagem: "Execute sql/supabase_finance_patrimony_v1.sql no Supabase para ativar o Financeiro." });
      throw new Error(error.message);
    }
    res.json({ sucesso: true, conta: data });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.put("/api/finance/accounts/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const patch = { updated_at: nowIso() };
    for (const key of ["name", "category", "source", "active", "include_in_total", "metadata"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.current_balance !== undefined) patch.current_balance = money(body.current_balance);
    if (body.account_type !== undefined) {
      const t = String(body.account_type).toLowerCase();
      if (!["asset", "liability"].includes(t)) return res.status(400).json({ sucesso: false, mensagem: "Tipo inválido." });
      patch.account_type = t;
    }
    const { data, error } = await supabase.from("financial_accounts").update(patch).eq("id", req.params.id).select("*").single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, conta: data });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/entries", async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body.entry_type || "").toLowerCase();
    const amount = Math.abs(money(body.amount));
    if (!body.account_id || !body.description || !["income", "expense", "adjustment"].includes(type) || amount <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Conta, tipo, valor e descrição são obrigatórios." });
    }

    const { data: account, error: accountError } = await supabase.from("financial_accounts").select("*").eq("id", body.account_id).single();
    if (accountError) throw new Error(accountError.message);

    let delta = 0;
    if (type === "adjustment") delta = num(body.signed_amount ?? body.amount);
    else if (account.account_type === "asset") delta = type === "income" ? amount : -amount;
    else delta = type === "expense" ? amount : -amount;

    const entry = {
      account_id: body.account_id,
      entry_type: type,
      amount,
      description: String(body.description).trim(),
      source: String(body.source || "manual"),
      reference_type: body.reference_type || null,
      reference_id: body.reference_id || null,
      occurred_at: body.occurred_at || nowIso(),
      metadata: { ...(body.metadata || {}), signed_delta: money(delta) }
    };

    const { data, error } = await supabase.from("financial_entries").insert(entry).select("*").single();
    if (error) throw new Error(error.message);

    const newBalance = money(num(account.current_balance) + delta);
    await supabase.from("financial_accounts").update({ current_balance: newBalance, updated_at: nowIso() }).eq("id", body.account_id);

    res.json({ sucesso: true, movimento: data, novo_saldo: newBalance });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/close-day", async (req, res) => {
  try {
    const summary = await buildSummary();
    if (!summary.database_ready) {
      return res.status(503).json({ sucesso: false, database_ready: false, mensagem: "Base financeira ainda não foi criada no Supabase." });
    }
    const date = String(req.body?.snapshot_date || new Date().toISOString().slice(0, 10));
    const t = summary.totals;
    const record = {
      snapshot_date: date,
      asset_total: t.assets,
      liability_total: t.liabilities,
      net_worth: t.net_worth,
      cash_total: t.cash,
      stock_total: t.stock,
      marketplace_receivable: t.marketplace_receivable,
      accounts_receivable: t.accounts_receivable,
      accounts_payable: t.accounts_payable,
      details: { buckets: summary.buckets, generated_at: summary.generated_at },
      updated_at: nowIso()
    };
    const { data, error } = await supabase.from("financial_snapshots").upsert(record, { onConflict: "snapshot_date" }).select("*").single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, mensagem: "Fechamento do dia salvo com sucesso.", snapshot: data });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/bank-status", async (req, res) => {
  const provider = process.env.OPEN_FINANCE_PROVIDER || null;
  res.json({
    sucesso: true,
    configured: Boolean(provider && process.env.OPEN_FINANCE_API_KEY),
    provider,
    mode: "read_only",
    mensagem: provider ? "Provedor configurado. A próxima etapa é concluir o consentimento OAuth/Open Finance." : "Nenhum provedor Open Finance configurado ainda."
  });
});

module.exports = router;
