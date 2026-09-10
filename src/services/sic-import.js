const crypto = require("crypto");
const zlib = require("zlib");
const { supabase } = require("../db/supabase");

const EXPECTED_PACKAGE_SHA256 = "b222e91f75f2b544467c08600af00d7ff478dee58b514c228a8634444a752529";
const EXPECTED_BACKUP_SHA256 = "9fa443ffd5bbc2262d5c3dfa1d97dd1bb400b1537ca920afc95208863bee1da6";
const sessions = new Map();
const SESSION_TTL_MS = 45 * 60 * 1000;

const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const txt = v => { const s = String(v ?? "").trim(); return s || null; };
const yes = v => v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
const validDate = v => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1900 && year <= 2026 ? s : null;
};
const doc = v => String(v ?? "").replace(/\D/g, "");
const validDoc = v => [11, 14].includes(doc(v).length);

async function upsertBatches(table, rows, onConflict, batchSize = 500) {
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
    done += batch.length;
  }
  return done;
}

async function insertBatches(table, rows, batchSize = 300, select = null) {
  const result = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    let query = supabase.from(table).insert(rows.slice(i, i + batchSize));
    if (select) query = query.select(select);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (data) result.push(...data);
  }
  return result;
}

async function fetchAll(table, select = "*", configure = q => q, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const query = configure(supabase.from(table).select(select).range(from, from + pageSize - 1));
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function cleanupSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) if (session.createdAt < cutoff) sessions.delete(id);
}

function validatePayload(payload) {
  if (!payload || payload?.meta?.sha !== EXPECTED_BACKUP_SHA256) throw new Error("Pacote não corresponde ao backup SIC autorizado.");
  const expected = { products: 753, customers: 11637, sales: 17965, sale_items: 99834, purchases: 2225, purchase_items: 3784 };
  for (const [key, count] of Object.entries(expected)) {
    if (!Array.isArray(payload[key]) || payload[key].length !== count) throw new Error(`Pacote SIC inválido em ${key}.`);
  }
}

function registerSicPackage(buffer) {
  cleanupSessions();
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (hash !== EXPECTED_PACKAGE_SHA256) throw new Error("Arquivo de migração não é o pacote SIC validado pela Matrix.");
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  validatePayload(payload);
  const id = crypto.randomUUID();
  sessions.set(id, { createdAt: Date.now(), payload, completed: new Set() });
  return {
    session_id: id,
    resumo: {
      produtos: payload.products.length,
      clientes: payload.customers.length,
      vendas: payload.sales.length,
      itens_venda: payload.sale_items.length,
      entradas: payload.purchases.length,
      itens_entrada: payload.purchase_items.length,
      fornecedores: payload.suppliers.length,
      orcamentos: payload.quotes.length
    }
  };
}

function getSession(id) {
  cleanupSessions();
  const session = sessions.get(id);
  if (!session) throw new Error("Sessão de migração expirou. Envie o pacote novamente.");
  return session;
}

function productRecords(p) {
  const supplier = new Map(p.suppliers.map(r => [n(r[0]), txt(r[2])]));
  return p.products.map(r => ({
    sku: txt(r[1]) || `SIC-${r[0]}`,
    name: txt(r[3]) || `Produto SIC ${r[0]}`,
    category: "SIC",
    product_type: "component",
    unit: txt(r[12]) || "UN",
    minimum_stock: n(r[11]),
    average_cost: n(r[8]),
    supplier_name: supplier.get(n(r[6])) || null,
    active: !yes(r[16]),
    metadata: {
      source: "sic", sic_control: n(r[0]), sic_code: txt(r[1]), sic_internal_code: txt(r[2]),
      sector_legacy_control: n(r[4]) || null, manufacturer: txt(r[5]), supplier_legacy_control: n(r[6]) || null,
      last_cost: n(r[7]), sale_price: n(r[9]), sic_quantity: n(r[10]), profit_percent: n(r[13]),
      commission_percent: n(r[14]), last_adjustment: validDate(r[15]), ean: txt(r[17]), ean_trib: txt(r[18])
    }
  }));
}

async function loadProductMap() {
  const rows = await fetchAll("erp_sic_product_map", "sic_control,product_id,sic_code");
  return new Map(rows.map(x => [n(x.sic_control), n(x.product_id)]));
}
async function loadCustomerMap() {
  const rows = await fetchAll("erp_sic_customer_map", "sic_control,customer_id");
  return new Map(rows.map(x => [n(x.sic_control), x.customer_id]));
}
async function loadSupplierMap() {
  const rows = await fetchAll("erp_suppliers", "id,legacy_control");
  return new Map(rows.map(x => [n(x.legacy_control), n(x.id)]));
}

