const test = require('node:test');
const assert = require('node:assert');
const {
  classifySource,
  findRuleFor,
  ruleNeedsHeaders,
  normalizePlutoPlaceholders,
} = require('../src/services/streamService');

const RULES = [
  { url: 'dns.explouddev.com', referer: '', useragent: 'Mozilla/5.0 Chrome/139', type: 'direct' },
  { url: 'directnohdr', type: 'direct' },
  { url: 'mf.fazoeli.co.za/get_token.php', referer: 'https://app.megaflix.com/', type: 'token' },
  { url: 'mydshapimaster', type: 'getlink' },
  { url: 'sinal.cc', referer: 'x', useragent: 'y', requestedWith: 'z', type: 'w' },
];

test('classify: DIRECT sem headers na regra → candidata (null)', () => {
  const c = classifySource({ link: 'https://directnohdr.example/master.m3u8' }, RULES);
  assert.strictEqual(c.type, 'DIRECT');
  assert.strictEqual(c.compatible, null);
});

test('classify: regra busca por fragmento no host, não URL literal', () => {
  const c = classifySource({ link: 'https://cdn42.dns.explouddev.com/live/1/2/3.m3u8' }, RULES);
  assert.strictEqual(c.type, 'DIRECT_WITH_HEADERS');
  assert.strictEqual(c.compatible, false);
});

test('classify: DIRECT_WITH_HEADERS incompatível sem proxy', () => {
  const c = classifySource({ link: 'http://dns.explouddev.com:80/live/x/y/z.m3u8' }, RULES);
  assert.strictEqual(c.type, 'DIRECT_WITH_HEADERS');
  assert.strictEqual(c.compatible, false);
});

test('classify: token incompatível', () => {
  const c = classifySource({ link: 'https://mf.fazoeli.co.za/get_token.php?a=1' }, RULES);
  assert.strictEqual(c.type, 'TOKEN');
  assert.strictEqual(c.compatible, false);
});

test('classify: web incompatível', () => {
  const c = classifySource({ link: 'https://sinal.cc/link/direto.m3u8' }, RULES);
  assert.strictEqual(c.type, 'WEB');
  assert.strictEqual(c.compatible, false);
});

test('classify: getlink é candidata (resolve depois)', () => {
  const c = classifySource({ link: 'https://mydshapimaster.example/x.m3u8' }, RULES);
  assert.strictEqual(c.type, 'GETLINK');
  assert.strictEqual(c.compatible, null);
});

test('classify: sem regra → UNKNOWN candidata', () => {
  const c = classifySource({ link: 'https://host-sem-regra.com.br/playlist.m3u8' }, RULES);
  assert.strictEqual(c.type, 'UNKNOWN');
  assert.strictEqual(c.compatible, null);
});

test('classify: URL inválida → INVALID', () => {
  assert.strictEqual(classifySource({ link: 'javascript:void(0)' }, RULES).type, 'INVALID');
  assert.strictEqual(classifySource({ link: '' }, RULES).type, 'INVALID');
});

test('ruleNeedsHeaders: detecta qualquer campo de header', () => {
  assert.ok(ruleNeedsHeaders({ referer: 'https://x/' }));
  assert.ok(ruleNeedsHeaders({ origin: 'y' }));
  assert.ok(ruleNeedsHeaders({ requestedWith: 'z' }));
  assert.ok(ruleNeedsHeaders({ useragent: 'ua' }));
  assert.ok(!ruleNeedsHeaders({ type: 'direct' }));
});

test('findRuleFor: primeiro fragmento que casar', () => {
  assert.strictEqual(findRuleFor(RULES, 'https://mf.fazoeli.co.za/get_token.php?a=1').type, 'token');
  assert.strictEqual(findRuleFor(RULES, 'https://outro.com/a.m3u8'), null);
});

test('normalizePlutoPlaceholders: preenche PSID/TARGETOPT', () => {
  assert.strictEqual(
    normalizePlutoPlaceholders('https://x/stitch/master.m3u8?PSID={PSID}&TARGETOPT={TARGETOPT}'),
    'https://x/stitch/master.m3u8?PSID=stremio&TARGETOPT=0'
  );
});