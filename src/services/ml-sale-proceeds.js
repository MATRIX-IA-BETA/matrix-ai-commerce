const { supabase } = require('../db/supabase');
const { getMercadoLivreAccount, mercadoLivreFetch } = require('./mercadolivre');

const money = value => Number((Number(value) || 0).toFixed(2));

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function pending(breakdown = null, paymentIds = []) {
  return {
    net: null,
    status: 'pending',
    source: null,
    paymentIds,
    breakdown
  };
}

async function getSellerProceeds(orderId) {
  const q = await supabase
    .from('marketplace_orders')
    .select('paid_amount,total_amount,shipping_id,raw_data')
    .eq('marketplace', 'mercadolivre')
    .eq('marketplace_order_id', String(orderId))
    .maybeSingle();

  if (q.error) throw q.error;
  if (!q.data) return pending();

  const order = q.data;
  const raw = order.raw_data || {};
  const items = Array.isArray(raw.order_items) ? raw.order_items : [];
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const paymentIds = [...new Set(payments.map(p => p?.id).filter(Boolean).map(String))];

  if (!items.length) return pending(null, paymentIds);

  // O ML documenta o líquido do pedido como:
  // (unit_price * quantity) - tarifa da venda - custo final de envio do vendedor.
  // sale_fee já vem líquido de promoções/estornos comerciais aplicados à tarifa.
  const gross = items.reduce((sum, item) => {
    const price = Number(item?.unit_price);
    const qty = Number(item?.quantity);
    return sum + (Number.isFinite(price) && Number.isFinite(qty) ? price * qty : 0);
  }, 0);

  if (!(gross > 0) || items.some(item => !Number.isFinite(Number(item?.sale_fee)))) {
    return pending(null, paymentIds);
  }

  const saleFee = money(items.reduce((sum, item) => sum + Math.abs(Number(item.sale_fee)), 0));
  const shippingId = order.shipping_id || raw?.shipping?.id || null;
  let shippingCost = 0;

  if (shippingId) {
    try {
      const account = await getMercadoLivreAccount();
      if (!account) return pending({ gross: money(gross), sale_fee: saleFee }, paymentIds);

      const { response } = await mercadoLivreFetch(
        `/shipments/${encodeURIComponent(String(shippingId))}/costs`,
        account,
        { headers: { 'x-format-new': 'true' } }
      );
      const payload = await readJson(response);

      if (!response.ok) {
        return pending({ gross: money(gross), sale_fee: saleFee }, paymentIds);
      }

      // A API atual retorna `senders` (array), não mais `sender`.
      // O campo `cost` é o custo FINAL pago pelo vendedor; `save` foi depreciado
      // e não deve ser subtraído novamente.
      const senders = Array.isArray(payload?.senders) ? payload.senders : [];
      const sellerId = String(account.user_id || account.account_id || '');
      const sender = senders.find(s => String(s?.user_id ?? '') === sellerId)
        || (senders.length === 1 ? senders[0] : null);
      const cost = Number(sender?.cost);

      if (!Number.isFinite(cost)) {
        return pending({
          gross: money(gross),
          sale_fee: saleFee,
          shipment_id: String(shippingId),
          senders_found: senders.length
        }, paymentIds);
      }

      shippingCost = money(Math.abs(cost));
    } catch (_) {
      return pending({ gross: money(gross), sale_fee: saleFee }, paymentIds);
    }
  }

  const net = money(gross - saleFee - shippingCost);

  return {
    net,
    status: 'reconciled',
    source: 'mercadolivre.order_sale_fee_plus_shipments_senders_cost',
    paymentIds,
    breakdown: {
      gross: money(gross),
      sale_fee: saleFee,
      shipping_cost: shippingCost,
      calculated_net: net
    }
  };
}

module.exports = { getSellerProceeds };
