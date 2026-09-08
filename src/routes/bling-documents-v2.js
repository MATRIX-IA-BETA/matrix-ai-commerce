const router = require("express").Router();
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
    .subarray(0, Math.min(bytes.length, 500))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();

  return (
    head.startsWith("<?xml") ||
    head.startsWith("<nfeProc") ||
    head.startsWith("<NFe") ||
    head.startsWith("<procNFe")
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
    const preferred = [
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
      if (!preferred.includes(key)) {
        collectStrings(child, out, depth + 1);
      }
    }
  }

  return out;
}

function decodePossibleBase64(value, format) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const dataUri = raw.match(/^data:[^;]+;base64,(.+)$/i);
  const candidate = dataUri ? dataUri[1] : raw;

  if (
    !dataUri &&
    (candidate.length < 80 || !/^[A-Za-z0-9+/=\r\n]+$/.test(candidate))
  ) {
    return null;
  }

  try {
    const bytes = Buffer.from(
      candidate.replace(/\s+/g, ""),
      "base64"
    );
    return isValidDocument(bytes, format) ? bytes : null;
  } catch {
    return null;
  }
}

async function fetchDocumentUrl(url, format) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const response = await fetch(parsed.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: acceptFor(format)
    }
  });

  if (!response.ok) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  return isValidDocument(bytes, format) ? bytes : null;
}

async function resolveDocumentFromJson(json, format) {
  const strings = collectStrings(json);

  // Algumas respostas do Bling podem devolver link assinado/temporário.
  for (const value of strings) {
    if (/^https:\/\//i.test(value.trim())) {
      const bytes = await fetchDocumentUrl(value.trim(), format);
      if (bytes) return bytes;
    }
  }

  // Fallback para conteúdo/base64 dentro do JSON.
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

    // Não salva mais JSON/HTML fingindo ser PDF. Se o Bling não entregar
    // um arquivo real, retorna diagnóstico legível no navegador.
    if (!documentBytes) {
      const contentType =
        upstream.headers.get("content-type") || "desconhecido";
      const preview = rawBytes
        .toString("utf8")
        .replace(/\s+/g, " ")
        .slice(0, 280);

      return res.status(502).json({
        sucesso: false,
        mensagem:
          "O Bling respondeu ao pedido de download, mas não entregou um PDF/XML válido.",
        diagnostico: {
          content_type: contentType,
          bytes: rawBytes.length,
          preview
        }
      });
    }

    res.set({
      "Content-Type": contentTypeFor(format),
      "Content-Disposition": `attachment; filename="NFe-${key}.${format}"`,
      "Content-Length": String(documentBytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });

    return res.send(documentBytes);
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

module.exports = router;
