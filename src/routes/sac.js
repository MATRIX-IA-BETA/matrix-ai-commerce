const router = require("express").Router();

const { supabase } = require("../db/supabase");
const { env } = require("../config/env");

const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const {
  extrairPackId,
  sincronizarConversaML,
  sincronizarClaimML,
  gerarRascunhoIA,
  contextoSac,
  enviarRespostaSac
} = require("../services/sac");


/* ============================================================
   CONFIGURAÇÃO
============================================================ */

const OPENAI_API_KEY = env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL;
const SAC_AUTO_SEND_SIMPLE = env.SAC_AUTO_SEND_SIMPLE;


/* ============================================================
   HELPERS DA CENTRAL SAC
============================================================ */

function numeroSeguro(valor, padrao, min, max) {
  const numero = Number(valor);

  if (!Number.isFinite(numero)) {
    return padrao;
  }

  return Math.min(
    Math.max(Math.trunc(numero), min),
    max
  );
}


function normalizarMensagem(mensagem) {
  if (!mensagem) return mensagem;

  const metadata =
    mensagem.metadata &&
    typeof mensagem.metadata === "object"
      ? mensagem.metadata
      : {};

  return {
    ...mensagem,

    media_type:
      metadata.media_type ||
      metadata.type ||
      null,

    transcription:
      metadata.transcription ||
      metadata.transcript ||
      null,

    image_analysis:
      metadata.image_analysis ||
      metadata.vision_analysis ||
      null,

    video_analysis:
      metadata.video_analysis ||
      null,

    ai_model:
      metadata.model ||
      metadata.ai_model ||
      null
  };
}


/* ============================================================
   ROTA ORIGINAL
   LISTAGEM DOS ATENDIMENTOS
============================================================ */

router.get("/sac", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit || 100), 1),
      500
    );

    let query = supabase
      .from("sac_threads")
      .select("*")
      .order(
        "last_message_at",
        { ascending: false }
      )
      .limit(limit);

    if (req.query.type) {
      query = query.eq(
        "type",
        String(req.query.type)
      );
    }

    if (req.query.status) {
      query = query.eq(
        "status",
        String(req.query.status)
      );
    }

    if (req.query.priority) {
      query = query.eq(
        "priority",
        String(req.query.priority)
      );
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      sucesso: true,
      atendimentos: data || []
    });

  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: erro.message
    });
  }
});


/* ============================================================
   CENTRAL SAC
   MODO OBSERVAÇÃO

   IMPORTANTE:
   TODAS ESTAS ROTAS PRECISAM FICAR ANTES DE /sac/:id
============================================================ */


/* ============================================================
   CENTRAL SAC — LIVE

   GET /sac/central/live
============================================================ */

