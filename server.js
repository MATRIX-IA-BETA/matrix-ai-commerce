const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = "matrix_portal_session";
const SESSION_MAX_AGE = 60 * 60 * 12;
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const attempts = new Map();

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const MODULES = [
  ["dashboard", "Painel"],
  ["sales", "Vendas"],
  ["stock", "Estoque"],
  ["finance", "Financeiro"],
  ["fiscal", "Fiscal"],
  ["sac", "SAC"],
  ["erp", "ERP"],
  ["admin", "Administração"]
];

const ROLE_TEMPLATES = {
  super_admin: { label: "Super Admin", permissions: Object.fromEntries(MODULES.map(([key]) => [key, true])) },
  admin: { label: "Administrador", permissions: Object.fromEntries(MODULES.map(([key]) => [key, true])) },
  finance: { label: "Financeiro", permissions: { dashboard: true, finance: true, fiscal: true } },
  stock: { label: "Estoque", permissions: { dashboard: true, stock: true, erp: true } },
  sac: { label: "SAC", permissions: { dashboard: true, sac: true } },
  sales: { label: "Vendas", permissions: { dashboard: true, sales: true, stock: true, sac: true } },
  viewer: { label: "Somente leitura", permissions: { dashboard: true } },
  custom: { label: "Personalizado", permissions: {} }
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

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

app.get("/portal.css", (req, res) => res.type("text/css").sendFile(path.join(__dirname, "public", "portal.css")));
app.get("/admin.css", (req, res) => res.type("text/css").sendFile(path.join(__dirname, "public", "admin.css")));
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
app.get("/health", (req, res) => res.json({ status: "ok", service: "matrix-ai-portal", admin: Boolean(supabase) }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function digits(value = "") {
  return String(value).replace(/\D/g, "");
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

function sessionSecret() {
  return process.env.PORTAL_SESSION_SECRET || "";
}

function sign(payload) {
  const secret = sessionSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function makeSession(data) {
  const payload = Buffer.from(JSON.stringify({
    ...data,
    csrf: crypto.randomBytes(18).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, item) => {
    const index = item.indexOf("=");
    if (index < 0) return cookies;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function sessionData(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw || !sessionSecret()) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function setSession(res, data) {
  const value = makeSession(data);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`);
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireOwner(req, res, next) {
  const session = sessionData(req);
  if (!session) return res.redirect(303, "/owner");
  if (session.type !== "owner") return res.status(403).type("html").send(messagePage("Acesso restrito", "Esta área é exclusiva do administrador proprietário."));
  req.session = session;
  next();
}

function validCsrf(req) {
  const session = sessionData(req);
  return Boolean(session?.csrf && req.body?.csrf && safeEqual(session.csrf, req.body.csrf));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algo, saltHex, hashHex] = String(encoded || "").split("$");
    if (algo !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function shell(title, body, css = "/portal.css") {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <meta name="theme-color" content="#050816">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${css}">
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

function messagePage(title, text, back = "/") {
  return shell(`Matrix AI | ${title}`, `
    <main class="singlePage"><section class="messageCard">
      ${brand()}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>
      <a class="button primaryButton" href="${escapeHtml(back)}">Voltar <span>→</span></a>
    </section></main>`);
}

function userLoginPage(message = "") {
  const error = message ? `<div class="formError" role="alert">${escapeHtml(message)}</div>` : "";
  return shell("Matrix AI | Login", `
    <main class="gate">
      <section class="gateIntro">
        ${brand()}
        <div class="gateCopy">
          <span class="eyebrow">COMMERCE OPERATING SYSTEM</span>
          <h1>A operação inteira.<br><em>Uma única inteligência.</em></h1>
          <p>Estoque, vendas, fiscal, financeiro e atendimento trabalhando juntos — sem planilha perdida no multiverso.</p>
          <div class="gateSignals"><span>Mercado Livre</span><span>Estoque</span><span>SAC IA</span><span>Financeiro</span></div>
        </div>
        <p class="legal">Ambiente privado · Shop Matrix © 2026</p>
      </section>
      <aside class="loginPanel"><div class="loginCard">
        <span class="secureBadge"><i></i> ACESSO PROTEGIDO</span>
        <h2>Entrar no Matrix AI</h2><p>Use os dados cadastrados pela sua empresa.</p>
        <form action="/login" method="post">
          <label for="cnpj">CNPJ da empresa</label><input id="cnpj" name="cnpj" inputmode="numeric" autocomplete="organization" placeholder="00.000.000/0000-00" required>
          <label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" placeholder="voce@empresa.com.br" required>
          <label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Digite sua senha" required>
          ${error}
          <button class="button primaryButton" type="submit">Entrar no portal <span>→</span></button>
        </form>
        <div class="loginFoot"><span class="lock">◆</span><a href="/owner">Acesso administrativo do proprietário</a></div>
      </div></aside>
    </main>`);
}

function ownerLoginPage(message = "") {
  const error = message ? `<div class="formError" role="alert">${escapeHtml(message)}</div>` : "";
  return shell("Matrix AI | Administração", `
    <main class="singlePage"><section class="messageCard ownerLogin">
      ${brand()}<span class="secureBadge"><i></i> PROPRIETÁRIO</span>
      <h1>Administração Matrix AI</h1><p>Use a senha administrativa atual do portal.</p>
      <form action="/owner-login" method="post">
        <label for="owner_password">Senha administrativa</label>
        <input id="owner_password" name="owner_password" type="password" autocomplete="current-password" required autofocus>
        ${error}
        <button class="button primaryButton" type="submit">Entrar como proprietário <span>→</span></button>
      </form><a class="textLink" href="/">Voltar para login de usuário</a>
    </section></main>`);
}

function portalPage(session) {
  const owner = session.type === "owner";
  const displayName = owner ? "Proprietário" : escapeHtml(session.name || "Usuário");
  const company = owner ? "Matrix AI" : escapeHtml(session.tenantName || "Empresa");
  const cards = [
    ["↗", "Vendas sob controle", "Mercado Livre, pedidos e indicadores reunidos em uma visão operacional."],
    ["◫", "Estoque inteligente", "Peças, kits, movimentações e patrimônio sem duplicidade e sem adivinhação."],
    ["✦", "SAC com IA", "Atendimento mais rápido, respostas consistentes e histórico centralizado."],
    ["R$", "Financeiro conectado", "Contas, conciliação, documentos fiscais e visão executiva em um só lugar."]
  ].map(([icon, title, text]) => `<article><span class="capIcon">${icon}</span><h3>${title}</h3><p>${text}</p></article>`).join("");

  return shell("Matrix AI | Portal privado", `
    <header class="siteHeader">${brand()}<nav><a href="#plataforma">Plataforma</a><a href="#visao">Visão</a>${owner ? '<a href="/admin">Administração</a>' : ""}</nav><form action="/logout" method="post"><button class="logout" type="submit">Sair</button></form></header>
    <main class="siteMain">
      <section class="hero" id="visao"><div class="heroCopy">
        <span class="privateBadge"><i></i> ${company}</span>
        <h1>Olá, ${displayName}.<br><em>A operação está no comando.</em></h1>
        <p>A Matrix AI conecta tudo que move a empresa em uma experiência simples, rastreável e preparada para crescer.</p>
        <div class="heroActions"><a class="button primaryButton" href="/app">Acessar Matrix AI <span>→</span></a>${owner ? '<a class="textLink" href="/admin">Gerenciar usuários</a>' : '<a class="textLink" href="#plataforma">Conhecer a plataforma</a>'}</div>
      </div><div class="productVisual"><div class="glow"></div><div class="window"><div class="windowTop"><div class="miniBrand"><span class="brandMark small"><i></i><b></b></span> Matrix AI</div><span class="status"><i></i> Online</span></div><div class="windowBody"><aside class="miniNav"><span class="active">⌂</span><span>◫</span><span>↗</span><span>✦</span><span>⚙</span></aside><div class="miniContent"><div class="miniTitle"><span>Painel executivo</span><b>Hoje</b></div><div class="stats"><div><small>OPERAÇÃO</small><strong>Online</strong><em>Estável</em></div><div><small>AMBIENTE</small><strong>${company}</strong><em>Isolado</em></div><div><small>SEGURANÇA</small><strong>Ativa</strong><em>Portal</em></div></div></div></div></div></div></section>
      <section class="platform" id="plataforma"><div class="sectionHeading"><span class="eyebrow">UMA PLATAFORMA. TODA A EMPRESA.</span><h2>Menos troca de tela.<br>Mais decisão.</h2><p>Cada módulo conversa com o próximo para eliminar retrabalho e mostrar o que realmente importa.</p></div><div class="capabilityGrid">${cards}</div></section>
    </main><footer>Matrix AI · Tecnologia criada dentro da operação, para a operação.</footer>`);
}

function roleOptions(selected = "viewer") {
  return Object.entries(ROLE_TEMPLATES).map(([key, value]) => `<option value="${key}"${key === selected ? " selected" : ""}>${escapeHtml(value.label)}</option>`).join("");
}

function permissionChecks(current = {}) {
  return MODULES.map(([key, label]) => `<label class="permissionCheck"><input type="checkbox" name="perm_${key}" value="1"${current[key] ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("");
}

function formatCnpj(cnpj = "") {
  const value = digits(cnpj);
  return value.length === 14 ? value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : value;
}

function adminPage({ session, tenants, users, audits, notice = "" }) {
  const csrf = escapeHtml(session.csrf);
  const noticeHtml = notice ? `<div class="adminNotice">${escapeHtml(notice)}</div>` : "";
  const tenantMap = Object.fromEntries(tenants.map(t => [t.id, t]));
  const tenantOptions = tenants.map(t => `<option value="${t.id}">${escapeHtml(t.trade_name || t.legal_name)} · ${formatCnpj(t.cnpj)}</option>`).join("");

  const rows = users.length ? users.map(user => {
    const tenant = tenantMap[user.tenant_id];
    const perms = user.permissions || {};
    const enabled = Object.entries(perms).filter(([, value]) => value).map(([key]) => MODULES.find(([id]) => id === key)?.[1] || key).join(", ") || "Painel";
    return `<tr>
      <td><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></td>
      <td>${escapeHtml(tenant?.trade_name || tenant?.legal_name || "—")}</td>
      <td><span class="rolePill">${escapeHtml(ROLE_TEMPLATES[user.role]?.label || user.role)}</span></td>
      <td class="modulesCell">${escapeHtml(enabled)}</td>
      <td><span class="statusPill ${user.active ? "on" : "off"}">${user.active ? "Ativo" : "Bloqueado"}</span></td>
      <td>${user.last_login_at ? new Date(user.last_login_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Nunca"}</td>
      <td><details class="rowActions"><summary>Gerenciar</summary><div class="actionBox">
        <form action="/admin/users/${user.id}/update" method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Perfil<select name="role">${roleOptions(user.role)}</select></label><div class="permissionGrid compact">${permissionChecks(perms)}</div><button type="submit">Salvar perfil</button></form>
        <form action="/admin/users/${user.id}/toggle" method="post"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary" type="submit">${user.active ? "Bloquear usuário" : "Reativar usuário"}</button></form>
        <form action="/admin/users/${user.id}/reset" method="post"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary" type="submit">Gerar senha temporária</button></form>
      </div></details></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="emptyState">Nenhum usuário cadastrado ainda.</td></tr>`;

  const auditRows = audits.map(item => `<li><span>${escapeHtml(item.action)}</span><small>${new Date(item.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</small></li>`).join("") || `<li><span>Nenhuma alteração registrada ainda.</span></li>`;

  return shell("Matrix AI | Administração", `
    <div class="adminShell"><aside class="adminSide">${brand()}<nav><a class="active" href="/admin">Usuários</a><a href="/">Portal</a></nav><div class="sideFoot"><span>SUPER ADMIN</span><strong>Proprietário</strong><form action="/logout" method="post"><button>Sair</button></form></div></aside>
    <main class="adminMain"><header class="adminHeader"><div><span class="eyebrow">ADMINISTRAÇÃO</span><h1>Controle de acesso</h1><p>Empresas, usuários, perfis e permissões em um só lugar.</p></div><a class="openApp" href="/app">Abrir Matrix AI →</a></header>
    ${noticeHtml}
    <section class="metrics"><article><small>EMPRESAS</small><strong>${tenants.length}</strong><span>ambientes cadastrados</span></article><article><small>USUÁRIOS</small><strong>${users.length}</strong><span>${users.filter(u => u.active).length} ativos</span></article><article><small>SEGURANÇA</small><strong>RLS</strong><span>tabelas administrativas protegidas</span></article></section>
    <section class="adminGrid"><article class="adminCard"><div class="cardHead"><div><span class="eyebrow">NOVO ACESSO</span><h2>Cadastrar usuário</h2></div></div><form class="adminForm" action="/admin/users" method="post"><input type="hidden" name="csrf" value="${csrf}"><div class="twoCols"><label>Nome completo<input name="name" required></label><label>E-mail<input name="email" type="email" required></label><label>Empresa<select name="tenant_id" required>${tenantOptions}</select></label><label>Telefone<input name="phone" inputmode="tel"></label><label>Perfil<select name="role">${roleOptions("viewer")}</select></label><label>Senha temporária<input name="password" type="text" minlength="8" required placeholder="mínimo 8 caracteres"></label></div><p class="hint">As permissões abaixo prevalecem para perfil personalizado e já ficam registradas para a futura camada de isolamento por módulo.</p><div class="permissionGrid">${permissionChecks({ dashboard: true })}</div><button class="adminPrimary" type="submit">+ Criar usuário</button></form></article>
    <article class="adminCard"><div class="cardHead"><div><span class="eyebrow">MULTIEMPRESA</span><h2>Cadastrar empresa</h2></div></div><form class="adminForm" action="/admin/tenants" method="post"><input type="hidden" name="csrf" value="${csrf}"><label>CNPJ<input name="cnpj" inputmode="numeric" required placeholder="00.000.000/0000-00"></label><label>Razão social<input name="legal_name" required></label><label>Nome fantasia<input name="trade_name"></label><button class="adminPrimary" type="submit">+ Criar empresa</button></form><div class="tenantList">${tenants.map(t => `<div><span><strong>${escapeHtml(t.trade_name || t.legal_name)}</strong><small>${formatCnpj(t.cnpj)}</small></span><b class="statusPill ${t.active ? "on" : "off"}">${t.active ? "Ativa" : "Inativa"}</b></div>`).join("")}</div></article></section>
    <section class="adminCard tableCard"><div class="cardHead"><div><span class="eyebrow">ACESSOS</span><h2>Usuários cadastrados</h2></div></div><div class="tableWrap"><table><thead><tr><th>Usuário</th><th>Empresa</th><th>Perfil</th><th>Módulos</th><th>Status</th><th>Último acesso</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <section class="adminCard auditCard"><div class="cardHead"><div><span class="eyebrow">AUDITORIA</span><h2>Últimas alterações</h2></div></div><ul>${auditRows}</ul></section>
    </main></div>`, "/admin.css");
}

function tempPasswordPage(password) {
  return shell("Matrix AI | Nova senha", `<main class="singlePage"><section class="messageCard"><span class="secureBadge"><i></i> SENHA TEMPORÁRIA</span><h1>Senha redefinida</h1><p>Copie e entregue ao usuário. Por segurança, ela não será mostrada novamente.</p><div class="temporaryPassword">${escapeHtml(password)}</div><a class="button primaryButton" href="/admin">Voltar à administração <span>→</span></a></section></main>`, "/admin.css");
}

function rateLimitRecord(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let record = attempts.get(ip);
  if (!record || now - record.startedAt > ATTEMPT_WINDOW) record = { count: 0, startedAt: now };
  return { ip, now, record };
}

app.get("/", (req, res) => {
  const session = sessionData(req);
  res.type("html").send(session ? portalPage(session) : userLoginPage());
});

app.get("/owner", (req, res) => {
  const session = sessionData(req);
  if (session?.type === "owner") return res.redirect(303, "/admin");
  res.type("html").send(ownerLoginPage());
});

app.post("/owner-login", (req, res) => {
  const { ip, record } = rateLimitRecord(req);
  if (record.count >= MAX_ATTEMPTS) return res.status(429).type("html").send(ownerLoginPage("Muitas tentativas. Aguarde alguns minutos."));
  if (!safeEqual(req.body.owner_password, process.env.PORTAL_ACCESS_PASSWORD)) {
    record.count += 1; attempts.set(ip, record);
    return res.status(401).type("html").send(ownerLoginPage("Senha incorreta."));
  }
  attempts.delete(ip);
  setSession(res, { type: "owner", name: "Proprietário" });
  res.redirect(303, "/admin");
});

app.post("/login", async (req, res) => {
  if (!supabase) return res.status(503).type("html").send(userLoginPage("Banco de usuários ainda não conectado neste ambiente."));
  const { ip, record } = rateLimitRecord(req);
  if (record.count >= MAX_ATTEMPTS) return res.status(429).type("html").send(userLoginPage("Muitas tentativas. Aguarde alguns minutos."));

  const cnpj = digits(req.body.cnpj);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (cnpj.length !== 14 || !email || !password) return res.status(400).type("html").send(userLoginPage("Preencha CNPJ, e-mail e senha."));

  const { data: tenant } = await supabase.from("matrix_tenants").select("id,cnpj,trade_name,legal_name,slug,active").eq("cnpj", cnpj).maybeSingle();
  if (!tenant?.active) {
    record.count += 1; attempts.set(ip, record);
    return res.status(401).type("html").send(userLoginPage("Empresa ou credenciais inválidas."));
  }

  const { data: users } = await supabase.from("matrix_portal_users").select("id,name,email,role,permissions,password_hash,active").eq("tenant_id", tenant.id).ilike("email", email).limit(1);
  const user = users?.[0];
  if (!user?.active || !verifyPassword(password, user.password_hash)) {
    record.count += 1; attempts.set(ip, record);
    return res.status(401).type("html").send(userLoginPage("Empresa ou credenciais inválidas."));
  }

  attempts.delete(ip);
  await supabase.from("matrix_portal_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
  setSession(res, { type: "user", userId: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.trade_name || tenant.legal_name, name: user.name, role: user.role, permissions: user.permissions || {} });
  res.redirect(303, "/");
});

app.post("/logout", (req, res) => { clearSession(res); res.redirect(303, "/"); });

app.get("/app", (req, res) => {
  const session = sessionData(req);
  if (!session) return res.redirect(303, "/");
  if (session.type === "owner" || session.tenantSlug === "shop-matrix") return res.redirect(302, appUrl());
  res.status(403).type("html").send(messagePage("Ambiente em preparação", "O cadastro está pronto, mas o acesso aos dados desta empresa só será liberado após a camada de isolamento multiempresa do aplicativo.", "/"));
});

app.get("/admin", requireOwner, async (req, res) => {
  if (!supabase) return res.status(503).type("html").send(messagePage("Banco não conectado", "Configure SUPABASE_URL e SUPABASE_SECRET_KEY neste ambiente.", "/"));
  const [{ data: tenants, error: tenantError }, { data: users, error: userError }, { data: audits }] = await Promise.all([
    supabase.from("matrix_tenants").select("id,cnpj,legal_name,trade_name,slug,active,created_at").order("created_at"),
    supabase.from("matrix_portal_users").select("id,tenant_id,name,email,phone,role,permissions,active,last_login_at,created_at").order("created_at", { ascending: false }),
    supabase.from("matrix_admin_audit").select("id,action,created_at").order("created_at", { ascending: false }).limit(12)
  ]);
  if (tenantError || userError) return res.status(500).type("html").send(messagePage("Erro administrativo", tenantError?.message || userError?.message || "Falha ao carregar dados.", "/"));
  res.type("html").send(adminPage({ session: req.session, tenants: tenants || [], users: users || [], audits: audits || [] }));
});

app.post("/admin/tenants", requireOwner, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).type("html").send(messagePage("Sessão inválida", "Atualize a página e tente novamente.", "/admin"));
  const cnpj = digits(req.body.cnpj);
  const legalName = String(req.body.legal_name || "").trim();
  const tradeName = String(req.body.trade_name || "").trim();
  if (cnpj.length !== 14 || !legalName) return res.status(400).type("html").send(messagePage("Dados inválidos", "Informe um CNPJ com 14 dígitos e a razão social.", "/admin"));
  const slugBase = (tradeName || legalName).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `empresa-${cnpj.slice(-6)}`;
  const { data, error } = await supabase.from("matrix_tenants").insert({ cnpj, legal_name: legalName, trade_name: tradeName || null, slug: `${slugBase}-${cnpj.slice(-4)}` }).select("id").single();
  if (error) return res.status(400).type("html").send(messagePage("Não foi possível cadastrar", error.code === "23505" ? "Esse CNPJ já está cadastrado." : error.message, "/admin"));
  await supabase.from("matrix_admin_audit").insert({ tenant_id: data.id, actor_type: "owner", action: "tenant.created", details: { cnpj } });
  res.redirect(303, "/admin");
});

function permissionsFromBody(body, role) {
  if (role !== "custom") return { ...(ROLE_TEMPLATES[role]?.permissions || {}) };
  return Object.fromEntries(MODULES.map(([key]) => [key, body[`perm_${key}`] === "1"]));
}

app.post("/admin/users", requireOwner, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).type("html").send(messagePage("Sessão inválida", "Atualize a página e tente novamente.", "/admin"));
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim();
  const role = ROLE_TEMPLATES[req.body.role] ? req.body.role : "viewer";
  const password = String(req.body.password || "");
  const tenantId = String(req.body.tenant_id || "");
  if (!name || !email.includes("@") || password.length < 8 || !tenantId) return res.status(400).type("html").send(messagePage("Dados inválidos", "Confira nome, e-mail, empresa e uma senha de no mínimo 8 caracteres.", "/admin"));
  const permissions = permissionsFromBody(req.body, role);
  const { data, error } = await supabase.from("matrix_portal_users").insert({ tenant_id: tenantId, name, email, phone: phone || null, role, permissions, password_hash: hashPassword(password), active: true, must_change_password: true }).select("id").single();
  if (error) return res.status(400).type("html").send(messagePage("Não foi possível criar o usuário", error.code === "23505" ? "Já existe um usuário com esse e-mail nessa empresa." : error.message, "/admin"));
  await supabase.from("matrix_admin_audit").insert({ tenant_id: tenantId, actor_type: "owner", action: "user.created", target_user_id: data.id, details: { email, role } });
  res.redirect(303, "/admin");
});

app.post("/admin/users/:id/update", requireOwner, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).type("html").send(messagePage("Sessão inválida", "Atualize a página e tente novamente.", "/admin"));
  const role = ROLE_TEMPLATES[req.body.role] ? req.body.role : "viewer";
  const permissions = permissionsFromBody(req.body, role);
  const { data: user } = await supabase.from("matrix_portal_users").select("tenant_id").eq("id", req.params.id).maybeSingle();
  if (!user) return res.status(404).type("html").send(messagePage("Usuário não encontrado", "O cadastro não existe mais.", "/admin"));
  const { error } = await supabase.from("matrix_portal_users").update({ role, permissions, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(400).type("html").send(messagePage("Falha ao atualizar", error.message, "/admin"));
  await supabase.from("matrix_admin_audit").insert({ tenant_id: user.tenant_id, actor_type: "owner", action: "user.permissions_updated", target_user_id: req.params.id, details: { role, permissions } });
  res.redirect(303, "/admin");
});

app.post("/admin/users/:id/toggle", requireOwner, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).type("html").send(messagePage("Sessão inválida", "Atualize a página e tente novamente.", "/admin"));
  const { data: user } = await supabase.from("matrix_portal_users").select("tenant_id,active").eq("id", req.params.id).maybeSingle();
  if (!user) return res.status(404).type("html").send(messagePage("Usuário não encontrado", "O cadastro não existe mais.", "/admin"));
  const active = !user.active;
  const { error } = await supabase.from("matrix_portal_users").update({ active, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(400).type("html").send(messagePage("Falha ao alterar usuário", error.message, "/admin"));
  await supabase.from("matrix_admin_audit").insert({ tenant_id: user.tenant_id, actor_type: "owner", action: active ? "user.enabled" : "user.disabled", target_user_id: req.params.id });
  res.redirect(303, "/admin");
});

app.post("/admin/users/:id/reset", requireOwner, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).type("html").send(messagePage("Sessão inválida", "Atualize a página e tente novamente.", "/admin"));
  const { data: user } = await supabase.from("matrix_portal_users").select("tenant_id").eq("id", req.params.id).maybeSingle();
  if (!user) return res.status(404).type("html").send(messagePage("Usuário não encontrado", "O cadastro não existe mais.", "/admin"));
  const temp = `Mx-${crypto.randomBytes(6).toString("base64url")}-9`;
  const { error } = await supabase.from("matrix_portal_users").update({ password_hash: hashPassword(temp), must_change_password: true, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(400).type("html").send(messagePage("Falha ao redefinir senha", error.message, "/admin"));
  await supabase.from("matrix_admin_audit").insert({ tenant_id: user.tenant_id, actor_type: "owner", action: "user.password_reset", target_user_id: req.params.id });
  res.type("html").send(tempPasswordPage(temp));
});

app.use((req, res) => {
  const session = sessionData(req);
  res.status(404).type("html").send(session ? messagePage("Página não encontrada", "Esse endereço não existe no portal.", "/") : userLoginPage());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matrix AI Portal + Admin rodando na porta ${PORT}`);
});