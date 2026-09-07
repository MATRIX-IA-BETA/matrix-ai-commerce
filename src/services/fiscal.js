const { supabase } = require("../db/supabase");

async function getFiscalSettings() {
  const fallback = {
    default_discount_percent: 0,
    suggest_ml_commission_as_discount: true,
    require_manual_confirmation: false
  };

  const { data, error } = await supabase
    .from("fiscal_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    const msg = String(error.message || "");
    if (/fiscal_settings|does not exist|relation/i.test(msg)) return fallback;
    throw new Error(`Erro lendo configuração fiscal: ${msg}`);
  }

  return data || fallback;
}

function normalizeDiscountType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["value", "valor", "fixed", "amount"].includes(type)) return "value";
  if (["percent", "percentage", "percentual", "%"].includes(type)) return "percent";
  return null;
}

function calculateFiscalPreview({
  grossAmount,
  commissionAmount,
  freightAmount,
  discountPercent,
  discountType,
  discountValue
}) {
  const gross = Math.max(0, Number(grossAmount || 0));
  const commission = Math.max(0, Number(commissionAmount || 0));
  const freight = Math.max(0, Number(freightAmount || 0));

  let type = normalizeDiscountType(discountType);
  let informedValue = Number(discountValue);

  if (!type) {
    type = "percent";
    informedValue = Number(discountPercent || 0);
  }

  if (!Number.isFinite(informedValue)) informedValue = 0;
  informedValue = Math.max(0, informedValue);

  let discountAmount = 0;
  let effectivePercent = 0;

  if (type === "value") {
    discountAmount = Math.min(gross, informedValue);
    effectivePercent = gross > 0 ? (discountAmount / gross) * 100 : 0;
  } else {
    informedValue = Math.min(100, informedValue);
    effectivePercent = informedValue;
    discountAmount = gross * (effectivePercent / 100);
  }

  const fiscalAmount = Math.max(0, gross - discountAmount);
  const operationalNet = gross - commission - freight;

  return {
    gross_amount: Number(gross.toFixed(2)),
    commission_amount: Number(commission.toFixed(2)),
    freight_amount: Number(freight.toFixed(2)),
    operational_net_amount: Number(operationalNet.toFixed(2)),
    discount_type: type,
    discount_value: Number(informedValue.toFixed(type === "percent" ? 4 : 2)),
    discount_amount: Number(discountAmount.toFixed(2)),
    discount_percent: Number(effectivePercent.toFixed(4)),
    fiscal_amount: Number(fiscalAmount.toFixed(2))
  };
}

module.exports = { getFiscalSettings, calculateFiscalPreview };
