const { createChannelId } = require('../utils/ids');
const { cleanLogo, normalizeEpgId, slugify } = require('../utils/normalize');

const CATEGORIES = [
  { catalogId: 'maxnet-todos', name: 'Todos', apiKey: 'todos', order: 0, searchable: true },
  { catalogId: 'maxnet-abertos', name: 'Abertos', apiKey: 'abertos', order: 1 },
  { catalogId: 'maxnet-sports', name: 'Esportes', apiKey: 'sports', order: 2 },
  { catalogId: 'maxnet-news', name: 'Notícias', apiKey: 'news', order: 3 },
  { catalogId: 'maxnet-infantil', name: 'Infantil', apiKey: 'infantil', order: 4 },
  { catalogId: 'maxnet-variedades', name: 'Variedades', apiKey: 'variedades', order: 5 },
  { catalogId: 'maxnet-docs', name: 'Documentários', apiKey: 'docs', order: 6 },
  { catalogId: 'maxnet-filmseseries', name: 'Filmes & Séries', apiKey: 'filmseseries', order: 7 },
  { catalogId: 'maxnet-24horas', name: '24 Horas', apiKey: '24horas', order: 8 },
  { catalogId: 'maxnet-events', name: 'Eventos', apiKey: 'events', order: 9 },
];

function apiKeyToCatalogId(apiKey) {
  const found = CATEGORIES.find((c) => c.apiKey === apiKey);
  return found ? found.catalogId : 'maxnet-todos';
}

function catalogIdToApiKey(catalogId) {
  const found = CATEGORIES.find((c) => c.catalogId === catalogId);
  return found && found.apiKey !== 'todos' ? found.apiKey : null;
}

/**
 * Normaliza um canal bruto da API externa para o modelo interno.
 * @param {object} raw canal retornado por /api/canais/*
 * @returns {object} modelo interno do canal
 */
function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = raw.tabela || 'todos';
  const numericId = raw.id ?? slugify(raw.name || 'ch');
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((s) => s && typeof s.link === 'string' && /^https?:\/\//i.test(s.link))
        .map((s) => ({ name: String(s.name || 'Fonte'), link: String(s.link) }))
    : [];
  return {
    id: createChannelId(category, numericId),
    category,
    legacyId: raw.id,
    name: String(raw.name || `Canal ${numericId}`),
    logo: cleanLogo(raw.logo),
    ref: raw.ref || '',
    description: raw.extra || '',
    idCanal: normalizeEpgId(raw.id_canal) || null,
    sources,
    raw,
  };
}

function channelNameWithFallback() {
  return 'Canal';
}

/**
 * Item de catálogo Stremio a partir do modelo interno.
 */
function toCatalogItem(channel) {
  return {
    id: channel.id,
    type: 'channel',
    name: channel.name,
    poster: channel.logo || undefined,
    posterThumb: channel.logo || undefined,
    background: channel.logo || undefined,
    genres: channel.description ? [channel.description] : undefined,
  };
}

/**
 * Meta Stremio a partir do modelo interno (+ contexto opcional de EPG).
 * @param {object} channel modelo interno
 * @param {object|null} now programa atual do EPG {title, start, stop} | null
 * @param {string|null} next título do próximo programa | null
 */
function toMeta(channel, now, next) {
  const descriptionParts = [];
  if (channel.description) descriptionParts.push(channel.description);
  if (now && now.title) {
    descriptionParts.push(`Agora no ar: ${now.title}${now.stopText ? ` (até ${now.stopText})` : ''}`);
  }
  if (next && next !== now?.title) {
    descriptionParts.push(`A seguir: ${next}`);
  }
  const genre = channel.category ? [channel.category] : undefined;
  const meta = {
    id: channel.id,
    type: 'channel',
    name: channel.name,
    poster: channel.logo || undefined,
    background: channel.logo || undefined,
    logo: channel.logo || undefined,
    description: descriptionParts.length ? descriptionParts.join('\n') : 'Canal de TV ao vivo.',
    genres: genre,
  };
  if (channel.sources && channel.sources.length) {
    meta.videos = channel.sources.map((s, i) => ({
      id: `${channel.id}:src-${i}`,
      title: s.name || `Fonte ${i + 1}`,
    }));
  }
  return meta;
}

module.exports = {
  CATEGORIES,
  apiKeyToCatalogId,
  catalogIdToApiKey,
  normalizeChannel,
  toCatalogItem,
  toMeta,
  channelNameWithFallback,
};