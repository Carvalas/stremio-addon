/**
 * addonExportService — monta o payload de um addon ESTÁTICO (manifest, catálogos,
 * streams e metas) a partir dos canais atuais.
 *
 * Usa o MESMO gate do catálogo/M3U:
 *   • catálogos por categoria filtrados por compatibilidade (ids/hosts);
 *   • stream com link CRU (sem /proxy) via resolveRawUrl;
 *   • meta simples (nome/logo) sem EPG.
 */
const compat = require('./compatibility');
const m3uService = require('./m3uService');
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
 * Monta os arquivos do addon estático.
 * @param {Array} channels canais normalizados (channelService.getChannels)
 * @param {object} opts { hwHosts: Set, compatIds: Set|null }
 * @returns {{ manifest: object, catalogs: Array, streams: Array, metas: Array }}
 *   catalogs: [{ catalogId, metas }]
 *   streams:  [{ id, url }]       — somente canais com URL crua
 *   metas:    [{ id, meta }]      — somente canais com URL crua
 */
function buildAddonPayloads(channels, { hwHosts = new Set(), compatIds = null } = {}) {
  const catalogs = CATEGORIES.map((c) => ({
    catalogId: c.catalogId,
    metas: catalogMetas(channels, c.apiKey, { hwHosts, compatIds }),
  }));

  const streams = [];
  const metas = [];
  for (const ch of channels || []) {
    if (!ch || !ch.id) continue;
    const url = m3uService.resolveRawUrl(ch, { hwHosts, compatIds });
    if (!url) continue;
    streams.push({ id: ch.id, url });
    metas.push({ id: ch.id, meta: toMeta(ch, null, null) });
  }

  return { manifest, catalogs, streams, metas };
}

module.exports = { buildAddonPayloads, catalogMetas };