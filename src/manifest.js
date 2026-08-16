const { CATEGORIES } = require('./adapters/maxnettvAdapter');

const version = require('../package.json').version;

const manifest = {
  id: 'com.maxnet.stremio',
  version,
  name: 'Live TV',
  description:
    'Catálogo de canais de TV ao vivo (abertos, esportes, notícias, infantil, variedades, documentários, 24 horas). Cada fonte é classificada por um probe HTTP e só é entregue se reproduzível diretamente, sem servidor ou proxy próprio.',
  logo: 'https://raw.githubusercontent.com/carvalas/stremio-addon/main/logo.svg',
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