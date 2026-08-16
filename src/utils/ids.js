const ID_PREFIX = 'maxnet';
const ID_SEP = ':';

/**
 * Cria um id estável no formato `maxnet:<tabela>:<id>`.
 * `id` numérico não é único globalmente — a categoria entra no id.
 */
function createChannelId(category, numericId) {
  return `${ID_PREFIX}${ID_SEP}${encodeURIComponent(String(category || 'todos'))}${ID_SEP}${numericId}`;
}

/**
 * Divide um id Stremio no formato `maxnet:<tabela>:<id>`.
 * Retorna { prefix, category, numericId } ou null.
 */
function parseChannelId(stremioId) {
  if (!stremioId) return null;
  const clean = String(stremioId)
    .replace(/^plugin:\/\/[^/]+\//, '')
    .replace(/^channel:/, '');
  const parts = clean.split(ID_SEP);
  if (parts.length !== 3 || parts[0] !== ID_PREFIX) return null;
  return { prefix: parts[0], category: decodeURIComponent(parts[1]), numericId: parts[2] };
}

/** Id usado em relatórios/amostras (`tabela:id`), sem prefixo Stremio. */
function shortChannelId(category, numericId) {
  return `${category}:${numericId}`;
}

module.exports = { ID_PREFIX, ID_SEP, createChannelId, parseChannelId, shortChannelId };