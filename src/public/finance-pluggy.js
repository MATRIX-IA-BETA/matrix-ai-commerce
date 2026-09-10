(()=>{
  const PLUGGY_SCRIPT = 'https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js';
  let state = null;
  let sdkPromise = null;
  let bypassRefresh = false;

  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

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
    } catch (error) {
      console.warn('[Open Finance] status:', error.message);
    }
    return state;
  }

  async function syncConnections(){
    if (!state?.configured || !state?.connections?.length) return null;
    return api('/api/finance/open-finance/sync', {method:'POST', body:'{}'});
  }

  async function connectBank(){
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

      const pluggy = new window.PluggyConnect({
        connectToken: tokenData.accessToken,
        includeSandbox: false,
        countries: ['BR'],
        language: 'pt',
        onSuccess: async (payload) => {
          try {
            const itemId = payload?.item?.id || payload?.id || payload?.itemId;
            if (!itemId) throw new Error('A conexão foi autorizada, mas a Pluggy não retornou o itemId.');
            const result = await api('/api/finance/open-finance/connected', {
              method:'POST',
              body: JSON.stringify({itemId})
            });
            await refreshStatus();
            const info = result?.resultado || {};
            alert(`${info.institution || 'Banco'} conectado. ${info.saved || info.accounts || 0} conta(s) importada(s) para o Financeiro.`);
            const refresh = $('refreshBtn');
            if (refresh) refresh.click();
          } catch (error) {
            alert('Banco autorizado, mas houve erro ao importar os saldos: ' + error.message);
          }
        },
        onError: (error) => {
          const message = error?.message || error?.data?.message || 'Falha na conexão bancária.';
          alert('Open Finance: ' + message);
        }
      });
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
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando bancos...'; }
      await syncConnections();
      await sleep(100);
    } catch (error) {
      console.warn('[Open Finance] sincronização:', error.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText || 'Atualizar dados'; }
      bypassRefresh = true;
      btn?.click();
      refreshStatus();
    }
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
