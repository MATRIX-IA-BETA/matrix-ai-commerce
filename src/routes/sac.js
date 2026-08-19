const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");
const {
  extrairPackId,
  sincronizarConversaML,
  sincronizarClaimML,
  gerarRascunhoIA,
  contextoSac,
  enviarRespostaSac
} = require("../services/sac");

const OPENAI_API_KEY = env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL;
const SAC_AUTO_SEND_SIMPLE = env.SAC_AUTO_SEND_SIMPLE;

router.get("/sac", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    let query = supabase.from("sac_threads").select("*").order("last_message_at", { ascending: false }).limit(limit);
    if (req.query.type) query = query.eq("type", String(req.query.type));
    if (req.query.status) query = query.eq("status", String(req.query.status));
    if (req.query.priority) query = query.eq("priority", String(req.query.priority));
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, atendimentos: data || [] });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.get("/sac/:id", async (req, res) => {
  try {
    const data = await contextoSac(req.params.id);
    res.json({ sucesso: true, ...data });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.post("/sac/:id/draft", async (req, res) => {
  try {
    const thread = await gerarRascunhoIA(req.params.id, { regenerate: true });
    res.json({ sucesso: true, atendimento: thread });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.post("/sac/:id/send", async (req, res) => {
  try {
    const result = await enviarRespostaSac(req.params.id, req.body?.text || null);
    res.json({ sucesso: true, resultado: result });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

// Sincroniza mensagens não lidas sem marcá-las como lidas
router.post("/sac/sync/messages", async (req, res) => {
  try {
    const account = await getMercadoLivreAccount();
    const { response } = await mercadoLivreFetch("/messages/unread?role=seller&tag=post_sale", account);
    const data = await response.json();
    if (!response.ok) throw new Error(`Erro buscando não lidas: ${JSON.stringify(data)}`);
    const results = [];
    for (const item of data.results || []) {
      const packId = extrairPackId(item.resource);
      if (!packId) continue;
      const thread = await sincronizarConversaML(packId, false);
      await gerarRascunhoIA(thread.id, { regenerate: false });
      results.push({ pack_id: packId, count: item.count, thread_id: thread.id });
    }
    res.json({ sucesso: true, quantidade: results.length, resultados: results });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

// Sincroniza reclamações abertas do vendedor
router.post("/sac/sync/claims", async (req, res) => {
  try {
    const account = await getMercadoLivreAccount();
    const params = new URLSearchParams({ "players.user_id": String(account.user_id), "players.role": "respondent", status: "opened", limit: "30", offset: "0" });
    const { response } = await mercadoLivreFetch(`/post-purchase/v1/claims/search?${params.toString()}`, account);
    const data = await response.json();
    if (!response.ok) throw new Error(`Erro buscando claims: ${JSON.stringify(data)}`);
    const claims = Array.isArray(data.data) ? data.data : (Array.isArray(data.results) ? data.results : []);
    const results = [];
    for (const claim of claims) {
      const id = claim.id || claim.claim_id;
      if (!id) continue;
      const thread = await sincronizarClaimML(id);
      await gerarRascunhoIA(thread.id, { regenerate: false });
      results.push({ claim_id: String(id), thread_id: thread.id });
    }
    res.json({ sucesso: true, quantidade: results.length, resultados: results });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

// Diagnóstico sem enviar nada
router.get("/sac/health/check", async (req, res) => {
  const checks = { openai_key: Boolean(OPENAI_API_KEY), ml_account: false, sac_tables: false };
  try { checks.ml_account = Boolean(await getMercadoLivreAccount()); } catch (_) {}
  try { const { error } = await supabase.from("sac_threads").select("id").limit(1); checks.sac_tables = !error; } catch (_) {}
  res.json({ sucesso: Object.values(checks).every(Boolean), checks, model: OPENAI_MODEL, auto_send_simple: SAC_AUTO_SEND_SIMPLE });
});



module.exports = router;
