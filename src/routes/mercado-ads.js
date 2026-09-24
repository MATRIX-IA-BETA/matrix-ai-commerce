const express = require("express");
const {
  getDateRange,
  getAdsContext,
  getCampaigns,
  getCampaignDetail,
  getAdGroups,
  syncAdsDaily,
  getStoredDaily
} = require("../services/mercado-ads");

const router = express.Router();

function errorResponse(res, error) {
  const status =
    Number.isFinite(Number(error?.status)) &&
    Number(error.status) >= 400 &&
    Number(error.status) < 600
      ? Number(error.status)
      : 500;

  res.status(status).json({
    success: false,
    sucesso: false,
    mensagem: error?.message || "Erro interno no Mercado Ads.",
    detalhe: error?.detail || null
  });
}

function params(req) {
  return {
    days: req.query.days || req.body?.days || 30,
    dateFrom: req.query.date_from || req.body?.date_from || null,
    dateTo: req.query.date_to || req.body?.date_to || null,
    advertiserId:
      req.query.advertiser_id ||
      req.body?.advertiser_id ||
      null
  };
}

router.get("/api/ads/health", async (req, res) => {
  try {
    const context = await getAdsContext({
      advertiserId: req.query.advertiser_id || null
    });

    res.json({
      success: true,
      sucesso: true,
      service: "mercado-ads",
      status: "online",
      advertiser: context.advertiser,
      advertisers: context.advertisers
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/advertiser", async (req, res) => {
  try {
    const context = await getAdsContext({
      advertiserId: req.query.advertiser_id || null
    });

    res.json({
      success: true,
      sucesso: true,
      advertiser: context.advertiser,
      advertisers: context.advertisers
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/campaigns", async (req, res) => {
  try {
    const result = await getCampaigns({
      ...params(req),
      status: req.query.status || null
    });

    res.json({
      success: true,
      sucesso: true,
      ...result
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/campaigns/:id", async (req, res) => {
  try {
    const result = await getCampaignDetail({
      ...params(req),
      campaignId: req.params.id
    });

    res.json({
      success: true,
      sucesso: true,
      ...result
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/adgroups", async (req, res) => {
  try {
    const result = await getAdGroups({
      ...params(req),
      campaignId: req.query.campaign_id || null,
      statuses: req.query.statuses || null,
      q: req.query.q || null
    });

    res.json({
      success: true,
      sucesso: true,
      ...result
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/summary", async (req, res) => {
  try {
    const options = params(req);
    const range = getDateRange(options);

    const campaigns = await getCampaigns({
      ...options,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo
    });

    let adGroups = null;
    let adGroupsError = null;

    try {
      adGroups = await getAdGroups({
        ...options,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo
      });
    } catch (error) {
      adGroupsError = error.message;
    }

    res.json({
      success: true,
      sucesso: true,
      advertiser: campaigns.advertiser,
      advertisers: campaigns.advertisers,
      range,
      metrics: campaigns.metrics_summary,
      campaigns: campaigns.campaigns,
      ad_groups: adGroups?.ad_groups || [],
      ad_groups_metrics: adGroups?.metrics_summary || null,
      ad_groups_error: adGroupsError
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/api/ads/daily", async (req, res) => {
  try {
    const result = await getStoredDaily(params(req));

    res.json({
      success: true,
      sucesso: true,
      ...result
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/api/ads/sync", async (req, res) => {
  try {
    const result = await syncAdsDaily(params(req));

    res.json({
      success: true,
      sucesso: true,
      mensagem: "Histórico do Mercado Ads sincronizado.",
      ...result
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

module.exports = router;
