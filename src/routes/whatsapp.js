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


function memoryOwnerKey(from) {
  const numero = limparNumero(from);
  const role = tipoDeUsuario(numero);

  if (role === "admin" || role === "family") {
    return `whatsapp:${numero}`;
  }

  return null;
}

function pedidoNaturalDeMemoria(texto) {
  const t = String(texto || "").trim();

  const patterns = [
    /^\s*(mia[,\s]*)?(lembra|lembre|guarda|guarde|grava|grave|anota|anote|salva|salve)\b/i,
    /^\s*(mia[,\s]*)?pra voce lembrar\b/i,
    /^\s*(mia[,\s]*)?quero que voce lembre\b/i
  ];

  return patterns.some(p => p.test(t));
}

function extrairMemoriaNatural(texto) {
  return String(texto || "")
    .replace(/^\s*mia[,\s]*/i, "")
    .replace(/^\s*(lembra|lembre|guarda|guarde|grava|grave|anota|anote|salva|salve)\s*(a[ií]|que|isso|:|-)?\s*/i, "")
    .replace(/^\s*(pra voce lembrar|quero que voce lembre)\s*(que|:|-)?\s*/i, "")
    .trim();
}

async function salvarMemoriaPessoal({
  ownerKey,
  ownerRole,
  content,
  source = "whatsapp_explicit"
}) {
  if (!ownerKey || !content) return null;

  let titulo = "Memória pessoal";
  let conteudo = content;

  if (OPENAI_API_KEY) {
    try {
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
Transforme a informação em uma memória curta e fiel.
Responda SOMENTE JSON válido:
{"title":"título curto","content":"fato em uma frase"}
Não invente, não generalize e não inclua informação que não esteja no texto.
`,
            input: content
          })
        }
      );

      const data = await response.json();

      if (response.ok) {
        const raw =
          data.output_text ||
          data?.output?.[0]?.content?.[0]?.text ||
          "";

        try {
          const obj = JSON.parse(
            raw.replace(/^```json\s*/i, "")
              .replace(/```$/i, "")
              .trim()
          );

          if (obj.title && obj.content) {
            titulo = String(obj.title);
            conteudo = String(obj.content);
          }
        } catch {}
      }
    } catch {}
  }

  const gravada = await supabaseRest(
    "matrix_personal_memory",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        owner_key: ownerKey,
        owner_role: ownerRole,
        title: titulo,
        content: conteudo,
        memory_type: "explicit",
        visibility: "owner",
        active: true,
        source
      })
    }
  );

  return Array.isArray(gravada) ? gravada[0] : null;
}

async function buscarMemoriaPessoal(ownerKey) {
  if (!ownerKey) return [];

  const data = await supabaseRest(
    `matrix_personal_memory?owner_key=eq.${encodeURIComponent(ownerKey)}&active=eq.true&select=title,content,memory_type,created_at&order=created_at.desc&limit=80`
  );

  return Array.isArray(data) ? data : [];
}

async function buscarMemoriaCompartilhadaFamilia() {
  const data = await supabaseRest(
    "matrix_shared_memory?active=eq.true&select=title,content,category,created_at&order=created_at.desc&limit=80"
  );

  return Array.isArray(data) ? data : [];
}

const MIA_PROMPT = `
Você é Mia, uma assistente de IA geral acessada pelo WhatsApp da família Shop Matrix.

COMPORTAMENTO:
- Converse naturalmente em português do Brasil.
- Pode responder sobre qualquer assunto dentro de suas capacidades.
- Use o histórico da conversa, a memória pessoal do usuário e a memória compartilhada quando forem relevantes.
- Não invente lembranças. Se a memória não trouxer um fato, diga que não sabe ou peça para o usuário ensinar.
- Não transforme conversa casual em memória automaticamente.
- Quando o usuário pedir explicitamente para lembrar/gravar/anotar/salvar algo, o sistema trata isso como memória pessoal.
- Somente administradores podem ensinar regras oficiais do SAC.
- Não misture memória de uma pessoa com outra.
- Não diga que é humana. Se perguntarem, diga que é uma assistente de IA.
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
  experiencias,
  memoriaPessoal = [],
  memoriaCompartilhada = []
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

  const memoriaUsuario = memoriaPessoal.length
    ? memoriaPessoal
        .map(item => `- ${item.title}: ${item.content}`)
        .join("\n")
    : "- Nenhuma memória pessoal disponível.";

  const memoriaFamilia = memoriaCompartilhada.length
    ? memoriaCompartilhada
        .map(item => `- ${item.title}: ${item.content}`)
        .join("\n")
    : "- Nenhuma memória compartilhada disponível.";

  return `
CONHECIMENTO OFICIAL DA SHOP MATRIX:
${regras}

EXPERIÊNCIAS DE ATENDIMENTOS JÁ RESOLVIDOS:
${casos}

MEMÓRIA PESSOAL DO USUÁRIO:
${memoriaUsuario}

MEMÓRIA COMPARTILHADA:
${memoriaFamilia}

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
  memoriaPessoal = [],
  memoriaCompartilhada = [],
  userType = "customer"
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const contexto = montarContexto({
    historico,
    conhecimento,
    experiencias,
    memoriaPessoal,
    memoriaCompartilhada
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


async function obterUrlMidiaWhatsApp(mediaId) {
  if (!mediaId) {
    throw new Error("ID da mídia do WhatsApp ausente.");
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data?.url) {
    console.error("Erro obtendo URL da mídia:", data);
    throw new Error(
      data?.error?.message ||
      "Não foi possível obter a URL do áudio."
    );
  }

  return {
    url: data.url,
    mimeType: data.mime_type || "audio/ogg"
  };
}

async function baixarMidiaWhatsApp(mediaId) {
  const { url, mimeType } =
    await obterUrlMidiaWhatsApp(mediaId);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
    }
  });

  if (!response.ok) {
    const texto = await response.text();
    console.error(
      "Erro baixando mídia do WhatsApp:",
      texto
    );
    throw new Error(
      "Não foi possível baixar o áudio do WhatsApp."
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType
  };
}

function extensaoAudioPorMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();

  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("amr")) return "amr";

  return "ogg";
}

async function transcreverAudioOpenAI({
  buffer,
  mimeType
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const ext = extensaoAudioPorMime(mimeType);

  const form = new FormData();
  const blob = new Blob(
    [buffer],
    { type: mimeType || "audio/ogg" }
  );

  form.append(
    "file",
    blob,
    `audio.${ext}`
  );

  // whisper-1 é estável para transcrição e barato para áudios curtos.
  form.append("model", "whisper-1");
  form.append("language", "pt");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: form
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "Erro transcrevendo áudio:",
      data
    );

    throw new Error(
      data?.error?.message ||
      "OpenAI recusou a transcrição do áudio."
    );
  }

  const texto =
    data?.text ||
    data?.transcript ||
    "";

  if (!String(texto).trim()) {
    throw new Error(
      "A transcrição do áudio veio vazia."
    );
  }

  return String(texto).trim();
}

async function extrairTextoMensagemWhatsApp(message) {
  if (!message) {
    return {
      text: null,
      originalType: null,
      metadata: {}
    };
  }

  if (message.type === "text") {
    return {
      text: message?.text?.body || null,
      originalType: "text",
      metadata: {}
    };
  }

  if (message.type === "button") {
    return {
      text: message?.button?.text || null,
      originalType: "button",
      metadata: {}
    };
  }

  if (message.type === "interactive") {
    return {
      text:
        message?.interactive?.button_reply?.title ||
        message?.interactive?.list_reply?.title ||
        null,
      originalType: "interactive",
      metadata: {}
    };
  }

  if (message.type === "audio") {
    const mediaId = message?.audio?.id;

    if (!mediaId) {
      throw new Error(
        "Mensagem de áudio sem media ID."
      );
    }

    const { buffer, mimeType } =
      await baixarMidiaWhatsApp(mediaId);

    const transcricao =
      await transcreverAudioOpenAI({
        buffer,
        mimeType
      });

    return {
      text: transcricao,
      originalType: "audio",
      metadata: {
        audio_media_id: mediaId,
        audio_mime_type: mimeType,
        audio_voice:
          Boolean(message?.audio?.voice)
      }
    };
  }

  return {
    text: null,
    originalType: message.type || null,
    metadata: {}
  };
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

            let parsedMessage;

            try {
              parsedMessage =
                await extrairTextoMensagemWhatsApp(
                  message
                );
            } catch (mediaError) {
              console.error(
                "Erro processando mídia do WhatsApp:",
                mediaError
              );

              if (message?.from) {
                try {
                  await enviarMensagemWhatsApp(
                    message.from,
                    "Não consegui processar esse áudio agora. Pode enviar novamente ou escrever a mensagem em texto?"
                  );
                } catch {}
              }

              continue;
            }

            const messageText =
              parsedMessage?.text || null;

            if (
              !message.from ||
              !messageText ||
              ![
                "text",
                "button",
                "interactive",
                "audio"
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
                original_type:
                  parsedMessage?.originalType ||
                  message.type,
                ...(parsedMessage?.metadata || {}),
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
                text: messageText,
                original_type:
                  parsedMessage?.originalType ||
                  message.type
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

            // MEMÓRIA PESSOAL EXPLÍCITA - ADMIN E FAMÍLIA
            if (
              (userType === "admin" || userType === "family") &&
              pedidoNaturalDeMemoria(messageText)
            ) {
              const ownerKey = memoryOwnerKey(message.from);
              const memoria = extrairMemoriaNatural(messageText);

              if (memoria) {
                const gravada = await salvarMemoriaPessoal({
                  ownerKey,
                  ownerRole: userType,
                  content: memoria
                });

                const confirmacao = gravada
                  ? `Beleza. Gravei na sua memória: ${gravada.content}`
                  : "Beleza. Gravei isso na sua memória.";

                const envio = await enviarMensagemWhatsApp(
                  message.from,
                  confirmacao
                );

                await salvarMensagem({
                  conversationId: conversa.id,
                  direction: "outbound",
                  role: "assistant",
                  content: confirmacao,
                  externalMessageId:
                    envio?.messages?.[0]?.id || null,
                  metadata: {
                    personal_memory: true
                  }
                });

                continue;
              }
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

            const ownerKey = memoryOwnerKey(message.from);

            const memoriaPessoal =
              (userType === "admin" || userType === "family")
                ? await buscarMemoriaPessoal(ownerKey)
                : [];

            const memoriaCompartilhada =
              (userType === "admin" || userType === "family")
                ? await buscarMemoriaCompartilhadaFamilia()
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
                memoriaPessoal,
                memoriaCompartilhada,
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
