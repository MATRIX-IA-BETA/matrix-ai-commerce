const DEFAULT_MARKETPLACE = "mercadolivre";
const PAGE_SIZE = 1000;
const ITEM_ID_CHUNK_SIZE = 200;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function daysAgoStart(days) {
  const safeDays = Math.max(1, Math.min(Math.floor(toNumber(days, 30)), 365));
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - safeDays + 1);
  return date.toISOString();
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function paymentList(order) {
  const raw = order?.raw_data || {};
  return Array.isArray(raw.payments) ? raw.payments : [];
}

function extractMarketplaceFee(order, items) {
  let total = 0;
  let found = false;

  for (const payment of paymentList(order)) {
    if (payment?.marketplace_fee == null || payment.marketplace_fee === "") {
      continue;
    }
    const fee = Number(payment?.marketplace_fee);
    if (Number.isFinite(fee)) {
      total += Math.abs(fee);
      found = true;
    }
  }

  if (!found) {
    for (const item of items) {
      const saleFee = firstNumber(
        item?.raw_data?.sale_fee,
        item?.raw_data?.item?.sale_fee
      );
      if (saleFee != null) {
        total += Math.abs(saleFee);
        found = true;
      }
    }
  }

  return found ? roundMoney(total) : null;
}

function extractShippingCost(order) {
  const raw = order?.raw_data || {};
  return firstNumber(
    raw?.shipping?.seller_cost,
    raw?.shipping?.cost,
    raw?.shipping?.shipping_cost,
    raw?.shipping_cost
  );
}

function extractNetRevenue(order) {
  let total = 0;
  let found = false;

  for (const payment of paymentList(order)) {
    const value = firstNumber(
      payment?.transaction_details?.net_received_amount,
      payment?.net_received_amount
    );

    if (value != null) {
      total += value;
      found = true;
    }
  }

  return found ? roundMoney(total) : null;
}

function itemsForOrder(itemsByOrder, order) {
  return itemsByOrder.get(String(order.id)) || [];
}

function orderQuantity(order, items) {
  if (items.length) {
    return items.reduce(
      (sum, item) => sum + Math.max(0, toNumber(item.quantity)),
      0
    );
  }

  const rawItems = Array.isArray(order?.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];

  return rawItems.reduce(
    (sum, item) => sum + Math.max(0, toNumber(item.quantity)),
    0
  );
}

function addMetric(acc, date, accountId) {
  const key = `${accountId || "sem-conta"}:${date}`;

  if (!acc.has(key)) {
    acc.set(key, {
      date,
      marketplace: DEFAULT_MARKETPLACE,
      account_id: accountId || null,
      orders_count: 0,
      paid_orders_count: 0,
      cancelled_orders: 0,
      returned_orders: 0,
      units_sold: 0,
      gross_revenue: 0,
      net_revenue: 0,
      marketplace_fees: 0,
      marketplace_fees_complete: true,
      shipping_cost: 0,
      shipping_cost_complete: true,
      product_cost: null,
      ads_spend: null,
      returns_loss: 0,
      returns_data_complete: false,
      contribution_margin: null,
      margin_percent: null,
      average_ticket: 0,
      profitability_complete: true,
      _net_revenue_complete: true
    });
  }

  return acc.get(key);
}

async function fetchAllOrders(supabase, { start, end, limit } = {}) {
  const orders = [];
  let offset = 0;
  const maximum = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : Infinity;

  while (orders.length < maximum) {
    const pageSize = Math.min(PAGE_SIZE, maximum - orders.length);
    let query = supabase
      .from("marketplace_orders")
      .select(
        "id,marketplace,account_id,marketplace_order_id,status,total_amount,paid_amount,date_created,raw_data"
      )
      .eq("marketplace", DEFAULT_MARKETPLACE)
      .order("date_created", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (start) query = query.gte("date_created", start);
    if (end) query = query.lte("date_created", end);

    const { data, error } = await query;
    if (error) throw new Error(`Erro lendo marketplace_orders: ${error.message}`);

    const page = data || [];
    orders.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return orders;
}

async function fetchOrderItems(supabase, orderIds) {
  const itemsByOrder = new Map();
  const ids = Array.from(orderIds);

  for (let start = 0; start < ids.length; start += ITEM_ID_CHUNK_SIZE) {
    const slice = ids.slice(start, start + ITEM_ID_CHUNK_SIZE);
    if (!slice.length) continue;

    const { data, error } = await supabase
      .from("marketplace_order_items")
      .select("order_id,item_id,title,quantity,unit_price,full_unit_price,raw_data")
      .in("order_id", slice);

    if (error) {
      throw new Error(`Erro lendo marketplace_order_items: ${error.message}`);
    }

    for (const item of data || []) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key).push(item);
    }
  }

  return itemsByOrder;
}

