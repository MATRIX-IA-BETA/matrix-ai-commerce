const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const CAMPAIGN_METRICS = [
  "clicks",
  "prints",
  "ctr",
  "cost",
  "cpc",
  "acos",
  "organic_units_quantity",
  "organic_units_amount",
  "organic_items_quantity",
  "direct_items_quantity",
  "indirect_items_quantity",
  "advertising_items_quantity",
  "cvr",
  "roas",
  "sov",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_amount",
  "indirect_amount",
  "total_amount"
].join(",");

const CAMPAIGN_DETAIL_METRICS = [
  CAMPAIGN_METRICS,
  "impression_share",
  "top_impression_share",
  "lost_impression_share_by_budget",
  "lost_impression_share_by_ad_rank",
  "acos_benchmark"
].join(",");

const ADGROUP_METRICS = [
  "CLICKS",
  "PRINTS",
  "COST",
  "CPC",
  "CTR",
  "DIRECT_AMOUNT",
  "INDIRECT_AMOUNT",
  "TOTAL_AMOUNT",
  "DIRECT_UNITS_QUANTITY",
  "INDIRECT_UNITS_QUANTITY",
  "UNITS_QUANTITY",
  "DIRECT_ITEMS_QUANTITY",
  "INDIRECT_ITEMS_QUANTITY",
  "ADVERTISING_ITEMS_QUANTITY",
  "ORGANIC_UNITS_QUANTITY",
  "ORGANIC_UNITS_AMOUNT",
  "ORGANIC_ITEMS_QUANTITY",
  "ACOS",
  "TACOS",
  "SOV",
  "CVR",
  "ROAS"
].join(",");

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function clampDays(value, fallback = 30) {
  const n = Math.floor(toNumber(value, fallback));
  return Math.max(1, Math.min(n, 90));
}

function dateOnly(value) {
  if (!value) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function getDateRange({ days = 30, dateFrom = null, dateTo = null } = {}) {
  const explicitFrom = dateOnly(dateFrom);
  const explicitTo = dateOnly(dateTo);

  if (explicitFrom && explicitTo) {
    const from = new Date(`${explicitFrom}T00:00:00Z`);
    const to = new Date(`${explicitTo}T00:00:00Z`);
    const diff = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;

    if (!Number.isFinite(diff) || diff < 1) {
      throw new Error("Período de Ads inválido.");
    }

    if (diff > 90) {
      throw new Error("A API do Mercado Ads aceita no máximo 90 dias por consulta.");
    }

    return { dateFrom: explicitFrom, dateTo: explicitTo, days: diff };
  }

  const safeDays = clampDays(days);
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - safeDays + 1);

  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    days: safeDays
  };
}

