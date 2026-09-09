(() => {
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const originalFetch = window.fetch.bind(window);
  const linkCache = new Map();
  const cancelledKey = pack => `sacMlCancelled:${String(pack || "")}`;

  function activePack() {
    return String(document.querySelector(".conv.active")?.dataset?.pack || "").trim();
  }

  function isCancelled(pack) {
    if (!pack) return false;
    try { return localStorage.getItem(cancelledKey(pack)) === "1"; } catch (_) { return false; }
  }

  function rememberCancelled(pack) {
    if (!pack) return;
    try { localStorage.setItem(cancelledKey(pack), "1"); } catch (_) {}
  }

  function installStyles() {
    if (document.getElementById("sacMlAiReviewStyle")) return;
    const style = document.createElement("style");
    style.id = "sacMlAiReviewStyle";
    style.textContent = `
      .ai-suggest-btn{background:#5534d7;border-color:#785ff0;font-weight:800;min-width:122px;white-space:nowrap}
      .ai-suggest-btn:hover:not(:disabled){filter:brightness(1.12)}
      .ai-suggest-btn:disabled{opacity:.45}
      .sac-ml-link{color:#9fc7ff;text-decoration:none;border-bottom:1px dotted #5d8fd1;cursor:pointer}
      .sac-ml-link:hover{color:#fff;border-bottom-color:#fff}
      .sac-ml-link-list{color:inherit;text-decoration:none;border-bottom:1px dotted #546a8c}
      .sac-ml-link-list:hover{color:#d8e9ff;border-bottom-color:#8db9f5}
      .cancelled-badge{display:inline-flex;align-items:center;margin-left:auto;padding:5px 9px;border-radius:999px;border:1px solid #a7374b;background:#431925;color:#ffbdc7;font-size:11px;font-weight:800;letter-spacing:.35px}
      .cancelled-note{color:#ffbdc7!important}
      @media(max-width:760px){.ai-suggest-btn{min-width:105px;padding-left:8px;padding-right:8px;font-size:12px}.cancelled-badge{font-size:10px;padding:4px 7px}}
    `;
    document.head.appendChild(style);
  }

  function clearCancelledBadge() {
    document.getElementById("cancelledBadge")?.remove();
  }

  function markCancelledUI(pack) {
    if (!pack || activePack() !== String(pack)) return;
    rememberCancelled(pack);

    const reply = document.getElementById("reply");
    const send = document.getElementById("send");
    const ai = document.getElementById("aiSuggest");
    if (reply) {
      reply.disabled = true;
      reply.value = "";
      reply.placeholder = "Pedido cancelado — o Mercado Livre bloqueou novas mensagens.";
      delete reply.dataset.aiSuggestion;
      delete reply.dataset.aiSuggestionPack;
    }
    if (send) send.disabled = true;
    if (ai) ai.disabled = true;

    let badge = document.getElementById("cancelledBadge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "cancelledBadge";
      badge.className = "cancelled-badge";
      badge.textContent = "CANCELADO";
      document.querySelector(".head")?.appendChild(badge);
    }
  }

  function syncCancelledState() {
    const pack = activePack();
    if (pack && isCancelled(pack)) {
      markCancelledUI(pack);
    } else {
      clearCancelledBadge();
      const reply = document.getElementById("reply");
      if (reply && !reply.disabled && reply.placeholder.includes("Pedido cancelado")) {
        reply.placeholder = "Digite sua resposta...";
      }
    }
  }

  async function getMarketplaceLinks(orderId) {
    const safe = String(orderId || "").replace(/\D/g, "");
    if (!safe) return null;
    if (linkCache.has(safe)) return linkCache.get(safe);

    const promise = originalFetch("/fiscal/marketplace-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_ids: [safe] }),
      cache: "no-store"
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.sucesso === false) return null;
      return data?.links?.[safe] || null;
    }).catch(() => null);

    linkCache.set(safe, promise);
    return promise;
  }

  function makeLink(text, href, className = "sac-ml-link") {
    const a = document.createElement("a");
    a.className = className;
    a.textContent = text;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", event => event.stopPropagation());
    return a;
  }

  async function enhanceHeaderLinks() {
    const meta = document.getElementById("meta");
    if (!meta) return;

    const raw = normalize(meta.textContent);
    const match = raw.match(/pedido\s+(\d+)/i);
    const orderId = match?.[1] || "";
    if (!orderId) return;
    if (meta.dataset.linksFor === orderId && meta.querySelector("a")) return;

    const productPart = raw.split("•").slice(2).join("•").trim() || "produto";
    const links = await getMarketplaceLinks(orderId);
    if (!document.body.contains(meta)) return;

    const currentRaw = normalize(meta.textContent);
    if (!new RegExp(`pedido\\s+${orderId}(?:\\D|$)`, "i").test(currentRaw)) return;

    meta.textContent = "";
    meta.dataset.linksFor = orderId;
    meta.append(document.createTextNode("Mercado Livre • pedido "));
    meta.append(makeLink(orderId, links?.order_url || `/mercadolivre/order/${encodeURIComponent(orderId)}/open`));
    meta.append(document.createTextNode(" • "));

    const products = Array.isArray(links?.product_items) ? links.product_items : [];
    if (products.length) {
      products.forEach((product, index) => {
        if (index) meta.append(document.createTextNode(" + "));
        meta.append(makeLink(product.title || productPart, product.url));
      });
    } else {
      meta.append(document.createTextNode(productPart));
    }
  }

  async function enhanceListLinks() {
    const rows = [...document.querySelectorAll(".conv")];
    for (const row of rows) {
      const orderBox = row.querySelector(".order");
      const productBox = row.querySelector(".product");
      const orderId = normalize(orderBox?.textContent).match(/(\d{10,})/)?.[1] || "";
      if (!orderId || row.dataset.mlLinksFor === orderId) continue;
      row.dataset.mlLinksFor = orderId;

      if (orderBox) {
        orderBox.textContent = "Pedido: ";
        orderBox.append(makeLink(orderId, `/mercadolivre/order/${encodeURIComponent(orderId)}/open`, "sac-ml-link-list"));
      }

      if (productBox) {
        const fallbackTitle = normalize(productBox.textContent);
        const links = await getMarketplaceLinks(orderId);
        if (!document.body.contains(row)) continue;
        const products = Array.isArray(links?.product_items) ? links.product_items : [];
        if (products.length) {
          productBox.textContent = "";
          products.forEach((product, index) => {
            if (index) productBox.append(document.createTextNode(" + "));
            productBox.append(makeLink(product.title || fallbackTitle, product.url, "sac-ml-link-list"));
          });
        }
      }
    }
  }

  function installLinkObservers() {
    const meta = document.getElementById("meta");
    const list = document.getElementById("list");
    if (meta) {
      new MutationObserver(() => {
        setTimeout(() => {
          enhanceHeaderLinks();
          syncCancelledState();
        }, 0);
      }).observe(meta, { childList: true, subtree: true, characterData: true });
    }
    if (list) {
      new MutationObserver(() => setTimeout(enhanceListLinks, 0)).observe(list, { childList: true, subtree: true });
    }
    document.addEventListener("click", event => {
      if (event.target.closest?.(".conv")) {
        setTimeout(() => {
          enhanceHeaderLinks();
          enhanceListLinks();
          syncCancelledState();
        }, 0);
      }
    });
    enhanceHeaderLinks();
    enhanceListLinks();
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
      const pack = activePack();
      if (pack && isCancelled(pack)) {
        if (!reply.disabled) reply.disabled = true;
        send.disabled = true;
        button.disabled = true;
        markCancelledUI(pack);
        return;
      }
      button.disabled = reply.disabled || !pack;
    };

    new MutationObserver(syncDisabled).observe(reply, { attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("click", event => {
      if (event.target.closest?.(".conv")) setTimeout(syncDisabled, 0);
    });

    button.addEventListener("click", async () => {
      const pack = activePack();
      if (!pack || isCancelled(pack)) return;

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

    if (sendMatch && method === "POST" && !response.ok) {
      const detail = await response.clone().json().catch(() => ({}));
      const raw = JSON.stringify(detail);
      if (response.status === 403 && /blocked_by_cancelled_order/i.test(raw)) {
        rememberCancelled(sendMatch[1]);
        setTimeout(() => markCancelledUI(sendMatch[1]), 0);
        return new Response(JSON.stringify({
          sucesso: false,
          codigo: "blocked_by_cancelled_order",
          pedido_cancelado: true,
          mensagem: "Pedido cancelado pelo comprador — o Mercado Livre bloqueou novas mensagens nesta venda."
        }), {
          status: 403,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

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

  function boot() {
    installButton();
    installLinkObservers();
    setTimeout(syncCancelledState, 0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
