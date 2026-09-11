const router = require("express").Router();
router.use(require("./finance-mp-detach-pluggy"));
router.use(require("./finance-mp-balance-direct"));
router.use(require("./finance-open-finance-mp-filter"));
router.use(require("./finance-mp-authoritative-sync"));
router.use(require("./finance-open-finance-live-refresh"));
router.use(require("./finance-mp-mlmatch-diagnostic"));
router.use(require("./finance-liabilities"));
module.exports = router;
