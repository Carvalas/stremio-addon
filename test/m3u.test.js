const test = require('node:test');
const assert = require('node:assert');
const {
  buildM3uFrom,
  hostOf,
  cleanAttr,
  cleanName,
  categoryLabel,
} = require('../src/services/m3uService');

function channel(id, name, sources, extra = {}) {
  return {
    id,
    name,
    category: extra.category || 'sports',
    logo: extra.logo || '',
    idCanal: extra.idCanal || null,
    sources,
    ...extra,
  };
}

const HOST = 'dns.explouddev.com';
const hwHosts = new Set([HOST]);
const PROXY = 'http://localhost:7000';

test('m3u: fonte em host HEADER_WORKING vira URL de proxy', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [
      { name: 'Fonte', link: `http://${HOST}:80/live/1/2/749.m3u8` },
    ]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY });
  const lines = out.split('\n');
  assert.strictEqual(lines[0], '#EXTM3U');
  assert.match(lines[1], /^#EXTINF:-1 /);
  assert.strictEqual(
    lines[2],
    `${PROXY}/proxy?u=${encodeURIComponent(`http://${HOST}:80/live/1/2/749.m3u8`)}`
  );
});

test('m3u: canal na lista precisa sem host de header usa URL direta', () => {
  const link = 'http://hls1.sua.tv/live/globo/s.m3u8';
  const channels = [channel('maxnet:abertos:7', 'Globo', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(['maxnet:abertos:7']), proxyBase: PROXY });
  assert.ok(out.includes(`\n${link}\n`));
});

test('m3u: canal fora da lista e sem host de header é pulado', () => {
  const channels = [
    channel('maxnet:24horas:99', 'X', [{ name: 'Fonte', link: 'http://191.96.224.143/x.m3u8' }]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(['maxnet:abertos:7']), proxyBase: PROXY });
  assert.strictEqual(out.trim(), '#EXTM3U');
});

test('m3u: tvg-id usa idCanal, com fallback para o id do canal', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [{ link: `http://${HOST}/a.m3u8` }], { idCanal: 'sportv.hd' }),
    channel('maxnet:news:4', 'CNN', [{ link: `http://${HOST}/b.m3u8` }]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY });
  assert.match(out, /tvg-id="sportv.hd"/);
  assert.match(out, /tvg-id="maxnet:news:4"/);
});

test('m3u: atributos tvg-name, group-title e tvg-logo', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [{ link: `http://${HOST}/a.m3u8` }], {
      category: 'sports',
      logo: 'http://logo/x.png',
    }),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY });
  assert.match(out, /tvg-name="SporTV"/);
  assert.match(out, /group-title="Esportes"/);
  assert.match(out, /tvg-logo="http:\/\/logo\/x.png"/);
});

test('m3u: sem logo o atributo é omitido', () => {
  const channels = [
    channel('maxnet:news:4', 'CNN', [{ link: `http://${HOST}/b.m3u8` }]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY });
  assert.ok(!out.includes('tvg-logo='));
});

test('m3u: nome preserva vírgula, mas remove quebras de linha', () => {
  const channels = [
    channel('maxnet:filmseseries:1', 'HBO, Signature', [{ link: `http://${HOST}/c.m3u8` }]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY });
  assert.ok(out.includes(',HBO, Signature\n'));
});

test('m3u: lista vazia retorna apenas o cabeçalho', () => {
  assert.strictEqual(buildM3uFrom([], { hwHosts, compatIds: new Set(), proxyBase: PROXY }), '#EXTM3U\n');
  assert.strictEqual(buildM3uFrom(undefined, {}), '#EXTM3U\n');
});

test('m3u: sem proxyBase, fonte de header não gera URL (não quebra)', () => {
  const channels = [
    channel('maxnet:sports:10', 'SporTV', [{ link: `http://${HOST}/a.m3u8` }]),
  ];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: '' });
  assert.strictEqual(out.trim(), '#EXTM3U');
});

test('m3u: helpers de limpeza', () => {
  assert.strictEqual(hostOf('http://dns.explouddev.com:80/a'), 'dns.explouddev.com');
  assert.strictEqual(hostOf('url-invalida'), '');
  assert.strictEqual(cleanAttr('a"b\nc\td'), 'a b c d');
  assert.strictEqual(cleanName('Nome\nCom\rLinha\tTab'), 'Nome Com Linha Tab');
  assert.strictEqual(categoryLabel('sports'), 'Esportes');
  assert.strictEqual(categoryLabel('categoria-x'), 'categoria-x');
});

test('m3u: modo raw emite o link cru (sem /proxy) para fonte de header', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY, raw: true });
  const lines = out.split('\n');
  assert.ok(!out.includes('/proxy'));
  assert.strictEqual(lines[2], link);
});

test('m3u: modo raw adiciona url-tvg no cabeçalho #EXTM3U', () => {
  const link = `http://${HOST}/a.m3u8`;
  const channels = [channel('maxnet:news:4', 'CNN', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, {
    hwHosts,
    compatIds: new Set(),
    proxyBase: PROXY,
    raw: true,
    epgUrl: 'https://explouddev.com/api/app/epg.xml',
  });
  assert.ok(out.startsWith('#EXTM3U url-tvg="https://explouddev.com/api/app/epg.xml"\n'));
});

test('m3u: modo raw sem epgUrl não adiciona url-tvg', () => {
  const link = `http://${HOST}/a.m3u8`;
  const channels = [channel('maxnet:news:4', 'CNN', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: PROXY, raw: true });
  assert.ok(out.startsWith('#EXTM3U\n'));
});

test('m3u: modo raw funciona sem proxyBase (não depende do servidor)', () => {
  const link = `http://${HOST}:80/live/1/2/749.m3u8`;
  const channels = [channel('maxnet:sports:10', 'SporTV', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, { hwHosts, compatIds: new Set(), proxyBase: '', raw: true });
  assert.ok(out.includes(`\n${link}\n`));
});

test('m3u: modo raw mantém diretos como URL direta', () => {
  const link = 'http://hls1.sua.tv/live/globo/s.m3u8';
  const channels = [channel('maxnet:abertos:7', 'Globo', [{ name: 'Fonte', link }])];
  const out = buildM3uFrom(channels, {
    hwHosts,
    compatIds: new Set(['maxnet:abertos:7']),
    proxyBase: PROXY,
    raw: true,
  });
  assert.ok(out.includes(`\n${link}\n`));
  assert.ok(!out.includes('/proxy'));
});