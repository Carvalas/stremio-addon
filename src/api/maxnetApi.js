/**
 * maxnetApi — cliente da API do Max Net TV.
 * Fachada sobre os módulos de transporte (channels/epg/streams).
 */
const channelsApi = require('./channels');
const epgApi = require('./epg');
const streamsApi = require('./streams');

const BASE_API = channelsApi.BASE_API;

/** Todos os canais (endpoint `todos`, um único fetch alimenta tudo). */
function getAllChannels() {
  return channelsApi.fetchChannels('');
}

/** Canais de uma categoria/`tabela` (ex.: abertos, sports, infantil, 24horas…). */
function getChannelsByCategory(category) {
  const base = `${BASE_API}/api/canais/${encodeURIComponent(category)}`;
  const withOrderBy = ['sports', 'news', 'infantil', 'variedades', 'docs', 'filmseseries'].includes(category);
  return channelsApi.requestJson(`${base}${withOrderBy ? '?orderBy=name' : ''}`);
}

/** Busca parcial por nome (case-insensitive). */
function searchChannels(query) {
  return channelsApi.fetchChannels(query);
}

/** Configuração global + regras de stream (streams_info). */
function getAppStart() {
  return streamsApi.fetchAppStart();
}

/** XMLTV cru (string XML ~9 MB). */
function getEpg() {
  return epgApi.fetchEpgXml();
}

/** Interface "Estende" o canal ou resolve URL server-side (/getlink.php). */
function resolveGetLink(url) {
  return streamsApi.resolveGetLink(url);
}

module.exports = {
  BASE_API,
  getAllChannels,
  getChannelsByCategory,
  searchChannels,
  getAppStart,
  getEpg,
  resolveGetLink,
};