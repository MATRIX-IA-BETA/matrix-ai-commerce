(() => {
  'use strict';
  const host = document.createElement('section');
  host.className = 'card'; host.id = 'adsPerformance'; host.setAttribute('aria-label', 'Vendas e Ads por semana');
  document.querySelector('.grid2').before(host);
  const style = document.createElement('style');
  style.textContent = '#adsPerformance{margin-top:14px}#adsPerformance .performance-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin:12px 0}#adsPerformance .performance-value{font-size:22px;font-weight:800;margin-top:6px}#adsPerformance .performance-alerts{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:8px;margin:12px 0}.performance-badge{display:inline-flex;gap:5px;align-items:center;font-weight:700;padding:4px 8px;border-radius:6px;background:#26364b}.performance-badge.good{color:#64e8ad;background:#0e3428}.performance-badge.warning{color:#ffd66d;background:#302810}.performance-badge.bad{color:#ff8798;background:#30151e}.performance-badge.unknown{color:#b8c7dc}.performance-notes{font-size:12px;line-height:1.6;color:#9db4d2;margin-top:12px}#adsPerformance summary{cursor:pointer}#adsPerformance td small{display:block;color:#9db4d2;margin-top:4px}@media(max-width:700px){#adsPerformance .performance-summary,#adsPerformance .performance-alerts{grid-template-columns:repeat(2,minmax(0,1fr))}#adsPerformance .table-head{align-items:flex-start;gap:10px;flex-direction:column}}';
  document.head.append(style);
  const escape = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = x => x == null ? '—' : new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'}).format(x);
  const pct = x => x == null ? '—' : Number(x).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) + '%';
  const roas = x => x == null ? '—' : Number(x).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) + 'x';
  const count = x => Number(x || 0).toLocaleString('pt-BR');
  const date = x => x ? x.slice(8,10)+'/'+x.slice(5,7) : '—';
  const stamp = x => x ? new Date(x).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}) : 'ainda não concluída';
  const labels = {good:'Verde · saudável',warning:'Amarelo · atenção',bad:'Vermelho · crítico',unknown:'Sem avaliação'};
  const badge = status => `<span class="performance-badge ${status}">${labels[status] || labels.unknown}</span>`;
  let busy = false, requestId = 0;
  function render(data) {
    const total = data.totals, recent = data.recent, sync = data.sync;
    const tile = (label, value, note) => `<div class="card"><div class="muted">${label}</div><div class="performance-value">${value}</div><small class="muted">${note}</small></div>`;
    const weeklyRows = data.weekly.map(w => `<tr><td><b>${date(w.week_start)}–${date(w.week_end)}</b>${w.partial ? `<small>Parcial / em andamento · dados ${date(w.date_from)}–${date(w.date_to)}</small>` : '<small>Segunda a domingo</small>'}</td><td class="num">${count(w.orders)}</td><td class="num">${money(w.revenue)}</td><td class="num">${money(w.ticket)}</td><td class="num">${w.revenue_change == null ? '—' : (w.revenue_change>0?'+':'')+pct(w.revenue_change)}</td><td class="num">${money(w.spend)}</td><td class="num">${money(w.attributed_revenue)}</td><td class="num">${roas(w.roas)}</td><td class="num">${pct(w.acos)}</td><td class="num">${pct(w.tacos)}</td><td class="num">${pct(w.ctr)}</td><td class="num">${money(w.cpc)}</td><td class="num">${pct(w.cvr)}</td><td class="num">${count(w.attributed_units)}</td><td class="num">${pct(w.attributed_share)}</td><td>${w.ads_days}/${w.days} dias${w.ads_complete?'':' · incompleto'}</td></tr>`).join('');
    const status = sync.last_error ? 'warning' : data.status;
    host.innerHTML = `<div class="table-head"><div><h2>Vendas + Ads · semana a semana</h2><span>Segunda a domingo · Brasília · ${date(data.range.dateFrom)} a ${date(data.range.dateTo)}</span></div>${badge(status)}</div>
      <div class="performance-summary">${tile('Faturamento ML',money(total.revenue),count(total.orders)+' pedidos · cancelamentos excluídos')}${tile('Investimento Ads',money(total.spend),'Histórico: '+total.ads_days+'/'+total.days+' dias')}${tile('ROAS do período',roas(total.roas),'Receita atribuída: '+money(total.attributed_revenue))}${tile('TACOS da loja',pct(total.tacos),'Ads / faturamento total ML')}</div>
      <div class="section-title"><div><h2>Semáforo dos 7 dias completos</h2><span>${date(recent.date_from)}–${date(recent.date_to)} · ${count(recent.clicks)} cliques · exclui o dia de hoje</span></div></div>
      <div class="performance-alerts">${data.alerts.map(a=>`<div class="insight ${a.status==='good'?'good':a.status==='bad'?'bad':a.status==='warning'?'warn':''}"><b>${escape(a.metric)}</b> ${badge(a.status)}<div class="performance-value">${a.metric==='ROAS'?roas(a.value):['CVR','TACOS'].includes(a.metric)?pct(a.value):count(a.value)}</div><div>${escape(a.message)}</div></div>`).join('')}</div>
      <div class="insight">${escape(sync.last_error ? "Resolver a atualização dos dados antes de avaliar aumento de verba." : data.recommendation)}</div>
      ${sync.last_error?`<div class="insight warn">Falha na atualização automática: ${escape(sync.last_error)}. Os números exibidos são o histórico disponível; a atualização será tentada novamente.</div>`:''}
      <div class="performance-notes">Atualização da tela: ${stamp(data.generated_at)} · Ads automático a cada ${sync.interval_minutes} min${sync.running?' · sincronizando agora':''} · última execução automática: ${stamp(sync.last_success)}.</div>
      <div class="scroll" style="margin-top:14px"><table><thead><tr><th>Semana</th><th class="num">Pedidos</th><th class="num">Faturamento ML</th><th class="num">Ticket</th><th class="num">Δ faturamento</th><th class="num">Ads</th><th class="num">Receita atribuída</th><th class="num">ROAS</th><th class="num">ACOS</th><th class="num">TACOS loja</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">CVR*</th><th class="num">Unid. Ads</th><th class="num">Atribuída / ML</th><th>Histórico Ads</th></tr></thead><tbody>${weeklyRows}</tbody></table></div>
      <details class="performance-notes"><summary>Campanhas nos últimos 7 dias completos</summary><div class="scroll"><table style="min-width:700px"><thead><tr><th>Campanha</th><th class="num">Ads</th><th class="num">Receita atribuída</th><th class="num">ROAS</th><th class="num">Alvo atual</th><th class="num">CVR*</th><th>Leitura ROAS</th></tr></thead><tbody>${data.campaigns.map(c=>{const s = !recent.ads_complete || data.alerts.some(a=>a.metric==='dados') || c.clicks<100 || !c.target ? 'unknown' : c.roas>=c.target?'good':c.roas>=c.target*.8?'warning':'bad';return `<tr><td>${escape(c.name)}</td><td class="num">${money(c.spend)}</td><td class="num">${money(c.attributed_revenue)}</td><td class="num">${roas(c.roas)}</td><td class="num">${roas(c.target)}</td><td class="num">${pct(c.cvr)}</td><td>${badge(s)}</td></tr>`}).join('')}</tbody></table></div></details>
      <details class="performance-notes"><summary>Como ler os números e alertas</summary>${data.methodology.map(x=>`<p>${escape(x)}</p>`).join('')}<p>*CVR usa unidades atribuídas, conforme o relatório anterior; não representa compradores únicos. Valores sem denominador aparecem como —. Receita atribuída pode superar faturamento do recorte por diferenças de atribuição e data.</p><p>Os alertas aparecem neste painel. Orçamentos e campanhas continuam sob decisão humana.</p></details>`;
  }
  async function load() {
    if (busy) return;
    busy = true; const id = ++requestId, days = document.getElementById('days').value;
    if (!host.children.length) host.innerHTML = '<div class="muted" role="status">Cruzando vendas e Ads...</div>';
    try {
      const response = await fetch('/api/ads/performance?days='+encodeURIComponent(days), {cache:'no-store'});
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.mensagem || 'Não foi possível carregar o cruzamento.');
      if (id === requestId && days === document.getElementById('days').value) render(data);
    } catch (error) { host.innerHTML = '<div class="insight bad" role="alert">Falha ao atualizar vendas + Ads: '+escape(error.message)+'</div>'; }
    finally { busy = false; if (days !== document.getElementById('days').value) load(); }
  }
  window.addEventListener('matrix:ads-loaded', load);
  document.getElementById('days').addEventListener('change', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 300000);
  load();
})();
