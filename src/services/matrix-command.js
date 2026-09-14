const { supabase } = require("../db/supabase");
const { createStockMovement } = require("./stock");

const STOP_WORDS = new Set([
  "matrix", "me", "fala", "diz", "mostra", "mostrar", "consulta", "consultar",
  "quanto", "quanta", "quantos", "quantas", "tem", "temos", "tenho", "ha",
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "da", "do", "das", "dos",
  "no", "na", "nos", "nas", "em", "para", "pra", "por", "favor", "hoje", "agora",
  "estoque", "saldo", "unidade", "unidades", "peca", "pecas", "item", "itens",
  "aqui", "gente", "nosso", "nossa", "nossos", "nossas", "que", "qual", "quais",
  "responde", "responda", "responder", "audio", "voz"
]);

function normalizarTexto(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ddr\s*([2345])/g, "ddr$1")
    .replace(/(\d+)\s*(?:gigas?|gigabytes?|gb)\b/g, "$1gb")
    .replace(/(\d+)\s*(?:megas?|megabytes?|mb)\b/g, "$1mb")
    .replace(/[^a-z0-9./+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textoSemWakeWord(text) {
  return String(text || "").replace(/^\s*matrix[,:;.!?\s-]*/i, "").trim();
}

function ehComandoMatrix(text) {
  return /^\s*matrix\b/i.test(String(text || ""));
}

function ehConfirmacao(text) {
  const t = normalizarTexto(text);
  return ["confirmo", "confirmar", "pode confirmar", "pode fazer", "pode executar", "sim confirma", "sim pode", "executa", "pode rodar"].includes(t);
}

function ehCancelamento(text) {
  const t = normalizarTexto(text);
  return ["cancela", "cancelar", "nao", "nao confirma", "desiste", "deixa pra la", "deixa para la"].includes(t);
}

function tokensDeBusca(text) {
  return normalizarTexto(textoSemWakeWord(text))
    .split(" ")
    .filter(Boolean)
    .filter(token => !STOP_WORDS.has(token))
    .filter(token => !/^r\$?$/.test(token))
    .filter(token => token.length > 1 || /^\d+$/.test(token));
}

function textoProduto(row) {
  return normalizarTexto([
    row?.sku,
    row?.name,
    row?.category,
    row?.supplier_name,
    row?.location_code
  ].filter(Boolean).join(" "));
}

function pontuarProduto(row, tokens) {
  if (!tokens.length) return 0;
  const haystack = textoProduto(row);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 5 ? 3 : 2;
  }
  const phrase = normalizarTexto(tokens.join(" "));
  if (phrase && haystack.includes(phrase)) score += 5;
  if (tokens.some(token => String(row?.sku || "").toLowerCase() === token)) score += 10;
  return score;
}

async function buscarProdutos(text, { limit = 8 } = {}) {
  const tokens = tokensDeBusca(text);
  if (!tokens.length) return { tokens, matches: [] };

  const { data, error } = await supabase
    .from("inventory_stock")
    .select("product_id,sku,name,category,product_type,unit,minimum_stock,average_cost,supplier_name,location_code,active,on_hand,reserved,available,below_minimum,stock_value")
    .eq("active", true)
    .neq("product_type", "kit")
    .limit(2500);

  if (error) throw new Error(`Erro consultando o estoque: ${error.message}`);

  const scored = (data || [])
    .map(row => ({ row, score: pontuarProduto(row, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.row.available || 0) - Number(a.row.available || 0));

  if (!scored.length) return { tokens, matches: [] };
  const best = scored[0].score;
  const threshold = Math.max(2, Math.floor(best * 0.72));
  const matches = scored
    .filter(item => item.score >= threshold)
    .slice(0, limit)
    .map(item => ({ ...item.row, match_score: item.score }));

  return { tokens, matches };
}

function formatNumber(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function registrarAuditoria(record) {
  const payload = {
    source: record.source || "system",
    actor_key: record.actorKey || null,
    actor_role: record.actorRole || null,
    page: record.page || null,
    command_text: String(record.commandText || ""),
    command_type: record.commandType || null,
    status: record.status || "received",
    requires_confirmation: Boolean(record.requiresConfirmation),
    result_summary: record.resultSummary || null,
    pending_payload: record.pendingPayload || {},
    metadata: record.metadata || {},
    expires_at: record.expiresAt || null,
    confirmed_at: record.confirmedAt || null,
    executed_at: record.executedAt || null,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("matrix_command_audit")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(`Erro registrando auditoria Matrix: ${error.message}`);
  return data;
}

async function atualizarAuditoria(id, patch) {
  const body = { ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from("matrix_command_audit")
    .update(body)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Erro atualizando auditoria Matrix: ${error.message}`);
  return data;
}

async function buscarPendente(actorKey) {
  if (!actorKey) return null;
  const { data, error } = await supabase
    .from("matrix_command_audit")
    .select("*")
    .eq("actor_key", actorKey)
    .eq("status", "pending_confirmation")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Erro lendo confirmação pendente: ${error.message}`);
  return data || null;
}

async function cancelarPendente(actorKey) {
  const pending = await buscarPendente(actorKey);
  if (!pending) return null;
  return atualizarAuditoria(pending.id, {
    status: "cancelled",
    result_summary: "Operação cancelada pelo usuário."
  });
}

function detectarIntencao(text) {
  const raw = normalizarTexto(textoSemWakeWord(text));

  if (/\b(abaixo|minimo|minima|critico|critica|zerado|zerados)\b/.test(raw) && /\bestoque\b/.test(raw)) {
    return { type: "stock_alerts" };
  }
  if (/\b(da entrada|dar entrada|entrada|recebe|receber|adiciona|adicionar)\b/.test(raw)) {
    return { type: "stock_entry" };
  }
  if (/\b(baixa|baixar|retira|retirar|remove|remover|saida|descarta|descartar)\b/.test(raw)) {
    return { type: "stock_exit" };
  }
  if (/\b(saldo|conta|contas|banco|bancos|financeiro)\b/.test(raw) && /\b(quanto|total|tem|temos|saldo|conta|contas|banco|bancos)\b/.test(raw)) {
    return { type: "finance_summary" };
  }
  if (/\b(venda|vendas|vendeu|vendemos|faturamento|faturou)\b/.test(raw) && /\b(hoje|agora|dia)\b/.test(raw)) {
    return { type: "sales_today" };
  }
  if (/\b(estoque|memoria|hd|ssd|fonte|placa|processador|gabinete|cabo|adaptador|quantos|quantas|quanto|tem|temos)\b/.test(raw)) {
    return { type: "stock_lookup" };
  }
  return { type: "unknown" };
}

function extrairQuantidade(text) {
  const raw = normalizarTexto(textoSemWakeWord(text));
  const patterns = [
    /(?:entrada|recebe|adiciona|baixa|retira|remove|saida|descarta)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)/,
    /\b(\d+(?:[.,]\d+)?)\s+(?:unidades?|pecas?|itens?)\b/
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return Number(m[1].replace(",", "."));
  }
  return null;
}

function extrairCusto(text) {
  const raw = normalizarTexto(textoSemWakeWord(text));
  const patterns = [
    /(?:a|por|custo|custando|valor)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*reais?)?\s*(?:cada|unidade)?/,
    /r\$\s*(\d+(?:[.,]\d{1,2})?)/
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return Number(m[1].replace(",", "."));
  }
  return null;
}

function limparBuscaDeMovimento(text) {
  let raw = textoSemWakeWord(text);
  raw = raw
    .replace(/\b(?:da|dar)\s+entrada\b/ig, " ")
    .replace(/\b(?:entrada|recebe(?:r)?|adiciona(?:r)?|baixa(?:r)?|retira(?:r)?|remove(?:r)?|saida|descarta(?:r)?)\b/ig, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:unidades?|pecas?|itens?)?\b/i, " ")
    .replace(/(?:a|por|custo|custando|valor)\s+(?:r\$\s*)?\d+(?:[.,]\d{1,2})?(?:\s*reais?)?\s*(?:cada|unidade)?/i, " ")
    .replace(/\b(?:por\s+defeito|defeito|avaria|perda|quebra|quebrado|uso interno)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw;
}

async function atualizarCustoReal(productId, cost, source = "matrix_voice") {
  if (!(Number(cost) >= 0)) return;
  const { data: product, error } = await supabase
    .from("inventory_products")
    .select("metadata")
    .eq("id", productId)
    .single();
  if (error) throw new Error(error.message);
  const metadata = {
    ...(product?.metadata || {}),
    actual_cost: Number(Number(cost).toFixed(4)),
    cost_source: source,
    cost_updated_at: new Date().toISOString()
  };
  const result = await supabase
    .from("inventory_products")
    .update({
      average_cost: Number(Number(cost).toFixed(4)),
      metadata,
      updated_at: new Date().toISOString()
    })
    .eq("id", productId);
  if (result.error) throw new Error(result.error.message);
}

async function consultaEstoque(text) {
  const { matches } = await buscarProdutos(text, { limit: 6 });
  if (!matches.length) {
    return { ok: false, status: "not_found", answer: "Não achei esse item no estoque. Fala o nome, marca, capacidade ou SKU/MLB com um pouco mais de detalhe." };
  }

  const bestScore = matches[0].match_score;
  const strongest = matches.filter(item => item.match_score === bestScore);
  const positive = strongest.filter(item => Number(item.on_hand || 0) !== 0 || Number(item.available || 0) !== 0);
  const chosen = positive.length === 1 ? positive[0] : strongest.length === 1 ? strongest[0] : null;

  if (chosen) {
    const onHand = formatNumber(chosen.on_hand);
    const available = formatNumber(chosen.available);
    const reserved = formatNumber(chosen.reserved);
    const reserveText = Number(chosen.reserved || 0) ? `, ${reserved} reservadas` : "";
    return {
      ok: true,
      status: "success",
      answer: `Hoje temos ${onHand} unidades de ${chosen.name}. Disponíveis: ${available}${reserveText}. SKU ${chosen.sku}.`,
      data: { products: [chosen] }
    };
  }

  const total = strongest.reduce((sum, item) => sum + Number(item.on_hand || 0), 0);
  const details = strongest.slice(0, 4).map(item => `${item.name}: ${formatNumber(item.on_hand)}`).join("; ");
  return {
    ok: true,
    status: "success",
    answer: `Encontrei ${strongest.length} itens que batem com o pedido, somando ${formatNumber(total)} unidades. ${details}. Se quiser um só, fala a marca ou o SKU.`,
    data: { products: strongest }
  };
}

async function alertasEstoque() {
  const { data, error } = await supabase
    .from("inventory_stock")
    .select("product_id,sku,name,on_hand,available,minimum_stock,below_minimum,product_type")
    .eq("active", true)
    .neq("product_type", "kit")
    .eq("below_minimum", true)
    .order("available", { ascending: true })
    .limit(12);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return { ok: true, status: "success", answer: "Nenhum componente ativo está abaixo do estoque mínimo agora.", data: { products: [] } };
  const details = rows.slice(0, 6).map(item => `${item.name}: ${formatNumber(item.available)}`).join("; ");
  return { ok: true, status: "success", answer: `Temos ${rows.length} itens na primeira lista de alerta de estoque. Os mais críticos: ${details}.`, data: { products: rows } };
}

async function resumoFinanceiro() {
  const { data, error } = await supabase
    .from("financial_accounts")
    .select("id,name,account_type,category,source,current_balance,include_in_total,active")
    .eq("active", true)
    .eq("include_in_total", true)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data || [];
  const total = rows.reduce((sum, item) => sum + Number(item.current_balance || 0), 0);
  const details = rows.map(item => `${item.name}: ${formatCurrency(item.current_balance)}`).join("; ");
  return { ok: true, status: "success", answer: `Saldo consolidado: ${formatCurrency(total)}. ${details || "Nenhuma conta ativa incluída no total."}`, data: { total, accounts: rows } };
}

async function vendasHoje() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const { data, error } = await supabase
    .from("account_daily_metrics")
    .select("orders_count,units_sold,gross_revenue,net_revenue,contribution_margin")
    .eq("date", today);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const sum = key => rows.reduce((acc, row) => acc + Number(row[key] || 0), 0);
  const orders = sum("orders_count");
  const units = sum("units_sold");
  const gross = sum("gross_revenue");
  const net = sum("net_revenue");
  return { ok: true, status: "success", answer: `Hoje temos ${formatNumber(orders)} pedidos, ${formatNumber(units)} unidades vendidas, faturamento bruto de ${formatCurrency(gross)} e líquido de ${formatCurrency(net)}.`, data: { orders, units, gross, net } };
}

async function prepararMovimento({ text, type, context }) {
  if (!context.permissions?.canWriteStock) {
    return {
      ok: false,
      status: "permission_denied",
      answer: context.source === "web_voice" || context.source === "web_text"
        ? "Essa alteração está bloqueada no painel público por segurança. Pelo WhatsApp do administrador eu consigo preparar e pedir sua confirmação antes de mexer no estoque."
        : "Seu perfil não tem permissão para alterar o estoque por comando."
    };
  }

  const quantity = extrairQuantidade(text);
  if (!(quantity > 0)) {
    return { ok: false, status: "needs_detail", answer: "Me diga a quantidade. Exemplo: Matrix, dá entrada de 50 memórias DDR3 8GB Kingston a 42 reais cada." };
  }

  const searchText = limparBuscaDeMovimento(text);
  const { matches } = await buscarProdutos(searchText, { limit: 6 });
  if (!matches.length) {
    return { ok: false, status: "not_found", answer: "Não achei com segurança qual produto você quer movimentar. Fala a marca, capacidade ou SKU." };
  }

  const bestScore = matches[0].match_score;
  const best = matches.filter(item => item.match_score === bestScore);
  const positive = best.filter(item => Number(item.on_hand || 0) !== 0 || Number(item.available || 0) !== 0);
  const product = best.length === 1 ? best[0] : positive.length === 1 ? positive[0] : null;

  if (!product) {
    const options = best.slice(0, 4).map(item => `${item.name} (SKU ${item.sku})`).join("; ");
    return { ok: false, status: "ambiguous", answer: `Achei mais de um item parecido: ${options}. Fala o SKU ou mais um detalhe antes de eu mexer no estoque.` };
  }

  const unitCost = type === "stock_entry" ? extrairCusto(text) : null;
  const delta = type === "stock_entry" ? quantity : -quantity;
  const verb = type === "stock_entry" ? "dar entrada" : "dar baixa";
  const costText = unitCost != null ? ` a ${formatCurrency(unitCost)} cada` : "";

  const pendingPayload = {
    action: type,
    product_id: Number(product.product_id),
    product_name: product.name,
    product_sku: product.sku,
    quantity,
    delta,
    unit_cost: unitCost,
    previous_on_hand: Number(product.on_hand || 0),
    previous_available: Number(product.available || 0)
  };
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const audit = await registrarAuditoria({
    source: context.source,
    actorKey: context.actorKey,
    actorRole: context.actorRole,
    page: context.page,
    commandText: text,
    commandType: type,
    status: "pending_confirmation",
    requiresConfirmation: true,
    resultSummary: `Aguardando confirmação para ${verb} de ${quantity} unidades de ${product.name}.`,
    pendingPayload,
    expiresAt,
    metadata: { channel: context.source }
  });

  return {
    ok: true,
    status: "pending_confirmation",
    requires_confirmation: true,
    audit_id: audit.id,
    answer: `Vou ${verb} de ${formatNumber(quantity)} unidades de ${product.name}${costText}. Saldo atual: ${formatNumber(product.on_hand)}. Confirma?`,
    data: pendingPayload
  };
}

async function executarPendente(pending) {
  const payload = pending?.pending_payload || {};
  if (!pending || !payload.action || !payload.product_id || !payload.delta) {
    throw new Error("Comando pendente inválido.");
  }

  await createStockMovement({
    productId: payload.product_id,
    quantity: payload.delta,
    movementType: "adjustment",
    unitCost: payload.unit_cost,
    referenceType: "matrix_voice_command",
    referenceId: pending.id,
    idempotencyKey: `matrix-command:${pending.id}`,
    notes: payload.action === "stock_entry" ? "Entrada confirmada por comando Matrix" : "Baixa confirmada por comando Matrix",
    metadata: {
      matrix_command_audit_id: pending.id,
      source: pending.source,
      actor_key: pending.actor_key,
      original_command: pending.command_text
    }
  });

  if (payload.action === "stock_entry" && payload.unit_cost != null) {
    await atualizarCustoReal(payload.product_id, payload.unit_cost, "matrix_voice");
  }

  const { data: balance, error } = await supabase
    .from("inventory_stock")
    .select("product_id,sku,name,on_hand,reserved,available")
    .eq("product_id", payload.product_id)
    .single();
  if (error) throw new Error(error.message);

  const actionText = payload.action === "stock_entry" ? "Entrada" : "Baixa";
  const answer = `${actionText} confirmada: ${formatNumber(payload.quantity)} unidades de ${payload.product_name}. Novo saldo: ${formatNumber(balance.on_hand)}; disponíveis: ${formatNumber(balance.available)}.`;
  await atualizarAuditoria(pending.id, {
    status: "executed",
    confirmed_at: new Date().toISOString(),
    executed_at: new Date().toISOString(),
    result_summary: answer,
    metadata: {
      ...(pending.metadata || {}),
      final_balance: balance
    }
  });
  return { ok: true, status: "executed", answer, data: { balance } };
}

async function executarConfirmacao({ text, context }) {
  const pending = await buscarPendente(context.actorKey);
  if (!pending) return null;
  if (ehCancelamento(text)) {
    await cancelarPendente(context.actorKey);
    return { ok: true, status: "cancelled", answer: "Cancelado. Não alterei o estoque." };
  }
  if (!ehConfirmacao(text)) return null;
  return executarPendente(pending);
}

async function executarComandoMatrix({ text, context = {} }) {
  const safeContext = {
    source: context.source || "system",
    actorKey: context.actorKey || null,
    actorRole: context.actorRole || "unknown",
    page: context.page || null,
    permissions: {
      canReadStock: context.permissions?.canReadStock !== false,
      canReadSales: Boolean(context.permissions?.canReadSales),
      canReadFinance: Boolean(context.permissions?.canReadFinance),
      canWriteStock: Boolean(context.permissions?.canWriteStock)
    }
  };

  const confirmation = await executarConfirmacao({ text, context: safeContext });
  if (confirmation) return confirmation;

  const intent = detectarIntencao(text);
  let result;

  try {
    if (intent.type === "stock_lookup") {
      if (!safeContext.permissions.canReadStock) result = { ok: false, status: "permission_denied", answer: "Seu perfil não pode consultar o estoque." };
      else result = await consultaEstoque(text);
    } else if (intent.type === "stock_alerts") {
      if (!safeContext.permissions.canReadStock) result = { ok: false, status: "permission_denied", answer: "Seu perfil não pode consultar o estoque." };
      else result = await alertasEstoque();
    } else if (intent.type === "finance_summary") {
      if (!safeContext.permissions.canReadFinance) result = { ok: false, status: "permission_denied", answer: "Essa informação financeira só fica disponível para perfis autorizados." };
      else result = await resumoFinanceiro();
    } else if (intent.type === "sales_today") {
      if (!safeContext.permissions.canReadSales) result = { ok: false, status: "permission_denied", answer: "Esse resumo de vendas só fica disponível para perfis autorizados." };
      else result = await vendasHoje();
    } else if (intent.type === "stock_entry" || intent.type === "stock_exit") {
      return prepararMovimento({ text, type: intent.type, context: safeContext });
    } else {
      result = {
        ok: false,
        status: "unsupported",
        answer: "Ainda não conectei esse comando operacional. Já consigo consultar estoque, alertas, vendas do dia e saldos autorizados; pelo WhatsApp do administrador também preparo entrada e baixa de estoque com confirmação."
      };
    }
  } catch (error) {
    result = { ok: false, status: "error", answer: `Não consegui executar esse comando agora: ${error.message}` };
  }

  await registrarAuditoria({
    source: safeContext.source,
    actorKey: safeContext.actorKey,
    actorRole: safeContext.actorRole,
    page: safeContext.page,
    commandText: text,
    commandType: intent.type,
    status: result.status,
    resultSummary: result.answer,
    metadata: {
      ok: Boolean(result.ok),
      result_data: result.data || null
    }
  });

  return { ...result, command_type: intent.type };
}

module.exports = {
  normalizarTexto,
  ehComandoMatrix,
  ehConfirmacao,
  ehCancelamento,
  buscarPendente,
  executarComandoMatrix
};