function buildDailyMetrics(orders, itemsByOrder) {
  const byDate = new Map();

  for (const order of orders) {
    const key = dateKey(order.date_created);
    if (!key) continue;

    const items = itemsForOrder(itemsByOrder, order);
    const metric = addMetric(byDate, key, order.account_id || null);
    const status = String(order.status || "").toLowerCase();
    const isPaid = status === "paid";
    const paidAmount = firstNumber(order.paid_amount, order.total_amount) || 0;
    const gross = firstNumber(order.total_amount, order.paid_amount) || 0;
    const fee = extractMarketplaceFee(order, items);
    const shipping = extractShippingCost(order);
    const net = extractNetRevenue(order);
    const quantity = orderQuantity(order, items);

    metric.orders_count += 1;

    if (isPaid) {
      metric.paid_orders_count += 1;
      metric.units_sold += quantity;
      metric.gross_revenue += gross;

      if (net != null) {
        metric.net_revenue += net;
      } else if (fee != null && shipping != null) {
        metric.net_revenue += paidAmount - fee - Math.abs(shipping);
      } else {
        metric._net_revenue_complete = false;
      }

      if (fee != null) {
        metric.marketplace_fees += fee;
      } else {
        metric.marketplace_fees_complete = false;
        metric.profitability_complete = false;
      }

      if (shipping != null) {
        metric.shipping_cost += Math.abs(shipping);
      } else {
        metric.shipping_cost_complete = false;
        metric.profitability_complete = false;
      }
    }

    if (status === "cancelled") metric.cancelled_orders += 1;
    if (status === "returned" || status === "partially_returned") {
      metric.returned_orders += 1;
      metric.returns_loss += paidAmount;
    }

  }

  return Array.from(byDate.values()).map(metric => {
    const netRevenue = metric._net_revenue_complete
      ? roundMoney(metric.net_revenue)
      : null;
    const contribution = netRevenue != null && metric.product_cost != null && metric.ads_spend != null
      ? netRevenue - metric.product_cost - metric.ads_spend - metric.returns_loss
      : null;
    const profitabilityComplete = metric.profitability_complete && contribution != null;
    const { _net_revenue_complete, ...publicMetric } = metric;

    return {
      ...publicMetric,
      units_sold: Math.round(metric.units_sold),
      gross_revenue: roundMoney(metric.gross_revenue),
      net_revenue: netRevenue,
      marketplace_fees: metric.marketplace_fees_complete
        ? roundMoney(metric.marketplace_fees)
        : null,
      marketplace_fee: metric.marketplace_fees_complete
        ? roundMoney(metric.marketplace_fees)
        : null,
      shipping_cost: metric.shipping_cost_complete
        ? roundMoney(metric.shipping_cost)
        : null,
      product_cost: metric.product_cost,
      ads_spend: metric.ads_spend,
      ads_cost: metric.ads_spend,
      returns_loss: metric.returns_data_complete
        ? roundMoney(metric.returns_loss)
        : null,
      contribution_margin: contribution == null ? null : roundMoney(contribution),
      margin_percent: contribution != null && metric.gross_revenue > 0
        ? roundMoney((contribution / metric.gross_revenue) * 100)
        : null,
      average_ticket: (metric.paid_orders_count || metric.orders_count) > 0
        ? roundMoney(metric.gross_revenue / (metric.paid_orders_count || metric.orders_count))
        : 0,
      profitability_complete: profitabilityComplete,
      updated_at: new Date().toISOString()
    };
  });
}

function missingColumn(error) {
  const text = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ");
  const patterns = [
    /Could not find the '([^']+)' column/i,
    /column ["']?([a-zA-Z0-9_]+)["']? .* does not exist/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function isMissingConflict(error) {
  return error?.code === "42P10" || /no unique or exclusion constraint/i.test(error?.message || "");
}

