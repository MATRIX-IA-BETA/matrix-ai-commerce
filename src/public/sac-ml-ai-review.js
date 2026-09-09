(() => {
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const originalFetch = window.fetch.bind(window);

  function activePack() {
    return String(document.querySelector(".conv.active")?.dataset?.pack || "").trim();
  }

  function installStyles() {
    if (document.getElementById("sacMlAiReviewStyle")) return;
    const style = document.createElement("style");
    style.id = "sacMlAiReviewStyle";
    style.textContent = `
      .ai-suggest-btn{background:#5534d7;border-color:#785ff0;font-weight:800;min-width:122px;white-space:nowrap}
      .ai-suggest-btn:hover:not(:disabled){filter:brightness(1.12)}
      .ai-suggest-btn:disabled{opacity:.45}
      @media(max-width:760px){.ai-suggest-btn{min-width:105px;padding-left:8px;padding-right:8px;font-size:12px}}
    `;
    document.head.appendChild(style);
  }

  function installButton() {
    installStyles();
    const composer = document.querySelector(".composer");
    const reply = document.getElementById("reply");
    const send = document.getElementById("send");
    if (!composer || !reply || !send || document.getElementById("aiSuggest")) return;

    const button = document.createElement("button");
    button.id = "aiSuggest";
    button.type = "button";
    button.className = "ai-suggest-btn";
    button.textContent = "SUGESTÃO AI";
    button.disabled = reply.disabled;
    composer.insertBefore(button, send);

    const syncDisabled = () => {
      button.disabled = reply.disabled || !activePack();
    };
    new MutationObserver(syncDisabled).observe(reply, { attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("click", event => {
      if (event.target.closest?.(".conv")) setTimeout(syncDisabled, 0);
    });

    button.addEventListener("click", async () => {
      const pack = activePack();
      if (!pack) return;

      button.disabled = true;
      button.textContent = "ANALISANDO PC...";
      try {
        const response = await originalFetch(`/api/sac/ml/ai/${encodeURIComponent(pack)}/suggest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store"
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.sucesso === false) throw new Error(data.mensagem || `HTTP ${response.status}`);

        reply.value = String(data.suggestion || "").slice(0, 350);
        reply.dataset.aiSuggestion = reply.value;
        reply.dataset.aiSuggestionPack = pack;
        reply.focus();
        reply.setSelectionRange(reply.value.length, reply.value.length);
        reply.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        const box = document.getElementById("error");
        if (box) {
          box.textContent = `Erro na sugestão da IA: ${error.message}`;
          box.classList.add("show");
        }
      } finally {
        button.textContent = "SUGESTÃO AI";
        syncDisabled();
      }
    });
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : String(input?.url || "");
    const method = String(init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
    const sendMatch = url.match(/\/api\/sac\/ml\/live\/(\d+)\/send(?:\?|$)/);

    let sentText = "";
    let suggestion = "";
    let suggestionPack = "";

    if (sendMatch && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body || {};
        sentText = String(body?.text || "");
      } catch (_) {}
      const reply = document.getElementById("reply");
      suggestion = String(reply?.dataset?.aiSuggestion || "");
      suggestionPack = String(reply?.dataset?.aiSuggestionPack || "");
    }

    const response = await originalFetch(input, init);

    if (
      response.ok &&
      sendMatch &&
      method === "POST" &&
      suggestion &&
      suggestionPack === sendMatch[1] &&
      normalize(suggestion) !== normalize(sentText)
    ) {
      originalFetch(`/api/sac/ml/ai/${encodeURIComponent(sendMatch[1])}/learn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestion, final_text: sentText }),
        cache: "no-store"
      }).then(async learningResponse => {
        const data = await learningResponse.json().catch(() => ({}));
        if (!learningResponse.ok || data.sucesso === false) {
          console.warn("[SAC ML AI] Não foi possível gravar aprendizado:", data.mensagem || learningResponse.status);
        } else if (data.saved) {
          console.log("[SAC ML AI] Correção do operador aprendida.", data.saved_in);
        }
      }).catch(error => console.warn("[SAC ML AI] Falha gravando aprendizado:", error));
    }

    if (response.ok && sendMatch && method === "POST") {
      const reply = document.getElementById("reply");
      if (reply && String(reply.dataset.aiSuggestionPack || "") === sendMatch[1]) {
        delete reply.dataset.aiSuggestion;
        delete reply.dataset.aiSuggestionPack;
      }
    }

    return response;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installButton, { once: true });
  } else {
    installButton();
  }
})();