async function phaseCore(p) {
  await upsertBatches("erp_sale_types", p.sale_types.map(r => ({ legacy_control: n(r[0]), name: txt(r[1]) || `Tipo ${r[0]}`, fixed: yes(r[2]), source: "sic" })), "legacy_control");
  await upsertBatches("erp_payment_methods", p.payment_methods.map(r => ({ legacy_control: n(r[0]), name: txt(r[1]) || `Pagamento ${r[0]}`, fixed: yes(r[2]), source: "sic" })), "legacy_control");
  await upsertBatches("erp_sales_channels", p.channels.map(r => ({ legacy_control: n(r[0]), name: txt(r[1]) || `Canal ${r[0]}`, commission_percent: n(r[2]), registered_at: validDate(r[3]), source: "sic", metadata: { type: txt(r[4]), code: txt(r[5]) } })), "legacy_control");
  await upsertBatches("erp_suppliers", p.suppliers.map(r => ({
    source: "sic", legacy_control: n(r[0]), legacy_code: txt(r[1]), name: txt(r[2]) || `Fornecedor ${r[0]}`,
    contact_name: txt(r[3]), document_number: validDoc(r[4]) ? doc(r[4]) : null, state_registration: txt(r[5]),
    address_line: txt(r[6]), neighborhood: txt(r[7]), city: txt(r[8]), state: txt(r[9]), zip_code: txt(r[10]),
    phone: txt(r[11]), fax: txt(r[12]), email: txt(r[13]), notes: txt(r[14]), raw_data: { registered_at: validDate(r[15]) }
  })), "legacy_control");
  await upsertBatches("erp_legacy_settings", p.settings.map(r => ({ section: txt(r[0]) || "SIC", setting_key: txt(r[1]) || "", setting_value: txt(r[2]), source: "sic" })).filter(r => r.setting_key), "section,setting_key");

  const refs = [];
  for (const [sourceTable, rows] of Object.entries(p.references || {})) {
    for (const r of rows) refs.push({ source_table: sourceTable, legacy_key: String(r[0]), display_name: txt(r[1]), data: { values: r } });
  }
  await upsertBatches("erp_legacy_reference_data", refs, "source_table,legacy_key");

  const products = productRecords(p);
  await upsertBatches("inventory_products", products, "sku", 300);
  const idBySku = new Map();
  for (let i = 0; i < products.length; i += 120) {
    const skus = products.slice(i, i + 120).map(x => x.sku);
    const { data, error } = await supabase.from("inventory_products").select("id,sku").in("sku", skus);
    if (error) throw new Error(`inventory_products map: ${error.message}`);
    for (const row of data || []) idBySku.set(row.sku, n(row.id));
  }
  const maps = p.products.map(r => {
    const sku = txt(r[1]) || `SIC-${r[0]}`;
    return { sic_control: n(r[0]), product_id: idBySku.get(sku), sic_code: sku };
  }).filter(x => x.product_id);
  await upsertBatches("erp_sic_product_map", maps, "sic_control");

  const { error: deleteError } = await supabase.from("inventory_movements").delete().eq("reference_type", "sic_opening_balance");
  if (deleteError) throw new Error(`Limpando saldo-base SIC: ${deleteError.message}`);
  const opening = [];
  for (const r of p.products) {
    const quantity = n(r[10]);
    if (!quantity) continue;
    const productId = idBySku.get(txt(r[1]) || `SIC-${r[0]}`);
    if (!productId) continue;
    opening.push({
      product_id: productId, quantity, movement_type: "opening_balance", unit_cost: n(r[8]),
      reference_type: "sic_opening_balance", reference_id: String(r[0]), idempotency_key: `sic:opening:${r[0]}`,
      notes: "Saldo físico importado do SICNET", metadata: { source: "sic", backup_sha256: p.meta.sha }
    });
  }
  await upsertBatches("inventory_movements", opening, "idempotency_key", 300);
  await upsertBatches("erp_sic_import_runs", [{
    source_name: "SICNET", source_file: "sicnet.bak", backup_sha256: p.meta.sha, backup_size_bytes: n(p.meta.size),
    backup_observed_at: p.meta.observed, status: "running", summary: { phase: "core" }
  }], "backup_sha256");
  return { produtos: maps.length, saldos: opening.length, unidades_em_estoque: opening.reduce((a, x) => a + n(x.quantity), 0), fornecedores: p.suppliers.length };
}

