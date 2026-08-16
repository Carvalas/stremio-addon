const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../src/manifest');
const { resolveRawUrl } = require('../src/services/m3uService');
const {
  buildAddonPayloads,
  catalogMetas,
  resolveSourceRawUrl,
} = require('../src/services/addonExportService');

const HOST = 'dns.explouddev.com';
const hwHosts = new Set([HOST]);

function channel(id, name, sources, extra = {}) {
  return {
    id,
    name,
    category: extra.category || 'todos',
    logo: extra.logo || 'http://logo/x.png',
    idCanal: extra.idCanal || null,
    sources,
    ...extra,
  };
}

test('manifest: shape do addon estatico', () => {
  assert.strictEqual(manifest.id, 'com.maxnet.stremio');
  assert.ok(manifest.resources.includes('catalog'));
  assert.ok(manifest.resources.includes('meta'));
  assert.ok(manifest.resources.includes('stream'));
  assert.ok(manifest.types.includes('channel'));
  assert.ok(manifest.catalogs.some((c) => c.id === 'maxnet-todos'));
});

test('addon: manifest embutido no payload', () => {
  const { manifest: m } = buildAddonPayloads([], { hwHosts, compatIds: new Set() });
  assert.strictEqual(m.id, 'com.maxnet.stremio');
});

test('addon: fonte em host HEADER_WORKING vira link cru no stream', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }], { category: 'sports' })];
  const { streams } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  assert.ok(streams.length >= 1);
  const chan = streams.find((s) => s.id === 'maxnet:sports:10');
  assert.ok(chan);
  assert.strictEqual(chan.url, link);
  assert.ok(!chan.url.includes('/proxy'));
});

test('addon: stream gerado para o id do canal E para cada fonte (:src-N)', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [
      { name: 'Fonte 1', link },
      { name: 'Fonte 2', link },
    ], { category: 'sports' }),
  ];
  const { streams } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  const ids = streams.map((s) => s.id);
  assert.ok(ids.includes('maxnet:sports:10'));
  assert.ok(ids.includes('maxnet:sports:10:src-0'));
  assert.ok(ids.includes('maxnet:sports:10:src-1'));
  const chan = streams.find((s) => s.id === 'maxnet:sports:10');
  const src0 = streams.find((s) => s.id === 'maxnet:sports:10:src-0');
  assert.strictEqual(src0.url, chan.url);
});

test('addon: meta expoe videos por padrao, so com fontes reproduziveis', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }], { category: 'sports' })];
  const { metas } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  assert.strictEqual(metas.length, 1);
  assert.ok(Array.isArray(metas[0].meta.videos));
  assert.strictEqual(metas[0].meta.videos.length, 1);
  assert.strictEqual(metas[0].meta.videos[0].id, 'maxnet:sports:10:src-0');
  assert.strictEqual(metas[0].meta.videos[0].title, 'Fonte');
});

test('addon: withVideos=false remove a lista de fontes (abre direto)', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }], { category: 'sports' })];
  const { metas } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set(), withVideos: false });
  assert.strictEqual(metas[0].meta.videos, undefined);
});

test('addon: cada fonte reproduzivel toca a propria URL (src-N distinto)', () => {
  const link0 = `http://${HOST}:80/live/1/2/749.m3u8`;
  const link1 = `http://${HOST}:80/live/1/2/2376.m3u8`;
  const channels = [
    channel('maxnet:abertos:7', 'Globo', [
      { name: 'Globo SP(CDN)', link: link0 },
      { name: 'Globo RJ(CDN)', link: link1 },
    ], { category: 'abertos' }),
  ];
  const { streams, metas } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  const src0 = streams.find((s) => s.id === 'maxnet:abertos:7:src-0');
  const src1 = streams.find((s) => s.id === 'maxnet:abertos:7:src-1');
  assert.strictEqual(src0.url, link0);
  assert.strictEqual(src1.url, link1);
  assert.notStrictEqual(src0.url, src1.url);
  assert.deepStrictEqual(metas[0].meta.videos.map((v) => v.id), ['maxnet:abertos:7:src-0', 'maxnet:abertos:7:src-1']);
});

test('addon: fonte que exigiria proxy fica fora de videos e streams', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [
      { name: 'Opcao 01(CDN)', link },
      { name: 'Opcao 02', link: 'http://191.96.224.143/x.m3u8' },
    ], { category: 'sports' }),
  ];
  const { streams, metas } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  const ids = streams.map((s) => s.id);
  assert.ok(ids.includes('maxnet:sports:10:src-0'));
  assert.ok(!ids.includes('maxnet:sports:10:src-1'));
  assert.deepStrictEqual(metas[0].meta.videos.map((v) => v.id), ['maxnet:sports:10:src-0']);
});

test('addon: fonte direta de canal na lista precisa entra (sem host header)', () => {
  const link = 'http://hls1.sua.tv/live/globo/s.m3u8';
  const channels = [channel('maxnet:abertos:7', 'Globo', [{ name: 'Globo BA(CDN)', link }], { category: 'abertos' })];
  const { streams, metas } = buildAddonPayloads(channels, {
    hwHosts,
    compatIds: new Set(['maxnet:abertos:7']),
  });
  assert.strictEqual(streams[0].url, link);
  assert.strictEqual(metas[0].meta.videos[0].id, 'maxnet:abertos:7:src-0');
});

