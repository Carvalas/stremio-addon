#!/usr/bin/env node
/**
 * export-m3u — gera um arquivo M3U estático dos canais reproduzíveis.
 *
 * Pode gerar dois modos:
 *   • raw  (padrão, --raw)  → links CRUS (sem /proxy) + url-tvg do EPG do provedor.
 *                            Serve para um M3U estático que roda no Nuvio SEM
 *                            servidor — basta hospedar o arquivo (GitHub Pages,
 *                            Dropbox, Gist) e carregar a URL no player.
 *   • proxy (--no-raw)      → URLs via /proxy (para uso enquanto o servidor
 *                            estiver no ar, ex.: http://localhost:7000 ou IP).
 *
 * Uso:
 *   node scripts/export-m3u.js --raw --out out/playlist-raw.m3u
 *   node scripts/export-m3u.js --no-raw --base http://localhost:7000 --out out/playlist.m3u
 */
'use strict';

const fs = require('fs');
const path = require('path');
const m3uService = require('../src/services/m3uService');

function parseArgs(argv) {
  const args = { raw: true, out: '', base: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--raw') args.raw = true;
    else if (a === '--no-raw') args.raw = false;
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--base') args.base = argv[++i] || '';
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Uso: node scripts/export-m3u.js [--raw|--no-raw] [--out arquivo.m3u] [--base http://host:porta]'
    );
    return;
  }

  const outFile = args.out || (args.raw ? 'out/playlist-raw.m3u' : 'out/playlist.m3u');

  if (args.base) process.env.PROXY_BASE_URL = args.base;

  const text = await m3uService.buildM3uText({ raw: args.raw });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text, 'utf8');

  const count = text.split('\n').filter((l) => l.startsWith('#EXTINF')).length;
  console.log(`Modo: ${args.raw ? 'raw (links crus, sem servidor)' : 'proxy'}`);
  console.log(`Canais: ${count}`);
  console.log(`Salvo em: ${path.resolve(outFile)}`);
  console.log(`Tamanho: ${Buffer.byteLength(text, 'utf8')} bytes`);
}

main().catch((err) => {
  console.error('Falha ao exportar M3U:', err.message);
  process.exit(1);
});