async function adsFetch(path, account, apiVersion = 2) {
  const { response, account: updatedAccount } = await mercadoLivreFetch(
    path,
    account,
    {
      headers: {
        "api-version": String(apiVersion),
        "content-type": "application/json"
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.cause?.[0]?.message ||
      `Mercado Ads recusou a consulta (HTTP ${response.status}).`;

    const error = new Error(message);
    error.status = response.status;
    error.detail = data;
    throw error;
  }

  return { data, account: updatedAccount };
}

async function getAdsContext({ advertiserId = null } = {}) {
  let account = await getMercadoLivreAccount();

  if (!account) {
    throw new Error("Nenhuma conta Mercado Livre conectada.");
  }

  const { data, account: updatedAccount } = await adsFetch(
    "/advertising/advertisers?product_id=PADS",
    account,
    1
  );

  account = updatedAccount;

  const advertisers = Array.isArray(data?.advertisers)
    ? data.advertisers
    : [];

  if (!advertisers.length) {
    throw new Error(
      "A conta conectada não possui um anunciante Product Ads habilitado."
    );
  }

  const requested = advertiserId
    ? advertisers.find(
        item => String(item.advertiser_id) === String(advertiserId)
      )
    : null;

  const advertiser =
    requested ||
    advertisers.find(item => item.site_id === "MLB") ||
    advertisers[0];

  return {
    account,
    advertisers,
    advertiser: {
      advertiser_id: String(advertiser.advertiser_id),
      site_id: advertiser.site_id || "MLB",
      advertiser_name: advertiser.advertiser_name || null,
      account_name: advertiser.account_name || null
    }
  };
}

function campaignMetrics(row) {
  return row?.metrics && typeof row.metrics === "object"
    ? row.metrics
    : {};
}

function normalizeCampaign(row) {
  const metrics = campaignMetrics(row);

  return {
    id: row?.id != null ? String(row.id) : null,
    name: row?.name || "Campanha sem nome",
    status: row?.status || null,
    strategy: row?.strategy || null,
    channel: row?.channel || null,
    currency_id: row?.currency_id || "BRL",
    budget: toNumber(row?.budget ?? row?.daily_budget, 0),
    automatic_budget: Boolean(row?.automatic_budget),
    roas_target:
      row?.roas_target == null ? null : toNumber(row.roas_target),
    last_updated: row?.last_updated || null,
    date_created: row?.date_created || null,
    metrics: {
      clicks: toNumber(metrics.clicks),
      prints: toNumber(metrics.prints),
      ctr: toNumber(metrics.ctr),
      cost: toNumber(metrics.cost),
      cpc: toNumber(metrics.cpc),
      acos: toNumber(metrics.acos),
      organic_units_quantity: toNumber(metrics.organic_units_quantity),
      organic_units_amount: toNumber(metrics.organic_units_amount),
      organic_items_quantity: toNumber(metrics.organic_items_quantity),
      direct_items_quantity: toNumber(metrics.direct_items_quantity),
      indirect_items_quantity: toNumber(metrics.indirect_items_quantity),
      advertising_items_quantity: toNumber(metrics.advertising_items_quantity),
      cvr: toNumber(metrics.cvr),
      roas: toNumber(metrics.roas),
      sov: toNumber(metrics.sov),
      direct_units_quantity: toNumber(metrics.direct_units_quantity),
      indirect_units_quantity: toNumber(metrics.indirect_units_quantity),
      units_quantity: toNumber(metrics.units_quantity),
      direct_amount: toNumber(metrics.direct_amount),
      indirect_amount: toNumber(metrics.indirect_amount),
      total_amount: toNumber(metrics.total_amount)
    }
  };
}

function aggregateMetrics(rows = []) {
  const total = {
    clicks: 0,
    prints: 0,
    cost: 0,
    organic_units_quantity: 0,
    organic_units_amount: 0,
    organic_items_quantity: 0,
    direct_items_quantity: 0,
    indirect_items_quantity: 0,
    advertising_items_quantity: 0,
    direct_units_quantity: 0,
    indirect_units_quantity: 0,
    units_quantity: 0,
    direct_amount: 0,
    indirect_amount: 0,
    total_amount: 0
  };

  for (const row of rows) {
    const metrics = row?.metrics || {};
    for (const key of Object.keys(total)) {
      total[key] += toNumber(metrics[key]);
    }
  }

  total.ctr = total.prints > 0
    ? round((total.clicks / total.prints) * 100, 3)
    : 0;

  total.cpc = total.clicks > 0
    ? round(total.cost / total.clicks, 2)
    : 0;

  total.roas = total.cost > 0
    ? round(total.total_amount / total.cost, 2)
    : 0;

  total.acos = total.total_amount > 0
    ? round((total.cost / total.total_amount) * 100, 2)
    : 0;

  total.cvr = total.clicks > 0
    ? round((total.units_quantity / total.clicks) * 100, 2)
    : 0;

  const combinedRevenue =
    total.total_amount + total.organic_units_amount;

  total.sov = combinedRevenue > 0
    ? round((total.total_amount / combinedRevenue) * 100, 2)
    : 0;

  total.tacos = combinedRevenue > 0
    ? round((total.cost / combinedRevenue) * 100, 2)
    : 0;

  for (const key of Object.keys(total)) {
    if (typeof total[key] === "number") {
      total[key] = round(total[key], 3);
    }
  }

  return total;
}

async function getCampaigns({
  days = 30,
  dateFrom = null,
  dateTo = null,
  advertiserId = null,
  status = null
} = {}) {
  const range = getDateRange({ days, dateFrom, dateTo });
  let context = await getAdsContext({ advertiserId });
  let account = context.account;
  const advertiser = context.advertiser;
  const rows = [];
  let offset = 0;
  const limit = 50;
  let metricsSummary = null;

  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      date_from: range.dateFrom,
      date_to: range.dateTo,
      metrics: CAMPAIGN_METRICS,
      metrics_summary: "true"
    });

    if (status) {
      params.set("filters[status]", String(status));
    }

    const path =
      `/advertising/${advertiser.site_id}/advertisers/${advertiser.advertiser_id}/product_ads/campaigns/search?${params.toString()}`;

    const fetched = await adsFetch(path, account, 2);
    account = fetched.account;

    const batch = Array.isArray(fetched.data?.results)
      ? fetched.data.results
      : [];

    rows.push(...batch);

    if (!metricsSummary && fetched.data?.metrics_summary) {
      metricsSummary = fetched.data.metrics_summary;
    }

    const total = toNumber(fetched.data?.paging?.total, rows.length);

    if (!batch.length || rows.length >= total || batch.length < limit) {
      break;
    }

    offset += batch.length;
  }

  const campaigns = rows.map(normalizeCampaign);

  return {
    advertiser: context.advertiser,
    advertisers: context.advertisers,
    range,
    campaigns,
    metrics_summary:
      metricsSummary && typeof metricsSummary === "object"
        ? {
            ...aggregateMetrics(campaigns),
            ...Object.fromEntries(
              Object.entries(metricsSummary).map(([key, value]) => [
                key,
                typeof value === "number" ? round(value, 3) : value
              ])
            )
          }
        : aggregateMetrics(campaigns)
  };
}

