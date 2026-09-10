const router = require("express").Router();
const { supabase } = require("../db/supabase");

const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));

router.post("/api/finance/liabilities/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Obrigação inválida." });
    }

    const { data: account, error: accountError } = await supabase
      .from("financial_accounts")
      .select("id,name,category,account_type,current_balance,active")
      .eq("id", id)
      .single();
    if (accountError) throw new Error(accountError.message);
    if (account.account_type !== "liability") {
      return res.status(400).json({ sucesso: false, mensagem: "A conta selecionada não é um passivo." });
    }

    const current = money(Math.max(0, n(account.current_balance)));
    if (current <= 0) {
      return res.json({ sucesso: true, mensagem: "Obrigação já está quitada.", novo_saldo: 0, valor_pago: 0 });
    }

    const full = req.body?.pay_full === true;
    const requested = full ? current : money(Math.abs(n(req.body?.amount)));
    if (requested <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Informe um valor de pagamento maior que zero." });
    }

    const paid = money(Math.min(current, requested));
    const newBalance = money(current - paid);
    const occurredAt = req.body?.occurred_at || new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("financial_accounts")
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("current_balance", account.current_balance)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    if (!updated?.length) {
      return res.status(409).json({ sucesso: false, mensagem: "O saldo dessa obrigação mudou. Atualize a tela e tente novamente." });
    }

    const { error: entryError } = await supabase.from("financial_entries").insert({
      account_id: id,
      entry_type: "adjustment",
      amount: paid,
      description: full ? `Quitação: ${account.name}` : `Pagamento parcial: ${account.name}`,
      source: "liability_payment",
      reference_type: "liability_payment",
      reference_id: String(id),
      occurred_at: occurredAt,
      metadata: {
        signed_delta: -paid,
        previous_balance: current,
        new_balance: newBalance,
        payment_mode: full ? "full" : "partial",
        bank_balance_managed_by_open_finance: true
      }
    });
    if (entryError) console.error("[Financeiro] obrigação baixada, mas falhou log:", entryError.message);

    res.json({
      sucesso: true,
      mensagem: newBalance === 0 ? "Obrigação quitada." : "Pagamento parcial registrado.",
      valor_pago: paid,
      novo_saldo: newBalance
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
