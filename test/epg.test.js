const test = require('node:test');
const assert = require('node:assert');
const { parseXmltvStartStop, hhmm, getCurrentProgram, parseEpgXml } = require('../src/services/epgService');

test('epg: parse do horário XMLTV com offset -0300', () => {
  // 2026-08-15 00:00 -0300 == 2026-08-15 03:00 UTC
  const t = parseXmltvStartStop('20260815000000 -0300');
  assert.strictEqual(t, Date.UTC(2026, 7, 15, 3, 0, 0));
});

test('epg: parse sem offset não quebra (null)', () => {
  assert.strictEqual(parseXmltvStartStop(null), null);
  assert.strictEqual(parseXmltvStartStop('garbage'), null);
});

test('epg: hhmm converte para hora do dia em UTC', () => {
  assert.strictEqual(hhmm(Date.UTC(2026, 0, 1, 20, 30, 0)), '20:30');
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="BAND HD"><display-name lang="pt">BAND HD</display-name></channel>
  <programme start="20260815100000 -0300" stop="20260815110000 -0300" channel="BAND HD">
    <title lang="pt">Jornal da Noite</title>
    <desc lang="pt">Edição principal do telejornal.</desc>
  </programme>
  <programme start="20260815110000 -0300" stop="20260815120000 -0300" channel="BAND HD">
    <title lang="pt">Show do Esporte</title>
  </programme>
</tv>`;

test('epg: parse do XMLTV gera mapa canal→programas', () => {
  const { channels, programsBy } = parseEpgXml(XML);
  assert.ok(channels.has('BAND HD'));
  assert.strictEqual(programsBy.get('BAND HD').length, 2);
});

test('epg: getCurrentProgram acha o intervalo que contém o instante', () => {
  const epg = parseEpgXml(XML);
  // 10:30 -0300 = 13:30 UTC
  const now = Date.UTC(2026, 7, 15, 13, 30, 0);
  const p = getCurrentProgram(epg, 'BAND HD', now);
  assert.strictEqual(p.title, 'Jornal da Noite');
  assert.ok(p.stopText);
});

test('epg: fora do intervalo retorna null', () => {
  const epg = parseEpgXml(XML);
  const now = Date.UTC(2026, 7, 15, 2, 0, 0); // antes de tudo
  assert.strictEqual(getCurrentProgram(epg, 'BAND HD', now), null);
});

test('epg: desconhecido retorna null', () => {
  const epg = parseEpgXml(XML);
  assert.strictEqual(getCurrentProgram(epg, 'NAO_EXISTE', Date.now()), null);
});