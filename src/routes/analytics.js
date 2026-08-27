const express = require("express");
const {
  rebuildProfitability,
  loadExecutive
} = require("../services/analytics");

function parseDateParam(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parsePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function createAnalyticsRouter({ supabase }) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({
      success: true,
      sucesso: true,
      service: "analytics",
      status: "online"
    });
  });

  async function rebuildHandler(req, res) {
    try {
      const result = await rebuildProfitability(supabase, {
        start: parseDateParam(req.query.start || req.body?.start),
        end: parseDateParam(req.query.end || req.body?.end),
        days: parsePositiveInteger(req.query.days || req.body?.days),
        limit: parsePositiveInteger(req.query.limit || req.body?.limit)
      });

      res.json(result);
    } catch (error) {
      console.error("Erro rebuild analytics:", error);
      res.status(500).json({
        success: false,
        sucesso: false,
        message: error.message,
        mensagem: error.message
      });
    }
  }

  router.get("/rebuild", rebuildHandler);
  router.post("/rebuild", rebuildHandler);
  router.get("/profitability/rebuild", rebuildHandler);
  router.post("/profitability/rebuild", rebuildHandler);

  router.get("/executive", async (req, res) => {
    try {
      const result = await loadExecutive(
        supabase,
        Number(req.query.days || 30),
        {
          autoRebuild: String(req.query.auto_rebuild || "true") !== "false"
        }
      );

      res.json(result);
    } catch (error) {
      console.error("Erro executive analytics:", error);
      res.status(500).json({
        success: false,
        sucesso: false,
        message: error.message,
        mensagem: error.message
      });
    }
  });

  return router;
}

module.exports = {
  createAnalyticsRouter
};
