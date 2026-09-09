const router = require("express").Router();
const {
  suggestForPack,
  learnFromEdit
} = require("../services/ml-sac-ai-review-v3");

router.post("/api/sac/ml/ai/:packId/suggest", async (req, res) => {
  try {
    const result = await suggestForPack(req.params.packId);
    res.json({ sucesso: true, ...result });
  } catch (error) {
    console.error("[SAC ML AI] sugestão:", error);
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/sac/ml/ai/:packId/learn", async (req, res) => {
  try {
    const result = await learnFromEdit({
      packId: req.params.packId,
      suggestion: req.body?.suggestion,
      finalText: req.body?.final_text
    });
    res.json({ sucesso: true, ...result });
  } catch (error) {
    console.error("[SAC ML AI] aprendizado:", error);
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