async function persistDailyMetrics(supabase, records) {
  if (!records.length) return { saved: 0 };

  let payload = records.map(record => ({ ...record }));
  const requiredColumns = new Set(["account_id", "date", "orders_count"]);
  const conflictCandidates = [
    "account_id,date",
    "marketplace,account_id,date"
  ];
  let lastError = null;

  for (const onConflict of conflictCandidates) {
    if (onConflict.split(",").some(column => !(column in payload[0]))) continue;

    while (true) {
      const { error } = await supabase
        .from("account_daily_metrics")
        .upsert(payload, { onConflict });

      if (!error) {
        return {
          saved: payload.length,
          on_conflict: onConflict,
          persisted_columns: Object.keys(payload[0])
        };
      }

      lastError = error;
      const column = missingColumn(error);

      if (column && !requiredColumns.has(column) && column in payload[0]) {
        payload = payload.map(record => {
          const next = { ...record };
          delete next[column];
          return next;
        });
        continue;
      }

      if (isMissingConflict(error)) break;
      throw new Error(`Erro gravando account_daily_metrics: ${error.message}`);
    }
  }

  throw new Error(
    `Erro gravando account_daily_metrics: ${lastError?.message || "constraint unica de conta/data nao encontrada"}`
  );
}

function aggregateDaily(records) {
  let netRevenueComplete = true;
  const totals = {
    orders_count: 0,
    paid_orders_count: 0,
    cancelled_orders: 0,
    returned_orders: 0,
    units_sold: 0,
    gross_revenue: 0,
    net_revenue: 0,
    marketplace_fees: 0,
    marketplace_fees_complete: true,
    shipping_cost: 0,
    shipping_cost_complete: true,
    product_cost: null,
    ads_spend: null,
    returns_loss: 0,
    returns_data_complete: true,
    contribution_margin: null,
    average_ticket: 0,
    margin_percent: null,
    profitability_complete: true
  };

  for (const row of records) {
    totals.orders_count += toNumber(row.orders_count);
    totals.paid_orders_count += toNumber(row.paid_orders_count);
    totals.cancelled_orders += toNumber(row.cancelled_orders);
    totals.returned_orders += toNumber(row.returned_orders);
    totals.units_sold += toNumber(row.units_sold);
    totals.gross_revenue += toNumber(row.gross_revenue);
    if (row.net_revenue != null) {
      totals.net_revenue += toNumber(row.net_revenue);
    } else {
      netRevenueComplete = false;
    }
    const rowFees = row.marketplace_fees ?? row.marketplace_fee;
    if (rowFees != null) {
      totals.marketplace_fees += toNumber(rowFees);
    } else {
      totals.marketplace_fees_complete = false;
    }
    if (row.marketplace_fees_complete === false) totals.marketplace_fees_complete = false;

    if (row.shipping_cost != null) {
      totals.shipping_cost += toNumber(row.shipping_cost);
    } else {
      totals.shipping_cost_complete = false;
    }
    if (row.shipping_cost_complete === false) totals.shipping_cost_complete = false;
    if (row.product_cost != null) {
      totals.product_cost = toNumber(totals.product_cost) + toNumber(row.product_cost);
    }
    if (row.ads_spend != null || row.ads_cost != null) {
      totals.ads_spend = toNumber(totals.ads_spend) + toNumber(row.ads_spend, toNumber(row.ads_cost));
    }
    if (row.returns_loss != null) {
      totals.returns_loss += toNumber(row.returns_loss);
    } else {
      totals.returns_data_complete = false;
    }
    if (row.returns_data_complete === false) totals.returns_data_complete = false;
    if (row.contribution_margin != null) {
      totals.contribution_margin = toNumber(totals.contribution_margin) + toNumber(row.contribution_margin);
    }
    if (row.profitability_complete === false) totals.profitability_complete = false;
  }

  const ticketOrders = totals.paid_orders_count || totals.orders_count;
  totals.average_ticket = ticketOrders > 0
    ? roundMoney(totals.gross_revenue / ticketOrders)
    : 0;
  if (!netRevenueComplete) totals.net_revenue = null;
  if (!totals.marketplace_fees_complete) totals.marketplace_fees = null;
  if (!totals.shipping_cost_complete) totals.shipping_cost = null;
  if (!totals.returns_data_complete) totals.returns_loss = null;
  if (!totals.profitability_complete) totals.contribution_margin = null;
  totals.margin_percent = totals.contribution_margin != null && totals.gross_revenue > 0
    ? roundMoney((totals.contribution_margin / totals.gross_revenue) * 100)
    : null;

  totals.marketplace_fee = totals.marketplace_fees;
  totals.ads_cost = totals.ads_spend;

  for (const key of Object.keys(totals)) {
    if (typeof totals[key] === "number") totals[key] = roundMoney(totals[key]);
  }

  return totals;
}

