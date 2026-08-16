const logger = require('../utils/logger');

const EPG_BASE_API = process.env.EPG_BASE_URL || 'https://explouddev.com';
const DEFAULT_UA = 'MaxNetTV/12.4 (Linux;Android 10) AndroidXMedia3/1.1.1';
const tag = 'api-epg';

async function fetchEpgXml() {
  const url = `${EPG_BASE_API}/api/app/epg.xml`;
  logger.debug(tag, `GET ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
  return text;
}

module.exports = { EPG_BASE_API, fetchEpgXml };