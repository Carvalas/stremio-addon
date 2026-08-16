const { CATEGORIES } = require('./adapters/maxnettvAdapter');

const version = require('../package.json').version;

const manifest = {
  id: 'com.maxnet.stremio',
  version,
  name: 'Max Net TV',
  description:
    'Canais de TV ao vivo Max Net TV (abertos, esportes, notícias, infantil, variedades, 24 horas). Baseado na API pública usada pelo aplicativo Max Net TV.',
  logo: 'https://explouddev.com/maxnettv/logos/mntv_globo0001.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['channel'],
  idPrefixes: ['maxnet:'],
  catalogs: CATEGORIES.map((c) => ({
    type: 'channel',
    id: c.catalogId,
    name: c.name,
    extra: c.searchable ? [{ name: 'search', isRequired: false }] : [],
  })),
};

module.exports = manifest;