function customerStage(r) {
  return {
    sic_control: n(r[0]), sic_code: txt(r[1]), name: txt(r[2]), document_number: validDoc(r[17]) ? doc(r[17]) : null,
    document_type: txt(r[18]), address_line: txt(r[3]), address_number: txt(r[4]), address_complement: txt(r[5]),
    neighborhood: txt(r[6]), city: txt(r[7]), state: txt(r[8]), zip_code: txt(r[9]), phone: txt(r[10]), mobile: txt(r[11]),
    email: txt(r[16]), contact_name: txt(r[19]), state_registration: txt(r[20]), identity_number: txt(r[21]),
    profession: txt(r[23]), birth_date: validDate(r[22]), registered_at: validDate(r[12]), credit_limit: n(r[24]), blocked: yes(r[25]),
    source_raw: { obs: txt(r[15]), customer_type_legacy_control: n(r[13]) || null, sales_channel_legacy_control: n(r[14]) || null, bank_reference: txt(r[26]), commercial_reference: txt(r[27]), activity: txt(r[28]), fax: txt(r[29]) }
  };
}

async function phaseCustomers(p) {
  const staged = p.customers.map(customerStage);
  await upsertBatches("erp_sic_customers_stage", staged, "sic_control", 400);

  const existing = await fetchAll("customers", "id,source,marketplace_buyer_id,document_number");
  const byTech = new Map();
  const byDoc = new Map();
  for (const c of existing) {
    if (c.source === "sic" && c.marketplace_buyer_id) byTech.set(c.marketplace_buyer_id, c.id);
    if (validDoc(c.document_number) && !byDoc.has(doc(c.document_number))) byDoc.set(doc(c.document_number), c.id);
  }

  const directMaps = new Map();
  const newKeys = new Map();
  for (const r of staged) {
    const tech = `SIC:${r.sic_control}`;
    const document = validDoc(r.document_number) ? doc(r.document_number) : null;
    const existingId = byTech.get(tech) || (document ? byDoc.get(document) : null);
    if (existingId) { directMaps.set(r.sic_control, existingId); continue; }
    const key = document ? `DOC:${document}` : `TECH:${tech}`;
    if (!newKeys.has(key)) newKeys.set(key, { representative: r, controls: [] });
    newKeys.get(key).controls.push(r.sic_control);
  }

  const newRows = [...newKeys.values()].map(({ representative: r }) => ({
    source: "sic", marketplace_buyer_id: `SIC:${r.sic_control}`, name: r.name || `Cliente SIC ${r.sic_control}`,
    email: r.email, phone: r.mobile || r.phone, document_type: r.document_type, document_number: r.document_number,
    address_line: r.address_line, address_number: r.address_number, neighborhood: r.neighborhood, city: r.city, state: r.state,
    zip_code: r.zip_code, country: "BR", raw_data: { sic_control: r.sic_control, sic_code: r.sic_code, contact_name: r.contact_name,
      address_complement: r.address_complement, state_registration: r.state_registration, identity_number: r.identity_number,
      profession: r.profession, birth_date: r.birth_date, registered_at: r.registered_at, credit_limit: r.credit_limit, blocked: r.blocked }
  }));
  const created = await insertBatches("customers", newRows, 250, "id,marketplace_buyer_id,document_number");
  const createdByTech = new Map(created.map(c => [c.marketplace_buyer_id, c.id]));
  const createdByDoc = new Map(created.filter(c => validDoc(c.document_number)).map(c => [doc(c.document_number), c.id]));

  for (const [key, info] of newKeys) {
    const id = key.startsWith("DOC:") ? createdByDoc.get(key.slice(4)) : createdByTech.get(key.slice(5));
    if (!id) throw new Error(`Falha vinculando cliente SIC ${info.controls[0]}`);
    for (const control of info.controls) directMaps.set(control, id);
  }
  const maps = staged.map(r => ({ sic_control: r.sic_control, customer_id: directMaps.get(r.sic_control), match_method: byDoc.has(doc(r.document_number)) ? "document" : "sic_created" })).filter(x => x.customer_id);
  await upsertBatches("erp_sic_customer_map", maps, "sic_control", 400);
  return { clientes_sic: staged.length, vinculados: maps.length, clientes_novos: created.length, aproveitados_existentes: staged.length - created.length };
}

