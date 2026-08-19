const router = require("express").Router();

router.get("/", (req, res) => {
  res.json({
    status: "online",
    sistema: "Matrix AI Commerce",
    mensagem: "Backend modular funcionando 🚀",
    arquitetura: "v2-modular"
  });
});

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    sistema: "Matrix AI Commerce",
    arquitetura: "v2-modular"
  });
});

module.exports = router;