async function getCampaignDetail({
  campaignId,
  days = 30,
  dateFrom = null,
  dateTo = null,
  advertiserId = null
}) {
  if (!campaignId) {
    throw new Error("campaignId é obrigatório.");
  }

  const range = getDateRange({ days, dateFrom, dateTo });
  const context = await getAdsContext({ advertiserId });

  const params = new URLSearchParams({
    date_from: range.dateFrom,
    date_to: range.dateTo,
    metrics: CAMPAIGN_DETAIL_METRICS
  });

  const path =
    `/advertising/${context.advertiser.site_id}/product_ads/campaigns/${encodeURIComponent(String(campaignId))}?${params.toString()}`;

  const fetched = await adsFetch(path, context.account, 2);
  const row = fetched.data || {};
  const normalized = normalizeCampaign(row);

  normalized.metrics = {
    ...normalized.metrics,
    impression_share: toNumber(row?.metrics?.impression_share),
    top_impression_share: toNumber(row?.metrics?.top_impression_share),
    lost_impression_share_by_budget:
      toNumber(row?.metrics?.lost_impression_share_by_budget),
    lost_impression_share_by_ad_rank:
      toNumber(row?.metrics?.lost_impression_share_by_ad_rank),
    acos_benchmark: toNumber(row?.metrics?.acos_benchmark)
  };

  return {
    advertiser: context.advertiser,
    range,
    campaign: normalized
  };
}

