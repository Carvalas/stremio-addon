const test = require('node:test');
const assert = require('node:assert');
const { createChannelId, parseChannelId, shortChannelId } = require('../src/utils/ids');

test('ids: categorias diferentes nunca colidem', () => {
  assert.notStrictEqual(createChannelId('abertos', 7), createChannelId('sports', 7));
});

test('ids: formato maxnet:<tabela>:<id>', () => {
  assert.strictEqual(createChannelId('abertos', 7), 'maxnet:abertos:7');
  assert.strictEqual(createChannelId('24horas', 568), 'maxnet:24horas:568');
});

test('ids: parseChannelId arredonda', () => {
  const p = parseChannelId('maxnet:sports:10');
  assert.deepStrictEqual(p, { prefix: 'maxnet', category: 'sports', numericId: '10' });
  assert.strictEqual(createChannelId(p.category, p.numericId), 'maxnet:sports:10');
});

test('ids: categorias com caracteres especiais são encodeadas', () => {
  const id = createChannelId('filmes&séries', 1);
  assert.ok(id.includes('maxnet:'));
  assert.strictEqual(parseChannelId(id).category, 'filmes&séries');
});

test('ids: null/não-válido retorna null no parse', () => {
  assert.strictEqual(parseChannelId(null), null);
  assert.strictEqual(parseChannelId('qualquer-coisa'), null);
  assert.strictEqual(parseChannelId('https://sem-formato.json'), null);
});

test('ids: shortChannelId agnóstico ao Stremio', () => {
  assert.strictEqual(shortChannelId('abertos', 7), 'abertos:7');
});