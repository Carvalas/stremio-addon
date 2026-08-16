const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.ANALYZE_OUT_DIR || path.join(process.cwd(), 'out');
const COMPAT_FILE = process.env.COMPAT_FILE || path.join(OUT_DIR, 'compatible-channels.json');
const HW_FILE = process.env.HEADER_WORKING_FILE || path.join(OUT_DIR, 'header-working-sources.json');

const enabled = process.env.ONLY_COMPATIBLE !== 'false';

let cached = null; // { ids: Set, mtime, file }
let hostCache = null; // { hosts: Set, mtime }

function readCompatFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    return list.filter((c) => c && c.id);
  } catch {
    return null;
  }
}

/**
 * Carrega o set de ids reproduzíveis. Retorna null quando o filtro está
 * desativado ou quando o arquivo ainda não foi gerado (sem filtro).
 */
function load() {
  if (!enabled) return null;
  try {
    const st = fs.statSync(COMPAT_FILE);
    if (cached && cached.file === COMPAT_FILE && cached.mtime === st.mtimeMs) {
      return cached.ids;
    }
    const list = readCompatFile(COMPAT_FILE);
    if (list === null) return null;
    cached = { ids: new Set(list.map((c) => c.id)), mtime: st.mtimeMs, file: COMPAT_FILE };
    return cached.ids;
  } catch {
    return null;
  }
}

/** Set de hosts confirmados HEADER_WORKING (do diagnóstico v2). */
function loadHostSet() {
  if (!enabled) return new Set();
  try {
    const st = fs.statSync(HW_FILE);
    if (hostCache && hostCache.mtime === st.mtimeMs) return hostCache.hosts;
    const rows = JSON.parse(fs.readFileSync(HW_FILE, 'utf8'));
    const hosts = new Set();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!r || !r.link) continue;
        try {
          hosts.add(new URL(r.link).hostname);
        } catch {
          /* ignora */
        }
      }
    }
    hostCache = { hosts, mtime: st.mtimeMs };
    return hosts;
  } catch {
    return new Set();
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Mantém canais que estão na lista precisa de ids OU que têm ≥1 fonte em host
 * confirmado HEADER_WORKING (links dns rotacionam; o host é o que vale).
 */
function filterChannelsWithHosts(channels, ids, hosts) {
  if (!Array.isArray(channels)) return channels;
  if (!ids) return channels;
  if (!ids.size && !hosts.size) return channels;
  return channels.filter((c) => {
    if (c && ids.has(c.id)) return true;
    if (c && c.sources && hosts.size) {
      return c.sources.some((s) => s && s.link && hosts.has(hostOf(s.link)));
    }
    return false;
  });
}

/**
 * Converte as rows do relatório (analyze-streams) em lista de compatíveis.
 * Espera rows com { channelId: 'abertos:7', name, compatible }.
 */
function buildCompatibleList(rows) {
  const { createChannelId } = require('../utils/ids');
  const list = [];
  for (const row of rows || []) {
    if (!row || !row.compatible) continue;
    const [cat, num] = String(row.channelId || '').split(':');
    if (!cat || !num) continue;
    list.push({ id: createChannelId(cat, num), name: row.name });
  }
  return list;
}

/**
 * Filtra canais mantendo apenas os do set de ids. ids null/∅ → passa tudo.
 */
function filterChannels(channels, ids) {
  if (!ids || !ids.size || !Array.isArray(channels)) return channels;
  return channels.filter((c) => c && ids.has(c.id));
}

module.exports = {
  enabled,
  load,
  loadHostSet,
  filterChannelsWithHosts,
  buildCompatibleList,
  filterChannels,
  COMPAT_FILE,
};