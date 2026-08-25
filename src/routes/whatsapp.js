const router = require("express").Router();
const { env } = require("../config/env");

const WHATSAPP_VERIFY_TOKEN = env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_ACCESS_TOKEN = env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION =
  env.WHATSAPP_API_VERSION ||
  process.env.WHATSAPP_API_VERSION ||
  "v26.0";

const OPENAI_API_KEY =
  env.OPENAI_API_KEY ||
  process.env.OPENAI_API_KEY;

const OPENAI_MODEL =
  env.OPENAI_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-5.6";

const SUPABASE_URL =
  env.SUPABASE_URL ||
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const MATRIX_ADMIN_WHATSAPP =
  env.MATRIX_ADMIN_WHATSAPP ||
  process.env.MATRIX_ADMIN_WHATSAPP ||
  "";

const MATRIX_ADMIN_WHATSAPPS =
  env.MATRIX_ADMIN_WHATSAPPS ||
  process.env.MATRIX_ADMIN_WHATSAPPS ||
  MATRIX_ADMIN_WHATSAPP ||
  "";

const MATRIX_FAMILY_WHATSAPPS =
  env.MATRIX_FAMILY_WHATSAPPS ||
  process.env.MATRIX_FAMILY_WHATSAPPS ||
  "";

function listaNumeros(valor) {
  return String(valor || "")
    .split(",")
    .map(limparNumero)
    .filter(Boolean);
}

function tipoDeUsuario(from) {
  const numero = limparNumero(from);
  if (listaNumeros(MATRIX_ADMIN_WHATSAPPS).includes(numero)) return "admin";
  if (listaNumeros(MATRIX_FAMILY_WHATSAPPS).includes(numero)) return "family";
  return "customer";
}

const MIA_PROMPT = `
Você é Mia, uma assistente de IA geral acessada pelo WhatsApp privado da família Shop Matrix.
Converse naturalmente em português do Brasil e responda perguntas de qualquer assunto dentro de suas capacidades.
Use o histórico desta conversa para manter contexto.
Não transforme conversa casual, perguntas gerais ou opiniões em regras da empresa.
Somente administradores podem ensinar conhecimento oficial ao SAC.
Quando o usuário for administrador e der uma instrução explícita de treinamento iniciada por APRENDA:, TREINAR: ou TREINE:, o sistema tratará isso separadamente.
Não diga que é humana. Se perguntarem, diga que é uma assistente de IA quase humana.
`;

const BASE_PROMPT = `
Você é a assistente de atendimento da Shop Matrix.
Você é uma IA em tempo real: conversa naturalmente, usa memória do cliente,
consulta conhecimento oficial da empresa e acumula experiência operacional.

PRINCÍPIOS:
- Responda em português do Brasil.
- Seja educada, objetiva, natural e resolutiva.
- Fale de forma simples com clientes leigos.
- Não invente diagnóstico, produto, recurso, prazo, política, preço, garantia,
  frete, estoque ou informação de pedido.
- Use o histórico da conversa. Nunca repita um teste que o cliente já confirmou ter feito.
- Em atendimento conversacional, nunca envie mais de 2 procedimentos/testes na mesma mensagem.
- Faça perguntas curtas quando precisar de informação para decidir o próximo passo.
- Não diga que é humana. Se perguntarem, diga que é a assistente virtual da Shop Matrix.
- Não execute orientação elétrica perigosa e nunca mande abrir uma fonte de alimentação.
- Conhecimento oficial fornecido abaixo tem prioridade sobre conhecimento genérico do modelo.
- Experiências anteriores ajudam, mas não podem contradizer conhecimento oficial.
`;

function limparNumero(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function precisaSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      "SUPABASE_URL ou SUPABASE_SECRET_KEY não configurado."
    );
  }
}

async function supabaseRest(path, options = {}) {
  precisaSupabase();

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    console.error("Erro Supabase REST:", {
      path,
      status: response.status,
      data
    });

    throw new Error(
      data?.message ||
      data?.hint ||
      `Supabase recusou a operação (${response.status}).`
    );
  }

  return data;
}

