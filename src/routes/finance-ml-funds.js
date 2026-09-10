const router = require("express").Router();
router.use(require("./finance-ml-sync-v3"));
router.use(require("./finance-liabilities"));
router.use(require("./finance-mp-release-report").router);
router.use(require("./finance-mp-classify"));
module.exports = router;
