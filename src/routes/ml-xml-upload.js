const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const MAX_XML_BYTES = 1024 * 1024;

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function extractTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

function extractBlock(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

function extractAccessKey(xml) {
  const fromProtocol = cleanId(extractTag(xml, "chNFe"));
  if (fromProtocol.length === 44) return fromProtocol;

  const infMatch = String(xml || "").match(/<infNFe\b[^>]*\bId=["']NFe(\d{44})["']/i);
  return infMatch ? infMatch[1] : null;
}

function validateXml(xml) {
  const text = String(xml || "").trim();
  if (!text) throw new Error("Selecione um arquivo XML antes de enviar.");
  if (Buffer.byteLength(text, "utf8") > MAX_XML_BYTES) throw new Error("O XML excede o limite de 1 MB.");
  if (!/<nfeProc\b/i.test(text) || !/<NFe\b/i.test(text)) throw new Error("O arquivo não parece ser um XML de NF-e processada (nfeProc/NFe).");
  const model = extractTag(text, "mod");
  if (model && model !== "55") throw new Error(`O Mercado Livre aceita NF-e modelo 55 neste fluxo. Modelo encontrado: ${model}.`);
  return text;
}

function xmlIdentity(xml) {
  const dest = extractBlock(xml, "dest");
  const accessKey = extractAccessKey(xml);
  const number = extractTag(xml, "nNF");
  const series = extractTag(xml, "serie");
  return {
    access_key: accessKey,
    number: number || null,
    series: series || null,
    model: extractTag(xml, "mod") || null,
    amount: extractTag(xml, "vNF") || null,
    recipient_name: extractTag(dest, "xNome") || null,
    recipient_document: cleanId(extractTag(dest, "CNPJ") || extractTag(dest, "CPF")) || null
  };
}

async function readJsonOrText(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return { raw }; }
}

async function marketplaceOrderExists(orderId) {
  const id = cleanId(orderId);
  if (!id) return false;
  const { data, error } = await supabase
    .from("marketplace_orders")
    .select("marketplace_order_id")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", id)
    .limit(1);
  if (error) throw new Error(`Erro consultando pedidos locais: ${error.message}`);
  return Boolean(data?.length);
}

async function findOrderFromXml(xml) {
  const identity = xmlIdentity(xml);

  // 1) Melhor vínculo: chave de acesso gravada quando a NF-e foi emitida.
  if (identity.access_key) {
    const { data, error } = await supabase
      .from("fiscal_documents")
      .select("marketplace_order_id,nfe_access_key,nfe_number,nfe_series,updated_at")
      .eq("nfe_access_key", identity.access_key)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (error) throw new Error(`Erro consultando vínculo fiscal: ${error.message}`);
    const orderId = cleanId(data?.[0]?.marketplace_order_id);
    if (orderId) return { order_id: orderId, source: "nfe_access_key", identity };
  }

  // 2) Fallback: número + série da NF-e, tolerando zeros à esquerda no número.
  if (identity.number) {
    const rawNumber = String(identity.number).trim();
    const normalizedNumber = String(Number(rawNumber));
    const candidates = [...new Set([rawNumber, normalizedNumber].filter(v => v && v !== "NaN"))];
    const { data, error } = await supabase
      .from("fiscal_documents")
      .select("marketplace_order_id,nfe_number,nfe_series,updated_at")
      .in("nfe_number", candidates)
      .order("updated_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(`Erro consultando número da NF-e: ${error.message}`);

    const wantedSeries = String(Number(identity.series || 0));
    const match = (data || []).find(row => {
      const rowNumber = String(Number(row?.nfe_number));
      const rowSeries = String(Number(row?.nfe_series || 0));
      return rowNumber === normalizedNumber && (!identity.series || rowSeries === wantedSeries);
    });
    const orderId = cleanId(match?.marketplace_order_id);
    if (orderId) return { order_id: orderId, source: "nfe_number_series", identity };
  }

  // 3) Algumas integrações gravam o número do pedido em observações do XML.
  const embedded = [...new Set(String(xml).match(/\b2000\d{12}\b/g) || [])];
  for (const candidate of embedded) {
    if (await marketplaceOrderExists(candidate)) {
      return { order_id: candidate, source: "xml_order_reference", identity };
    }
  }

  throw new Error(
    `Não consegui localizar automaticamente o pedido referente à NF-e${identity.number ? ` ${identity.number}` : ""}. ` +
    "A Matrix tentou pela chave de acesso, número/série e referência de pedido dentro do XML."
  );
}

async function loadOrderContext(orderId, account) {
  const safeOrderId = cleanId(orderId);
  if (!safeOrderId) throw new Error("Número do pedido inválido.");

  const orderResult = await mercadoLivreFetch(`/orders/${encodeURIComponent(safeOrderId)}`, account);
  const order = await orderResult.response.json().catch(() => ({}));
  if (!orderResult.response.ok) throw new Error(`Não consegui consultar o pedido no Mercado Livre: ${order?.message || order?.error || orderResult.response.status}`);

  const shipmentId = cleanId(order?.shipping?.id);
  if (!shipmentId) throw new Error("Este pedido não possui shipment_id para envio da NF-e.");

  const shipmentResult = await mercadoLivreFetch(`/shipments/${encodeURIComponent(shipmentId)}`, account, { headers: { "x-format-new": "true" } });
  const shipment = await shipmentResult.response.json().catch(() => ({}));
  if (!shipmentResult.response.ok) throw new Error(`Não consegui consultar o envio no Mercado Livre: ${shipment?.message || shipment?.error || shipmentResult.response.status}`);

  let invoice = null;
  const invoiceResult = await mercadoLivreFetch(`/shipments/${encodeURIComponent(shipmentId)}/invoice_data?siteId=MLB`, account);
  if (invoiceResult.response.ok) {
    invoice = await invoiceResult.response.json().catch(() => null);
  } else if (invoiceResult.response.status !== 404) {
    const detail = await invoiceResult.response.json().catch(() => ({}));
    const message = String(detail?.message || detail?.error || "");
    if (!/not.?found|invoice.*not/i.test(message)) throw new Error(`Não consegui consultar a NF-e já enviada: ${message || invoiceResult.response.status}`);
  }

  const orderItems = Array.isArray(order?.order_items) ? order.order_items : [];
  const buyer = order?.buyer || {};
  return {
    order_id: safeOrderId,
    shipment_id: shipmentId,
    order_status: order?.status || null,
    paid_amount: order?.paid_amount ?? null,
    buyer_name: [buyer?.first_name, buyer?.last_name].filter(Boolean).join(" ").trim() || buyer?.nickname || null,
    product_title: orderItems.map(line => line?.item?.title).filter(Boolean).join(" + ") || null,
    shipment_status: shipment?.status || null,
    shipment_substatus: shipment?.substatus || null,
    logistic_type: shipment?.logistic_type || shipment?.shipping_option?.logistic_type || null,
    invoice: invoice && typeof invoice === "object" ? {
      id: invoice?.id ?? null,
      status: invoice?.status || null,
      fiscal_key: invoice?.fiscal_key || null,
      invoice_number: invoice?.invoice_number || null,
      invoice_serie: invoice?.invoice_serie || null,
      invoice_amount: invoice?.invoice_amount ?? null
    } : null
  };
}

router.post("/api/ml/xml-upload/identify", async (req, res) => {
  try {
    const xml = validateXml(req.body?.xml);
    const match = await findOrderFromXml(xml);
    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });
    const context = await loadOrderContext(match.order_id, account);
    res.json({
      sucesso: true,
      ...context,
      modo: context.invoice?.id ? "update" : "new",
      xml: match.identity,
      localizado_por: match.source
    });
  } catch (error) {
    res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

// Mantida por compatibilidade com links antigos, mas a tela nova não exige o pedido.
router.get("/api/ml/xml-upload/order/:orderId", async (req, res) => {
  try {
    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });
    const context = await loadOrderContext(req.params.orderId, account);
    res.json({ sucesso: true, ...context, modo: context.invoice?.id ? "update" : "new" });
  } catch (error) {
    res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/ml/xml-upload/send", async (req, res) => {
  try {
    const xml = validateXml(req.body?.xml);
    const match = await findOrderFromXml(xml);
    const orderId = match.order_id;

    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });
    const context = await loadOrderContext(orderId, account);

    const cancelled = String(context.order_status || "").toLowerCase() === "cancelled" || (context.paid_amount != null && Number(context.paid_amount) === 0);
    if (cancelled) return res.status(409).json({ sucesso: false, mensagem: "A venda está cancelada. O XML não será enviado." });

    let path;
    let method;
    if (context.invoice?.id) {
      path = `/shipment_invoice/${encodeURIComponent(context.invoice.id)}/?siteId=MLB`;
      method = "PUT";
    } else {
      if (context.shipment_status !== "ready_to_ship" || context.shipment_substatus !== "invoice_pending") {
        return res.status(409).json({ sucesso: false, mensagem: `O envio não está aguardando NF-e. Status atual: ${context.shipment_status || "-"} / ${context.shipment_substatus || "-"}.` });
      }
      path = `/shipments/${encodeURIComponent(context.shipment_id)}/invoice_data/?siteId=MLB`;
      method = "POST";
    }

    const result = await mercadoLivreFetch(path, account, {
      method,
      headers: { "Content-Type": "application/xml", Accept: "application/json" },
      body: xml
    });
    const data = await readJsonOrText(result.response);
    if (!result.response.ok) {
      return res.status(result.response.status).json({ sucesso: false, mensagem: data?.message || data?.error || data?.raw || `Mercado Livre recusou o XML (${result.response.status}).`, detalhe_ml: data });
    }

    let refreshed = null;
    try { refreshed = await loadOrderContext(orderId, account); } catch (_) {}
    res.json({
      sucesso: true,
      order_id: orderId,
      localizado_por: match.source,
      modo: method === "PUT" ? "update" : "new",
      mensagem: method === "PUT" ? "XML atualizado no Mercado Livre com sucesso." : "XML enviado ao Mercado Livre com sucesso.",
      resultado_ml: data,
      contexto: refreshed
    });
  } catch (error) {
    res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
