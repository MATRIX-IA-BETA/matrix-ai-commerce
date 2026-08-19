const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { base64url, normalizeDateStart, normalizeDateEnd } = require("../utils/common");
const {
  getMercadoLivreAccount,
  ensureValidMercadoLivreToken,
  mercadoLivreFetch,
  salvarPedidoMercadoLivre,
  sincronizarPedidoPorId,
  extrairFinanceiroPedido
} = require("../services/mercadolivre");

const CLIENT_ID = env.MERCADOLIVRE_CLIENT_ID;
const CLIENT_SECRET = env.MERCADOLIVRE_CLIENT_SECRET;
const REDIRECT_URI = env.MERCADOLIVRE_REDIRECT_URI;
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
const oauthSessions = new Map();

router.get(
  "/auth/mercadolivre",
  (req, res) => {

    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !REDIRECT_URI ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return res.status(500).json({
        sucesso: false,
        mensagem:
          "Variáveis obrigatórias não configuradas."
      });
    }

    const state =
      crypto.randomBytes(32).toString("hex");

    const codeVerifier =
      base64url(
        crypto.randomBytes(64)
      );

    const codeChallenge =
      base64url(
        crypto
          .createHash("sha256")
          .update(codeVerifier)
          .digest()
      );

    oauthSessions.set(
      state,
      {
        codeVerifier,
        criadoEm: Date.now()
      }
    );

    const params =
      new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256"
      });

    const authorizationUrl =
      `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

    res.redirect(authorizationUrl);
  }
);

router.get(
  "/auth/mercadolivre/callback",
  async (req, res) => {

    const {
      code,
      state,
      error
    } = req.query;

    if (error) {
      return res.status(400).json({
        sucesso: false,
        erro: error
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        sucesso: false,
        mensagem:
          "Code ou state não recebido."
      });
    }

    const session =
      oauthSessions.get(state);

    if (!session) {
      return res.status(400).json({
        sucesso: false,
        mensagem:
          "State inválido ou sessão OAuth expirada."
      });
    }

    oauthSessions.delete(state);

    try {
      const body =
        new URLSearchParams({
          grant_type:
            "authorization_code",

          client_id:
            CLIENT_ID,

          client_secret:
            CLIENT_SECRET,

          code,

          redirect_uri:
            REDIRECT_URI,

          code_verifier:
            session.codeVerifier
        });

      const tokenResponse =
        await fetch(
          "https://api.mercadolibre.com/oauth/token",
          {
            method: "POST",

            headers: {
              accept:
                "application/json",

              "content-type":
                "application/x-www-form-urlencoded"
            },

            body:
              body.toString()
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        console.error(
          "Erro OAuth Mercado Livre:",
          tokenData
        );

        return res
          .status(tokenResponse.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a troca do código pelo token."
          });
      }

      const expiresAt =
        new Date(
          Date.now() +
          Number(
            tokenData.expires_in
          ) * 1000
        ).toISOString();

      const marketplaceAccount = {
        marketplace:
          "mercadolivre",

        account_id:
          String(tokenData.user_id),

        user_id:
          String(tokenData.user_id),

        access_token:
          tokenData.access_token,

        refresh_token:
          tokenData.refresh_token,

        expires_at:
          expiresAt
      };

      const {
        data: existing,
        error: searchError
      } =
        await supabase
          .from(
            "marketplace_accounts"
          )
          .select("id")
          .eq(
            "marketplace",
            "mercadolivre"
          )
          .eq(
            "account_id",
            String(
              tokenData.user_id
            )
          )
          .maybeSingle();

      if (searchError) {
        console.error(
          "Erro consultando Supabase:",
          searchError
        );

        return res
          .status(500)
          .json({
            sucesso: false,
            mensagem:
              "Erro ao consultar o banco de dados."
          });
      }

      if (existing) {
        const {
          error: updateError
        } =
          await supabase
            .from(
              "marketplace_accounts"
            )
            .update({
              access_token:
                tokenData.access_token,

              refresh_token:
                tokenData.refresh_token,

              expires_at:
                expiresAt,

              user_id:
                String(
                  tokenData.user_id
                )
            })
            .eq(
              "id",
              existing.id
            );

        if (updateError) {
          console.error(
            "Erro atualizando tokens:",
            updateError
          );

          return res
            .status(500)
            .json({
              sucesso: false,
              mensagem:
                "Erro ao atualizar a conexão no banco."
            });
        }

      } else {
        const {
          error: insertError
        } =
          await supabase
            .from(
              "marketplace_accounts"
            )
            .insert(
              marketplaceAccount
            );

        if (insertError) {
          console.error(
            "Erro salvando tokens:",
            insertError
          );

          return res
            .status(500)
            .json({
              sucesso: false,
              mensagem:
                "Erro ao salvar a conexão no banco."
            });
        }
      }

      console.log(
        `Mercado Livre conectado e salvo. User ID: ${tokenData.user_id}`
      );

      res.json({
        sucesso: true,
        mensagem:
          "Mercado Livre conectado e salvo na Matrix AI Commerce 🚀",

        user_id:
          tokenData.user_id,

        expires_at:
          expiresAt
      });

    } catch (erroInterno) {
      console.error(
        "Erro interno OAuth:",
        erroInterno
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          "Erro interno durante autenticação do Mercado Livre."
      });
    }
  }
);

// =========================================================
// DADOS DO VENDEDOR
// =========================================================

router.get(
  "/mercadolivre/me",
  async (req, res) => {

    try {
      let account =
        await getMercadoLivreAccount();

      if (!account) {
        return res
          .status(404)
          .json({
            sucesso: false,
            mensagem:
              "Nenhuma conta do Mercado Livre conectada."
          });
      }

      const {
        response
      } =
        await mercadoLivreFetch(
          `/users/${account.user_id}`,
          account
        );

      const mlData =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a consulta.",
            detalhe: mlData
          });
      }

      res.json({
        sucesso: true,

        vendedor: {
          id:
            mlData.id,

          nickname:
            mlData.nickname,

          registration_date:
            mlData.registration_date,

          country_id:
            mlData.country_id,

          site_id:
            mlData.site_id,

          seller_reputation:
            mlData.seller_reputation
        }
      });

    } catch (erro) {
      console.error(
        "Erro /mercadolivre/me:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao consultar Mercado Livre."
      });
    }
  }
);

// =========================================================
// LISTA PEDIDOS DO MERCADO LIVRE
// =========================================================

router.get(
  "/mercadolivre/orders",
  async (req, res) => {

    try {
      const requested =
        Number(req.query.limit || 20);

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(requested)
              ? requested
              : 20,
            1
          ),
          50
        );

      const account =
        await getMercadoLivreAccount();

      if (!account) {
        return res
          .status(404)
          .json({
            sucesso: false,
            mensagem:
              "Nenhuma conta Mercado Livre conectada."
          });
      }

      const params =
        new URLSearchParams({
          seller:
            String(
              account.user_id
            ),

          sort:
            "date_desc",

          limit:
            String(limit)
        });

      const {
        response
      } =
        await mercadoLivreFetch(
          `/orders/search?${params.toString()}`,
          account
        );

      const data =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            sucesso: false,
            mensagem:
              "Mercado Livre recusou a consulta de pedidos.",
            detalhe:
              data
          });
      }

      res.json({
        sucesso: true,
        quantidade:
          data.results?.length || 0,

        paging:
          data.paging || null,

        pedidos:
          data.results || []
      });

    } catch (erro) {
      console.error(
        "Erro orders:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message
      });
    }
  }
);

// =========================================================
// DETALHE DE UM PEDIDO
// =========================================================

router.get(
  "/mercadolivre/orders/:id",
  async (req, res) => {
    try {
      const marketplaceOrderId = String(req.params.id);

      const {
        data: pedido,
        error: pedidoError
      } = await supabase
        .from("marketplace_orders")
        .select("*")
        .eq("marketplace", "mercadolivre")
        .eq("marketplace_order_id", marketplaceOrderId)
        .maybeSingle();

      if (pedidoError) {
        throw new Error(
          `Erro buscando pedido: ${pedidoError.message}`
        );
      }

      if (!pedido) {
        return res.status(404).json({
          sucesso: false,
          mensagem: "Pedido não encontrado."
        });
      }

      const {
        data: itens,
        error: itensError
      } = await supabase
        .from("marketplace_order_items")
        .select("*")
        .eq("order_id", pedido.id)
        .order("id", { ascending: true });

      if (itensError) {
        throw new Error(
          `Erro buscando itens do pedido: ${itensError.message}`
        );
      }

      let shipmentCosts = null;

      if (pedido.shipping_id) {
        try {
          const account =
            await getMercadoLivreAccount();

          if (account) {
            const {
              response: shipmentResponse
            } = await mercadoLivreFetch(
              `/shipments/${pedido.shipping_id}/costs`,
              account
            );

            const shipmentData =
              await shipmentResponse.json();

            if (shipmentResponse.ok) {
              shipmentCosts = shipmentData;
            }
          }
        } catch (shipmentError) {
          console.warn(
            "Não foi possível obter custo de frete:",
            shipmentError.message
          );
        }
      }

      const financeiro =
        extrairFinanceiroPedido(
          pedido,
          itens || [],
          shipmentCosts
        );

      const buyerJson =
        pedido.raw_data?.buyer || {
          id: pedido.buyer_id || null,
          nickname: pedido.buyer_nickname || null
        };

      res.json({
        sucesso: true,
        pedido: {
          ...pedido,
          buyer_json: buyerJson
        },
        itens: itens || [],
        financeiro
      });

    } catch (erro) {
      console.error(
        "Erro detalhe do pedido:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao consultar pedido."
      });
    }
  }
);


// =========================================================
// PEDIDOS SALVOS / FILTROS POR PERÍODO
// =========================================================

router.get(
  "/dashboard/orders",
  async (req, res) => {
    try {
      const requested =
        Number(req.query.limit || 100);

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(requested)
              ? requested
              : 100,
            1
          ),
          500
        );

      const start =
        normalizeDateStart(req.query.start);

      const end =
        normalizeDateEnd(req.query.end);

      const status =
        req.query.status
          ? String(req.query.status)
          : null;

      const q =
        req.query.q
          ? String(req.query.q).trim()
          : "";

      let query = supabase
        .from("marketplace_orders")
        .select(
          "id,marketplace_order_id,status,total_amount,paid_amount,date_created,buyer_id,buyer_nickname"
        )
        .eq("marketplace", "mercadolivre")
        .order("date_created", { ascending: false })
        .limit(limit);

      if (start) {
        query = query.gte("date_created", start);
      }

      if (end) {
        query = query.lte("date_created", end);
      }

      if (status) {
        query = query.eq("status", status);
      }

      if (q) {
        query = query.or(
          `marketplace_order_id.ilike.%${q}%,buyer_nickname.ilike.%${q}%`
        );
      }

      const {
        data,
        error
      } = await query;

      if (error) {
        throw new Error(
          `Erro filtrando pedidos: ${error.message}`
        );
      }

      res.json({
        sucesso: true,
        quantidade: data?.length || 0,
        filtros: {
          start: req.query.start || null,
          end: req.query.end || null,
          status,
          q: q || null
        },
        pedidos: data || []
      });

    } catch (erro) {
      console.error(
        "Erro /dashboard/orders:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao filtrar pedidos."
      });
    }
  }
);

// =========================================================
// SINCRONIZA PEDIDOS PARA SUPABASE
// =========================================================

router.get(
  "/mercadolivre/sync-orders",
  async (req, res) => {
    try {
      // Lotes curtos evitam timeout/upstream error no Railway.
      // O offset permite continuar a sincronização na chamada seguinte.
      const requested = Number(req.query.limit || 200);
      const requestedOffset = Number(req.query.offset || 0);

      const totalDesejado = Math.min(
        Math.max(Number.isFinite(requested) ? requested : 200, 1),
        300
      );

      const offsetInicial = Math.max(
        Number.isFinite(requestedOffset) ? requestedOffset : 0,
        0
      );

      let account = await getMercadoLivreAccount();

      if (!account) {
        return res.status(404).json({
          sucesso: false,
          mensagem: "Nenhuma conta Mercado Livre conectada."
        });
      }

      account = await ensureValidMercadoLivreToken(account);

      const resultados = [];
      let offset = offsetInicial;
      let encontrados = 0;
      let terminou = false;

      // A API do ML entrega no máximo 50 por página.
      // Aqui fazemos paginação automática.
      while (!terminou && encontrados < totalDesejado) {
        const pageLimit = Math.min(50, totalDesejado - encontrados);

        const params = new URLSearchParams({
          seller: String(account.user_id),
          sort: "date_desc",
          limit: String(pageLimit),
          offset: String(offset)
        });

        const {
          response,
          account: contaAtualizada
        } = await mercadoLivreFetch(
          `/orders/search?${params.toString()}`,
          account
        );

        account = contaAtualizada;

        const data = await response.json();

        if (!response.ok) {
          return res.status(response.status).json({
            sucesso: false,
            mensagem: "Mercado Livre recusou a sincronização.",
            detalhe: data,
            encontrados,
            sincronizados: resultados.filter(item => item.sucesso).length
          });
        }

        const pedidos = Array.isArray(data.results)
          ? data.results
          : [];

        if (pedidos.length === 0) {
          terminou = true;
          break;
        }

        encontrados += pedidos.length;

        for (const pedido of pedidos) {
          try {
            const salvo = await salvarPedidoMercadoLivre(
              pedido,
              account
            );

            resultados.push({
              sucesso: true,
              ...salvo
            });
          } catch (erroPedido) {
            console.error(
              `Erro pedido ${pedido.id}:`,
              erroPedido
            );

            resultados.push({
              sucesso: false,
              marketplace_order_id: String(pedido.id),
              erro: erroPedido.message
            });
          }
        }

        offset += pedidos.length;

        const totalDisponivel = Number(data.paging?.total || 0);

        if (
          pedidos.length < pageLimit ||
          (totalDisponivel > 0 && offset >= totalDisponivel)
        ) {
          terminou = true;
        }
      }

      const comSucesso = resultados.filter(
        item => item.sucesso
      ).length;

      const comErro = resultados.length - comSucesso;

      res.json({
        sucesso: comErro === 0,
        mensagem: "Sincronização paginada concluída.",
        solicitados: totalDesejado,
        offset_inicial: offsetInicial,
        encontrados,
        sincronizados: comSucesso,
        erros: comErro,
        proximo_offset: offset,
        terminou,
        proxima_url: terminou
          ? null
          : `/mercadolivre/sync-orders?limit=${totalDesejado}&offset=${offset}`,
        resultados
      });
    } catch (erro) {
      console.error("Erro sync-orders:", erro);

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno na sincronização."
      });
    }
  }
);
// =========================================================
// SINCRONIZA UM PEDIDO ESPECÍFICO
// =========================================================

router.get(
  "/mercadolivre/sync-order/:id",
  async (req, res) => {

    try {
      const resultado =
        await sincronizarPedidoPorId(
          req.params.id
        );

      res.json({
        sucesso: true,
        resultado
      });

    } catch (erro) {
      console.error(
        "Erro sync-order:",
        erro
      );

      res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message
      });
    }
  }
);

// =========================================================
// DASHBOARD / RESUMO AVANÇADO
// =========================================================

router.get(
  "/dashboard/summary",
  async (req, res) => {
    try {
      const pageSize = 1000;
      let offset = 0;
      let terminou = false;
      const pedidos = [];

      const start =
        normalizeDateStart(req.query.start);

      const end =
        normalizeDateEnd(req.query.end);

      while (!terminou) {
        let query = supabase
          .from("marketplace_orders")
          .select(
            "id,status,total_amount,paid_amount,date_created,marketplace_order_id"
          )
          .eq("marketplace", "mercadolivre")
          .order("date_created", { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (start) {
          query = query.gte("date_created", start);
        }

        if (end) {
          query = query.lte("date_created", end);
        }

        const { data, error } =
          await query;

        if (error) {
          throw new Error(`Erro dashboard: ${error.message}`);
        }

        const lote = data || [];
        pedidos.push(...lote);

        if (lote.length < pageSize) {
          terminou = true;
        } else {
          offset += pageSize;
        }
      }

      const porStatus = {};
      const vendasPorDia = {};
      let faturamentoTotal = 0;
      let faturamentoPago = 0;
      let pedidosPagos = 0;
      let pedidosCancelados = 0;

      for (const pedido of pedidos) {
        const status = pedido.status || "sem_status";
        porStatus[status] = (porStatus[status] || 0) + 1;

        const total = Number(pedido.total_amount || 0);
        const pago = Number(
          pedido.paid_amount != null
            ? pedido.paid_amount
            : pedido.total_amount || 0
        );

        if (Number.isFinite(total)) {
          faturamentoTotal += total;
        }

        if (status === "paid") {
          pedidosPagos += 1;

          if (Number.isFinite(pago)) {
            faturamentoPago += pago;
          }

          if (pedido.date_created) {
            const dia = String(pedido.date_created).slice(0, 10);

            if (!vendasPorDia[dia]) {
              vendasPorDia[dia] = {
                pedidos: 0,
                faturamento: 0
              };
            }

            vendasPorDia[dia].pedidos += 1;
            vendasPorDia[dia].faturamento +=
              Number.isFinite(pago) ? pago : 0;
          }
        }

        if (status === "cancelled") {
          pedidosCancelados += 1;
        }
      }

      const ticketMedio = pedidosPagos > 0
        ? faturamentoPago / pedidosPagos
        : 0;

      const taxaCancelamento = pedidos.length > 0
        ? (pedidosCancelados / pedidos.length) * 100
        : 0;

      // Ranking dos produtos usando os itens já sincronizados.
      const { data: itens, error: itensError } = await supabase
        .from("marketplace_order_items")
        .select(
          "order_id,item_id,title,quantity,unit_price,full_unit_price"
        )
        .eq("marketplace", "mercadolivre");

      if (itensError) {
        throw new Error(
          `Erro buscando itens do dashboard: ${itensError.message}`
        );
      }

      const idsPedidosPagos = new Set(
        pedidos
          .filter(p => p.status === "paid")
          .map(p => String(p.id))
      );

      const produtos = {};

      for (const item of itens || []) {
        if (!idsPedidosPagos.has(String(item.order_id))) {
          continue;
        }

        const chave = item.item_id || item.title || "sem_item";
        const quantidade = Number(item.quantity || 0);
        const preco = Number(
          item.unit_price != null
            ? item.unit_price
            : item.full_unit_price || 0
        );

        if (!produtos[chave]) {
          produtos[chave] = {
            item_id: item.item_id || null,
            titulo: item.title || "Sem título",
            quantidade: 0,
            faturamento: 0
          };
        }

        produtos[chave].quantidade += quantidade;

        if (Number.isFinite(preco)) {
          produtos[chave].faturamento += quantidade * preco;
        }
      }

      const rankingProdutos = Object.values(produtos)
        .map(produto => ({
          ...produto,
          faturamento: Number(produto.faturamento.toFixed(2))
        }))
        .sort((a, b) => b.quantidade - a.quantidade)
        .slice(0, 20);

      const serieDiaria = Object.entries(vendasPorDia)
        .map(([data, valores]) => ({
          data,
          pedidos: valores.pedidos,
          faturamento: Number(valores.faturamento.toFixed(2))
        }))
        .sort((a, b) => a.data.localeCompare(b.data));

      const ultimoPedido = pedidos.length
        ? pedidos[0]
        : null;

      res.json({
        sucesso: true,
        marketplace: "mercadolivre",
        periodo: {
          start: req.query.start || null,
          end: req.query.end || null
        },
        pedidos: pedidos.length,
        pedidos_pagos: pedidosPagos,
        pedidos_cancelados: pedidosCancelados,
        faturamento: Number(faturamentoTotal.toFixed(2)),
        faturamento_pago: Number(faturamentoPago.toFixed(2)),
        ticket_medio: Number(ticketMedio.toFixed(2)),
        taxa_cancelamento_percentual:
          Number(taxaCancelamento.toFixed(2)),
        por_status: porStatus,
        vendas_por_dia: serieDiaria,
        top_produtos: rankingProdutos,
        ultimo_pedido: ultimoPedido
          ? {
              id: ultimoPedido.marketplace_order_id,
              status: ultimoPedido.status,
              valor: ultimoPedido.total_amount,
              data: ultimoPedido.date_created
            }
          : null
      });
    } catch (erro) {
      console.error("Erro dashboard:", erro);

      res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);
// =========================================================
// STATUS DA INTEGRAÇÃO
// =========================================================

router.get(
  "/mercadolivre/status",
  async (req, res) => {

    try {
      const account =
        await getMercadoLivreAccount();

      if (!account) {
        return res.json({
          sucesso: true,
          conectado: false
        });
      }

      res.json({
        sucesso: true,
        conectado: true,

        user_id:
          account.user_id,

        expires_at:
          account.expires_at,

        token_expirado:
          account.expires_at
            ? new Date(
                account.expires_at
              ).getTime() <=
              Date.now()
            : null
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


module.exports = router;
