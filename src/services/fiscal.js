const { supabase } = require("../db/supabase");

async function getFiscalSettings() {
  const { data, error } = await supabase
    .from("fiscal_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(`Erro lendo configuração fiscal: ${error.message}`);

  return data || {
    default_discount_percent: 0,
    suggest_ml_commission_as_discount: true,
    require_manual_confirmation: true
  };
}

function calculateFiscalPreview({ grossAmount, commissionAmount, freightAmount, discountPercent }) {
  const gross = Number(grossAmount || 0);
  const commission = Number(commissionAmount || 0);
  const freight = Number(freightAmount || 0);
  const discount = Number(discountPercent || 0);
  const fiscalAmount = Math.max(0, gross * (1 - discount / 100));
  const operationalNet = gross - commission - freight;

  return {
    gross_amount: Number(gross.toFixed(2)),
    commission_amount: Number(commission.toFixed(2)),
    freight_amount: Number(freight.toFixed(2)),
    operational_net_amount: Number(operationalNet.toFixed(2)),
    discount_percent: Number(discount.toFixed(4)),
    fiscal_amount: Number(fiscalAmount.toFixed(2))
  };
}


module.exports = { getFiscalSettings, calculateFiscalPreview };