router.get(
  "/sac/central/live",
  async (req, res) => {

    try {

      const limit = numeroSeguro(
        req.query.limit,
        100,
        1,
        500
      );

      let query = supabase
        .from("v_sac_live_queue")
        .select("*")
        .order(
          "last_message_at",
          {
            ascending: false,
            nullsFirst: false
          }
        )
        .limit(limit);


      if (req.query.channel) {
        query = query.eq(
          "channel",
          String(req.query.channel)
        );
      }


      if (req.query.control_mode) {
        query = query.eq(
          "control_mode",
          String(req.query.control_mode)
        );
      }


      if (req.query.attention_level) {
        query = query.eq(
          "attention_level",
          String(req.query.attention_level)
        );
      }


      if (
        String(req.query.review || "")
          .toLowerCase() === "true"
      ) {
        query = query.eq(
          "requires_review",
          true
        );
      }


      const { data, error } = await query;

      if (error) {
        throw error;
      }


      res.json({
        sucesso: true,

        central: {
          mode: "observation",

          realtime_source:
            "sac_conversations+sac_messages",

          total:
            (data || []).length
        },

        conversas:
          data || []
      });


    } catch (erro) {

      console.error(
        "[CENTRAL SAC] live:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);


/* ============================================================
   CENTRAL SAC — CONVERSA COMPLETA

   GET /sac/central/conversation/:id
============================================================ */

router.get(
  "/sac/central/conversation/:id",
  async (req, res) => {

    try {

      const conversationId =
        String(req.params.id);


      const messageLimit =
        numeroSeguro(
          req.query.limit,
          300,
          1,
          1000
        );


      const [
        conversationResult,
        messagesResult,
        auditsResult,
        controlEventsResult,
        correctionsResult
      ] = await Promise.all([


        supabase
          .from("sac_conversations")
          .select("*")
          .eq(
            "id",
            conversationId
          )
          .maybeSingle(),


        supabase
          .from("sac_messages")
          .select("*")
          .eq(
            "conversation_id",
            conversationId
          )
          .order(
            "created_at",
            {
              ascending: true
            }
          )
          .limit(messageLimit),


        supabase
          .from("sac_ai_audits")
          .select("*")
          .eq(
            "conversation_id",
            conversationId
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          )
          .limit(100),


        supabase
          .from("sac_control_events")
          .select("*")
          .eq(
            "conversation_id",
            conversationId
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          )
          .limit(100),


        supabase
          .from("sac_response_corrections")
          .select("*")
          .eq(
            "conversation_id",
            conversationId
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          )
          .limit(100)

      ]);


      if (conversationResult.error) {
        throw conversationResult.error;
      }


      if (!conversationResult.data) {

        return res
          .status(404)
          .json({
            sucesso: false,
            mensagem:
              "Conversa não encontrada."
          });
      }


      if (messagesResult.error) {
        throw messagesResult.error;
      }


      if (auditsResult.error) {
        throw auditsResult.error;
      }


      if (controlEventsResult.error) {
        throw controlEventsResult.error;
      }


      if (correctionsResult.error) {
        throw correctionsResult.error;
      }


      const mensagens =
        (messagesResult.data || [])
          .map(normalizarMensagem);


      res.json({

        sucesso: true,

        mode:
          "observation",

        conversa:
          conversationResult.data,

        mensagens,

        auditorias:
          auditsResult.data || [],

        eventos_controle:
          controlEventsResult.data || [],

        correcoes:
          correctionsResult.data || []

      });


    } catch (erro) {

      console.error(
        "[CENTRAL SAC] conversation:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);


/* ============================================================
   CENTRAL SAC — AUDITORIAS

   GET /sac/central/audits
============================================================ */

router.get(
  "/sac/central/audits",
  async (req, res) => {

    try {

      const limit =
        numeroSeguro(
          req.query.limit,
          100,
          1,
          500
        );


      let query = supabase
        .from("v_sac_audit_queue")
        .select("*")
        .order(
          "created_at",
          {
            ascending: false
          }
        )
        .limit(limit);


      if (req.query.severity) {

        query = query.eq(
          "severity",
          String(req.query.severity)
        );

      }


      const { data, error } =
        await query;


      if (error) {
        throw error;
      }


      res.json({

        sucesso: true,

        quantidade:
          (data || []).length,

        auditorias:
          data || []

      });


    } catch (erro) {

      console.error(
        "[CENTRAL SAC] audits:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);


/* ============================================================
   CENTRAL SAC — ESTATÍSTICAS

   GET /sac/central/stats
============================================================ */

router.get(
  "/sac/central/stats",
  async (req, res) => {

    try {

      const [
        conversationsResult,
        auditsResult
      ] = await Promise.all([


        supabase
          .from("sac_conversations")
          .select(
            "id,control_mode,attention_level,requires_review,last_message_at"
          ),


        supabase
          .from("sac_ai_audits")
          .select(
            "id,severity,status,possible_error,incomplete_answer,contradiction,customer_frustrated,unsafe_promise,technical_uncertainty,unresolved"
          )
          .eq(
            "status",
            "open"
          )

      ]);


      if (conversationsResult.error) {
        throw conversationsResult.error;
      }


      if (auditsResult.error) {
        throw auditsResult.error;
      }


      const conversations =
        conversationsResult.data || [];


      const audits =
        auditsResult.data || [];


      const agora =
        Date.now();


      const vinteQuatroHoras =
        24 * 60 * 60 * 1000;


      const ativas24h =
        conversations.filter(
          conversa => {

            if (!conversa.last_message_at) {
              return false;
            }


            const timestamp =
              new Date(
                conversa.last_message_at
              ).getTime();


            if (!Number.isFinite(timestamp)) {
              return false;
            }


            return (
              agora - timestamp
            ) <= vinteQuatroHoras;

          }
        ).length;


      const stats = {

        total_conversations:
          conversations.length,


        active_last_24h:
          ativas24h,


        ai_control:
          conversations.filter(
            conversa =>
              conversa.control_mode === "ai"
          ).length,


        human_control:
          conversations.filter(
            conversa =>
              conversa.control_mode === "human"
          ).length,


        requires_review:
          conversations.filter(
            conversa =>
              conversa.requires_review === true
          ).length,


        attention:
          conversations.filter(
            conversa =>
              conversa.attention_level ===
              "attention"
          ).length,


        urgent:
          conversations.filter(
            conversa =>
              conversa.attention_level ===
              "urgent"
          ).length,


        open_audits:
          audits.length,


        audit_flags: {

          possible_error:
            audits.filter(
              audit =>
                audit.possible_error === true
            ).length,


          incomplete_answer:
            audits.filter(
              audit =>
                audit.incomplete_answer === true
            ).length,


          contradiction:
            audits.filter(
              audit =>
                audit.contradiction === true
            ).length,


          customer_frustrated:
            audits.filter(
              audit =>
                audit.customer_frustrated === true
            ).length,


          unsafe_promise:
            audits.filter(
              audit =>
                audit.unsafe_promise === true
            ).length,


          technical_uncertainty:
            audits.filter(
              audit =>
                audit.technical_uncertainty === true
            ).length,


          unresolved:
            audits.filter(
              audit =>
                audit.unresolved === true
            ).length

        }

      };


      res.json({

        sucesso: true,

        mode:
          "observation",

        stats,

        generated_at:
          new Date().toISOString()

      });


    } catch (erro) {

      console.error(
        "[CENTRAL SAC] stats:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);


/* ============================================================
   SINCRONIZAÇÃO DE MENSAGENS ML
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.post(
  "/sac/sync/messages",
  async (req, res) => {

    try {

      const account =
        await getMercadoLivreAccount();


      const { response } =
        await mercadoLivreFetch(
          "/messages/unread?role=seller&tag=post_sale",
          account
        );


      const data =
        await response.json();


      if (!response.ok) {

        throw new Error(
          `Erro buscando não lidas: ${JSON.stringify(data)}`
        );

      }


      const results = [];


      for (const item of data.results || []) {

        const packId =
          extrairPackId(
            item.resource
          );


        if (!packId) {
          continue;
        }


        const thread =
          await sincronizarConversaML(
            packId,
            false
          );


        await gerarRascunhoIA(
          thread.id,
          {
            regenerate: false
          }
        );


        results.push({

          pack_id:
            packId,

          count:
            item.count,

          thread_id:
            thread.id

        });

      }


      res.json({

        sucesso: true,

        quantidade:
          results.length,

        resultados:
          results

      });


    } catch (erro) {

      res.status(500).json({

        sucesso: false,

        mensagem:
          erro.message

      });

    }
  }
);


/* ============================================================
   SINCRONIZAÇÃO DE CLAIMS ML
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.post(
  "/sac/sync/claims",
  async (req, res) => {

    try {

      const account =
        await getMercadoLivreAccount();


      const params =
        new URLSearchParams({

          "players.user_id":
            String(
              account.user_id
            ),

          "players.role":
            "respondent",

          status:
            "opened",

          limit:
            "30",

          offset:
            "0"

        });


      const { response } =
        await mercadoLivreFetch(

          `/post-purchase/v1/claims/search?${params.toString()}`,

          account

        );


      const data =
        await response.json();


      if (!response.ok) {

        throw new Error(
          `Erro buscando claims: ${JSON.stringify(data)}`
        );

      }


      const claims =
        Array.isArray(data.data)

          ? data.data

          : Array.isArray(data.results)

            ? data.results

            : [];


      const results = [];


      for (const claim of claims) {

        const id =
          claim.id ||
          claim.claim_id;


        if (!id) {
          continue;
        }


        const thread =
          await sincronizarClaimML(id);


        await gerarRascunhoIA(

          thread.id,

          {
            regenerate: false
          }

        );


        results.push({

          claim_id:
            String(id),

          thread_id:
            thread.id

        });

      }


      res.json({

        sucesso: true,

        quantidade:
          results.length,

        resultados:
          results

      });


    } catch (erro) {

      res.status(500).json({

        sucesso: false,

        mensagem:
          erro.message

      });

    }
  }
);


/* ============================================================
   HEALTH CHECK SAC
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.get(
  "/sac/health/check",
  async (req, res) => {

    const checks = {

      openai_key:
        Boolean(
          OPENAI_API_KEY
        ),

      ml_account:
        false,

      sac_tables:
        false

    };


    try {

      checks.ml_account =
        Boolean(
          await getMercadoLivreAccount()
        );

    } catch (_) {}


    try {

      const { error } =
        await supabase
          .from("sac_threads")
          .select("id")
          .limit(1);


      checks.sac_tables =
        !error;

    } catch (_) {}


    res.json({

      sucesso:
        Object.values(checks)
          .every(Boolean),

      checks,

      model:
        OPENAI_MODEL,

      auto_send_simple:
        SAC_AUTO_SEND_SIMPLE

    });

  }
);


/* ============================================================
   ATENÇÃO:
   AS ROTAS DINÂMICAS /sac/:id FICAM DAQUI PARA BAIXO.

   ISSO EVITA QUE "central", "health", "sync" ETC.
   SEJAM INTERPRETADOS COMO ID.
============================================================ */


/* ============================================================
   CONTEXTO DE UM ATENDIMENTO
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.get(
  "/sac/:id",
  async (req, res) => {

    try {

      const data =
        await contextoSac(
          req.params.id
        );


      res.json({

        sucesso: true,

        ...data

      });


    } catch (erro) {

      res.status(500).json({

        sucesso: false,

        mensagem:
          erro.message

      });

    }
  }
);


/* ============================================================
   GERAR RASCUNHO
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.post(
  "/sac/:id/draft",
  async (req, res) => {

    try {

      const thread =
        await gerarRascunhoIA(

          req.params.id,

          {
            regenerate: true
          }

        );


      res.json({

        sucesso: true,

        atendimento:
          thread

      });


    } catch (erro) {

      res.status(500).json({

        sucesso: false,

        mensagem:
          erro.message

      });

    }
  }
);


/* ============================================================
   ENVIAR RESPOSTA
   ROTA ORIGINAL PRESERVADA
============================================================ */

router.post(
  "/sac/:id/send",
  async (req, res) => {

    try {

      const result =
        await enviarRespostaSac(

          req.params.id,

          req.body?.text ||
          null

        );


      res.json({

        sucesso: true,

        resultado:
          result

      });


    } catch (erro) {

      res.status(500).json({

        sucesso: false,

        mensagem:
          erro.message

      });

    }
  }
);


/* ============================================================
   EXPORT
============================================================ */

module.exports = router;
