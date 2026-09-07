const { supabase } = require("../db/supabase");

async function getFiscalSettings() {
  const { data, error } = await supabase.from("fiscal_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Erro lendo configuração fiscal: ${error.message}`);
  return data || { default_discount_percent: 0, suggest_ml_commission_as_discount: true, require_manual_confirmation: false };
}

function normalizeDiscountType(v) {
  v=String(v||"").toLowerCase();
  if (["value","valor","fixed","amount"].includes(v)) return "value";
  if (["percent","percentage","percentual","%"].includes(v)) return "percent";
  return null;
}

function calculateFiscalPreview({ grossAmount, commissionAmount, freightAmount, discountPercent, discountType, discountValue }) {
  const gross=Math.max(0,Number(grossAmount||0)), commission=Math.max(0,Number(commissionAmount||0)), freight=Math.max(0,Number(freightAmount||0));
  let type=normalizeDiscountType(discountType), value=Number(discountValue);
  if (!type) { type="percent"; value=Number(discountPercent||0); }
  if (!Number.isFinite(value)) value=0;
  value=Math.max(0,value);
  let amount, percent;
  if (type==="value") {
    amount=Math.min(gross,value);
    percent=gross>0 ? amount/gross*100 : 0;
  } else {
    value=Math.min(100,value);
    percent=value;
    amount=gross*percent/100;
  }
  return {
    gross_amount:+gross.toFixed(2), commission_amount:+commission.toFixed(2), freight_amount:+freight.toFixed(2),
    operational_net_amount:+(gross-commission-freight).toFixed(2),
    discount_type:type, discount_value:+value.toFixed(type==="percent"?4:2),
    discount_amount:+amount.toFixed(2), discount_percent:+percent.toFixed(4),
    fiscal_amount:+Math.max(0,gross-amount).toFixed(2)
  };
}
module.exports = { getFiscalSettings, calculateFiscalPreview };
