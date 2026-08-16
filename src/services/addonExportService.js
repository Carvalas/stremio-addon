/**
 * addonExportService — monta o payload de um addon ESTÁTICO (manifest, catálogos,
 * streams e metas) a partir dos canais atuais.
 *
 * Usa o MESMO gate do catálogo/M3U:
 *   • catálogos por categoria filtrados por compatibilidade (ids/hosts);
 *   • stream com link CRU (sem /proxy) via resolveSourceRawUrl — por FONTE;
 *   • meta com lista de vídeos por padrão, contendo apenas fontes
 *     reproduzíveis (cada opção :src-N toca o próprio sinal).
 */
const compat = require('./compatibility');
const m3uService = require('./m3uService');
const streamService = require('./streamService');
const { CATEGORIES, toCatalogItem, toMeta } = require('../adapters/maxnettvAdapter');
const manifest = require('../manifest');

function catalogMetas(channels, apiKey, { hwHosts, compatIds }) {
  let list = apiKey === 'todos' ? channels : channels.filter((c) => c && c.category === apiKey);
  if (apiKey !== 'todos') {
    list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }
  return compat.filterChannelsWithHosts(list, compatIds, hwHosts).map(toCatalogItem);
}

/**
 * URL crua reproduzível para UMA fonte específica (mesma lógica de gate):
 *   • host confirmado HEADER_WORKING → link cru da própria fonte;
 *   • senão, canal na lista precisa e fonte http → link direto;
 *   • senão '' (exigiria proxy → não reproduzível sem servidor).
 * @param {object} channel modelo interno do canal
 * @param {object} source fonte (channel.sources[i])
 * @param {object} opts { hwHosts: Set, compatIds: Set|null }
 */
function resolveSourceRawUrl(channel, source, { hwHosts = new Set(), compatIds = null } = {}) {
  if (!channel || !source || !source.link) return '';
  if (hwHosts.has(m3uService.hostOf(source.link))) {
    return streamService.normalizePlutoPlaceholders(source.link);
  }
  if (compatIds && compatIds.has(channel.id) && /^https?:\/\//i.test(source.link)) {
    return streamService.normalizePlutoPlaceholders(source.link);
  }
  return '';
}

/**
 * Monta os arquivos do addon estático.
 * @param {Array} channels canais normalizados (channelService.getChannels)
 * @param {object} opts { hwHosts: Set, compatIds: Set|null, withVideos: bool }
 *   withVideos=true (padrão): a meta expõe `videos` com as fontes reproduzíveis
 *   (cada uma toca o próprio sinal via :src-N). Com false, sem lista na ficha
 *   (abertura direta pelo id do canal; os :src-N continuam gerados).
 * @returns {{ manifest: object, catalogs: Array, streams: Array, metas: Array }}
 *   catalogs: [{ catalogId, metas }]
 *   streams:  [{ id, entries }]   — id do canal (entries = TODAS as fontes
 *                                   reproduzíveis, nomeadas) + um por fonte
 *                                   (:src-N, com a própria URL crua)
 *   metas:    [{ id, meta }]      — somente canais com ≥1 fonte reproduzível
 */
function buildAddonPayloads(channels, { hwHosts = new Set(), compatIds = null, withVideos = true } = {}) {
  const catalogs = CATEGORIES.map((c) => ({
    catalogId: c.catalogId,
    metas: catalogMetas(channels, c.apiKey, { hwHosts, compatIds }),
  }));

  const streams = [];
  const metas = [];
  for (const ch of channels || []) {
    if (!ch || !ch.id) continue;
    const playable = [];
    for (let i = 0; i < (ch.sources || []).length; i++) {
      const url = resolveSourceRawUrl(ch, ch.sources[i], { hwHosts, compatIds });
      if (url) playable.push({ i, url, name: ch.sources[i].name || `Fonte ${i + 1}` });
    }
    if (!playable.length) continue;

    const meta = toMeta(ch, null, null);
    if (withVideos) {
      meta.videos = playable.map((p) => ({ id: `${ch.id}:src-${p.i}`, title: p.name }));
    } else if (meta.videos) {
      delete meta.videos;
    }
    streams.push({
      id: ch.id,
      entries: playable.map((p) => ({ name: p.name, title: p.name, url: p.url })),
    });
    for (const p of playable) {
      streams.push({ id: `${ch.id}:src-${p.i}`, entries: [{ name: p.name, title: p.name, url: p.url }] });
    }
    metas.push({ id: ch.id, meta });
  }

  return { manifest, catalogs, streams, metas };
}

module.exports = { buildAddonPayloads, catalogMetas, resolveSourceRawUrl };