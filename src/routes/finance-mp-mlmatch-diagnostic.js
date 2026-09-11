const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

async function call(account, path, options = undefined) {
  try {
    const { response, data } = await mpRequest(path, account, options);
    return {
      http: response.status,
      ok: response.ok,
      data: response.ok ? data : { error: data?.message || data?.error || data }
    };
  } catch (error) {
    return { http: 0, ok: false, data: { error: error.message } };
  }
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");

  const [settlementConfig, settlementList, releaseConfig, releaseList] = await Promise.all([
    call(account, "/v1/account/settlement_report/config"),
    call(account, "/v1/account/settlement_report/list"),
    call(account, "/v1/account/release_report/config"),
    call(account, "/v1/account/release_report/list")
  ]);

  const result = {
    objetivo: "ver se já existem relatórios financeiros nativos do Mercado Pago capazes de fechar o saldo indisponível/A receber sem aproximação",
    account_id: String(account.user_id || account.account_id || ""),
    settlement_report: {
      config: settlementConfig,
      list: settlementList
    },
    release_report: {
      config: releaseConfig,
      list: releaseList
    }
  };

  console.log("[Financeiro MP REPORT AVAILABILITY]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro MP REPORT AVAILABILITY] falhou:", error.message)), 18000);
startup.unref?.();

module.exports = router;
