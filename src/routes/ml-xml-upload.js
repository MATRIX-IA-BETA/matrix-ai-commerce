const router = require("express").Router();
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const MAX_XML_BYTES = 1024 * 1024;

function cleanId(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function extractTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : null;
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

async function readJsonOrText(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return { raw }; }
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
    const orderId = cleanId(req.body?.order_id);
    const xml = validateXml(req.body?.xml);
    if (!orderId) return res.status(400).json({ sucesso: false, mensagem: "Informe o número do pedido." });

    const account = await getMercadoLivreAccount();
    if (!account) return res.status(404).json({ sucesso: false, mensagem: "Conta Mercado Livre não conectada." });
    const context = await loadOrderContext(orderId, account);

    if (String(context.order_status || "").toLowerCase() === "cancelled" || Number(context.paid_amount) === 0) {
      return res.status(409).json({ sucesso: false, mensagem: "A venda está cancelada. O XML não será enviado." });
    }

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
    res.json({ sucesso: true, modo: method === "PUT" ? "update" : "new", mensagem: method === "PUT" ? "XML atualizado no Mercado Livre com sucesso." : "XML enviado ao Mercado Livre com sucesso.", resultado_ml: data, contexto: refreshed });
  } catch (error) {
    res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
