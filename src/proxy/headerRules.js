/**
 * headerRules — regras de `streams_info` do app_start + allowlist de hosts.
 *
 * É a fonte da verdade para:
 *   • quais fontes exigem headers (classificação HEADER vs DIRECT etc.);
 *   • quais headers injetar ao buscar upstream;
 *   • quais hosts são confiáveis para o proxy (anti open-proxy).
 */
const fs = require('fs');
const path = require('path');

const api = require('../api/streams');
const { TtlCache } = require('../cache/cache');
const logger = require('../utils/logger');
const { normalizeHost } = require('./security');

const tag = 'header-rules';

const RULES_TTL = Number(process.env.RULES_TTL_MS || 30 * 60 * 1000);
const ALLOWLIST_TTL = Number(process.env.ALLOWLIST_TTL_MS || 10 * 60 * 1000);
const OUT_DIR = process.env.ANALYZE_OUT_DIR || path.join(process.cwd(), 'out');

const HEADER_FIELDS = ['referer', 'useragent', 'requestedWith', 'origin'];

const rulesCache = new TtlCache({ defaultTtl: RULES_TTL, maxEntries: 20 });
const allowCache = new TtlCache({ defaultTtl: ALLOWLIST_TTL, maxEntries: 20 });

function normalizePlutoPlaceholders(url) {
  return String(url)
    .replace(/\{PSID\}/gi, 'stremio')
    .replace(/\{TARGETOPT\}/gi, '0');
}

function findRuleFor(rules, sourceUrl) {
  const lower = String(sourceUrl).toLowerCase();
  for (const rule of rules) {
    if (!rule || !rule.url) continue;
    const frag = String(rule.url).toLowerCase();
    if (frag && lower.includes(frag)) return rule;
  }
  return null;
}

function ruleNeedsHeaders(rule) {
  if (!rule) return false;
  return HEADER_FIELDS.some((k) => rule[k] && String(rule[k]).trim());
}

function headersFromRule(rule) {
  const headers = { Accept: '*/*' };
  if (rule && rule.useragent) headers['User-Agent'] = String(rule.useragent);
  if (rule && rule.referer) headers['Referer'] = String(rule.referer);
  if (rule && rule.origin) headers['Origin'] = String(rule.origin);
  if (rule && rule.requestedWith) headers['X-Requested-With'] = String(rule.requestedWith);
  return headers;
}

const NON_HTTP_RE = /^(data:|javascript:|blob:|about:)/i;

/**
 * Classificação estática de uma URL:
 *   DIRECT → sem headers, candidata a direto
 *   HEADER → regra exige headers (candidata ao proxy)
 *   PROTECTED / WEB / GETLINK / UNKNOWN / INVALID
 */
function classifyUrl(url) {
  const link = normalizePlutoPlaceholders(url).trim();
  if (!link || !/^https?:\/\//i.test(link) || NON_HTTP_RE.test(link)) {
    return { type: 'INVALID', rule: null, headers: null };
  }
  const rules = cachedRules();
  const rule = rules ? findRuleFor(rules, link) : null;
  if (!rule) return { type: 'UNKNOWN', rule: null, headers: null };
  const rtype = String(rule.type || 'direct');
  if (rtype === 'token') return { type: 'PROTECTED', rule, headers: null };
  if (rtype === 'w') return { type: 'WEB', rule, headers: null };
  if (rtype === 'getlink') return { type: 'GETLINK', rule, headers: null };
  if (ruleNeedsHeaders(rule)) {
    return { type: 'HEADER', rule, headers: headersFromRule(rule) };
  }
  return { type: 'DIRECT', rule, headers: headersFromRule(null) };
}

function cachedRules() {
  return rulesCache.get('streams:rules') || null;
}

/** Carrega (e cacheia) as regras de app_start. */
async function getRules() {
  return rulesCache.getOrSet('streams:rules', RULES_TTL, async () => {
    const app = await api.fetchAppStart();
    return Array.isArray(app.streams_info) ? app.streams_info : [];
  });
}

/** Headers a usar para buscar uma URL upstream, baseados na regra correspondente. */
function getHeadersForUrl(url) {
  const rules = cachedRules();
  const rule = rules ? findRuleFor(rules, url) : null;
  return headersFromRule(rule);
}

function uniqueHosts(list) {
  const out = new Set();
  for (const h of list) {
    const host = normalizeHost(h);
    if (host) out.add(host);
  }
  return out;
}

/** Hosts de mídia conhecidos: regras + fontes confirmadas como HEADER_WORKING. */
async function getAllowedHosts() {
  return allowCache.getOrSet('streams:allowlist', ALLOWLIST_TTL, async () => {
    const hosts = new Set();

    // 1) hosts das regras do app (contém dns.explouddev.com, sinal.cc, etc.)
    const rules = await getRules();
    for (const r of rules || []) {
      if (r.url) hosts.add(normalizeHost(r.url));
    }

    // 2) hosts das fontes HEADER_WORKING confirmadas na última análise
    const hwFile = path.join(OUT_DIR, 'header-working-sources.json');
    try {
      const rows = JSON.parse(fs.readFileSync(hwFile, 'utf8'));
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && row.link) {
            try {
              hosts.add(normalizeHost(new URL(row.link).hostname));
            } catch {
              /* ignora */
            }
          }
        }
      }
    } catch (err) {
      logger.debug(tag, `header-working-sources.json indisponível: ${err.message}`);
    }

    // 3) extras via env (separados por vírgula)
    if (process.env.PROXY_EXTRA_HOSTS) {
      for (const h of String(process.env.PROXY_EXTRA_HOSTS).split(',')) {
        const host = normalizeHost(h.trim());
        if (host) hosts.add(host);
      }
    }

    logger.debug(tag, `allowlist com ${hosts.size} hosts`);
    return [...hosts];
  });
}

async function getAllowedHostSet() {
  return new Set(await getAllowedHosts());
}

module.exports = {
  getRules,
  getHeadersForUrl,
  classifyUrl,
  getAllowedHosts,
  getAllowedHostSet,
  findRuleFor,
  ruleNeedsHeaders,
  normalizePlutoPlaceholders,
};