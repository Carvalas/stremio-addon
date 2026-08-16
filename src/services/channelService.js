const { TtlCache } = require('../cache/cache');
const api = require('../api/channels');
const compat = require('./compatibility');
const logger = require('../utils/logger');
const {
  normalizeChannel,
  toCatalogItem,
  catalogIdToApiKey,
  apiKeyToCatalogId,
} = require('../adapters/maxnettvAdapter');
const { createChannelId, parseChannelId } = require('../utils/ids');

const tag = 'channel-service';

const CHANNELS_TTL = Number(process.env.CHANNELS_TTL_MS || 600000); // 10 min
const SEARCH_TTL = Number(process.env.SEARCH_TTL_MS || 300000); // 5 min

const cache = new TtlCache({ defaultTtl: CHANNELS_TTL, maxEntries: 200 });

function sortByName(list) {
  return list.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function getRawList() {
  return cache.getOrSet('channels:all', CHANNELS_TTL, async () => {
    logger.info(tag, 'Buscando lista de canais na API');
    const raw = await api.fetchChannels('');
    if (!Array.isArray(raw)) throw new Error('API retornou formato inesperado');
    const channels = [];
    for (const item of raw) {
      const ch = normalizeChannel(item);
      if (ch) channels.push(ch);
    }
    logger.info(tag, `${channels.length} canais carregados`);
    return channels;
  });
}

async function getChannels() {
  return getRawList();
}

async function getChannelsByCatalog(catalogId) {
  const all = await getRawList();
  const apiKey = catalogIdToApiKey(catalogId);
  if (!apiKey) return all;
  return sortByName(all.filter((c) => c.category === apiKey));
}

async function searchChannels(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `search:${q.toLowerCase()}`;
  return cache.getOrSet(key, SEARCH_TTL, async () => {
    logger.info(tag, `Buscando "${q}"`);
    const raw = await api.fetchChannels(q);
    if (!Array.isArray(raw)) return [];
    const seen = new Map();
    for (const item of raw) {
      const ch = normalizeChannel(item);
      if (ch) seen.set(ch.id, ch);
    }
    const list = [...seen.values()];
    const ids = compat.load();
    return sortByName(compat.filterChannelsWithHosts(list, ids, compat.loadHostSet()));
  });
}

async function getChannelById(stremioId) {
  const parsed = parseChannelId(stremioId);
  if (!parsed) {
    // fallback: procura por id_canal igual
    return findByIdCanal(stremioId);
  }
  const all = await getRawList();
  const want = createChannelId(parsed.category, parsed.numericId);
  return all.find((c) => c.id === want) || null;
}

async function findByIdCanal(idCanal) {
  if (!idCanal) return null;
  const all = await getRawList();
  const target = String(idCanal).trim().toLowerCase();
  return all.find((c) => c.idCanal && String(c.idCanal).toLowerCase() === target) || null;
}

async function catalog(catalogId) {
  const channels = await getChannelsByCatalog(catalogId);
  return compat
    .filterChannelsWithHosts(channels, compat.load(), compat.loadHostSet())
    .map(toCatalogItem);
}

module.exports = {
  catalog,
  getChannels,
  getChannelsByCatalog,
  searchChannels,
  getChannelById,
  findByIdCanal,
  apiKeyToCatalogId,
  cache,
};