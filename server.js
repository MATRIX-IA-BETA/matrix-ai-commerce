const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = "matrix_portal_session";
const SESSION_MAX_AGE = 60 * 60 * 12;
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const attempts = new Map();

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "8kb" }));

app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
  next();
});

app.get("/portal.css", (req, res) => {
  res.type("text/css").sendFile(path.join(__dirname, "public", "portal.css"));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "matrix-ai-portal" });
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(payload) {
  const secret = process.env.PORTAL_SESSION_SECRET || "";
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function sessionValue() {
  const payload = "matrix-ai-owner-v1";
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, item) => {
    const index = item.indexOf("=");
    if (index < 0) return cookies;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function isAuthenticated(req) {
  const current = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const expected = sessionValue();
  return Boolean(expected) && safeEqual(current, expected);
}

function appUrl() {
  const fallback = "https://steadfast-insight-production-2092.up.railway.app";
  try {
    const value = new URL(process.env.MATRIX_APP_URL || fallback);
    return value.protocol === "https:" ? value.toString() : fallback;
  } catch {
    return fallback;
  }
}

function shell(title, body) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <meta name="theme-color" content="#050816">
  <title>${title}</title>
  <link rel="stylesheet" href="/portal.css">
</head>
<body>${body}</body>
</html>`;
}

function brand() {
  return `<a class="brand" href="/" aria-label="Matrix AI">
    <span class="brandMark"><i></i><b></b></span>
    <span>Matrix <strong>AI</strong></span>
  </a>`;
}

function loginPage(message = "") {
  const error = message
    ? `<div class="formError" role="alert">${message}</div>`
    : "";

  return shell("Matrix AI | Acesso privado", `
    <main class="gate">
      <section class="gateIntro">
        ${brand()}
        <div class="gateCopy">
          <span class="eyebrow">COMMERCE OPERATING SYSTEM</span>
          <h1>A operação inteira.<br><em>Uma única inteligência.</em></h1>
          <p>Estoque, vendas, fiscal, financeiro e atendimento trabalhando juntos — sem planilha perdida no multiverso.</p>
          <div class="gateSignals">
            <span>Mercado Livre</span><span>Estoque</span><span>SAC IA</span><span>Financeiro</span>
          </div>
        </div>
        <p class="legal">Ambiente privado · Shop Matrix © 2026</p>
      </section>
      <aside class="loginPanel">
        <div class="loginCard">
          <span class="secureBadge"><i></i> ACESSO PROTEGIDO</span>
          <h2>Bem-vindo de volta</h2>
          <p>Entre para acessar o portal Matrix AI.</p>
          <form action="/login" method="post">
            <label for="password">Senha de acesso</label>
            <div class="passwordField">
              <span>⌁</span>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Digite sua senha" required autofocus>
            </div>
            ${error}
            <button class="button primaryButton" type="submit">Entrar no portal <span>→</span></button>
          </form>
          <div class="loginFoot"><span class="lock">◆</span><span>Sessão segura e conteúdo não indexado</span></div>
        </div>
      </aside>
    </main>`);
}

function portalPage() {
  const cards = [
    ["↗", "Vendas sob controle", "Mercado Livre, pedidos e indicadores reunidos em uma visão operacional."],
    ["◫", "Estoque inteligente", "Peças, kits, movimentações e patrimônio sem duplicidade e sem adivinhação."],
    ["✦", "SAC com IA", "Atendimento mais rápido, respostas consistentes e histórico centralizado."],
    ["R$", "Financeiro conectado", "Contas, conciliação, documentos fiscais e visão executiva em um só lugar."]
  ].map(([icon, title, text]) => `
    <article><span class="capIcon">${icon}</span><h3>${title}</h3><p>${text}</p></article>
  `).join("");

  return shell("Matrix AI | Portal privado", `
    <header class="siteHeader">
      ${brand()}
      <nav><a href="#plataforma">Plataforma</a><a href="#visao">Visão</a></nav>
      <form action="/logout" method="post"><button class="logout" type="submit">Sair</button></form>
    </header>
    <main class="siteMain">
      <section class="hero" id="visao">
        <div class="heroCopy">
          <span class="privateBadge"><i></i> AMBIENTE PRIVADO</span>
          <h1>Seu negócio no comando.<br><em>A IA no operacional.</em></h1>
          <p>A Matrix AI transforma dados espalhados em decisões claras, conectando tudo que move a Shop Matrix em uma experiência simples.</p>
          <div class="heroActions">
            <a class="button primaryButton" href="/app">Acessar Matrix AI <span>→</span></a>
            <a class="textLink" href="#plataforma">Conhecer a plataforma</a>
          </div>
          <div class="trustRow">
            <span><i></i> Operação centralizada</span>
            <span><i></i> Acesso restrito</span>
            <span><i></i> Dados em tempo real</span>
          </div>
        </div>
        <div class="productVisual" aria-label="Prévia do painel Matrix AI">
          <div class="glow"></div>
          <div class="window">
            <div class="windowTop">
              <div class="miniBrand"><span class="brandMark small"><i></i><b></b></span> Matrix AI</div>
              <span class="status"><i></i> Online</span>
            </div>
            <div class="windowBody">
              <aside class="miniNav"><span class="active">⌂</span><span>◫</span><span>↗</span><span>✦</span><span>⚙</span></aside>
              <div class="miniContent">
                <div class="miniTitle"><span>Painel executivo</span><b>Hoje</b></div>
                <div class="stats">
                  <div><small>VENDAS</small><strong>403</strong><em>↑ 18%</em></div>
                  <div><small>OPERAÇÃO</small><strong>Online</strong><em>Estável</em></div>
                  <div><small>AUTOMAÇÕES</small><strong>12</strong><em>Ativas</em></div>
                </div>
                <div class="chartCard">
                  <div class="chartHead"><span>Visão da operação</span><small>Últimos 7 dias</small></div>
                  <div class="bars"><i class="h38"></i><i class="h52"></i><i class="h46"></i><i class="h68"></i><i class="h61"></i><i class="h83"></i><i class="h92"></i></div>
                </div>
                <div class="activity"><i></i><span><b>Sistema sincronizado</b><small>Todos os módulos respondendo</small></span><em>agora</em></div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="platform" id="plataforma">
        <div class="sectionHeading">
          <span class="eyebrow">UMA PLATAFORMA. TODA A EMPRESA.</span>
          <h2>Menos troca de tela.<br>Mais decisão.</h2>
          <p>Cada módulo conversa com o próximo para eliminar retrabalho e mostrar o que realmente importa.</p>
        </div>
        <div class="capabilityGrid">${cards}</div>
      </section>
      <section class="closing">
        <div><span class="eyebrow">PRONTO PARA OPERAR</span><h2>A Matrix AI já está esperando por você.</h2></div>
        <a class="button lightButton" href="/app">Entrar no aplicativo <span>→</span></a>
      </section>
    </main>
    <footer>Matrix AI · Tecnologia criada dentro da operação, para a operação.</footer>
  `);
}

app.get("/", (req, res) => {
  res.type("html").send(isAuthenticated(req) ? portalPage() : loginPage());
});

app.post("/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let record = attempts.get(ip);

  if (!record || now - record.startedAt > ATTEMPT_WINDOW) {
    record = { count: 0, startedAt: now };
  }

  if (record.count >= MAX_ATTEMPTS) {
    return res.status(429).type("html").send(loginPage("Muitas tentativas. Aguarde alguns minutos."));
  }

  if (!safeEqual(req.body.password, process.env.PORTAL_ACCESS_PASSWORD)) {
    record.count += 1;
    attempts.set(ip, record);
    return res.status(401).type("html").send(loginPage("Senha incorreta. Confira e tente novamente."));
  }

  attempts.delete(ip);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(sessionValue())}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`);
  res.redirect(303, "/");
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  res.redirect(303, "/");
});

app.get("/app", (req, res) => {
  if (!isAuthenticated(req)) return res.redirect(303, "/");
  res.redirect(302, appUrl());
});

app.use((req, res) => {
  res.status(404).type("html").send(isAuthenticated(req) ? portalPage() : loginPage());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Portal rodando na porta ${PORT}`);
});
