/**
 * streamService — resolução de streams para o Stremio.
 *
 *   • fontes DIRECT                   → URL original (validada por probe);
 *   • fontes DIRECT_WITH_HEADERS      → ONLY se confirmadas HEADER_WORKING na
 *                                       análise; entregues via proxy local de
 *                                       headers (/proxy), sem JWT/token;
 *   • fontes TOKEN / WEB              → ignoradas;
 *   • getlink                         → só se a URL final for direta.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TtlCache } = require('../cache/cache');
const api = require('../api/streams');
const channelService = require('./channelService');
const config = require('../utils/config');
const logger = require('../utils/logger');

const tag = 'stream-service';

const RULES_TTL = Number(process.env.RULES_TTL_MS || 30 * 60 * 1000); // regras app_start
const PROBE_TTL = Number(process.env.PROBE_TTL_MS || 10 * 60 * 1000); // resultado de probe
const PROBE_TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 8000);

const PLAYER_UA = process.env.PLAYER_UA || 'DVPlayer/35 (Android 9)';
const PROXY_ENABLED = process.env.PROXY_ENABLED !== 'false';
const OUT_DIR = process.env.ANALYZE_OUT_DIR || path.join(process.cwd(), 'out');
const HW_FILE = process.env.HEADER_WORKING_FILE || path.join(OUT_DIR, 'header-working-sources.json');
const PROXY_BASE =
  String(process.env.PROXY_BASE_URL || config.publicBaseUrl()).replace(/\/+$/, '') + '/proxy';

const rulesCache = new TtlCache({ defaultTtl: RULES_TTL, maxEntries: 50 });
const probeCache = new TtlCache({ defaultTtl: PROBE_TTL, maxEntries: 2000 });

const HEADER_FIELDS = ['referer', 'useragent', 'requestedWith', 'origin'];

let hwCache = null; // { map: Map<shortId, [{link,name}]>, mtime }

/** Fontes HEADER_WORKING confirmadas pela última análise. */
function loadHeaderWorking() {
  if (!PROXY_ENABLED) return { map: new Map(), hosts: new Set(), links: new Set() };
  try {
    const st = fs.statSync(HW_FILE);
    if (hwCache && hwCache.mtime === st.mtimeMs) return hwCache.data;
    const rows = JSON.parse(fs.readFileSync(HW_FILE, 'utf8'));
    const map = new Map();
    const hosts = new Set();
    const links = new Set();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!r || !r.channelId || !r.link) continue;
        if (!map.has(r.channelId)) map.set(r.channelId, []);
        map.get(r.channelId).push({ link: r.link, name: r.name || 'Fonte' });
        hosts.add(new URL(r.link).hostname);
        links.add(r.link);
      }
    }
    hwCache = { data: { map, hosts, links }, mtime: st.mtimeMs };
    return hwCache.data;
  } catch {
    return { map: new Map(), hosts: new Set(), links: new Set() };
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

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

/**
 * Classifica uma fonte com base nas regras de `streams_info`.
 * @returns {{type: string, compatible: boolean|null, reason: string, rule: object|null}}
 *   compatible: true  = confirmada direta    (só após probe)
 *   compatible: false = incompatível (sem resolver agora)
 *   compatible: null  = candidata (precisa de probe)
 */
function classifySource(source, rules) {
  const link = normalizePlutoPlaceholders(source && source.link ? source.link : '').trim();
  if (!link || !/^https?:\/\//i.test(link)) {
    return { type: 'INVALID', compatible: false, reason: 'URL inválida', rule: null };
  }
  const rule = findRuleFor(rules, link);
  if (!rule) {
    // sem regra: só é utilizável se o probe direto confirmar
    return { type: 'UNKNOWN', compatible: null, reason: 'Sem regra em streams_info', rule: null };
  }
  const rtype = String(rule.type || 'direct');
  if (rtype === 'token') return { type: 'TOKEN', compatible: false, reason: 'Requer endpoint de token', rule };
  if (rtype === 'w') return { type: 'WEB', compatible: false, reason: 'Depende de WebView/HTML', rule };
  if (rtype === 'getlink') return { type: 'GETLINK', compatible: null, reason: 'Resolve via /getlink.php', rule };
  if (ruleNeedsHeaders(rule)) {
    return { type: 'DIRECT_WITH_HEADERS', compatible: false, reason: `Headers exigidos pela regra (${rule.url})`, rule };
  }
  return { type: 'DIRECT', compatible: null, reason: 'Sem headers indicados na regra', rule };
}

function withHardTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('hard timeout')), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

const probeKey = (url) => `probe:${crypto.createHash('sha256').update(url).digest('hex')}`;

