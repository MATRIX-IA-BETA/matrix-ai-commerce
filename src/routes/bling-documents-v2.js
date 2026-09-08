const router = require("express").Router();
const { blingFetch } = require("../services/bling");
const { supabase } = require("../db/supabase");

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function isPdf(bytes) {
  return Buffer.isBuffer(bytes) &&
    bytes.length >= 5 &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function isXml(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return false;
  const head = bytes
    .subarray(0, Math.min(bytes.length, 1000))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();

  return (
    head.startsWith("<?xml") ||
    head.startsWith("<nfeProc") ||
    head.startsWith("<NFe") ||
    head.startsWith("<procNFe") ||
    head.includes("<nfeProc") ||
    head.includes("<NFe")
  );
}

function isValidDocument(bytes, format) {
  return format === "pdf" ? isPdf(bytes) : isXml(bytes);
}

function contentTypeFor(format) {
  return format === "pdf"
    ? "application/pdf"
    : "application/xml; charset=utf-8";
}

function acceptFor(format) {
  return format === "pdf"
    ? "application/pdf, application/octet-stream;q=0.9, */*;q=0.8"
    : "application/xml, text/xml, application/octet-stream;q=0.9, */*;q=0.8";
}

function tryParseJson(bytes) {
  if (!bytes?.length) return null;
  const text = bytes.toString("utf8").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectStrings(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;

  if (typeof value === "string") {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      collectStrings(child, out, depth + 1);
    }
  }

  return out;
}

function decodePossibleBase64(value, format) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const dataUri = raw.match(/^data:[^;]+;base64,(.+)$/is);
  const candidate = dataUri ? dataUri[1] : raw;

  if (
    !dataUri &&
    (candidate.length < 80 || !/^[A-Za-z0-9+/=\r\n]+$/.test(candidate))
  ) {
    return null;
  }

  try {
    const bytes = Buffer.from(candidate.replace(/\s+/g, ""), "base64");
    return isValidDocument(bytes, format) ? bytes : null;
  } catch {
    return null;
  }
}

function safeHttpsUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function fetchDocumentUrl(url, format) {
  const safeUrl = safeHttpsUrl(url);
  if (!safeUrl) return null;

  try {
    const response = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: acceptFor(format),
        "User-Agent": "Matrix-AI-Commerce/1.0"
      }
    });

    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    return isValidDocument(bytes, format) ? bytes : null;
  } catch {
    return null;
  }
}

async function resolveDocumentFromJson(json, format) {
  const strings = collectStrings(json);

  for (const value of strings) {
    const url = safeHttpsUrl(value);
    if (!url) continue;
    const bytes = await fetchDocumentUrl(url, format);
    if (bytes) return bytes;
  }

  for (const value of strings) {
    const bytes = decodePossibleBase64(value, format);
    if (bytes) return bytes;
  }

  return null;
}

function blingErrorFromJson(json) {
  return (
    json?.error?.message ||
    json?.message ||
    json?.mensagem ||
    json?.error?.description ||
    null
  );
}

async function getFiscalDocumentByKey(key) {
  const { data, error } = await supabase
    .from("fiscal_documents")
    .select("bling_nfe_id,nfe_pdf_url")
    .eq("nfe_access_key", key)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[DANFE] Falha buscando NF-e local:", error.message);
    return null;
  }

  return data || null;
}

async function getNfeDetail(id) {
  if (!id) return null;

  try {
    const response = await blingFetch(
      `/nfe/${encodeURIComponent(String(id))}`,
      { method: "GET" }
    );

    const text = await response.text();
    if (!response.ok || !text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function resolveFromKnownNfe(key, format) {
  const fiscal = await getFiscalDocumentByKey(key);
  if (!fiscal) return null;

  const candidates = [];

  if (format === "pdf" && fiscal.nfe_pdf_url) {
    candidates.push(fiscal.nfe_pdf_url);
  }

  if (fiscal.bling_nfe_id) {
    const detail = await getNfeDetail(fiscal.bling_nfe_id);
    const d = detail?.data || detail || {};

    if (format === "pdf") {
      // linkPDF primeiro: tende a apontar para o arquivo PDF real.
      candidates.push(d.linkPDF, d.linkDanfe, d.danfe);
    } else {
      candidates.push(d.linkXml, d.linkXML, d.xml);
    }
  }

  for (const candidate of candidates.filter(Boolean)) {
    const bytes = await fetchDocumentUrl(candidate, format);
    if (bytes) return bytes;
  }

  return null;
}

function sendDocument(res, key, format, documentBytes) {
  res.set({
    "Content-Type": contentTypeFor(format),
    "Content-Disposition": `attachment; filename="NFe-${key}.${format}"`,
    "Content-Length": String(documentBytes.length),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });

  return res.send(documentBytes);
}

router.get("/bling/nfe/document/:key/:format", async (req, res) => {
  try {
    const key = digitsOnly(req.params.key);
    const format = String(req.params.format || "").toLowerCase();

    if (key.length !== 44) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Chave de acesso da NF-e inválida."
      });
    }

    if (!["pdf", "xml"].includes(format)) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Formato deve ser pdf ou xml."
      });
    }

    // Para notas já sincronizadas, prioriza os links oficiais da própria NF-e.
    const knownBytes = await resolveFromKnownNfe(key, format);
    if (knownBytes) {
      return sendDocument(res, key, format, knownBytes);
    }

    // Fallback para a rota específica por chave criada pelo Bling em 2026.
    const upstream = await blingFetch(
      `/nfe/documento/${encodeURIComponent(key)}?formato=${encodeURIComponent(format)}`,
      {
        method: "GET",
        headers: {
          Accept: acceptFor(format)
        }
      }
    );

    const rawBytes = Buffer.from(await upstream.arrayBuffer());
    const json = tryParseJson(rawBytes);

    if (!upstream.ok) {
      const detail = json
        ? blingErrorFromJson(json) || JSON.stringify(json)
        : rawBytes.toString("utf8").slice(0, 1000);

      return res.status(upstream.status).json({
        sucesso: false,
        mensagem: `Bling recusou o download da NF-e: ${detail || `HTTP ${upstream.status}`}`
      });
    }

    let documentBytes = isValidDocument(rawBytes, format)
      ? rawBytes
      : null;

    if (!documentBytes && json) {
      documentBytes = await resolveDocumentFromJson(json, format);
    }

    if (!documentBytes) {
      const rawText = rawBytes.toString("utf8").trim();
      const directUrl = safeHttpsUrl(rawText);
      if (directUrl) {
        documentBytes = await fetchDocumentUrl(directUrl, format);
      }
    }

    if (documentBytes) {
      return sendDocument(res, key, format, documentBytes);
    }

    const contentType = upstream.headers.get("content-type") || "desconhecido";
    const preview = rawBytes
      .toString("utf8")
      .replace(/\s+/g, " ")
      .slice(0, 320);

    return res.status(502).json({
      sucesso: false,
      mensagem:
        `O Bling respondeu, mas não entregou um ${format.toUpperCase()} válido. ` +
        `Tipo: ${contentType}; ${rawBytes.length} bytes; início: ${preview || "(vazio)"}`,
      diagnostico: {
        content_type: contentType,
        bytes: rawBytes.length,
        preview
      }
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

module.exports = router;
