const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { blingFetch } = require("../services/bling");

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function recursiveFindAccessKey(value, depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    const onlyDigits = digitsOnly(text);
    if (onlyDigits.length === 44) return onlyDigits;
    const match = text.match(/(?:^|\D)(\d{44})(?:\D|$)/);
    return match ? match[1] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindAccessKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const preferred = [
      "chaveAcesso",
      "chave",
      "accessKey",
      "chaveNfe",
      "chaveAcessoNfe",
      "linkDanfe",
      "linkPDF",
      "linkXml"
    ];

    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = recursiveFindAccessKey(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const child of Object.values(value)) {
      const found = recursiveFindAccessKey(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function extractInfo(payload) {
  const d = payload?.data || payload || {};
  const situation =
    d?.situacao?.valor ??
    d?.situacao?.id ??
    d?.situacao?.descricao ??
    d?.situacao ??
    d?.status?.valor ??
    d?.status?.descricao ??
    d?.status ??
    null;

  const accessKey = recursiveFindAccessKey(d);
  const situationText = String(situation ?? "").toLowerCase();
  const authorized =
    Boolean(accessKey) ||
    [5, 6, 9].includes(Number(situation)) ||
    /autoriz|emitid|aprovad|processad/.test(situationText);

  return {
    number: d?.numero ?? d?.numeroNota ?? null,
    series: d?.serie ?? d?.serieNota ?? null,
    accessKey,
    pdfUrl: d?.linkDanfe ?? d?.linkPDF ?? d?.danfe ?? null,
    authorized
  };
}

router.post("/bling/nfe/emit/from-order/:orderId", async (req, res, next) => {
  const orderId = String(req.params.orderId);

  try {
    const { data: fiscal, error } = await supabase
      .from("fiscal_documents")
      .select("*")
      .eq("marketplace_order_id", orderId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!fiscal?.bling_nfe_id) return next();

    if (String(fiscal.status || "").toLowerCase() === "authorized") {
      return res.json({
        sucesso: true,
        mensagem: "Esta NF-e já está autorizada. Nenhuma nova nota foi criada.",
        fiscal
      });
    }

    const response = await blingFetch(
      `/nfe/${encodeURIComponent(String(fiscal.bling_nfe_id))}`,
      { method: "GET" }
    );

    if (!response.ok) return next();

    const detail = await readJson(response);
    const info = extractInfo(detail);

    if (!info.authorized) return next();

    const { data: updated, error: updateError } = await supabase
      .from("fiscal_documents")
      .upsert(
        {
          marketplace_order_id: orderId,
          bling_nfe_id: String(fiscal.bling_nfe_id),
          status: "authorized",
          nfe_number: info.number == null ? fiscal.nfe_number : String(info.number),
          nfe_series: info.series == null ? fiscal.nfe_series : String(info.series),
          nfe_access_key: info.accessKey || fiscal.nfe_access_key || null,
          nfe_pdf_url: info.pdfUrl || fiscal.nfe_pdf_url || null,
          bling_response: {
            authorized_guard: detail,
            synced_at: nowIso()
          },
          updated_at: nowIso()
        },
        { onConflict: "marketplace_order_id" }
      )
      .select("*")
      .single();

    if (updateError) throw new Error(updateError.message);

    return res.json({
      sucesso: true,
      mensagem: "A NF-e já estava autorizada no Bling. A Matrix sincronizou o status e não tentou alterar nem emitir outra nota.",
      fiscal: updated
    });
  } catch (error) {
    console.warn(`[Bling emit guard] Falha no pré-check do pedido ${orderId}:`, error.message);
    return next();
  }
});

module.exports = router;
