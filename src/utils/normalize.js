const crypto = require('crypto');

const ID_PREFIX = 'maxnet';
const ID_SEP = ':';

function slugify(v, max = 60) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .slice(0, max);
}

function buildChannelId(category, numericId) {
  return `${ID_PREFIX}${ID_SEP}${encodeURIComponent(category)}${ID_SEP}${numericId}`;
}

function parseChannelId(stremioId) {
  if (!stremioId) return null;
  const clean = String(stremioId)
    .replace(/^plugin:\/\/[^/]+\//, '')
    .replace(/^channel:/, '');
  const parts = clean.split(ID_SEP);
  if (parts.length !== 3 || parts[0] !== ID_PREFIX) return null;
  return { prefix: parts[0], category: decodeURIComponent(parts[1]), numericId: parts[2] };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function cleanLogo(url) {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function decodeXmlEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function normalizeEpgId(idCanal) {
  if (!idCanal) return null;
  return decodeXmlEntities(String(idCanal).trim());
}

module.exports = {
  ID_PREFIX,
  ID_SEP,
  buildChannelId,
  parseChannelId,
  slugify,
  sha256Hex,
  cleanLogo,
  decodeXmlEntities,
  normalizeEpgId,
};