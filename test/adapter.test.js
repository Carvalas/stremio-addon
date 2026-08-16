const test = require('node:test');
const assert = require('node:assert');
const { normalizeChannel, toCatalogItem, toMeta } = require('../src/adapters/maxnettvAdapter');

const RAW = {
  tabela: 'abertos',
  id: 7,
  id_canal: 'tv-globo',
  name: 'Globo',
  logo: 'https://explouddev.com/maxnettv/logos/mntv_globo0001.png',
  type: 'live',
  ref: 'https://embedstream.org/',
  extra: 'Ao Vivo - 24 Horas',
  sources: [
    { name: 'Globo SP(CDN)', link: 'http://dns.explouddev.com:80/live/287945811/148063/255465.m3u8' },
  ],
};

test('adapter: normaliza canal real', () => {
  const c = normalizeChannel(RAW);
  assert.strictEqual(c.id, 'maxnet:abertos:7');
  assert.strictEqual(c.category, 'abertos');
  assert.strictEqual(c.name, 'Globo');
  assert.strictEqual(c.idCanal, 'tv-globo');
  assert.strictEqual(c.sources.length, 1);
  assert.strictEqual(c.logo, RAW.logo);
});

test('adapter: fonte com URL inválida é descartada', () => {
  const raw = { ...RAW, sources: [{ name: 'x', link: 'not-a-url' }, { name: 'y', link: 'https://ok/master.m3u8' }] };
  const c = normalizeChannel(raw);
  assert.deepStrictEqual(c.sources.map((s) => s.link), ['https://ok/master.m3u8']);
});

test('adapter: canal malformado não derruba (null só para entrada nula)', () => {
  assert.strictEqual(normalizeChannel(null), null);
  // objeto vazio é tolerado: gera canal com fallback, jamais quebra o fluxo
  const c = normalizeChannel({});
  assert.ok(c);
  assert.strictEqual(c.sources.length, 0);
  assert.ok(c.name.startsWith('Canal'));
});

test('adapter: id duplicado entre categorias gera ids diferentes', () => {
  const a = normalizeChannel({ ...RAW, tabela: 'sports' }).id;
  const b = normalizeChannel(RAW).id;
  assert.notStrictEqual(a, b);
});

test('adapter: toCatalogItem tem type channel', () => {
  const item = toCatalogItem(normalizeChannel(RAW));
  assert.strictEqual(item.type, 'channel');
  assert.strictEqual(item.id, 'maxnet:abertos:7');
  assert.strictEqual(item.poster, RAW.logo);
});

test('adapter: toMeta monta descrição com EPG quando houver', () => {
  const meta = toMeta(normalizeChannel(RAW), { title: 'Jornal da Noite', stopText: '20:00' }, 'Novela');
  assert.ok(meta.description.includes('Jornal da Noite'));
  assert.ok(meta.description.includes('Novela'));
  assert.strictEqual(meta.type, 'channel');
});

test('adapter: toMeta funciona sem EPG', () => {
  const meta = toMeta(normalizeChannel(RAW), null, null);
  assert.strictEqual(meta.description.includes('Agora'), false);
});