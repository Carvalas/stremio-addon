/**
 * security — permite apenas streaming dos hosts de mídia conhecidos pelo addon.
 *
 * Regras:
 *   • só HTTP(S);
 *   • host deve estar na allowlist (regras app_start + fontes confirmadas);
 *   • hosts aprendidos via redirect de fontes confiáveis também são aceitos;
 *   • IPs privados/locais sempre bloqueados (anti SSRF);
 *   • nunca um open proxy (URLs arbitrárias → 403).
 */
const dns = require('dns');

const MAX_REDIRECTS = Number(process.env.PROXY_MAX_REDIRECTS || 5);
const LEARN_TTL = Number(process.env.PROXY_LEARN_TTL_MS || 3600 * 1000); // hosts aprendidos: 1h

const learnedHosts = new Map(); // host -> expires

const PRIVATE_RE =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|^::1$|^fe80:|^fc|^fd|^10:|^192\.168)/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/\.$/, '');
}

function looksLikeIp(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

function isPrivateHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (looksLikeIp(host)) {
    return PRIVATE_RE.test(host) || host.startsWith('169.254.');
  }
  return false; // hostname: a resolução com blocos privados é conferida em resolveAndCheck
}

/** Resolve o host e garante que nenhum IP resolvido seja privado. */
function resolveAndCheck(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return resolve(false);
      const all = addresses.map((a) => String(a.address));
      resolve(all.length > 0 && all.every((ip) => !PRIVATE_RE.test(ip)));
    });
  });
}

function isLearned(host) {
  const expires = learnedHosts.get(host);
  if (expires === undefined) return false;
  if (expires < Date.now()) {
    learnedHosts.delete(host);
    return false;
  }
  return true;
}

/** Registra um host como destino de mídia confiável (vindo de redirect de fonte conhecida). */
function learnHost(host) {
  const h = normalizeHost(host);
  if (!h || isPrivateHost(h)) return;
  learnedHosts.set(h, Date.now() + LEARN_TTL);
}

/**
 * Valida uma URL para streaming. `allowedHosts` é um Set de hosts confiáveis.
 * @throws {Error} com .status = 400|403|500
 */
async function validateUrl(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'URL inválida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'Somente HTTP(S)');
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw httpError(400, 'Sem host');

  const inAllowlist = allowedHosts.has(host);
  const inLearned = isLearned(host);
  if (!inAllowlist && !inLearned) {
    if (isPrivateHost(host)) throw httpError(403, 'Destino interno bloqueado');
    throw httpError(403, 'Host não autorizado');
  }
  const safe = await resolveAndCheck(host);
  if (!safe) throw httpError(403, 'Resolver para IP privado bloqueado');
  return url;
}

/** Sempre aprende os hosts intermediários/finais de um redirect de fonte confiável. */
function processRedirect(locationUrl, allowedHosts, originHost) {
  const target = new URL(locationUrl, `https://${originHost}/`);
  learnHost(target.hostname);
  return target;
}

module.exports = {
  MAX_REDIRECTS,
  validateUrl,
  isPrivateHost,
  learnHost,
  isLearned,
  processRedirect,
  normalizeHost,
  httpError,
};