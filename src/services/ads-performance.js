const { supabase } = require('../db/supabase');
const { getMercadoLivreAccount } = require('./mercadolivre');
const { syncAdsDaily } = require('./mercado-ads');
const { localDate, shift, buildPerformance } = require('./ads-performance-core');
const syncState = { running: false, last_success: null, last_error: null, records_saved: null, interval_minutes: 60 };
let inFlight = null;
async function refreshAdsPerformance() {
  if (inFlight) return inFlight;
  syncState.running = true;
  inFlight = (async () => {
    try {
      const today = localDate(new Date());
      const result = await syncAdsDaily({ dateFrom: shift(today, -89), dateTo: today });
      if (!result.records_saved) throw new Error('Sincronização retornou zero registros; histórico não confirmado.');
      syncState.last_success = new Date().toISOString(); syncState.records_saved = result.records_saved; syncState.last_error = null;
      return result;
    } catch (error) { syncState.last_error = error.message; throw error; }
    finally { syncState.running = false; inFlight = null; }
  })();
  return inFlight;
}
function startAdsPerformanceSync() {
  if (process.env.MATRIX_ADS_AUTO_SYNC === 'false') return;
  const run = () => refreshAdsPerformance().then(r => console.log(`Ads automático: ${r.records_saved} registros`)).catch(e => console.error('Ads automático:', e.message));
  setTimeout(run, 30000).unref();
  setInterval(run, 3600000).unref();
}
async function paged(factory) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await factory().range(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 500) return rows;
    if (rows.length >= 100000) throw new Error('Volume acima do limite de análise; refine o período.');
  }
}
async function getAdsPerformance({ days = 60 } = {}) {
  const safeDays = Math.max(7, Math.min(90, Math.floor(Number(days) || 60)));
  const today = localDate(new Date()), dateFrom = shift(today, -safeDays + 1), historyFrom = dateFrom < shift(today, -37) ? dateFrom : shift(today, -37);
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error('Nenhuma conta Mercado Livre conectada.');
  const accountId = String(account.account_id || account.user_id);
  const [orders, ads] = await Promise.all([
    paged(() => supabase.from('marketplace_orders').select('id,status,total_amount,date_created').eq('marketplace', 'mercadolivre').eq('account_id', accountId).gte('date_created', `${historyFrom}T00:00:00-03:00`).lt('date_created', `${shift(today, 1)}T00:00:00-03:00`).order('date_created').order('id')),
    paged(() => supabase.from('marketplace_ads_daily').select('id,account_id,advertiser_id,date,campaign_id,campaign_name,spend,attributed_revenue,attributed_orders,attributed_units,clicks,impressions,roas_target,organic_units_amount,updated_at').eq('marketplace', 'mercadolivre').eq('account_id', accountId).eq('level', 'campaign').gte('date', historyFrom).lte('date', today).order('date').order('id'))
  ]);
  const result = buildPerformance({ orders, ads, dateFrom, dateTo: today });
  return { ...result, sync: { ...syncState } };
}
module.exports = { getAdsPerformance, refreshAdsPerformance, startAdsPerformanceSync, paged };