/** Probe direto (sem headers especiais) e cacheado. */
async function probeDirect(url) {
  return probeCache.getOrSet(probeKey(url), PROBE_TTL, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    try {
      const work = fetch(url, {
        headers: { 'User-Agent': PLAYER_UA, Accept: '*/*' },
        redirect: 'follow',
        signal: ctrl.signal,
      }).then(async (res) => {
        clearTimeout(t);
        if (!res.ok) return { ok: false };
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const head = (await res.text()).slice(0, 1500);
        return { ok: ct.includes('mpegurl') || head.includes('#EXTM3U') };
      });
      const r = await withHardTimeout(work, PROBE_TIMEOUT + 3000);
      logger.debug(tag, `probe ${r && r.ok ? 'OK' : 'FAIL'} ${url.slice(0, 90)}`);
      return r || { ok: false };
    } catch (err) {
      clearTimeout(t);
      return { ok: false };
    }
  });
}

async function resolveGetLinkUrl(link) {
  const result = await api.resolveGetLink(link);
  if (!result) return null;
  if (result.success && typeof result.link === 'string') return result.link;
  if (result.success && typeof result.url === 'string') return result.url;
  return null;
}

/**
 * Resolve UMA fonte para uma URL final diretamente utilizável, ou null.
 * Ordem: direta confirmada → proxy (HEADER_WORKING) → getlink (só se direta).
 */
async function resolveSourceToStream(source, channel, rules) {
  const cls = classifySource(source, rules);
  if (cls.type === 'INVALID') return null;

  // Fonte com headers: só entra via proxy se a análise confirmou HEADER_WORKING
  if (cls.type === 'DIRECT_WITH_HEADERS') {
    if (!PROXY_ENABLED) return null;
    const candidate = normalizePlutoPlaceholders(source.link).trim();
    const hw = loadHeaderWorking();
    // gate por host (links dns rotacionam por sessão; o host é o que vale)
    if (hw.hosts.has(hostOf(candidate))) {
      logger.debug(tag, `${channel.name}/${source.name}: via proxy (HEADER_WORKING)`);
      return {
        name: source.name || 'Fonte',
        title: `${source.name || 'Fonte'} (via proxy)`,
        url: `${PROXY_BASE}?u=${encodeURIComponent(candidate)}`,
        proxied: true,
      };
    }
    logger.debug(tag, `${channel.name}/${source.name}: ${cls.reason} (sem confirmação HEADER_WORKING)`);
    return null;
  }

  if (cls.compatible === false) {
    logger.debug(tag, `${channel.name}/${source.name}: ${cls.reason}`);
    return null;
  }

  let candidate = normalizePlutoPlaceholders(source.link).trim();

  if (cls.type === 'GETLINK') {
    const resolved = await resolveGetLinkUrl(candidate);
    if (!resolved) {
      logger.warn(tag, `getlink falhou para ${channel.name}/${source.name}`);
      return null;
    }
    candidate = normalizePlutoPlaceholders(resolved).trim();
  }

  const probe = await probeDirect(candidate);
  if (!probe.ok) {
    logger.debug(tag, `${channel.name}/${source.name}: probe falhou — ignorada`);
    return null;
  }

  return { name: source.name || cls.type, title: source.name || cls.type, url: candidate };
}

/**
 * Gera os streams Stremio para um id de canal.
 * Retorna somente fontes DIRECT confirmadas; se o canal não tiver nenhuma,
 * retorna [] (canal não reproduzível nesta arquitetura).
 * @param {string} stremioId 'maxnet:<cat>:<id>'
 */
async function getStreamsForChannel(stremioId) {
  const channel = await channelService.getChannelById(stremioId);
  if (!channel) {
    logger.warn(tag, `canal não encontrado: ${stremioId}`);
    return [];
  }
  if (!channel.sources || !channel.sources.length) {
    logger.warn(tag, `canal sem fontes: ${channel.name}`);
    return [];
  }

  const rulesCache2 = api.fetchAppStart;
  let rules = [];
  try {
    const app = await rulesCache.getOrSet('appstart:rules', RULES_TTL, () => rulesCache2());
    rules = Array.isArray(app.streams_info) ? app.streams_info : [];
  } catch (err) {
    logger.warn(tag, `sem regras app_start: ${err.message}`);
  }

  logger.info(tag, `resolvendo ${channel.sources.length} fonte(s) de ${channel.name}`);

  // resolve as fontes em paralelo (limite de concorrência), preservando a ordem da API
  const ordered = [...channel.sources];
  const slots = new Array(ordered.length);
  const CONC = 6;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= ordered.length) break;
      slots[idx] = await resolveSourceToStream(ordered[idx], channel, rules);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, ordered.length) }, () => worker()));
  const results = slots
    .filter(Boolean)
    .map((s) => ({ name: s.name, title: s.title, url: s.url }));

  if (!results.length) logger.info(tag, `canal ${channel.name}: nenhuma fonte direta`);
  return results;
}

module.exports = {
  getStreamsForChannel,
  classifySource,
  findRuleFor,
  ruleNeedsHeaders,
  normalizePlutoPlaceholders,
  probeDirect,
  probeCache,
  loadHeaderWorking,
  PROXY_ENABLED,
  PROXY_BASE,
};