function buildSaleAgg(p) {
  const map = new Map();
  for (const r of p.sale_items) {
    const key = n(r[1]);
    const a = map.get(key) || { lines: 0, units: 0, gross: 0, net: 0, profit: 0 };
    a.lines += 1; a.units += n(r[2]); a.gross += n(r[4]); a.net += n(r[5]); a.profit += n(r[6]);
    map.set(key, a);
  }
  return map;
}

async function phaseSales(p) {
  const customers = await loadCustomerMap();
  const agg = buildSaleAgg(p);
  const rows = p.sales.map(r => {
    const a = agg.get(n(r[0])) || { lines: 0, units: 0, gross: 0, net: 0, profit: 0 };
    return {
      source: "sic", legacy_control: n(r[0]), sale_date: validDate(r[1]), sale_time_seconds: n(r[2]),
      sale_type_legacy_control: n(r[3]) || null, payment_method_legacy_control: n(r[6]) || null,
      sales_channel_legacy_control: n(r[7]) || null, sic_customer_control: n(r[8]) || null,
      customer_id: customers.get(n(r[8])) || null, is_sale: yes(r[14]), cancelled: yes(r[16]), note_number: n(r[4]) || null,
      order_number: n(r[5]) || null, nfe_number: n(r[21]) || null, freight_amount: n(r[17]), gross_amount: a.gross,
      net_amount: a.net, estimated_cost_amount: a.net - a.profit, profit_amount: a.profit, units: a.units, item_lines: a.lines,
      notes: txt(r[13]), metadata: { supplier_legacy_control: n(r[9]) || null, tag_customer: txt(r[10]), commission: n(r[11]), seller_commission: n(r[12]), sic_user_control: n(r[15]) || null, transporter_legacy_control: n(r[18]) || null, store_legacy_control: n(r[19]) || null, client_manager_legacy_control: n(r[20]) || null, resale: yes(r[22]), resale_commission: n(r[23]) }
    };
  });
  await upsertBatches("erp_sales", rows, "legacy_control", 400);
  return { vendas: rows.length };
}

async function phaseSaleItems(p, part) {
  const products = await loadProductMap();
  const chunkSize = 20000;
  const start = part * chunkSize;
  const end = Math.min(p.sale_items.length, start + chunkSize);
  const rows = p.sale_items.slice(start, end).map(r => ({
    source: "sic", legacy_control: n(r[0]), sale_legacy_control: n(r[1]), sic_product_control: n(r[3]) || null,
    product_id: products.get(n(r[3])) || null, quantity: n(r[2]), gross_total: n(r[4]), net_total: n(r[5]),
    profit_amount: n(r[6]), surcharge_amount: n(r[7]), cancelled_quantity: n(r[10]), cancelled_amount: n(r[11]),
    icms_percent: n(r[9]), commission_percent: n(r[14]), cfop: txt(r[12]), forecast_date: validDate(r[15]),
    metadata: { included_at: validDate(r[8]), price_table_legacy_control: n(r[13]) || null }
  }));
  await upsertBatches("erp_sale_items", rows, "legacy_control", 800);
  return { parte: part + 1, partes: 5, itens: rows.length, processados_ate: end, total: p.sale_items.length };
}

