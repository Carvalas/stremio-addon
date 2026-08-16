/**
 * m3uService — gera uma playlist M3U consumível por players IPTV (Nuvio, etc.).
 *
 * Para cada canal reproduzível (mesmo gate do catálogo: lista precisa OU fonte
 * em host HEADER_WORKING), emite uma entrada apontando para:
 *   • fonte em host confirmado HEADER_WORKING → proxy local (/proxy?u=...);
 *   • senão, fonte direta confirmada (DIRECT_WORKING) → URL original.
 *
 * Modo `raw` (links crus, para M3U estático sem servidor): a fonte com host
 * confirmado é emitida com a URL original (em vez de /proxy) e o cabeçalho
 * ganha `url-tvg` apontando para o XMLTV do provedor — o player busca o EPG
 * direto, sem depender do addon.
 *
 * Permite o Nuvio carregar a lista sem depender do Stremio, e funciona tanto
 * na máquina local (http://localhost:7000) quanto numa VM 24/7 (PROXY_BASE_URL).
 */
const channelService = require('./channelService');
const compat = require('./compatibility');
const streamService = require('./streamService');
const config = require('../utils/config');
const { CATEGORIES } = require('../adapters/maxnettvAdapter');

const DEFAULT_EPG_BASE = 'https://explouddev.com';
const CATEGORY_NAMES = new Map(CATEGORIES.map((c) => [c.apiKey, c.name]));

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Limpa um valor para uso seguro dentro de um atributo entre aspas. */
function cleanAttr(value) {
  return String(value || '').replace(/[\r\n\t"]/g, ' ').trim();
}

/** Limpa o nome exibido (mantém acentos; remove quebras de linha). */
function cleanName(value) {
  return String(value || 'Canal').replace(/[\r\n\t]+/g, ' ').trim();
}

function categoryLabel(apiKey) {
  return CATEGORY_NAMES.get(apiKey) || cleanAttr(apiKey) || 'Canais';
}

/**
 * Constrói a playlist a partir de canais normalizados.
 * @param {Array} channels canais de channelService.getChannels()
 * @param {object} opts
 *   { hwHosts: Set, compatIds: Set|null, proxyBase: string, raw: boolean, epgUrl: string }
 */
function buildM3uFrom(
  channels,
  { hwHosts = new Set(), compatIds = null, proxyBase = '', raw = false, epgUrl = '' } = {}
) {
  if (!Array.isArray(channels)) return '#EXTM3U\n';
  const proxyBaseNorm = String(proxyBase || '').replace(/\/+$/, '');
  const lines = ['#EXTM3U'];
  if (raw && epgUrl) lines[0] = `#EXTM3U url-tvg="${cleanAttr(epgUrl)}"`;
  const seen = new Set();

  for (const channel of channels) {
    if (!channel || !channel.id || seen.has(channel.id)) continue;
    if (!Array.isArray(channel.sources) || !channel.sources.length) continue;

    let url = '';
    // 1) fonte com host confirmado HEADER_WORKING (mesmo gate do catálogo)
    const headerSource = channel.sources.find((s) => s && s.link && hwHosts.has(hostOf(s.link)));
    if (headerSource) {
      const link = streamService.normalizePlutoPlaceholders(headerSource.link);
      if (raw) {
        url = link; // modo estático: link cru, sem proxy
      } else if (proxyBaseNorm) {
        url = `${proxyBaseNorm}/proxy?u=${encodeURIComponent(link)}`;
      }
    } else if (compatIds && compatIds.has(channel.id)) {
      // 2) canal na lista precisa → usa a primeira fonte (direta confirmada)
      const direct = channel.sources.find((s) => s && /^https?:\/\//i.test(s.link));
      if (direct) {
        url = streamService.normalizePlutoPlaceholders(direct.link);
      }
    }

    if (!url) continue;
    seen.add(channel.id);

    const name = cleanName(channel.name);
    const logo = cleanAttr(channel.logo);
    const tvgId = cleanAttr(channel.idCanal || channel.id);
    const group = categoryLabel(channel.category);

    const attrs = [`tvg-id="${tvgId}"`, `tvg-name="${name}"`, `group-title="${group}"`];
    if (logo) attrs.push(`tvg-logo="${logo}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${name}`);
    lines.push(url);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Constrói a playlist completa com os dados atuais (canais + análise).
 * @param {object} opts { raw: boolean } — raw=true → links crus + url-tvg (sem servidor)
 */
async function buildM3uText({ raw = false } = {}) {
  const [channels, hwHosts, compatIds] = await Promise.all([
    channelService.getChannels(),
    Promise.resolve(compat.loadHostSet()),
    Promise.resolve(compat.load()),
  ]);
  const proxyBase = String(
    process.env.PROXY_BASE_URL || config.publicBaseUrl()
  ).replace(/\/+$/, '');
  const epgBase = String(process.env.EPG_BASE_URL || DEFAULT_EPG_BASE).replace(/\/+$/, '');
  return buildM3uFrom(channels, {
    hwHosts,
    compatIds,
    proxyBase,
    raw,
    epgUrl: raw ? `${epgBase}/api/app/epg.xml` : '',
  });
}

module.exports = {
  buildM3uFrom,
  buildM3uText,
  hostOf,
  cleanAttr,
  cleanName,
  categoryLabel,
};