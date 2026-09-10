(()=>{
  let syncingMl = false;
  let lastMlSync = 0;
  let mpConnected = false;

  const $ = id => document.getElementById(id);
  const brl = value => Number(value || 0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
  const esc = value => String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const parseMoney = value => Number(String(value ?? '').replace(/\./g,'').replace(',','.'));

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache:'no-store',
      ...options,
      headers:{
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.sucesso === false) {
      const error = new Error(data.mensagem || `Falha HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function ensureStyle(){
    if ($('financeEnhancementsStyle')) return;
    const style = document.createElement('style');
    style.id = 'financeEnhancementsStyle';
    style.textContent = `
      .source.ml-held{border-color:#725324;background:linear-gradient(180deg,#2b210d,#15170f)}
      .source.ml-held .dot{background:#ffd34d}
      .liability-manager{margin-top:12px}
      .liability-manager .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
      .liability-manager .head h2{margin:0;font-size:16px}
      .liability-manager .head small{color:#8fa4c3}
      .liability-actions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
      .mini-btn{border:1px solid #315078;background:#13243e;color:#fff;border-radius:8px;padding:6px 8px;font-size:11px;font-weight:800;cursor:pointer}
      .mini-btn.good{background:#17684d;border-color:#2aa879}
      .mini-btn.warn{background:#5b4218;border-color:#9b762c}
      .mini-btn.auth{margin-top:7px;background:#1d65cb;border-color:#4690ff;width:100%}
      .mini-btn:disabled{opacity:.45;cursor:not-allowed}
      .paid-badge{display:inline-flex;padding:4px 7px;border-radius:999px;background:#103126;border:1px solid #236d51;color:#8bf0c4;font-size:11px;font-weight:800}
      .ml-sync-note{color:#8fa4c3;font-size:11px;margin-top:4px}
      @media(min-width:1400px){.sources{grid-template-columns:repeat(7,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function ensureMlHeldCard(){
    const mlValue = $('srcMl');
    if (!mlValue) return null;
    const card = mlValue.closest('.source');
    if (!card) return null;

    const labels = card.querySelectorAll('small');
    if (labels[0]) labels[0].textContent = 'Mercado Livre — A receber';
    if (labels[1]) labels[1].textContent = 'Vendas ainda não liberadas';

    let held = $('srcMlHeld');
    if (!held) {
      const div = document.createElement('div');
      div.className = 'source ml-held';
      div.id = 'srcMlHeldCard';
      div.innerHTML = '<span class="dot"></span><small>Mercado Livre — Retido</small><strong id="srcMlHeld">R$ 0,00</strong><small>Reclamações / disputas</small><div id="mlHeldSyncNote" class="ml-sync-note"></div><button id="mpAuthorizeBtn" class="mini-btn auth" type="button" hidden>Autorizar Mercado Pago</button>';
      card.insertAdjacentElement('afterend', div);
      held = $('srcMlHeld');
    }
    return held;
  }

  function ensureLiabilityManager(){
    let panel = $('liabilityManager');
    if (panel) return panel;
    const tables = document.querySelector('.tables');
    if (!tables) return null;
    panel = document.createElement('section');
    panel.id = 'liabilityManager';
    panel.className = 'card liability-manager';
    panel.innerHTML = `
      <div class="head"><h2>Obrigações / Passivos</h2><small>Baixe pagamentos sem mexer manualmente no saldo bancário</small></div>
      <div style="overflow:auto"><table class="table" style="min-width:760px">
        <thead><tr><th>Obrigação</th><th>Categoria</th><th>Saldo</th><th>Ações</th></tr></thead>
        <tbody id="liabilityManagerRows"></tbody>
      </table></div>`;
    tables.insertAdjacentElement('afterend', panel);
    panel.addEventListener('click', handleLiabilityAction);
    return panel;
  }

  function accountByKey(summary, key){
    return (summary?.accounts || []).find(account => account?.metadata?.matrix_key === key) || null;
  }

  function renderLiabilities(summary){
    ensureLiabilityManager();
    const body = $('liabilityManagerRows');
    if (!body) return;
    const accounts = (summary?.accounts || [])
      .filter(account => account.account_type === 'liability' && account.active !== false)
      .sort((a,b) => Number(b.current_balance || 0) - Number(a.current_balance || 0));

    if (!accounts.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma obrigação cadastrada.</td></tr>';
      return;
    }

    body.innerHTML = accounts.map(account => {
      const balance = Number(account.current_balance || 0);
      const actions = balance > 0
        ? `<div class="liability-actions"><button class="mini-btn warn" data-action="partial" data-id="${account.id}" data-name="${esc(account.name)}" data-balance="${balance}">Pagamento parcial</button><button class="mini-btn good" data-action="full" data-id="${account.id}" data-name="${esc(account.name)}" data-balance="${balance}">Quitar</button></div>`
        : '<span class="paid-badge">Quitado</span>';
      return `<tr><td>${esc(account.name)}</td><td>${esc(account.category || '—')}</td><td class="amount ${balance > 0 ? 'neg' : 'pos'}">${brl(balance)}</td><td>${actions}</td></tr>`;
    }).join('');
  }

  function applySummary(summary){
    const receivable = accountByKey(summary, 'ml_receivable');
    const held = accountByKey(summary, 'ml_claims_held');
    ensureMlHeldCard();

    if ($('srcMl')) $('srcMl').textContent = brl(receivable?.current_balance || 0);
    if ($('srcMlHeld')) $('srcMlHeld').textContent = brl(held?.current_balance || 0);

    const syncedAt = held?.metadata?.synced_at || receivable?.metadata?.synced_at;
    if ($('mlHeldSyncNote') && mpConnected) {
      $('mlHeldSyncNote').textContent = syncedAt
        ? `Fonte: Mercado Pago · ${new Date(syncedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`
        : 'Mercado Pago autorizado';
    }

    const t = summary?.totals || {};
    if ($('netWorth')) $('netWorth').textContent = brl(t.net_worth);
    if ($('assets')) $('assets').textContent = brl(t.assets);
    if ($('liabilities')) $('liabilities').textContent = brl(t.liabilities);
    if ($('cash')) $('cash').textContent = brl(t.cash);
    if ($('srcBank')) $('srcBank').textContent = brl(t.cash);
    if ($('srcStock')) $('srcStock').textContent = brl(t.stock);
    if ($('srcAr')) $('srcAr').textContent = brl(t.accounts_receivable);
    if ($('srcAp')) $('srcAp').textContent = brl(t.accounts_payable);

    renderLiabilities(summary);
  }

  async function refreshSummary(){
    try {
      const summary = await api('/api/finance/summary');
      applySummary(summary);
      return summary;
    } catch (error) {
      console.warn('[Financeiro extra] resumo:', error.message);
      return null;
    }
  }

  function updateMpAuthUi(){
    const button = $('mpAuthorizeBtn');
    const note = $('mlHeldSyncNote');
    if (button) button.hidden = mpConnected;
    if (!mpConnected && note) note.textContent = 'Autorize o Mercado Pago para valores exatos';
  }

  async function refreshMpStatus(){
    try {
      const status = await api('/api/finance/mercadolivre/status');
      mpConnected = Boolean(status.mercadopago_connected);
      updateMpAuthUi();
      return status;
    } catch (error) {
      console.warn('[Financeiro ML] status:', error.message);
      return null;
    }
  }

  async function syncMl(force = false){
    if (syncingMl || !mpConnected) return;
    if (!force && Date.now() - lastMlSync < 20000) return;
    syncingMl = true;
    try {
      await api('/api/finance/mercadolivre/sync', {method:'POST', body:'{}'});
      lastMlSync = Date.now();
      await refreshSummary();
    } catch (error) {
      if (error.data?.authorization_required) {
        mpConnected = false;
        updateMpAuthUi();
      }
      console.warn('[Financeiro ML] sincronização:', error.message);
      const note = $('mlHeldSyncNote');
      if (note && mpConnected) note.textContent = 'Falha ao sincronizar agora';
    } finally {
      syncingMl = false;
    }
  }

  async function handleLiabilityAction(event){
    const button = event.target.closest('[data-action][data-id]');
    if (!button) return;
    const id = Number(button.dataset.id);
    const name = button.dataset.name || 'obrigação';
    const current = Number(button.dataset.balance || 0);
    let payload;

    if (button.dataset.action === 'full') {
      if (!confirm(`Quitar ${name} no valor de ${brl(current)}?\n\nIsso baixa apenas a obrigação. O saldo do banco continua vindo automaticamente do Open Finance.`)) return;
      payload = {pay_full:true};
    } else {
      const typed = prompt(`Quanto foi pago de ${name}?\nSaldo atual: ${brl(current)}`);
      if (typed == null) return;
      const amount = parseMoney(typed);
      if (!Number.isFinite(amount) || amount <= 0) return alert('Digite um valor válido.');
      payload = {amount};
    }

    const old = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Salvando...';
      const result = await api(`/api/finance/liabilities/${id}/pay`, {method:'POST', body:JSON.stringify(payload)});
      alert(`${result.mensagem}\nValor pago: ${brl(result.valor_pago)}\nSaldo restante: ${brl(result.novo_saldo)}`);
      await refreshSummary();
    } catch (error) {
      alert('Não foi possível registrar o pagamento: ' + error.message);
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  }

  function handleOauthReturn(){
    const params = new URLSearchParams(location.search);
    const status = params.get('mercadopago');
    if (!status) return;
    if (status === 'connected') {
      history.replaceState({}, '', location.pathname);
      setTimeout(async()=>{
        await refreshMpStatus();
        await syncMl(true);
      },300);
    } else if (status === 'error') {
      const reason = params.get('reason') || 'autorização recusada';
      history.replaceState({}, '', location.pathname);
      alert('Mercado Pago: não foi possível concluir a autorização. ' + reason);
    }
  }

  function bind(){
    ensureStyle();
    ensureMlHeldCard();
    ensureLiabilityManager();

    const auth = $('mpAuthorizeBtn');
    if (auth && !auth.dataset.bound) {
      auth.dataset.bound = '1';
      auth.addEventListener('click', () => { location.href = '/auth/mercadopago'; });
    }

    const refresh = $('refreshBtn');
    if (refresh && !refresh.dataset.mlFundsBound) {
      refresh.dataset.mlFundsBound = '1';
      refresh.addEventListener('click', () => syncMl(false), true);
    }

    handleOauthReturn();
    setTimeout(async () => {
      await refreshSummary();
      await refreshMpStatus();
      await syncMl(false);
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once:true});
  else bind();
})();