async function getCampaignDaily({
  campaignId,
  days = 30,
  dateFrom = null,
  dateTo = null,
  advertiserId = null,
  context = null
} = {}) {
  if (!campaignId) {
    throw new Error("campaignId é obrigatório.");
  }

  const range = getDateRange({ days, dateFrom, dateTo });
  const adsContext = context || await getAdsContext({ advertiserId });

  const params = new URLSearchParams({
    date_from: range.dateFrom,
    date_to: range.dateTo,
    metrics: CAMPAIGN_DETAIL_METRICS,
    aggregation_type: "DAILY"
  });

  const path =
    `/advertising/${adsContext.advertiser.site_id}/product_ads/campaigns/${encodeURIComponent(String(campaignId))}?${params.toString()}`;

  const fetched = await adsFetch(path, adsContext.account, 2);

  return {
    advertiser: adsContext.advertiser,
    range,
    daily: Array.isArray(fetched.data) ? fetched.data : []
  };
}

function normalizeAdGroup(row) {
  const metrics =
    row?.metrics && typeof row.metrics === "object"
      ? row.metrics
      : {};

  return {
    id: String(
      row?.ad_group_id ??
      row?.id ??
      ""
    ) || null,
    name:
      row?.name ||
      row?.user_product_name ||
      row?.family_name ||
      null,
    campaign_id:
      row?.campaign_id != null
        ? String(row.campaign_id)
        : row?.campaign?.id != null
          ? String(row.campaign.id)
          : null,
    status: row?.status || row?.state || null,
    channel: row?.channel || null,
    item_id:
      row?.item_id != null ? String(row.item_id) : null,
    user_product_id:
      row?.user_product_id != null
        ? String(row.user_product_id)
        : null,
    family_id:
      row?.family_id != null ? String(row.family_id) : null,
    metrics: {
      clicks: toNumber(metrics.clicks),
      prints: toNumber(metrics.prints),
      cost: toNumber(metrics.cost),
      cpc: toNumber(metrics.cpc),
      ctr: toNumber(metrics.ctr),
      direct_amount: toNumber(metrics.direct_amount),
      indirect_amount: toNumber(metrics.indirect_amount),
      total_amount: toNumber(metrics.total_amount),
      direct_units_quantity: toNumber(metrics.direct_units_quantity),
      indirect_units_quantity: toNumber(metrics.indirect_units_quantity),
      units_quantity: toNumber(metrics.units_quantity),
      direct_items_quantity: toNumber(metrics.direct_items_quantity),
      indirect_items_quantity: toNumber(metrics.indirect_items_quantity),
      advertising_items_quantity: toNumber(metrics.advertising_items_quantity),
      organic_units_quantity: toNumber(metrics.organic_units_quantity),
      organic_units_amount: toNumber(metrics.organic_units_amount),
      organic_items_quantity: toNumber(metrics.organic_items_quantity),
      acos: toNumber(metrics.acos),
      tacos: toNumber(metrics.tacos),
      sov: toNumber(metrics.sov),
      cvr: toNumber(metrics.cvr),
      roas: toNumber(metrics.roas)
    },
    raw: row
  };
}

async function getAdGroups({
  days = 30,
  dateFrom = null,
  dateTo = null,
  advertiserId = null,
  campaignId = null,
  statuses = null,
  q = null
} = {}) {
  const range = getDateRange({ days, dateFrom, dateTo });
  const context = await getAdsContext({ advertiserId });

  const params = new URLSearchParams({
    date_from: range.dateFrom,
    date_to: range.dateTo,
    limit: "800",
    sort: "desc",
    sort_by: "cost",
    metrics: ADGROUP_METRICS,
    metrics_summary: "true",
    "filters[channel]": "marketplace"
  });

  if (campaignId) {
    params.set("filters[campaigns]", String(campaignId));
  }

  if (statuses) {
    params.set("filters[statuses]", String(statuses));
  }

  if (q) {
    params.set("filters[q]", String(q));
  }

  const path =
    `/advertising/${context.advertiser.site_id}/advertisers/${context.advertiser.advertiser_id}/product_ads/ad_groups/search?${params.toString()}`;

  const fetched = await adsFetch(path, context.account, 2);

  const adGroups = Array.isArray(fetched.data?.results)
    ? fetched.data.results.map(normalizeAdGroup)
    : [];

  const computed = aggregateMetrics(adGroups);

  return {
    advertiser: context.advertiser,
    range,
    paging: fetched.data?.paging || null,
    ad_groups: adGroups,
    metrics_summary:
      fetched.data?.metrics_summary && typeof fetched.data.metrics_summary === "object"
        ? {
            ...computed,
            ...Object.fromEntries(
              Object.entries(fetched.data.metrics_summary).map(([key, value]) => [
                key,
                typeof value === "number" ? round(value, 3) : value
              ])
            )
          }
        : computed
  };
}

