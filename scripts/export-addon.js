#!/usr/bin/env node
/**
 * export-addon — gera um addon ESTÁTICO dos canais reproduzíveis para hospedar
 * em GitHub Pages (zero servidor). Usa o mesmo gate do catálogo/M3U.
 *
 * Estrutura gerada em <out> (raiz = base do addon):
 *   manifest.json
 *   catalog/channel/<catalogId>.json   {metas:[...]}
 *   stream/channel/<id>.json           {streams:[{url: link CRU}]}
 *   meta/channel/<id>.json             {meta:{...}}
 *
 * Uso:
 *   node scripts/export-addon.js [--out out]
 *
 * Obs.: em Windows o nome de arquivo não aceita ':' — stream/meta são gravados
 * com '_' (apenas preview local); o CI (Linux) grava os nomes corretos.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const channelService = require('../src/services/channelService');
const compat = require('../src/services/compatibility');
const { buildAddonPayloads } = require('../src/services/addonExportService');

function parseArgs(argv) {
  const args = { out: 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || 'out';
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: node scripts/export-addon.js [--out dir]');
    return;
  }

  const outDir = path.resolve(args.out);
  const sanitize = process.platform === 'win32';

  const hwHosts = compat.loadHostSet();
  const compatIds = compat.load();
  const channels = await channelService.getChannels();
  const { manifest, catalogs, streams, metas } = buildAddonPayloads(channels, { hwHosts, compatIds });

  writeJson(path.join(outDir, 'manifest.json'), manifest);

  let catalogTotal = 0;
  for (const cat of catalogs) {
    writeJson(path.join(outDir, 'catalog', 'channel', `${cat.catalogId}.json`), { metas: cat.metas });
    catalogTotal += cat.metas.length;
  }

  const idToFile = (id) => (sanitize ? String(id).replace(/:/g, '_') : String(id));
  for (const s of streams) {
    writeJson(path.join(outDir, 'stream', 'channel', `${idToFile(s.id)}.json`), {
      streams: [{ name: 'Max Net TV', title: 'Max Net TV', url: s.url }],
    });
  }
  for (const m of metas) {
    writeJson(path.join(outDir, 'meta', 'channel', `${idToFile(m.id)}.json`), { meta: m.meta });
  }

  const todos = catalogs.find((c) => c.catalogId === 'maxnet-todos');
  console.log('Modo: estatico (links crus, sem servidor)');
  console.log(`Manifest: ${path.join(outDir, 'manifest.json')}`);
  console.log(`Catálogos: ${catalogs.length} (${catalogTotal} itens no total; Todos: ${todos ? todos.metas.length : 0})`);
  console.log(`Streams com URL crua: ${streams.length}/${channels.length} canais`);
  console.log(`Metas: ${metas.length}`);
  if (sanitize) {
    console.log('AVISO (Windows): nomes de stream/meta gravados com "_" em vez de ":" (preview local).');
    console.log('O CI (Linux) gera os nomes corretos com ":" ao publicar em gh-pages.');
  }
}

main().catch((err) => {
  console.error('Falha ao exportar addon:', err.message);
  process.exit(1);
});