async function phaseRest(p) {
  const products = await loadProductMap();
  const customers = await loadCustomerMap();
  const suppliers = await loadSupplierMap();
  await upsertBatches("erp_sale_payments", p.payments.map(r => ({ source: "sic", legacy_control: n(r[0]), sale_legacy_control: n(r[1]), payment_method_legacy_control: n(r[2]) || null, amount: n(r[3]), change_amount: n(r[4]) })), "legacy_control", 800);

  const purchaseAgg = new Map();
  for (const r of p.purchase_items) {
    const key = n(r[1]); const a = purchaseAgg.get(key) || { lines: 0, units: 0, total: 0 };
    a.lines++; a.units += n(r[3]); a.total += n(r[4]); purchaseAgg.set(key, a);
  }
  const purchases = p.purchases.map(r => {
    const a = purchaseAgg.get(n(r[0])) || { lines: 0, units: 0, total: 0 };
    return { source: "sic", legacy_control: n(r[0]), entry_date: validDate(r[1]), note_number: n(r[2]) || null,
      supplier_legacy_control: n(r[3]) || null, supplier_id: suppliers.get(n(r[3])) || null, sic_customer_control: n(r[7]) || null,
      entry_type: txt(r[6]), freight_amount: n(r[5]), total_amount: a.total, units: a.units, item_lines: a.lines,
      cfop: txt(r[9]), nfe_access_key: txt(r[11]), notes: txt(r[4]), metadata: { sic_user_control: n(r[8]) || null, store_legacy_control: n(r[10]) || null } };
  });
  await upsertBatches("erp_purchase_entries", purchases, "legacy_control", 500);
  await upsertBatches("erp_purchase_items", p.purchase_items.map(r => ({ source: "sic", legacy_control: n(r[0]), purchase_legacy_control: n(r[1]), sic_product_control: n(r[2]) || null, product_id: products.get(n(r[2])) || null, quantity: n(r[3]), total_amount: n(r[4]), unit_cost: n(r[3]) ? n(r[4]) / n(r[3]) : 0, icms_percent: n(r[5]), ipi_amount: n(r[6]), included_at: validDate(r[7]), expiry_date: validDate(r[8]), quantity_consumed: n(r[9]), cfop: txt(r[10]), ipi_percent: n(r[11]), metadata: {} })), "legacy_control", 800);

  await upsertBatches("erp_quotes", p.quotes.map(r => ({ source: "sic", legacy_control: n(r[0]), quote_date: validDate(r[1]), quote_time_seconds: n(r[2]), sic_customer_control: n(r[3]) || null, customer_id: customers.get(n(r[3])) || null, customer_name: txt(r[5]), contact_name: txt(r[6]), total_amount: n(r[7]), sales_channel_legacy_control: n(r[8]) || null, notes: txt(r[9]) })), "legacy_control", 500);
  await upsertBatches("erp_quote_items", p.quote_items.map(r => ({ source: "sic", legacy_control: n(r[0]), quote_legacy_control: n(r[1]), sic_product_control: n(r[2]) || null, product_id: products.get(n(r[2])) || null, product_name: txt(r[3]), quantity: n(r[4]), unit_price: n(r[5]), real_unit_price: n(r[6]), original_unit_price: n(r[7]), total_amount: n(r[8]) })), "legacy_control", 800);
  await upsertBatches("erp_audit_logs", p.logs.map(r => ({ source_table: "TABLOG", legacy_control: n(r[0]), event_date: validDate(r[1]), start_time_seconds: n(r[2]), end_time_seconds: n(r[3]), sic_user_control: n(r[4]) || null, level: n(r[5]), action: txt(r[6]), station: txt(r[7]), metadata: {} })), "source_table,legacy_control", 800);
  return { pagamentos: p.payments.length, entradas: purchases.length, itens_entrada: p.purchase_items.length, orcamentos: p.quotes.length, itens_orcamento: p.quote_items.length, logs: p.logs.length };
}

async function phaseFinish(p) {
  const { data: dashboard, error } = await supabase.from("erp_dashboard_summary").select("*").single();
  if (error) throw new Error(`Validação ERP: ${error.message}`);
  const { error: runError } = await supabase.from("erp_sic_import_runs").update({ status: "success", finished_at: new Date().toISOString(), summary: { phase: "finished", dashboard } }).eq("backup_sha256", p.meta.sha);
  if (runError) throw new Error(`Finalizando migração: ${runError.message}`);
  return dashboard;
}

const phases = ["core", "customers", "sales", "sale-items-0", "sale-items-1", "sale-items-2", "sale-items-3", "sale-items-4", "rest", "finish"];
async function runSicImportPhase(sessionId, phase) {
  if (!phases.includes(phase)) throw new Error("Fase de migração inválida.");
  const session = getSession(sessionId);
  let result;
  if (phase === "core") result = await phaseCore(session.payload);
  else if (phase === "customers") result = await phaseCustomers(session.payload);
  else if (phase === "sales") result = await phaseSales(session.payload);
  else if (phase.startsWith("sale-items-")) result = await phaseSaleItems(session.payload, Number(phase.slice(-1)));
  else if (phase === "rest") result = await phaseRest(session.payload);
  else result = await phaseFinish(session.payload);
  session.completed.add(phase);
  if (phase === "finish") sessions.delete(sessionId);
  return { phase, result, concluida: phase === "finish" };
}

module.exports = { EXPECTED_PACKAGE_SHA256, EXPECTED_BACKUP_SHA256, registerSicPackage, runSicImportPhase, phases };