function dailyRecord({
  accountId,
  advertiser,
  campaign,
  metric
}) {
  const date = dateOnly(metric?.date);

  if (!date) return null;

  const campaignId = String(campaign.id);

  return {
    row_key: `${accountId}:${date}:campaign:${campaignId}`,
    marketplace: "mercadolivre",
    account_id: String(accountId),
    advertiser_id: advertiser.advertiser_id,
    site_id: advertiser.site_id,
    date,
    level: "campaign",
    campaign_id: campaignId,
    campaign_name: campaign.name || null,
    campaign_status: campaign.status || null,
    strategy: campaign.strategy || null,
    currency_id: campaign.currency_id || "BRL",
    budget: toNumber(campaign.budget),
    roas_target:
      campaign.roas_target == null
        ? null
        : toNumber(campaign.roas_target),
    impressions: toNumber(metric.prints),
    clicks: toNumber(metric.clicks),
    spend: toNumber(metric.cost),
    attributed_orders: toNumber(metric.advertising_items_quantity),
    attributed_units: toNumber(metric.units_quantity),
    attributed_revenue: toNumber(metric.total_amount),
    acos_percent: toNumber(metric.acos),
    roas: toNumber(metric.roas),
    ctr: toNumber(metric.ctr),
    cpc: toNumber(metric.cpc),
    cvr: toNumber(metric.cvr),
    sov: toNumber(metric.sov),
    tacos: toNumber(metric.tacos),
    organic_units_quantity: toNumber(metric.organic_units_quantity),
    organic_units_amount: toNumber(metric.organic_units_amount),
    organic_items_quantity: toNumber(metric.organic_items_quantity),
    direct_items_quantity: toNumber(metric.direct_items_quantity),
    indirect_items_quantity: toNumber(metric.indirect_items_quantity),
    advertising_items_quantity: toNumber(metric.advertising_items_quantity),
    direct_units_quantity: toNumber(metric.direct_units_quantity),
    indirect_units_quantity: toNumber(metric.indirect_units_quantity),
    direct_amount: toNumber(metric.direct_amount),
    indirect_amount: toNumber(metric.indirect_amount),
    total_amount: toNumber(metric.total_amount),
    impression_share: toNumber(metric.impression_share),
    top_impression_share: toNumber(metric.top_impression_share),
    lost_impression_share_by_budget:
      toNumber(metric.lost_impression_share_by_budget),
    lost_impression_share_by_ad_rank:
      toNumber(metric.lost_impression_share_by_ad_rank),
    acos_benchmark: toNumber(metric.acos_benchmark),
    source: "mercado_ads_api_v2",
    raw_data: {
      campaign,
      metric
    },
    updated_at: new Date().toISOString()
  };
}

