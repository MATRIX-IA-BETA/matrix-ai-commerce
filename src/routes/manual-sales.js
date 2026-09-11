const router = require('express').Router();
const { supabase } = require('../db/supabase');

router.get('/sales/manual', async (req, res) => {
  try {
    const { data, error } = await supabase.from('manual_sales').select('*').order('sale_date', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ sucesso: true, vendas: data || [] });
  } catch (e) {
    res.status(500).json({ sucesso: false, mensagem: e.message });
  }
});

module.exports = router;