test('resolveSourceRawUrl: header, direto (canal compat), e vazio', () => {
  const header = channel('maxnet:sports:10', 'A', [{ link: `http://${HOST}/a.m3u8` }]);
  assert.strictEqual(resolveSourceRawUrl(header, header.sources[0], { hwHosts, compatIds: new Set() }), `http://${HOST}/a.m3u8`);

  const direct = channel('maxnet:abertos:7', 'B', [{ link: 'http://hls1.sua.tv/live/globo/s.m3u8' }]);
  assert.strictEqual(
    resolveSourceRawUrl(direct, direct.sources[0], { hwHosts, compatIds: new Set(['maxnet:abertos:7']) }),
    'http://hls1.sua.tv/live/globo/s.m3u8'
  );

  const none = channel('maxnet:24horas:99', 'C', [{ link: 'http://191.96.224.143/x.m3u8' }]);
  assert.strictEqual(resolveSourceRawUrl(none, none.sources[0], { hwHosts, compatIds: new Set(['maxnet:abertos:7']) }), '');

  assert.strictEqual(resolveSourceRawUrl(null, null, { hwHosts, compatIds: new Set() }), '');
});

test('addon: canal na lista precisa sem host de header usa URL direta', () => {
  const link = 'http://hls1.sua.tv/live/globo/s.m3u8';
  const channels = [channel('maxnet:abertos:7', 'Globo', [{ name: 'Fonte', link }], { category: 'abertos' })];
  const { streams } = buildAddonPayloads(channels, {
    hwHosts,
    compatIds: new Set(['maxnet:abertos:7']),
  });
  assert.strictEqual(streams[0].url, link);
});

test('addon: canal sem URL crua fica fora de streams e metas', () => {
  const channels = [
    channel('maxnet:24horas:99', 'X', [{ link: 'http://191.96.224.143/x.m3u8' }], { category: '24horas' }),
  ];
  const { streams, metas } = buildAddonPayloads(channels, {
    hwHosts,
    compatIds: new Set(['maxnet:abertos:7']),
  });
  assert.strictEqual(streams.length, 0);
  assert.strictEqual(metas.length, 0);
});

test('addon: catalogo de categoria filtra por categoria e compatibilidade', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [{ link: `http://${HOST}/a.m3u8` }], { category: 'sports' }),
    channel('maxnet:sports:11', 'Premiere', [{ link: 'http://outro.host/b.m3u8' }], { category: 'sports' }),
    channel('maxnet:news:4', 'CNN', [{ link: `http://${HOST}/c.m3u8` }], { category: 'news' }),
  ];
  const metas = catalogMetas(channels, 'sports', { hwHosts, compatIds: new Set() });
  assert.deepStrictEqual(metas.map((m) => m.name), ['SporTV']);
  assert.ok(metas.every((m) => m.type === 'channel' && m.id && m.name));
});

test('addon: catalogo "todos" inclui todas as categorias (somente compativeis)', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [{ link: `http://${HOST}/a.m3u8` }], { category: 'sports' }),
    channel('maxnet:news:4', 'CNN', [{ link: 'http://outro.host/c.m3u8' }], { category: 'news' }),
  ];
  const metas = catalogMetas(channels, 'todos', { hwHosts, compatIds: new Set() });
  assert.deepStrictEqual(metas.map((m) => m.name).sort(), ['SporTV']);
});

test('addon: payload de meta tem id/name/poster', () => {
  const link = `http://${HOST}/a.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }], { category: 'sports' })];
  const { metas } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].meta.id, 'maxnet:sports:10');
  assert.strictEqual(metas[0].meta.name, 'SporTV');
  assert.strictEqual(metas[0].meta.poster, 'http://logo/x.png');
});

test('resolveRawUrl: header cru, direto, e vazio', () => {
  const header = channel('maxnet:sports:10', 'A', [{ link: `http://${HOST}/a.m3u8` }]);
  assert.strictEqual(resolveRawUrl(header, { hwHosts, compatIds: new Set() }), `http://${HOST}/a.m3u8`);

  const direct = channel('maxnet:abertos:7', 'B', [{ link: 'http://hls1.sua.tv/live/globo/s.m3u8' }]);
  assert.strictEqual(
    resolveRawUrl(direct, { hwHosts, compatIds: new Set(['maxnet:abertos:7']) }),
    'http://hls1.sua.tv/live/globo/s.m3u8'
  );

  const none = channel('maxnet:24horas:99', 'C', [{ link: 'http://191.96.224.143/x.m3u8' }]);
  assert.strictEqual(resolveRawUrl(none, { hwHosts, compatIds: new Set(['maxnet:abertos:7']) }), '');

  assert.strictEqual(resolveRawUrl(header, { hwHosts: new Set(), compatIds: new Set() }), '');
  assert.strictEqual(resolveRawUrl(null, { hwHosts, compatIds: new Set() }), '');
});

test('addon: normaliza placeholders Pluto no link cru', () => {
  const link = `http://${HOST}/live/{PSID}/{TARGETOPT}/x.m3u8`;
  const channels = [channel('maxnet:filmseseries:1', 'Pluto', [{ name: 'Fonte', link }], { category: 'filmseseries' })];
  const { streams } = buildAddonPayloads(channels, { hwHosts, compatIds: new Set() });
  assert.strictEqual(streams[0].url, `http://${HOST}/live/stremio/0/x.m3u8`);
});