const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { sincronizarPedidoPorId } = require("../services/mercadolivre");
const { processStockForMarketplaceOrder } = require("../services/stock");
const {
  processarNotificacaoMensagemML,
  processarNotificacaoClaimML
} = require("../services/sac");

router.post(
  "/webhooks/mercadolivre",
  async (req, res) => {

    // Responde IMEDIATAMENTE ao Mercado Livre
    res.sendStatus(200);

    const payload = req.body || {};

    console.log(
      "Notificação Mercado Livre:",
      payload.topic,
      payload.resource
    );

    try {
      const {
        data: event,
        error: eventError
      } = await supabase
        .from("marketplace_webhook_events")
        .insert({
          marketplace: "mercadolivre",

          topic:
            payload.topic || null,

          resource:
            payload.resource || null,

          user_id:
            payload.user_id != null
              ? String(payload.user_id)
              : null,

          application_id:
            payload.application_id != null
              ? String(payload.application_id)
              : null,

          payload,

          processed: false
        })
        .select("id")
        .single();

      if (eventError) {
        console.error(
          "Erro gravando webhook:",
          eventError
        );

        return;
      }

      try {
        const resource =
          String(payload.resource || "");

        // Eventos relacionados a pedidos
        if (
          resource.startsWith("/orders/") ||
          payload.topic === "orders_v2"
        ) {
          const match =
            resource.match(/\/orders\/(\d+)/);

          if (match && match[1]) {
            await sincronizarPedidoPorId(
              match[1]
            );

            try {
              await processStockForMarketplaceOrder(match[1]);
            } catch (stockError) {
              console.error("Erro atualizando estoque pelo webhook:", stockError);
            }
          }
        }


        // Mensagens pós-venda
        if (payload.topic === "messages") {
          await processarNotificacaoMensagemML(payload);
        }

        // Reclamações e ações em reclamações
        if (
          payload.topic === "claims" ||
          payload.topic === "claims_actions"
        ) {
          await processarNotificacaoClaimML(payload);
        }

        await supabase
          .from("marketplace_webhook_events")
          .update({
            processed: true,
            processed_at:
              new Date().toISOString(),
            error_message: null
          })
          .eq("id", event.id);

      } catch (processError) {
        console.error(
          "Erro processando webhook:",
          processError
        );

        await supabase
          .from("marketplace_webhook_events")
          .update({
            processed: false,
            processed_at:
              new Date().toISOString(),
            error_message:
              String(processError.message)
                .slice(0, 1000)
          })
          .eq("id", event.id);
      }

    } catch (erro) {
      console.error(
        "Erro geral webhook ML:",
        erro
      );
    }
  }
);


module.exports = router;
