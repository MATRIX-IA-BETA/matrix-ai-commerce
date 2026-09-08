const { env } = require("../config/env");

const BLING_API_BASE = String(env.BLING_API_BASE || "").replace(/\/$/, "");
const MIN_INTERVAL_MS = 400;
const MAX_429_RETRIES = 4;

let lastRequestStartedAt = 0;
let rateQueue = Promise.resolve();
let installed = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function isBlingRequest(input) {
  if (!BLING_API_BASE) return false;
  return inputUrl(input).startsWith(`${BLING_API_BASE}/`);
}

async function acquireRateSlot() {
  const turn = rateQueue.then(async () => {
    const elapsed = Date.now() - lastRequestStartedAt;
    const waitMs = Math.max(0, MIN_INTERVAL_MS - elapsed);

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastRequestStartedAt = Date.now();
  });

  // Mantém a fila viva mesmo se uma espera excepcional falhar.
  rateQueue = turn.catch(() => {});
  await turn;
}

function retryAfterMs(response, attempt) {
  const raw = response?.headers?.get?.("retry-after");

  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(MIN_INTERVAL_MS, Math.ceil(seconds * 1000));
    }

    const absolute = Date.parse(raw);
    if (Number.isFinite(absolute)) {
      return Math.max(MIN_INTERVAL_MS, absolute - Date.now());
    }
  }

  // Backoff curto para o limite por segundo do Bling.
  return Math.min(6000, 800 * Math.pow(2, attempt));
}

function installBlingRateLimitGuard() {
  if (installed || global.__matrixBlingRateLimitInstalled) return;

  const originalFetch = global.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("Fetch global não disponível para instalar controle de limite do Bling.");
  }

  global.fetch = async function matrixRateLimitedFetch(input, init) {
    if (!isBlingRequest(input)) {
      return originalFetch(input, init);
    }

    let response = null;

    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
      await acquireRateSlot();
      response = await originalFetch(input, init);

      if (response.status !== 429) {
        return response;
      }

      if (attempt >= MAX_429_RETRIES) {
        return response;
      }

      const waitMs = retryAfterMs(response, attempt);
      console.warn(
        `[Bling rate limit] HTTP 429 em ${inputUrl(input)}. Nova tentativa em ${waitMs} ms (${attempt + 1}/${MAX_429_RETRIES}).`
      );
      await sleep(waitMs);
    }

    return response;
  };

  installed = true;
  Object.defineProperty(global, "__matrixBlingRateLimitInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

module.exports = {
  installBlingRateLimitGuard
};
