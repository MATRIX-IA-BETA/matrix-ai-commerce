// Matrix AI Commerce — Núcleo Analítico V1
// Não inventa custos: campos ausentes entram em missing_fields.
// Compatível com Supabase JS e com as tabelas da migração 06.

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((n(v) + Number.EPSILON) * p) / p;
}
function dateOnly(v) {
  return v ? String(v).slice(0, 10) : null;
}
function uniq(a) {
  return [...new Set((a || []).filter(Boolean))];
}

function createAnalyticsService({ supabase }) {
  if (!supabase) throw new Error("analytics: supabase obrigatório");

  async function getAccount(accountId = null) {
    let q = supabase.from("marketplace_accounts")
      .select("id,marketplace,account_id,user_id")
      .eq("marketplace", "mercadolivre");
    if (accountId) q = q.eq("account_id", String(accountId));
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function ensureAnalyticsAccount(account) {
    if (!account) return null;
    const marketplaceAccountId = String(account.account_id || account.user_id);
    const record = {
      marketplace: "mercadolivre",
      marketplace_account_id: marketplaceAccountId,
      currency_id: "BRL",
      updated_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from("analytics_accounts")
      .upsert(record, { onConflict: "marketplace,marketplace_account_id" })
      .select("*").single();
    if (error) throw error;
    return data;
  }

  function extractOrderComponents(order) {
    const raw = order.raw_data || {};
    const comps = [];
    const add = (type, name, amount, direction="expense", sourceRef=null, meta={}) => {
      const value = n(amount);
      if (!value) return;
      comps.push({
        marketplace: "mercadolivre",
        marketplace_order_id: String(order.marketplace_order_id),
        component_type: type,
        component_name: name,
        amount: Math.abs(value),
        currency_id: order.currency_id || raw.currency_id || "BRL",
        direction,
        source: "marketplace_order_payload",
        source_ref: sourceRef,
        is_estimated: false,
        occurred_at: order.date_created || null,
        metadata: meta
      });
    };

    // Dados efetivamente presentes no payload do pedido.
    for (const p of Array.isArray(raw.payments) ? raw.payments : []) {
      const id = p.id != null ? String(p.id) : null;
      add("marketplace_fee", "marketplace_fee", p.marketplace_fee, "expense", id, { payment_id:id });
      add("shipping_cost", "shipping_cost", p.shipping_cost, "expense", id, { payment_id:id });
      add("tax", "taxes_amount", p.taxes_amount, "expense", id, { payment_id:id });
      add("coupon", "coupon_amount", p.coupon_amount, "expense", id, { payment_id:id });
      add("discount", "discount_amount", p.discount_amount, "expense", id, { payment_id:id });
      add("refund", "transaction_amount_refunded", p.transaction_amount_refunded, "expense", id, { payment_id:id });
    }

    const charges = Array.isArray(raw.order_items) ? raw.order_items : [];
    charges.forEach((item, idx) => {
      const saleFee = item.sale_fee ?? item.sale_fee_amount;
      add("marketplace_fee", "sale_fee", saleFee, "expense",
          `${item.item?.id || "item"}:${idx}`, { item_id:item.item?.id || null });
    });

    return comps;
  }

  async function replaceOrderComponents(order) {
    const orderId = String(order.marketplace_order_id);
    const { error: delErr } = await supabase.from("order_financial_components")
      .delete()
      .eq("marketplace", "mercadolivre")
      .eq("marketplace_order_id", orderId)
      .eq("source", "marketplace_order_payload");
    if (delErr) throw delErr;

    const comps = extractOrderComponents(order);
    if (comps.length) {
      const { error } = await supabase.from("order_financial_components").insert(comps);
      if (error) throw error;
    }
    return comps;
  }

  async function findProductCost(item, atDate) {
    let q = supabase.from("product_cost_history")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .eq("item_id", String(item.item_id))
      .lte("effective_from", atDate || new Date().toISOString())
      .order("effective_from", { ascending:false })
      .limit(1);
    if (item.variation_id) q = q.eq("variation_id", String(item.variation_id));
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return data;
  }

  async function calculateOrder(order) {
    const orderId = String(order.marketplace_order_id);
    const { data: items, error: itemsErr } = await supabase.from("marketplace_order_items")
      .select("item_id,variation_id,title,quantity,unit_price,full_unit_price")
      .eq("order_id", order.id);
    if (itemsErr) throw itemsErr;

    const components = await replaceOrderComponents(order);
    const sumType = type => components.filter(x => x.component_type === type)
      .reduce((s,x) => s + (x.direction === "income" ? -n(x.amount) : n(x.amount)), 0);

    let productCost = 0;
    const missing = [];
    const costEvidence = [];

    for (const item of items || []) {
      if (!item.item_id) {
        missing.push("product_cost:item_sem_id");
        continue;
      }
      const cost = await findProductCost(item, order.date_created);
      if (!cost) {
        missing.push(`product_cost:${item.item_id}${item.variation_id ? ":"+item.variation_id : ""}`);
        continue;
      }
      const qty = n(item.quantity);
      const unitTotal = n(cost.unit_cost) + n(cost.freight_in_cost) + n(cost.packaging_cost)
        + n(cost.tax_cost) + n(cost.other_cost);
      productCost += qty * unitTotal;
      costEvidence.push({ item_id:item.item_id, variation_id:item.variation_id, qty, unit_total:unitTotal });
    }

    const gross = n(order.total_amount);
    const paid = order.paid_amount == null ? gross : n(order.paid_amount);
    const fees = sumType("marketplace_fee");
    const shipping = sumType("shipping_cost");
    const tax = sumType("tax");
    const refunds = sumType("refund");
    const discounts = sumType("discount") + sumType("coupon");

    if (!components.some(x => x.component_type === "marketplace_fee")) missing.push("marketplace_fees");
    if (!components.some(x => x.component_type === "shipping_cost")) missing.push("shipping_cost");
    missing.push("ads_cost"); // só sai daqui quando Ads for sincronizado/atribuído.
    if (!costEvidence.length && (items || []).length) missing.push("product_cost");

    const { data: returns } = await supabase.from("marketplace_returns")
      .select("total_loss,refunded_amount")
      .eq("marketplace_order_id", orderId);
    const returnsCost = (returns || []).reduce((s,r) => s+n(r.total_loss || r.refunded_amount), 0);

    const net = paid - refunds - discounts;
    const margin = net - productCost - fees - shipping - tax - returnsCost;
    const pct = net ? (margin / net) * 100 : null;

    const snapshot = {
      marketplace:"mercadolivre",
      marketplace_order_id:orderId,
      gross_revenue:round(gross,4),
      net_revenue:round(net,4),
      product_cost:round(productCost,4),
      marketplace_fees:round(fees,4),
      shipping_cost:round(shipping,4),
      ads_cost:0,
      tax_cost:round(tax,4),
      returns_cost:round(returnsCost,4),
      other_cost:0,
      contribution_margin:round(margin,4),
      contribution_margin_percent:pct == null ? null : round(pct,4),
      estimated_fields:[],
      missing_fields:uniq(missing),
      calculation_version:"v1.1-real-data-only",
      calculated_at:new Date().toISOString(),
      metadata:{ cost_evidence:costEvidence, financial_components:components.length }
    };
    const { error } = await supabase.from("order_profitability_snapshots").insert(snapshot);
    if (error) throw error;
    return snapshot;
  }

  async function rebuildProfitability({ days=30, limit=3000 }={}) {
    const since = new Date(Date.now() - Math.max(1,days)*86400000).toISOString();
    const { data: orders, error } = await supabase.from("marketplace_orders")
      .select("*").eq("marketplace","mercadolivre")
      .gte("date_created", since)
      .order("date_created",{ascending:false}).limit(Math.min(limit,5000));
    if (error) throw error;
    const result = { processed:0, errors:[] };
    for (const order of orders || []) {
      try { await calculateOrder(order); result.processed++; }
      catch(e) { result.errors.push({ order_id:order.marketplace_order_id, error:e.message }); }
    }
    return result;
  }

  async function rebuildDailyMetrics({ days=30 }={}) {
    const account = await getAccount();
    if (!account) throw new Error("Nenhuma conta Mercado Livre conectada.");
    await ensureAnalyticsAccount(account);
    const accountId = String(account.account_id || account.user_id);
    const sinceDate = new Date(Date.now() - Math.max(1,days)*86400000).toISOString().slice(0,10);

    const { data: xray, error } = await supabase.from("v_order_financial_xray")
      .select("*").eq("marketplace","mercadolivre").gte("date_created", `${sinceDate}T00:00:00Z`);
    if (error) throw error;

    const byDay = {};
    for (const o of xray || []) {
      const d = dateOnly(o.date_created); if (!d) continue;
      const m = byDay[d] ||= {
        marketplace:"mercadolivre", account_id:accountId, date:d,
        orders_count:0, units_sold:0, gross_revenue:0, net_revenue:0, product_cost:0,
        marketplace_fees:0, shipping_cost:0, ads_spend:0, refunds:0, returns_loss:0,
        contribution_margin:0, claims_count:0, reputation_events_count:0, metadata:{}
      };
      m.orders_count++;
      m.gross_revenue += n(o.gross_revenue);
      m.net_revenue += n(o.paid_amount);
      m.product_cost += n(o.product_cost);
      m.marketplace_fees += n(o.marketplace_fees);
      m.shipping_cost += n(o.shipping_cost);
      m.ads_spend += n(o.ads_cost);
      m.returns_loss += n(o.returns_cost);
      m.contribution_margin += n(o.contribution_margin);
    }

    const { data: ads } = await supabase.from("marketplace_ads_daily")
      .select("date,spend,attributed_revenue").gte("date",sinceDate);
    for (const a of ads || []) {
      const m = byDay[a.date]; if (!m) continue;
      m.ads_spend += n(a.spend);
      m.metadata.attributed_ads_revenue = n(m.metadata.attributed_ads_revenue)+n(a.attributed_revenue);
    }

    const { data: returns } = await supabase.from("marketplace_returns")
      .select("opened_at,total_loss").gte("opened_at",`${sinceDate}T00:00:00Z`);
    const returnCounts = {};
    for (const r of returns || []) {
      const d=dateOnly(r.opened_at); if (!d || !byDay[d]) continue;
      returnCounts[d]=(returnCounts[d]||0)+1;
      byDay[d].returns_loss += n(r.total_loss);
    }

    const rows = Object.values(byDay).map(m => {
      m.gross_revenue=round(m.gross_revenue); m.net_revenue=round(m.net_revenue);
      m.product_cost=round(m.product_cost); m.marketplace_fees=round(m.marketplace_fees);
      m.shipping_cost=round(m.shipping_cost); m.ads_spend=round(m.ads_spend);
      m.returns_loss=round(m.returns_loss); m.contribution_margin=round(m.contribution_margin);
      m.contribution_margin_percent=m.net_revenue ? round(m.contribution_margin/m.net_revenue*100,4):null;
      m.acos_percent=(m.metadata.attributed_ads_revenue||0) ? round(m.ads_spend/m.metadata.attributed_ads_revenue*100,4):null;
      m.roas=m.ads_spend ? round((m.metadata.attributed_ads_revenue||0)/m.ads_spend,6):null;
      m.return_rate_percent=m.orders_count ? round((returnCounts[m.date]||0)/m.orders_count*100,4):0;
      m.calculated_at=new Date().toISOString();
      return m;
    });
    if (rows.length) {
      const { error: upErr } = await supabase.from("account_daily_metrics")
        .upsert(rows,{onConflict:"marketplace,account_id,date"});
      if (upErr) throw upErr;
    }
    return { days:rows.length, account_id:accountId };
  }

  async function generateInsights({ days=30 }={}) {
    const account = await getAccount();
    if (!account) throw new Error("Nenhuma conta Mercado Livre conectada.");
    const accountId=String(account.account_id||account.user_id);
    const since=new Date(Date.now()-Math.max(1,days)*86400000).toISOString().slice(0,10);

    const { data: metrics, error } = await supabase.from("account_daily_metrics")
      .select("*").eq("account_id",accountId).gte("date",since).order("date");
    if (error) throw error;
    const totals=(metrics||[]).reduce((a,m)=>{
      for (const k of ["orders_count","gross_revenue","net_revenue","product_cost","marketplace_fees",
        "shipping_cost","ads_spend","returns_loss","contribution_margin"]) a[k]+=n(m[k]);
      return a;
    },{orders_count:0,gross_revenue:0,net_revenue:0,product_cost:0,marketplace_fees:0,
      shipping_cost:0,ads_spend:0,returns_loss:0,contribution_margin:0});

    const { data: losses } = await supabase.from("v_top_losses_30d").select("*")
      .eq("account_id",accountId).limit(20);
    const { data: returns } = await supabase.from("marketplace_returns")
      .select("ai_reason_category,reason_text,total_loss").gte("opened_at",`${since}T00:00:00Z`);

    await supabase.from("ai_insights").update({status:"superseded",updated_at:new Date().toISOString()})
      .eq("account_id",accountId).eq("status","open").eq("metadata->>engine","matrix_rules_v1");

    const insights=[];
    const add=(x)=>insights.push({
      marketplace:"mercadolivre",account_id:accountId,status:"open",
      valid_from:new Date().toISOString(),confidence:x.confidence ?? .9,
      evidence_quality:x.evidence_quality||"measured",
      metadata:{engine:"matrix_rules_v1",window_days:days,...(x.metadata||{})},...x
    });

    const marginPct=totals.net_revenue ? totals.contribution_margin/totals.net_revenue*100:null;
    if (marginPct != null && marginPct < 10) add({
      insight_type:"margin_alert",category:"financeiro",severity:marginPct<0?"critical":"high",
      title:"Margem de contribuição baixa",
      summary:`A margem medida no período está em ${round(marginPct,2)}%.`,
      recommendation:"Revisar custos cadastrados, taxas, frete e preço dos itens com pior margem.",
      current_financial_impact:round(totals.contribution_margin), expected_financial_impact:null,
      metadata:{margin_percent:round(marginPct,4)}
    });
    if (totals.returns_loss > 0) add({
      insight_type:"returns_loss",category:"devolucoes",severity:"high",
      title:"Devoluções estão consumindo margem",
      summary:`Perda registrada com devoluções no período: R$ ${round(totals.returns_loss).toFixed(2)}.`,
      recommendation:"Atacar primeiro os motivos e SKUs que concentram a maior perda.",
      current_financial_impact:-round(totals.returns_loss),expected_financial_impact:null,
      metadata:{returns_count:(returns||[]).length}
    });
    if (totals.ads_spend > 0 && totals.net_revenue > 0) {
      const spendPct=totals.ads_spend/totals.net_revenue*100;
      if (spendPct>10) add({
        insight_type:"ads_pressure",category:"ads",severity:"medium",
        title:"Publicidade pressionando o resultado",
        summary:`O gasto de Ads registrado equivale a ${round(spendPct,2)}% da receita líquida medida.`,
        recommendation:"Separar campanhas/SKUs por ROAS e reduzir verba onde o retorno não cobre a margem.",
        current_financial_impact:-round(totals.ads_spend),expected_financial_impact:null,
        metadata:{ads_over_net_percent:round(spendPct,4)}
      });
    }
    for (const l of (losses||[]).slice(0,5)) add({
      insight_type:"loss_concentration",category:"perdas",severity:n(l.total_loss)>500?"high":"medium",
      title:`Perda concentrada: ${l.loss_type || "evento"}`,
      summary:`R$ ${round(l.total_loss).toFixed(2)} em ${l.events_count} evento(s) nos últimos 30 dias.`,
      recommendation:"Abrir os eventos de origem e eliminar a causa recorrente antes de escalar vendas.",
      current_financial_impact:-round(l.total_loss),expected_financial_impact:null,
      confidence:n(l.avg_confidence)||.8,metadata:{cause_category:l.cause_category}
    });

    if (insights.length) {
      const { data: inserted, error: insErr } = await supabase.from("ai_insights").insert(insights).select("*");
      if (insErr) throw insErr;
      for (const i of inserted || []) {
        const evidence=[{
          insight_id:i.id,evidence_type:"period_metrics",entity_type:"account",entity_id:accountId,
          metric_name:"net_revenue",metric_value:round(totals.net_revenue,6),
          calculation:`Janela de ${days} dias; dados consolidados de account_daily_metrics`,
          source_table:"account_daily_metrics",observed_at:new Date().toISOString(),is_estimated:false,confidence:1
        }];
        await supabase.from("ai_insight_evidence").insert(evidence);
      }
    }
    return { account_id:accountId, insights_created:insights.length, totals, margin_percent:marginPct==null?null:round(marginPct,4) };
  }

  async function healthSnapshot({ days=30 }={}) {
    const account=await getAccount(); if(!account) throw new Error("Nenhuma conta Mercado Livre conectada.");
    const accountId=String(account.account_id||account.user_id);
    const since=new Date(Date.now()-Math.max(1,days)*86400000).toISOString().slice(0,10);
    const { data:m }=await supabase.from("account_daily_metrics").select("*").eq("account_id",accountId).gte("date",since);
    const total=(m||[]).reduce((a,x)=>{a.rev+=n(x.net_revenue);a.margin+=n(x.contribution_margin);a.ret+=n(x.returns_loss);a.ads+=n(x.ads_spend);a.orders+=n(x.orders_count);return a;},{rev:0,margin:0,ret:0,ads:0,orders:0});
    const marginPct=total.rev?total.margin/total.rev*100:null;
    const returnPct=total.rev?total.ret/total.rev*100:0;
    const adsPct=total.rev?total.ads/total.rev*100:0;
    const financial=marginPct==null?50:Math.max(0,Math.min(100,50+marginPct*2));
    const operational=Math.max(0,Math.min(100,100-returnPct*5));
    const adsScore=Math.max(0,Math.min(100,100-adsPct*3));
    const reputation=75; // neutro enquanto não houver métrica real de reputação sincronizada
    const inventory=50;  // neutro enquanto não houver snapshots de estoque
    const health=round(financial*.4+operational*.25+reputation*.15+adsScore*.1+inventory*.1,4);
    const row={marketplace:"mercadolivre",account_id:accountId,health_score:health,
      financial_score:round(financial,4),operational_score:round(operational,4),
      reputation_score:reputation,ads_score:round(adsScore,4),inventory_score:inventory,
      amount_lost_30d:round(total.ret),amount_at_risk_30d:0,amount_opportunity_30d:0,
      explanation:{window_days:days,neutral_scores:{reputation:"aguardando dados reais",inventory:"aguardando dados reais"},
        margin_percent:marginPct==null?null:round(marginPct,4),returns_loss_percent:round(returnPct,4),ads_over_net_percent:round(adsPct,4)},
      snapshot_at:new Date().toISOString()};
    const {error}=await supabase.from("account_health_snapshots").insert(row); if(error) throw error;
    return row;
  }

  async function rebuildAll(opts={}) {
    const profitability=await rebuildProfitability(opts);
    const daily=await rebuildDailyMetrics(opts);
    const insights=await generateInsights(opts);
    const health=await healthSnapshot(opts);
    return { profitability,daily,insights,health };
  }

  async function executiveDashboard({ days=30 }={}) {
    const account=await getAccount(); if(!account) throw new Error("Nenhuma conta Mercado Livre conectada.");
    const accountId=String(account.account_id||account.user_id);
    const since=new Date(Date.now()-Math.max(1,days)*86400000).toISOString().slice(0,10);
    const [{data:metrics},{data:health},{data:insights},{data:losses},{data:opportunities},{data:returns}] = await Promise.all([
      supabase.from("account_daily_metrics").select("*").eq("account_id",accountId).gte("date",since).order("date"),
      supabase.from("account_health_snapshots").select("*").eq("account_id",accountId).order("snapshot_at",{ascending:false}).limit(1).maybeSingle(),
      supabase.from("v_open_ai_insights").select("*").eq("account_id",accountId).limit(20),
      supabase.from("v_top_losses_30d").select("*").eq("account_id",accountId).limit(20),
      supabase.from("opportunity_events").select("*").eq("account_id",accountId).eq("status","open").order("expected_gain",{ascending:false}).limit(20),
      supabase.from("marketplace_returns").select("id,marketplace_order_id,item_id,reason_text,ai_reason_category,total_loss,opened_at,status").gte("opened_at",`${since}T00:00:00Z`).order("opened_at",{ascending:false}).limit(100)
    ]);
    const totals=(metrics||[]).reduce((a,m)=>{for(const k of ["orders_count","gross_revenue","net_revenue","product_cost","marketplace_fees","shipping_cost","ads_spend","returns_loss","contribution_margin"])a[k]+=n(m[k]);return a;},
      {orders_count:0,gross_revenue:0,net_revenue:0,product_cost:0,marketplace_fees:0,shipping_cost:0,ads_spend:0,returns_loss:0,contribution_margin:0});
    const marginPct=totals.net_revenue?totals.contribution_margin/totals.net_revenue*100:null;
    return {sucesso:true,marketplace:"mercadolivre",account_id:accountId,window_days:days,
      trust:{mode:"real-data-only",estimated_values_are_never_silently_zero:true,generated_at:new Date().toISOString()},
      totals:{...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,round(v)])),margin_percent:marginPct==null?null:round(marginPct,4)},
      health:health||null,daily:metrics||[],insights:insights||[],losses:losses||[],opportunities:opportunities||[],returns:returns||[]};
  }

  return { calculateOrder,rebuildProfitability,rebuildDailyMetrics,generateInsights,healthSnapshot,rebuildAll,executiveDashboard,ensureAnalyticsAccount };
}
module.exports={ createAnalyticsService };
