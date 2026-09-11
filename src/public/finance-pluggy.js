(()=>{
  const PLUGGY_SCRIPT = 'https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js';
  let state = null;
  let sdkPromise = null;
  let bypassRefresh = false;

  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[char]));
  }
  function brl(value){
    return Number(value || 0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.sucesso === false) throw new Error(data.mensagem || `Falha HTTP ${response.status}`);
    return data;
  }

  function loadSdk(){
    if (window.PluggyConnect) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${PLUGGY_SCRIPT}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, {once:true});
        existing.addEventListener('error', () => reject(new Error('Não foi possível carregar o Pluggy Connect.')), {once:true});
        return;
      }
      const script = document.createElement('script');
      script.src = PLUGGY_SCRIPT;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar o Pluggy Connect.'));
      document.head.appendChild(script);
    });
    return sdkPromise;
  }

  function ensureBankAccountsPanel(){
    let panel = $('pluggyBankAccountsPanel');
    if (panel) return panel;

    const sources = document.querySelector('.sources');
    if (!sources) return null;

    if (!$('pluggyBankAccountsStyles')) {
      const style = document.createElement('style');
      style.id = 'pluggyBankAccountsStyles';
      style.textContent = `
        .pluggy-bank-panel{margin:0 0 14px;border:1px solid #263f62;background:rgba(10,23,41,.96);border-radius:15px;padding:15px}
        .pluggy-bank-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
        .pluggy-bank-head h2{font-size:16px;margin:0}.pluggy-bank-head small{color:#8fa4c3}
        .pluggy-bank-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
        .pluggy-bank-card{border:1px solid #263f62;background:#0b182a;border-radius:13px;padding:13px;min-height:104px}
        .pluggy-bank-name{display:flex;align-items:center;gap:7px;color:#c8d8ed;font-weight:800;font-size:13px}
        .pluggy-bank-dot{width:8px;height:8px;border-radius:50%;background:#31dc98;flex:0 0 auto}
        .pluggy-bank-balance{display:block;font-size:22px;margin:9px 0 3px;color:#f3f7ff}
        .pluggy-bank-detail{color:#8fa4c3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        @media(max-width:680px){.pluggy-bank-grid{grid-template-columns:1fr}}
      `;
      document.head.appendChild(style);
    }

    panel = document.createElement('section');
    panel.id = 'pluggyBankAccountsPanel';
    panel.className = 'pluggy-bank-panel';
    panel.hidden = true;
    panel.innerHTML = '<div class="pluggy-bank-head"><h2>Saldos por conta bancária</h2><small id="pluggyBankAccountsCount"></small></div><div id="pluggyBankAccountsGrid" class="pluggy-bank-grid"></div>';
    sources.insertAdjacentElement('afterend', panel);
    return panel;
  }

  function institutionFor(account){
    const metadata = account?.metadata || {};
    const itemId = metadata.pluggy_item_id ? String(metadata.pluggy_item_id) : '';
    const connection = (state?.connections || []).find(row => String(row.external_connection_id || '') === itemId);
    return metadata.institution || connection?.institution_name || account?.name || 'Banco';
  }

  async function renderBankAccounts(){
    const panel = ensureBankAccountsPanel();
    if (!panel) return;

    try {
      const summary = await api('/api/finance/summary');
      const accounts = (summary.accounts || [])
        .filter(account => String(account.source || '').toLowerCase() === 'pluggy')
        .filter(account => account.account_type === 'asset')
        .filter(account => /banco|bank|caixa|cash/i.test(String(account.category || '')))
        .sort((a, b) => institutionFor(a).localeCompare(institutionFor(b), 'pt-BR') || String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));

      const grid = $('pluggyBankAccountsGrid');
      const count = $('pluggyBankAccountsCount');
      if (!grid || !count) return;

      if (!accounts.length) {
        panel.hidden = true;
        grid.innerHTML = '';
        count.textContent = '';
        return;
      }

      count.textContent = accounts.length === 1 ? '1 conta conectada' : `${accounts.length} contas conectadas`;
      grid.innerHTML = accounts.map(account => {
        const bank = institutionFor(account);
        const metadata = account.metadata || {};
        const details = [];
        if (account.name && String(account.name).trim().toLowerCase() !== String(bank).trim().toLowerCase()) details.push(account.name);
        if (metadata.masked_number) details.push(`Conta ${metadata.masked_number}`);
        if (!details.length) details.push('Conta bancária via Open Finance');
        return `<div class="pluggy-bank-card">
          <div class="pluggy-bank-name"><span class="pluggy-bank-dot"></span>${esc(bank)}</div>
          <strong class="pluggy-bank-balance">${brl(account.current_balance)}</strong>
          <div class="pluggy-bank-detail" title="${esc(details.join(' · '))}">${esc(details.join(' · '))}</div>
        </div>`;
      }).join('');
      panel.hidden = false;
    } catch (error) {
      console.warn('[Open Finance] saldos por banco:', error.message);
    }
  }

  function renderCard(){
    const btn = $('bankBtn');
    if (!btn || !state) return;
    const connections = Array.isArray(state.connections) ? state.connections : [];
    if (!state.configured) {
      btn.innerHTML = '<small>🏦 Conectar banco</small><strong style="font-size:14px">Pluggy · configurar</strong><small>Somente leitura</small>';
      return;
    }
    if (!connections.length) {
      btn.innerHTML = '<small>🏦 Conectar banco</small><strong style="font-size:14px">Pluggy Open Finance</strong><small>Somente leitura</small>';
      return;
    }
    const label = connections.length === 1 ? '1 conexão bancária' : `${connections.length} conexões bancárias`;
    btn.innerHTML = `<small>🏦 Open Finance conectado</small><strong style="font-size:14px">${label}</strong><small>Conectar outro banco</small>`;
  }

  async function refreshStatus(){
    try {
      state = await api('/api/finance/open-finance/status');
      renderCard();
      await renderBankAccounts();
    } catch (error) {
      console.warn('[Open Finance] status:', error.message);
    }
    return state;
  }

  async function syncConnections(){
    if (!state?.configured || !state?.connections?.length) return null;
    return api('/api/finance/open-finance/sync', {method:'POST', body:'{}'});
  }

  function requiresUserAction(result){
    const status = String(result?.item_status || '').toUpperCase();
    const message = String(result?.mensagem || result?.refresh_detail || '');
    return ['WAITING_USER_ACTION','WAITING_USER_INPUT','LOGIN_ERROR','INVALID_CREDENTIALS'].includes(status) ||
      /WAITING_USER_ACTION|WAITING_USER_INPUT|INVALID_CREDENTIALS|MFA/i.test(message);
  }

  async function connectBank(updateItemId = null, institutionName = null){
    const btn = $('bankBtn');
    if (!btn) return;
    try {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '.65';
      const current = await refreshStatus();
      if (!current?.configured) {
        alert('A integração Pluggy já está pronta na Matrix. Falta apenas cadastrar PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Railway.');
        return;
      }

      const tokenData = await api('/api/finance/open-finance/connect-token', {method:'POST', body:'{}'});
      await loadSdk();
      if (!window.PluggyConnect) throw new Error('Pluggy Connect não ficou disponível no navegador.');

      const options = {
        connectToken: tokenData.accessToken,
        includeSandbox: false,
        countries: ['BR'],
        language: 'pt',
        onSuccess: async (payload) => {
          try {
            const itemId = payload?.item?.id || payload?.id || payload?.itemId || updateItemId;
            if (!itemId) throw new Error('A conexão foi autorizada, mas a Pluggy não retornou o itemId.');
            const result = await api('/api/finance/open-finance/connected', {
              method:'POST',
              body: JSON.stringify({itemId})
            });
            await refreshStatus();
            const info = result?.resultado || {};
            const label = institutionName || info.institution || 'Banco';
            alert(updateItemId
              ? `${label} atualizado. O saldo novo já foi importado para o Financeiro.`
              : `${label} conectado. ${info.saved || info.accounts || 0} conta(s) importada(s) para o Financeiro.`);
            const refresh = $('refreshBtn');
            if (refresh) {
              bypassRefresh = true;
              refresh.click();
            }
          } catch (error) {
            alert('Banco autorizado, mas houve erro ao importar os saldos: ' + error.message);
          }
        },
        onError: (error) => {
          const message = error?.message || error?.data?.message || 'Falha na conexão bancária.';
          alert('Open Finance: ' + message);
        }
      };

      if (updateItemId) options.updateItem = String(updateItemId);

      const pluggy = new window.PluggyConnect(options);
      pluggy.init();
    } catch (error) {
      alert('Open Finance: ' + error.message);
    } finally {
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
  }

  async function handleRefresh(event){
    if (bypassRefresh) {
      bypassRefresh = false;
      return;
    }
    if (!state?.configured || !state?.connections?.length) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const btn = $('refreshBtn');
    const oldText = btn?.textContent;
    let pendingUpdate = null;
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando bancos...'; }
      const syncResult = await syncConnections();
      pendingUpdate = (syncResult?.resultados || []).find(requiresUserAction) || null;
      await sleep(100);
    } catch (error) {
      console.warn('[Open Finance] sincronização:', error.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText || 'Atualizar dados'; }
    }

    if (pendingUpdate?.item_id) {
      await connectBank(pendingUpdate.item_id, pendingUpdate.institution || 'Banco');
      return;
    }

    bypassRefresh = true;
    btn?.click();
    refreshStatus();
  }

  function bind(){
    const bankBtn = $('bankBtn');
    if (bankBtn && !bankBtn.dataset.pluggyBound) {
      bankBtn.dataset.pluggyBound = '1';
      bankBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        connectBank();
      }, true);
    }

    const refreshBtn = $('refreshBtn');
    if (refreshBtn && !refreshBtn.dataset.pluggyBound) {
      refreshBtn.dataset.pluggyBound = '1';
      refreshBtn.addEventListener('click', handleRefresh, true);
    }

    refreshStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once:true});
  else bind();
})();
