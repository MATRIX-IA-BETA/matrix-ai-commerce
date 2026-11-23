const originalFetch = global.fetch;

if (!global.__matrixMpReleaseFastWindow && typeof originalFetch === "function") {
  global.__matrixMpReleaseFastWindow = true;

  global.fetch = async function matrixFetch(input, init = {}) {
    const url = typeof input === "string" ? input : String(input?.url || "");
    // Consultas históricas explícitas precisam preservar as datas originais.
    // Removemos a marcação interna antes de enviar a chamada ao Mercado Pago.
    const headers = { ...(init?.headers || {}) };
    const fullPeriod = headers["X-Matrix-Full-Period"] === "1";
    delete headers["X-Matrix-Full-Period"];
    let nextInit = { ...init, headers };

    if (
      url === "https://api.mercadopago.com/v1/account/release_report" &&
      String(init?.method || "GET").toUpperCase() === "POST" &&
      typeof init?.body === "string" &&
      !fullPeriod
    ) {
      try {
        const body = JSON.parse(init.body);
        const end = new Date(body.end_date || Date.now());
        const begin = new Date(end.getTime() - 6 * 60 * 60 * 1000);
        nextInit = {
          ...init,
          body: JSON.stringify({ ...body, begin_date: begin.toISOString().replace(/\.\d{3}Z$/, "Z") })
        };
      } catch (_) {}
    }

    const response = await originalFetch(input, nextInit);

    if (/\/v1\/account\/release_report\/task\//.test(url)) {
      response.clone().json().then(data => {
        console.log("[Financeiro MP Report Fast] tarefa:", JSON.stringify({
          id: data?.id || null,
          status: data?.status || null,
          report_id: data?.report_id || null,
          file_name: data?.file_name || null,
          last_modified: data?.last_modified || null
        }));
      }).catch(() => {});
    }

    return response;
  };
}

module.exports = true;
