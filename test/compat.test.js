const test = require('node:test');
const assert = require('node:assert');
const { buildCompatibleList, filterChannels, filterChannelsWithHosts } = require('../src/services/compatibility');

test('compat: buildCompatibleList monta ids completos só para compatíveis', () => {
  const rows = [
    { channelId: 'abertos:7', name: 'Globo', compatible: true },
    { channelId: 'sports:10', name: 'SporTV', compatible: false },
    { channelId: 'news:4', name: 'Record News', compatible: true },
    { channelId: 'sem-id', name: 'Quebrado', compatible: true },
  ];
  const list = buildCompatibleList(rows);
  assert.deepStrictEqual(list, [
    { id: 'maxnet:abertos:7', name: 'Globo' },
    { id: 'maxnet:news:4', name: 'Record News' },
  ]);
});

test('compat: buildCompatibleList tolera rows inválidas', () => {
  assert.deepStrictEqual(buildCompatibleList(null), []);
  assert.deepStrictEqual(buildCompatibleList([null, {}, { channelId: 'x:1', compatible: true }]), [
    { id: 'maxnet:x:1', name: undefined },
  ]);
});

test('compat: filterChannels mantém só ids do set', () => {
  const ids = new Set(['maxnet:abertos:7']);
  const list = [
    { id: 'maxnet:abertos:7', name: 'Globo' },
    { id: 'maxnet:sports:125', name: 'GE TV' },
  ];
  assert.deepStrictEqual(filterChannels(list, ids), [{ id: 'maxnet:abertos:7', name: 'Globo' }]);
});

test('compat: ids null/∅ passa tudo (filtro desativado)', () => {
  const list = [{ id: 'maxnet:abertos:7' }, { id: 'maxnet:sports:125' }];
  assert.strictEqual(filterChannels(list, null).length, 2);
  assert.strictEqual(filterChannels(list, new Set()).length, 2);
  assert.strictEqual(filterChannels(undefined, new Set('maxnet:abertos:7')), undefined);
});

test('compat: filterChannelsWithHosts mantém canal de host confirmado mesmo fora da lista', () => {
  const channels = [
    { id: 'maxnet:filmseseries:1', name: 'HBO', sources: [{ link: 'http://dns.explouddev.com:80/live/1/2/3.m3u8' }] },
    { id: 'maxnet:abertos:7', name: 'Globo', sources: [{ link: 'http://hls1.sua.tv/x.m3u8' }] },
    { id: 'maxnet:24horas:99', name: 'X', sources: [{ link: 'http://191.96.224.143/x.m3u8' }] },
  ];
  const ids = new Set(['maxnet:abertos:7']);
  const hosts = new Set(['dns.explouddev.com']);
  const out = filterChannelsWithHosts(channels, ids, hosts);
  assert.deepStrictEqual(out.map((c) => c.name), ['HBO', 'Globo']);
  // 191.96.224.143 não está entre os hosts confirmados → fora
});

test('compat: filterChannelsWithHosts com ids null mantém tudo', () => {
  const list = [{ id: 'x:1', sources: [{ link: 'http://qualquer/m.m3u8' }] }];
  assert.strictEqual(filterChannelsWithHosts(list, null, new Set()).length, 1);
});