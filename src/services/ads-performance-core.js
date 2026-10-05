// Pure calculations: money/counts are summed before rates are calculated.
const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function shift(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function monday(date) { const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); return shift(date, -((weekday + 6) % 7)); }
function empty() { return { orders: 0, revenue: 0, spend: 0, attributed_revenue: 0, attributed_units: 0, attributed_orders: 0, clicks: 0, impressions: 0, organic_promoted_revenue: 0 }; }
function add(target, source) { for (const key of Object.keys(empty())) target[key] += number(source[key]); return target; }
function metrics(row) {
  const ratio = (a, b, multiplier = 1, digits = 2) => b > 0 ? round(a / b * multiplier, digits) : null;
  return { ...row, revenue: round(row.revenue), spend: round(row.spend), attributed_revenue: round(row.attributed_revenue), organic_promoted_revenue: round(row.organic_promoted_revenue),
    ticket: ratio(row.revenue, row.orders), roas: ratio(row.attributed_revenue, row.spend), acos: ratio(row.spend, row.attributed_revenue, 100), tacos: ratio(row.spend, row.revenue, 100),
    ctr: ratio(row.clicks, row.impressions, 100, 3), cpc: ratio(row.spend, row.clicks), cvr: ratio(row.attributed_units, row.clicks, 100), attributed_share: ratio(row.attributed_revenue, row.revenue, 100),
    non_attributed_difference: round(row.revenue - row.attributed_revenue) };
}
function buildPerformance({ orders = [], ads = [], dateFrom, dateTo, now = new Date() }) {
  const today = localDate(now), dates = new Map();
  function day(date) { if (!dates.has(date)) dates.set(date, { date, ...empty(), ads_rows: 0, campaigns: new Set(), updated: [] }); return dates.get(date); }
  for (const order of orders) {
    const date = localDate(order.date_created);
    if (!date || String(order.status).toLowerCase() === 'cancelled') continue;
    const row = day(date); row.orders++; row.revenue += number(order.total_amount);
  }
  // Defend against accidental repeated rows from a join or a retried page.
  const seen = new Set(), campaignLatest = new Map();
  const uniqueAds = [];
  for (const ad of ads) {
    const key = `${ad.account_id}:${ad.advertiser_id}:${ad.campaign_id}:${ad.date}`;
    if (seen.has(key)) continue;
    seen.add(key); uniqueAds.push(ad);
    const row = day(ad.date); row.ads_rows++; row.campaigns.add(String(ad.campaign_id)); if (ad.updated_at) row.updated.push(ad.updated_at);
    add(row, { spend: ad.spend, attributed_revenue: ad.attributed_revenue, attributed_units: ad.attributed_units, attributed_orders: ad.attributed_orders,
      clicks: ad.clicks, impressions: ad.impressions, organic_promoted_revenue: ad.organic_units_amount });
    const old = campaignLatest.get(String(ad.campaign_id));
    if (!old || ad.date >= old.date) campaignLatest.set(String(ad.campaign_id), ad);
  }
  const alertTo = dateTo < today ? dateTo : shift(today, -1), alertFrom = shift(alertTo, -6), baselineFrom = shift(alertFrom, -30), baselineTo = shift(alertFrom, -1);
  function period(from, to) {
    const sum = empty(); let covered = 0; const updates = [];
    for (let date = from; date <= to; date = shift(date, 1)) {
      const row = dates.get(date); if (!row) continue; add(sum, row); if (row.ads_rows) covered++; updates.push(...row.updated);
    }
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
    const earliest = updates.length ? updates.reduce((a, b) => a < b ? a : b) : null;
    return { ...metrics(sum), date_from: from, date_to: to, days, ads_days: covered, ads_complete: covered === days, oldest_update: earliest };
  }
  const weekly = [];
  for (let start = monday(dateFrom); start <= dateTo; start = shift(start, 7)) {
    const from = start < dateFrom ? dateFrom : start, end = shift(start, 6), to = end > dateTo ? dateTo : end;
    const row = period(from, to); row.week_start = start; row.week_end = end; row.partial = from !== start || to !== end || to >= today;
    const previous = weekly.at(-1);
    row.revenue_change = !row.partial && previous && !previous.partial && previous.revenue > 0 ? round((row.revenue / previous.revenue - 1) * 100, 1) : null;
    weekly.push(row);
  }
  const recent = period(alertFrom, alertTo);
  const expectedCampaigns = new Map();
  for (const ad of uniqueAds) {
    const id = String(ad.campaign_id);
    if (!expectedCampaigns.has(id) || ad.date < expectedCampaigns.get(id)) expectedCampaigns.set(id, ad.date);
  }
  let missingCampaignDays = 0;
  for (let date = alertFrom; date <= alertTo; date = shift(date, 1)) {
    for (const [id, firstDate] of expectedCampaigns) if (firstDate <= date && !dates.get(date)?.campaigns.has(id)) missingCampaignDays++;
  }
  recent.missing_campaign_days = missingCampaignDays;
  recent.ads_complete = recent.ads_complete && missingCampaignDays === 0;
  const baseline = period(baselineFrom, baselineTo), campaigns = [];
  for (const [id, latest] of campaignLatest) {
    const sum = empty();
    for (const ad of uniqueAds) if (String(ad.campaign_id) === id && ad.date >= alertFrom && ad.date <= alertTo) add(sum, { spend: ad.spend, attributed_revenue: ad.attributed_revenue, attributed_units: ad.attributed_units, clicks: ad.clicks, impressions: ad.impressions });
    campaigns.push({ id, name: latest.campaign_name || id, target: number(latest.roas_target) || null, ...metrics(sum) });
  }
  const withTarget = campaigns.filter(c => c.target > 0 && c.spend > 0);
  const targetSpend = withTarget.reduce((sum, c) => sum + c.spend, 0);
  const target = targetSpend > 0 ? round(withTarget.reduce((sum, c) => sum + c.spend * c.target, 0) / targetSpend) : null;
  const stale = !recent.oldest_update || Date.parse(now) - Date.parse(recent.oldest_update) > 2 * 3600000;
  const enough = recent.clicks >= 100;
  const baseUsable = baseline.ads_complete && baseline.tacos > 0;
  const alerts = [];
  const put = (metric, status, value, message) => alerts.push({ metric, status, value, message });
  const usable = recent.ads_complete && !stale;
  if (!usable) put('dados', 'warning', recent.ads_days, `Histórico ${recent.ads_days}/7 dias; ${stale ? 'há registros sem atualização há mais de 2 horas' : `faltam dias/campanhas de Ads (${missingCampaignDays} combinações)`}. Sem sinal verde até atualizar.`);
  const classify = (value, green, yellow, higher = true) => value == null || !usable || !enough ? 'unknown' : higher ? (value >= green ? 'good' : value >= yellow ? 'warning' : 'bad') : (value <= green ? 'good' : value <= yellow ? 'warning' : 'bad');
  put('ROAS', target ? classify(recent.roas, target, target * .8) : 'unknown', recent.roas, target ? `Alvo ponderado por investimento: ${target}x; amarelo entre 80% e 100% do alvo.` : 'Sem alvo de campanha disponível.');
  put('CVR', classify(recent.cvr, 1.3, 1), recent.cvr, 'Unidades atribuídas / cliques: ≥1,7% forte; 1,3–1,7% normal; 1–1,3% atenção; <1% crítico.');
  put('TACOS', baseUsable ? classify(recent.tacos, baseline.tacos * 1.2, baseline.tacos * 1.5, false) : 'unknown', recent.tacos, baseUsable ? `Referência dos 30 dias anteriores: ${baseline.tacos}%; amarelo acima de +20%, vermelho acima de +50%.` : 'Referência anterior incompleta; sem classificação de TACOS.');
  if (!enough) put('amostra', 'unknown', recent.clicks, 'Menos de 100 cliques nos 7 dias; amostra insuficiente para recomendar escala.');
  const state = alerts.some(a => a.status === 'bad') ? 'bad' : alerts.some(a => a.status === 'warning') ? 'warning' : alerts.some(a => a.status === 'unknown') ? 'unknown' : 'good';
  return { generated_at: new Date(now).toISOString(), timezone: 'America/Sao_Paulo', range: { dateFrom, dateTo }, totals: period(dateFrom, dateTo), weekly, recent, baseline, campaigns, alerts, status: state, roas_target: target,
    recommendation: state === 'bad' ? 'Segurar aumentos de verba e investigar conversão e oferta.' : state === 'warning' ? 'Acompanhar a causa do alerta antes de ampliar investimento.' : state === 'unknown' ? 'Completar dados e amostra antes de decidir escala.' : recent.cvr >= 1.7 ? 'Indicadores favoráveis para avaliar aumento gradual de verba, junto com margem e estoque.' : 'Manter acompanhamento: conversão na faixa normal.',
    methodology: ['Cancelamentos excluídos. Faturamento bruto dos pedidos por data de criação; devoluções e custos não são descontados.', 'Semanas de segunda a domingo no horário de Brasília; períodos parciais identificados.', 'ROAS, ACOS, CTR, CPC e CVR recalculados sobre somas; CVR usa unidades atribuídas / cliques.', 'TACOS usa todo o faturamento ML. Receita orgânica reportada pelo Ads cobre apenas publicações promovidas.', 'Faturamento menos receita atribuída é apenas diferença contábil; não identifica pedidos orgânicos nem efeito incremental da publicidade.', 'Alertas usam os últimos 7 dias completos. São critérios operacionais, não prova de lucro ou autorização automática para mudar campanhas.'] };
}
module.exports = { localDate, shift, monday, metrics, buildPerformance };
