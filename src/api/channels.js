const logger = require('../utils/logger');

const BASE_API = process.env.API_BASE_URL || 'https://explouddev.com.br';
const DEFAULT_UA = 'MaxNetTV/12.4 (Linux;Android 10) AndroidXMedia3/1.1.1';
const tag = 'api-channels';

async function requestJson(url, { timeout = 15000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json, */*',
    },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} para ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON inválido para ${url}: ${text.slice(0, 120)}`);
  }
}

function channelsUrl(query) {
  const base = `${BASE_API}/api/canais/todos`;
  const q = query === undefined ? '' : String(query);
  return `${base}?search=${encodeURIComponent(q)}`;
}

async function fetchChannels(query) {
  const url = channelsUrl(query);
  logger.debug(tag, `GET ${url}`);
  const data = await requestJson(url);
  if (!Array.isArray(data)) {
    throw new Error('Resposta de canais não é um array JSON');
  }
  return data;
}

module.exports = {
  BASE_API,
  requestJson,
  fetchChannels,
};