function buildInsights(totals) {
  const insights = [];

  if (totals.orders_count > 0) {
    insights.push({
      type: "analytics",
      title: "Pedidos consolidados",
      summary: `${totals.orders_count} pedidos entraram no Analytics do período.`,
      message: `${totals.orders_count} pedidos entraram no Analytics do período.`
    });
  }

  if (totals.profitability_complete === false) {
    insights.push({
      type: "data_gap",
      title: "Lucratividade incompleta",
      summary: "Alguns pedidos não trouxeram todos os componentes financeiros. A margem permanece incompleta até existirem dados reais suficientes.",
      message: "Alguns pedidos não trouxeram todos os componentes financeiros. A margem permanece incompleta até existirem dados reais suficientes."
    });
  }

  if (totals.contribution_margin < 0) {
    insights.push({
      type: "loss",
      title: "Margem negativa detectada",
      summary: "A soma de taxas, frete, devoluções, custos e Ads superou a receita líquida no período.",
      message: "A soma de taxas, frete, devoluções, custos e Ads superou a receita líquida no período."
    });
  }

  return insights;
}

async function rebuildProfitability(supabase, options = {}) {
  const orders = await fetchAllOrders(supabase, {
    start: options.start || (options.days ? daysAgoStart(options.days) : null),
    end: options.end || null,
    limit: options.limit || null
  });
  const itemsByOrder = await fetchOrderItems(
    supabase,
    new Set(orders.map(order => order.id))
  );
  const daily = buildDailyMetrics(orders, itemsByOrder);
  const persistence = await persistDailyMetrics(supabase, daily);

  return {
    success: true,
    sucesso: true,
    marketplace: DEFAULT_MARKETPLACE,
    account_id: orders.find(order => order.account_id)?.account_id || null,
    source_orders: orders.length,
    total_found: orders.length,
    processed: orders.length,
    errors: [],
    days_rebuilt: daily.length,
    saved_metrics: persistence.saved,
    persisted_columns: persistence.persisted_columns || [],
    daily,
    totals: aggregateDaily(daily)
  };
}

async function loadExecutive(supabase, days = 30, options = {}) {
  const windowDays = Math.max(1, Math.min(toNumber(days, 30), 365));
  const start = daysAgoStart(windowDays);

  let { data, error } = await supabase
    .from("account_daily_metrics")
    .select("*")
    .eq("marketplace", DEFAULT_MARKETPLACE)
    .gte("date", start.slice(0, 10))
    .order("date", { ascending: true });

  if (error && missingColumn(error) === "marketplace") {
    ({ data, error } = await supabase
      .from("account_daily_metrics")
      .select("*")
      .gte("date", start.slice(0, 10))
      .order("date", { ascending: true }));
  }

  if (error) {
    throw new Error(`Erro lendo account_daily_metrics: ${error.message}`);
  }

  let daily = data || [];
  let rebuilt = false;

  if (!daily.length && options.autoRebuild !== false) {
    const rebuiltResult = await rebuildProfitability(supabase, { start });
    daily = rebuiltResult.daily;
    rebuilt = true;
  }

  const totals = aggregateDaily(daily);
  const accountIds = Array.from(new Set(daily.map(row => row.account_id).filter(Boolean)));

  return {
    success: true,
    sucesso: true,
    marketplace: DEFAULT_MARKETPLACE,
    account_id: accountIds.length === 1 ? accountIds[0] : null,
    window_days: windowDays,
    rebuilt,
    orders_count: totals.orders_count,
    gross_revenue: totals.gross_revenue,
    receita_bruta: totals.gross_revenue,
    receita_liquida: totals.net_revenue,
    daily,
    totals,
    insights: buildInsights(totals)
    ,health: {
      health_score: null,
      explanation: "Score indisponivel ate existirem todos os componentes reais."
    },
    losses: [],
    opportunities: [],
    returns: [],
    returns_complete: false,
    trust: {
      mode: "real-data-only",
      estimated_values_are_never_silently_zero: true,
      generated_at: new Date().toISOString()
    }
  };
}

module.exports = {
  rebuildProfitability,
  loadExecutive
};