async function syncAdsDaily({
  days = 30,
  dateFrom = null,
  dateTo = null,
  advertiserId = null
} = {}) {
  const range = getDateRange({ days, dateFrom, dateTo });
  const context = await getAdsContext({ advertiserId });
  const campaignResult = await getCampaigns({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    advertiserId: context.advertiser.advertiser_id
  });

  const accountId =
    context.account.account_id ||
    context.account.user_id;

  const records = [];

  for (const campaign of campaignResult.campaigns) {
    const daily = await getCampaignDaily({
      campaignId: campaign.id,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      context
    });

    for (const metric of daily.daily) {
      const record = dailyRecord({
        accountId,
        advertiser: context.advertiser,
        campaign,
        metric
      });

      if (record) records.push(record);
    }
  }

  for (let i = 0; i < records.length; i += 250) {
    const chunk = records.slice(i, i + 250);

    const { error } = await supabase
      .from("marketplace_ads_daily")
      .upsert(chunk, { onConflict: "row_key" });

    if (error) {
      throw new Error(
        `Erro salvando métricas de Ads: ${error.message}`
      );
    }
  }

  return {
    advertiser: context.advertiser,
    range,
    campaigns: campaignResult.campaigns.length,
    records_saved: records.length
  };
}

async function getStoredDaily({
  days = 30,
  dateFrom = null,
  dateTo = null
} = {}) {
  const range = getDateRange({ days, dateFrom, dateTo });

  const { data, error } = await supabase
    .from("marketplace_ads_daily")
    .select(
      "date,spend,clicks,impressions,attributed_units,attributed_revenue,organic_units_quantity,organic_units_amount,direct_amount,indirect_amount,total_amount"
    )
    .eq("marketplace", "mercadolivre")
    .eq("level", "campaign")
    .gte("date", range.dateFrom)
    .lte("date", range.dateTo)
    .order("date", { ascending: true });

  if (error) {
    throw new Error(
      `Erro lendo histórico de Ads: ${error.message}`
    );
  }

  const byDate = new Map();

  for (const row of data || []) {
    const date = row.date;
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        cost: 0,
        clicks: 0,
        prints: 0,
        units_quantity: 0,
        total_amount: 0,
        organic_units_quantity: 0,
        organic_units_amount: 0,
        direct_amount: 0,
        indirect_amount: 0
      });
    }

    const item = byDate.get(date);
    item.cost += toNumber(row.spend);
    item.clicks += toNumber(row.clicks);
    item.prints += toNumber(row.impressions);
    item.units_quantity += toNumber(row.attributed_units);
    item.total_amount += toNumber(row.attributed_revenue);
    item.organic_units_quantity += toNumber(row.organic_units_quantity);
    item.organic_units_amount += toNumber(row.organic_units_amount);
    item.direct_amount += toNumber(row.direct_amount);
    item.indirect_amount += toNumber(row.indirect_amount);
  }

  const daily = Array.from(byDate.values()).map(row => {
    const combinedRevenue =
      row.total_amount + row.organic_units_amount;

    return {
      ...row,
      ctr:
        row.prints > 0
          ? round((row.clicks / row.prints) * 100, 3)
          : 0,
      cpc:
        row.clicks > 0
          ? round(row.cost / row.clicks, 2)
          : 0,
      roas:
        row.cost > 0
          ? round(row.total_amount / row.cost, 2)
          : 0,
      acos:
        row.total_amount > 0
          ? round((row.cost / row.total_amount) * 100, 2)
          : 0,
      cvr:
        row.clicks > 0
          ? round((row.units_quantity / row.clicks) * 100, 2)
          : 0,
      sov:
        combinedRevenue > 0
          ? round((row.total_amount / combinedRevenue) * 100, 2)
          : 0,
      tacos:
        combinedRevenue > 0
          ? round((row.cost / combinedRevenue) * 100, 2)
          : 0
    };
  });

  return {
    range,
    daily,
    metrics_summary: aggregateMetrics(
      daily.map(row => ({ metrics: row }))
    )
  };
}

module.exports = {
  CAMPAIGN_METRICS,
  ADGROUP_METRICS,
  getDateRange,
  getAdsContext,
  getCampaigns,
  getCampaignDetail,
  getCampaignDaily,
  getAdGroups,
  syncAdsDaily,
  getStoredDaily,
  aggregateMetrics
};
