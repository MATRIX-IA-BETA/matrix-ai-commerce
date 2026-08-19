function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDateStart(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDateEnd(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function textoSeguro(value, max = 5000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

module.exports = {
  base64url,
  nowIso,
  normalizeDateStart,
  normalizeDateEnd,
  textoSeguro
};
