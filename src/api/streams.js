const logger = require('../utils/logger');

const BASE_API = process.env.API_BASE_URL || 'https://explouddev.com.br';
const DEFAULT_UA = 'MaxNetTV/12.4 (Linux;Android 10) AndroidXMedia3/1.1.1';
const tag = 'api-streams';

async function fetchAppStart() {
  const url = `${BASE_API}/api/app/app_start.php`;
  logger.debug(tag, `GET ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}

async function resolveGetLink(streamUrl) {
  const b64 = Buffer.from(String(streamUrl)).toString('base64');
  const url = `${BASE_API}/getlink.php?url=${encodeURIComponent(b64)}`;
  logger.debug(tag, `GET ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  // o endpoint pode embrulhar warnings do PHP antes do JSON
  const start = text.indexOf('{');
  if (start === -1) return { success: false, message: text.slice(0, 200) };
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return { success: false, message: text.slice(0, 200) };
  }
}

module.exports = { BASE_API, fetchAppStart, resolveGetLink };