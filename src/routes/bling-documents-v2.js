const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { blingFetch } = require("../services/bling");

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
  if (depth > 10 || value == null) return out;

  if (typeof value === "string") {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    const preferred = [
      "linkPDF",
      "linkDanfe",
      "linkXml",
      "url",
      "link",
      "href",
      "download",
      "documento",
      "arquivo",
      "pdf",
      "xml",
      "conteudo",
      "content",
      "base64",
      "data"
    ];

    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectStrings(value[key], out, depth + 1);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!preferred.includes(key)) collectStrings(child, out, depth + 1);
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

function decodePossibleHex(value, format) {
  const raw = String(value || "").trim().replace(/\s+/g, "");
  if (raw.length < 100 || raw.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(raw)) {
    return null;
  }

  try {
    const bytes = Buffer.from(raw, "hex");
    return isValidDocument(bytes, format) ? bytes : null;
  } catch {
    return null;
  }
}

function extractUrlsFromText(text) {
  const urls = [];
  const raw = String(text || "");

  const direct = raw.match(/https:\/\/[^\s"'<>]+/gi) || [];
  urls.push(...direct);

  const escaped = raw.match(/https:\\/\\/[^\s"'<>]+/gi) || [];
  for (const value of escaped) {
    urls.push(value.replace(/\\\//g, "/"));
  }

  return [...new Set(urls.map(v => v.replace(/&amp;/g, "&")))];
}

async function fetchDocumentUrl(url, format, depth = 0) {
  if (depth > 3) return null;

  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const response = await fetch(parsed.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: acceptFor(format),
      "User-Agent": "Matrix-AI-Commerce/1.0"
    }
  });

  if (!response.ok) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (isValidDocument(bytes, format)) return bytes;

  const json = tryParseJson(bytes);
  if (json) {
    const resolved = await resolveDocumentFromJson(json, format, depth + 1);
    if (resolved) return resolved;
  }

  const text = bytes.toString("utf8").trim();
  const base64 = decodePossibleBase64(text, format);
  if (base64) return base64;

  const hex = decodePossibleHex(text, format);
  if (hex) return hex;

  for (const nestedUrl of extractUrlsFromText(text)) {
    if (nestedUrl === parsed.toString()) continue;
    const resolved = await fetchDocumentUrl(nestedUrl, format, depth + 1);
    if (resolved) return resolved;
  }

  return null;
}

async function resolveDocumentFromJson(json, format, depth = 0) {
  const strings = collectStrings(json);

  for (const value of strings) {
    const text = String(value || "").trim();
    if (/^https:\/\//i.test(text)) {
      const bytes = await fetchDocumentUrl(text, format, depth + 1);
      if (bytes) return bytes;
    }
  }

  for (const value of strings) {
    const bytes = decodePossibleBase64(value, format);
    if (bytes) return bytes;
  }

  for (const value of strings) {
    const bytes = decodePossibleHex(value, format);
    if (bytes) return bytes;
  }

  return null;
}

async function resolveDocumentFromRaw(rawBytes, format) {
  if (isValidDocument(rawBytes, format)) return rawBytes;

  const json = tryParseJson(rawBytes);
  if (json) {
    const resolved = await resolveDocumentFromJson(json, format);
    if (resolved) return resolved;
  }

  const text = rawBytes.toString("utf8").trim();
  if (!text) return null;

  const base64 = decodePossibleBase64(text, format);
  if (base64) return base64;

  const hex = decodePossibleHex(text, format);
  if (hex) return hex;

  const urls = extractUrlsFromText(text);
  for (const url of urls) {
    const resolved = await fetchDocumentUrl(url, format);
    if (resolved) return resolved;
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
    .select("marketplace_order_id,bling_nfe_id,nfe_access_key,nfe_pdf_url,bling_response")
    .eq("nfe_access_key", key)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Erro lendo NF-e da Matrix: ${error.message}`);
  return data || null;
}

async function getNfeDetail(id) {
  if (!id) return null;

  const response = await blingFetch(
    `/nfe/${encodeURIComponent(String(id))}`,
    { method: "GET" }
  );

  const bytes = Buffer.from(await response.arrayBuffer());
  const json = tryParseJson(bytes);

  if (!response.ok) return null;
  return json || null;
}

async function resolveFromKnownNfe(key, format) {
  const fiscal = await getFiscalDocumentByKey(key);
  if (!fiscal) return null;

  // O GET /nfe/{id} do Bling já retorna linkPDF/linkDanfe com accessKey.
  // Esse é o caminho mais confiável para DANFE de notas antigas emitidas no Bling.
  const candidates = [];
  if (format === "pdf" && fiscal.nfe_pdf_url) {
    candidates.push(fiscal.nfe_pdf_url);
  }

  let detail = null;
  if (fiscal.bling_nfe_id) {
    detail = await getNfeDetail(fiscal.bling_nfe_id);
  }

  if (detail) {
    const d = detail?.data || detail;
    if (format === "pdf") {
      candidates.push(d?.linkPDF, d?.linkDanfe, d?.danfe);
    } else {
      candidates.push(d?.linkXml, d?.xml, d?.linkXML);
    }

    const strings = collectStrings(detail);
    for (const value of strings) {
      const text = String(value || "").trim();
      const lower = text.toLowerCase();
      if (
        /^https:\/\//i.test(text) &&
        (format === "pdf"
          ? /pdf|danfe|document/.test(lower)
          : /xml|document/.test(lower))
      ) {
        candidates.push(text);
      }
    }
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (/^https:\/\//i.test(String(candidate).trim())) {
      const bytes = await fetchDocumentUrl(candidate, format);
      if (bytes) return bytes;
    } else {
      const bytes =
        decodePossibleBase64(candidate, format) ||
        decodePossibleHex(candidate, format);
      if (bytes) return bytes;
    }
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

    // 1) Primeiro tenta os links oficiais devolvidos no detalhe da NF-e.
    // O Bling passou a incluir accessKey em linkPDF/linkDanfe em 2026.
    const knownBytes = await resolveFromKnownNfe(key, format);
    if (knownBytes) return sendDocument(res, key, format, knownBytes);

    // 2) Fallback: endpoint específico de documento por chave.
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

    const documentBytes = await resolveDocumentFromRaw(rawBytes, format);
    if (documentBytes) return sendDocument(res, key, format, documentBytes);

    const contentType = upstream.headers.get("content-type") || "desconhecido";
    const preview = rawBytes
      .toString("utf8")
      .replace(/\s+/g, " ")
      .slice(0, 500);

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