async function obterOuCriarConversa({
  telefone,
  nome
}) {
  const numero = limparNumero(telefone);

  const existente = await supabaseRest(
    `sac_conversations?channel=eq.whatsapp&external_user_id=eq.${encodeURIComponent(numero)}&select=id,external_user_id,contact_name,status,last_message_at&limit=1`
  );

  if (Array.isArray(existente) && existente[0]) {
    const conversa = existente[0];

    await supabaseRest(
      `sac_conversations?id=eq.${conversa.id}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          contact_name: nome || conversa.contact_name || null,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    );

    return conversa;
  }

  const criada = await supabaseRest(
    "sac_conversations",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        channel: "whatsapp",
        external_user_id: numero,
        contact_name: nome || null,
        status: "open",
        last_message_at: new Date().toISOString()
      })
    }
  );

  if (!Array.isArray(criada) || !criada[0]) {
    throw new Error("Não foi possível criar a conversa.");
  }

  return criada[0];
}

async function mensagemJaProcessada(externalMessageId) {
  if (!externalMessageId) {
    return false;
  }

  const data = await supabaseRest(
    `sac_messages?external_message_id=eq.${encodeURIComponent(externalMessageId)}&select=id&limit=1`
  );

  return Array.isArray(data) && data.length > 0;
}

async function salvarMensagem({
  conversationId,
  direction,
  role,
  content,
  externalMessageId = null,
  metadata = {}
}) {
  return supabaseRest(
    "sac_messages",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation,resolution=ignore-duplicates"
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        direction,
        role,
        content,
        external_message_id: externalMessageId,
        metadata
      })
    }
  );
}

async function buscarHistorico(conversationId) {
  const data = await supabaseRest(
    `sac_messages?conversation_id=eq.${conversationId}&select=role,content,created_at&order=created_at.desc&limit=16`
  );

  return (Array.isArray(data) ? data : [])
    .reverse()
    .map(item => ({
      role: item.role,
      content: item.content
    }));
}

async function buscarConhecimentoOficial() {
  const data = await supabaseRest(
    "matrix_ai_knowledge?active=eq.true&approved=eq.true&select=category,title,content,priority&order=priority.desc&limit=100"
  );

  return Array.isArray(data) ? data : [];
}

async function buscarExperienciasResolvidas() {
  const data = await supabaseRest(
    "sac_learnings?status=eq.verified_by_outcome&select=title,content,confidence&order=created_at.desc&limit=12"
  );

  return Array.isArray(data) ? data : [];
}

function montarContexto({
  historico,
  conhecimento,
  experiencias
}) {
  const regras = conhecimento.length
    ? conhecimento
        .map(
          item =>
            `- [${item.category}] ${item.title}: ${item.content}`
        )
        .join("\n")
    : "- Nenhuma regra oficial cadastrada.";

  const casos = experiencias.length
    ? experiencias
        .map(
          item =>
            `- ${item.title}: ${item.content}`
        )
        .join("\n")
    : "- Nenhuma experiência resolvida cadastrada.";

  const conversa = historico.length
    ? historico
        .map(
          item =>
            `${item.role === "assistant" ? "ATENDENTE" : "CLIENTE"}: ${item.content}`
        )
        .join("\n")
    : "Sem histórico anterior.";

  return `
CONHECIMENTO OFICIAL DA SHOP MATRIX:
${regras}

EXPERIÊNCIAS DE ATENDIMENTOS JÁ RESOLVIDOS:
${casos}

HISTÓRICO DESTA CONVERSA:
${conversa}
`;
}

async function gerarRespostaIA({
  mensagem,
  nomeCliente,
  historico,
  conhecimento,
  experiencias,
  userType = "customer"
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const contexto = montarContexto({
    historico,
    conhecimento,
    experiencias
  });

  const input = `
${contexto}

NOME DO CLIENTE:
${nomeCliente || "não informado"}

NOVA MENSAGEM DO CLIENTE:
${mensagem}

Responda somente ao cliente. Não explique regras internas nem mencione banco de dados.
`;

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: userType === "customer" ? BASE_PROMPT : MIA_PROMPT,
        input
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro OpenAI:", data);

    throw new Error(
      data?.error?.message ||
      "OpenAI recusou a geração da resposta."
    );
  }

  const outputText =
    data.output_text ||
    (Array.isArray(data.output)
      ? data.output
          .flatMap(item => item?.content || [])
          .map(content => content?.text || "")
          .filter(Boolean)
          .join("\n")
      : "");

  if (!outputText || !outputText.trim()) {
    throw new Error("OpenAI retornou resposta vazia.");
  }

  return outputText.trim();
}

async function enviarMensagemWhatsApp(
  to,
  message
) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurado."
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: limparNumero(to),
        type: "text",
        text: {
          preview_url: false,
          body: String(message)
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro enviando WhatsApp:", data);

    throw new Error(
      data?.error?.message ||
      "WhatsApp recusou o envio."
    );
  }

  return data;
}

function pareceConfirmacaoDeResolucao(texto) {
  const t = String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return [
    "funcionou",
    "resolveu",
    "deu certo",
    "agora ligou",
    "voltou a funcionar",
    "obrigado resolveu",
    "obrigada resolveu"
  ].some(frase => t.includes(frase));
}

async function gerarAprendizadoDoCaso({
  historico
}) {
  if (!OPENAI_API_KEY || historico.length < 3) {
    return null;
  }

  const conversa = historico
    .map(
      item =>
        `${item.role === "assistant" ? "ATENDENTE" : "CLIENTE"}: ${item.content}`
    )
    .join("\n");

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions:
          "Resuma um atendimento técnico resolvido em até 500 caracteres. Informe sintoma, procedimento que resolveu e qualquer condição relevante. Não invente nada.",
        input: conversa
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    return null;
  }

  return (
    data.output_text ||
    data?.output?.[0]?.content?.[0]?.text ||
    ""
  ).trim() || null;
}

async function salvarAprendizadoResolvido({
  conversationId,
  resumo
}) {
  if (!resumo) {
    return;
  }

  await supabaseRest(
    "sac_learnings",
    {
      method: "POST",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        title: "Caso resolvido no WhatsApp",
        content: resumo,
        status: "verified_by_outcome",
        confidence: 0.8,
        source: "customer_resolution_confirmation"
      })
    }
  );
}

function ehComandoDeTreinamento(
  from,
  texto
) {
  if (tipoDeUsuario(from) !== "admin") {
    return false;
  }

  return /^\s*(aprenda|treinar|treine)\s*:/i.test(
    String(texto || "")
  );
}

function extrairRegraTreinamento(texto) {
  return String(texto || "")
    .replace(
      /^\s*(aprenda|treinar|treine)\s*:\s*/i,
      ""
    )
    .trim();
}

async function salvarConhecimentoOficial(
  conteudo
) {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: `
Classifique uma regra operacional da Shop Matrix.
Responda SOMENTE JSON válido com:
{"category":"produto|procedimento|atendimento|politica|tecnico","title":"titulo curto","content":"regra clara e fiel"}
Não invente nada e preserve o sentido da regra recebida.
`,
        input: conteudo
      })
    }
  );

  const data = await response.json();

  let estrutura = {
    category: "atendimento",
    title: "Regra ensinada pelo administrador",
    content: conteudo
  };

  if (response.ok) {
    const texto =
      data.output_text ||
      data?.output?.[0]?.content?.[0]?.text ||
      "";

    try {
      const json = JSON.parse(
        texto.replace(/^```json\s*/i, "")
          .replace(/```$/i, "")
          .trim()
      );

      if (
        json.category &&
        json.title &&
        json.content
      ) {
        estrutura = json;
      }
    } catch {
      // usa estrutura simples
    }
  }

  const gravada = await supabaseRest(
    "matrix_ai_knowledge",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        category: estrutura.category,
        title: estrutura.title,
        content: estrutura.content,
        priority: 100,
        active: true,
        approved: true,
        source: "admin_whatsapp"
      })
    }
  );

  return Array.isArray(gravada)
    ? gravada[0]
    : null;
}

// Validação do webhook pela Meta
router.get(
  "/webhooks/whatsapp",
  (req, res) => {
    const mode = req.query["hub.mode"];
    const token =
      req.query["hub.verify_token"];
    const challenge =
      req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token &&
      WHATSAPP_VERIFY_TOKEN &&
      token === WHATSAPP_VERIFY_TOKEN
    ) {
      console.log(
        "Webhook do WhatsApp verificado com sucesso."
      );

      return res.status(200).send(challenge);
    }

    console.warn(
      "Falha na verificação do webhook do WhatsApp."
    );

    return res.sendStatus(403);
  }
);

// Recebe mensagens e atualizações
router.post(
  "/webhooks/whatsapp",
  async (req, res) => {
    res.sendStatus(200);

    try {
      const body = req.body;

      if (
        body?.object !==
        "whatsapp_business_account"
      ) {
        return;
      }

      for (const entry of body.entry || []) {
        for (
          const change of entry.changes || []
        ) {
          const value = change.value || {};

          for (
            const status of value.statuses || []
          ) {
            console.log("Status WhatsApp:", {
              id: status.id,
              status: status.status,
              recipient_id: status.recipient_id,
              timestamp: status.timestamp
            });
          }

          for (
            const message of value.messages || []
          ) {
            const contact =
              Array.isArray(value.contacts) &&
              value.contacts.length
                ? value.contacts[0]
                : null;

            const messageText =
              message?.text?.body ||
              message?.button?.text ||
              message?.interactive
                ?.button_reply?.title ||
              message?.interactive
                ?.list_reply?.title ||
              null;

            if (
              !message.from ||
              !messageText ||
              ![
                "text",
                "button",
                "interactive"
              ].includes(message.type)
            ) {
              continue;
            }

            if (
              await mensagemJaProcessada(
                message.id
              )
            ) {
              console.log(
                "Mensagem duplicada ignorada:",
                message.id
              );

              continue;
            }

            const userType = tipoDeUsuario(message.from);

            const conversa =
              await obterOuCriarConversa({
                telefone: message.from,
                nome:
                  contact?.profile?.name ||
                  null
              });

            await salvarMensagem({
              conversationId: conversa.id,
              direction: "inbound",
              role: "user",
              content: messageText,
              externalMessageId: message.id,
              metadata: {
                type: message.type,
                contact_name:
                  contact?.profile?.name ||
                  null,
                phone_number_id:
                  value?.metadata
                    ?.phone_number_id ||
                  null
              }
            });

            console.log(
              "Mensagem WhatsApp recebida e memorizada:",
              {
                from: message.from,
                conversation_id: conversa.id,
                text: messageText
              }
            );

            // TREINAMENTO AO VIVO PELO WHATSAPP DO ADMIN
            if (
              ehComandoDeTreinamento(
                message.from,
                messageText
              )
            ) {
              const regra =
                extrairRegraTreinamento(
                  messageText
                );

              if (!regra) {
                await enviarMensagemWhatsApp(
                  message.from,
                  "Escreva depois de APRENDA: a regra que deseja ensinar."
                );
                continue;
              }

              const conhecimento =
                await salvarConhecimentoOficial(
                  regra
                );

              const confirmacao =
                conhecimento
                  ? `Aprendido e gravado na memória da Shop Matrix: ${conhecimento.content}`
                  : "Aprendido e gravado na memória da Shop Matrix.";

              const envio =
                await enviarMensagemWhatsApp(
                  message.from,
                  confirmacao
                );

              await salvarMensagem({
                conversationId: conversa.id,
                direction: "outbound",
                role: "assistant",
                content: confirmacao,
                externalMessageId:
                  envio?.messages?.[0]?.id ||
                  null,
                metadata: {
                  training: true
                }
              });

              continue;
            }

            const historico =
              await buscarHistorico(
                conversa.id
              );

            // Se o próprio cliente confirmou que resolveu,
            // transforma esse atendimento em experiência operacional.
            if (
              userType === "customer" &&
              pareceConfirmacaoDeResolucao(
                messageText
              )
            ) {
              const resumo =
                await gerarAprendizadoDoCaso({
                  historico
                });

              await salvarAprendizadoResolvido({
                conversationId: conversa.id,
                resumo
              });
            }

            const conhecimento =
              userType === "customer"
                ? await buscarConhecimentoOficial()
                : [];

            const experiencias =
              userType === "customer"
                ? await buscarExperienciasResolvidas()
                : [];

            const respostaIA =
              await gerarRespostaIA({
                mensagem: messageText,
                nomeCliente:
                  contact?.profile?.name ||
                  null,
                historico,
                conhecimento,
                experiencias,
                userType
              });

            const envio =
              await enviarMensagemWhatsApp(
                message.from,
                respostaIA
              );

            await salvarMensagem({
              conversationId: conversa.id,
              direction: "outbound",
              role: "assistant",
              content: respostaIA,
              externalMessageId:
                envio?.messages?.[0]?.id ||
                null,
              metadata: {
                ai_model: OPENAI_MODEL
              }
            });

            console.log(
              "Resposta IA enviada e memorizada:",
              {
                to: message.from,
                conversation_id: conversa.id,
                message_id:
                  envio?.messages?.[0]?.id ||
                  null
              }
            );
          }
        }
      }
    } catch (erro) {
      console.error(
        "Erro processando webhook do WhatsApp:",
        erro
      );
    }
  }
);

// Envio manual
router.post(
  "/whatsapp/send",
  async (req, res) => {
    try {
      const { to, message } =
        req.body || {};

      if (!to || !message) {
        return res.status(400).json({
          sucesso: false,
          mensagem:
            "Informe 'to' e 'message'."
        });
      }

      const data =
        await enviarMensagemWhatsApp(
          to,
          message
        );

      return res.json({
        sucesso: true,
        resposta: data
      });
    } catch (erro) {
      console.error(
        "Erro /whatsapp/send:",
        erro
      );

      return res.status(500).json({
        sucesso: false,
        mensagem:
          erro.message ||
          "Erro interno ao enviar WhatsApp."
      });
    }
  }
);

// Consulta simples da memória por número (útil para painel futuro)
router.get(
  "/whatsapp/memory/:phone",
  async (req, res) => {
    try {
      const numero =
        limparNumero(req.params.phone);

      const conversas =
        await supabaseRest(
          `sac_conversations?channel=eq.whatsapp&external_user_id=eq.${encodeURIComponent(numero)}&select=id,contact_name,status,last_message_at&limit=1`
        );

      if (
        !Array.isArray(conversas) ||
        !conversas[0]
      ) {
        return res.json({
          sucesso: true,
          encontrado: false
        });
      }

      const conversa = conversas[0];
      const historico =
        await buscarHistorico(
          conversa.id
        );

      return res.json({
        sucesso: true,
        encontrado: true,
        conversa,
        historico
      });
    } catch (erro) {
      return res.status(500).json({
        sucesso: false,
        mensagem: erro.message
      });
    }
  }
);

module.exports = router;
