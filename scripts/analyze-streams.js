#!/usr/bin/env node
/**
 * analyze-streams v2 — Diagnóstico por PLAYLIST + SEGMENTO, agrupado por HOST.
 *
 * Para cada fonte HLS:
 *   1) GET da playlist (com headers da regra, quando houver)
 *   2) se for master, segue para a primeira sub-playlist
 *   3) pega o primeiro segmento e baixa apenas os primeiros bytes
 *   4) classifica com base no QUE ENTREGOU (não só no HTTP 200)
 *
 * Taxonomia:
 *   DIRECT_WORKING  — sem headers: playlist + segmento com dados de vídeo
 *   HEADER_WORKING  — com headers da regra: playlist + segmento OK
 *   PLAYLIST_ONLY   — playlist OK, segmento não entregou
 *   SEGMENT_404/401/403 — playlist OK, segmento com esse status
 *   PLAYLIST_401/403     — playlist barrada nesse status
 *   PROTECTED  — regra type=token
 *   WEB        — regra type=w (WebView/HTML)
 *   GETLINK    — regra type=getlink (resolver depois)
 *   DEAD_HOST  — DNS/TLS falhou
 *   TIMEOUT    — estourou o tempo
 *   UNKNOWN    — sem regra e sem confirmação
 *   INVALID    — URL não é HTTP(S)
 *
 * Saída em out/:
 *   streams-report.json        resumo
 *   streams-detail.json        por fonte
 *   hosts-report.json          agrupado por host
 *   compatible-channels.json   canais DIRECT_WORKING (para o addon)
 *   history/<data>.json        snapshot diário
 *
 * Uso:
 *   npm run analyze-streams
 *   npm run analyze-streams -- --no-probe
 *   npm run analyze-streams -- --limit 100
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_API = process.env.MAXNET_BASE_URL || 'https://explouddev.com.br';
const PLAYER_UA = process.env.PLAYER_UA || 'DVPlayer/35 (Android 9)';
const PROBE_TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 6000);
const SEG_TIMEOUT = Number(process.env.SEG_TIMEOUT_MS || 6000);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 14);
const OUT_DIR = process.env.ANALYZE_OUT_DIR || path.join(process.cwd(), 'out');

async function fetchJson(url, timeout) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MaxNetTV/12.4 (Linux;Android 10) AndroidXMedia3/1.1.1', Accept: '*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return JSON.parse(text);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function findRule(rules, sourceUrl) {
  const lower = String(sourceUrl).toLowerCase();
  for (const rule of rules) {
    if (!rule || !rule.url) continue;
    const frag = String(rule.url).toLowerCase();
    if (frag && lower.includes(frag)) return rule;
  }
  return null;
}

function normalizePluto(url) {
  return String(url)
    .replace(/\{PSID\}/gi, 'stremio')
    .replace(/\{TARGETOPT\}/gi, '0');
}

function ruleNeedsHeaders(rule) {
  if (!rule) return false;
  return Boolean(
    (rule.referer && String(rule.referer).trim()) ||
    (rule.useragent && String(rule.useragent).trim()) ||
    (rule.requestedWith && String(rule.requestedWith).trim()) ||
    (rule.origin && String(rule.origin).trim())
  );
}

function headersFromRule(rule) {
  const headers = { Accept: '*/*' };
  if (!rule) return headers;
  if (rule.useragent) headers['User-Agent'] = String(rule.useragent);
  if (rule.referer) headers['Referer'] = String(rule.referer);
  if (rule.origin) headers['Origin'] = String(rule.origin);
  if (rule.requestedWith) headers['X-Requested-With'] = String(rule.requestedWith);
  return headers;
}

const NON_HTTP_RE = /^(data:|javascript:|blob:|about:)/i;

function classifyStatic(link, rules) {
  const url = normalizePluto(link).trim();
  if (!url || !/^https?:\/\//i.test(url) || NON_HTTP_RE.test(url)) {
    return { type: 'INVALID', rule: null, headers: null };
  }
  const rule = findRule(rules, url);
  if (!rule) {
    return { type: 'UNKNOWN', rule: null, headers: headersFromRule(null) };
  }
  const rtype = String(rule.type || 'direct');
  if (rtype === 'token') return { type: 'PROTECTED', rule, headers: null };
  if (rtype === 'w') return { type: 'WEB', rule, headers: null };
  if (rtype === 'getlink') return { type: 'GETLINK', rule, headers: null };
  // direct
  if (ruleNeedsHeaders(rule)) {
    return { type: 'HEADER', rule, headers: headersFromRule(rule) };
  }
  return { type: 'DIRECT', rule, headers: headersFromRule(null) };
}

/** Timeout duro: garante resolução/rejeição mesmo se o fetch travar. */
function withHardTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('hard timeout')), ms);
  });
  const work = promise.catch((e) => {
    throw e;
  });
  return Promise.race([work, timer]).finally(() => clearTimeout(t));
}

function classifyErr(err) {
  if (err.name === 'AbortError' || err.message === 'hard timeout') return 'timeout';
  const code = err.cause && err.cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'ENOTFOUND';
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'TLS_ERROR';
  if (code) return code;
  return err.message || 'erro';
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      if (parts.length > 4) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString('utf8');
}

async function fetchPlaylist(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const body = await readLimited(res, 131072);
    const isPlaylist = ct.includes('mpegurl') || body.includes('#EXTM3U');
    if (!isPlaylist) return { ok: false, status: res.status, detail: 'não é playlist HLS' };
    return { ok: true, status: res.status, playlistUrl: res.url || url, body };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, detail: classifyErr(err) };
  }
}

function firstEntry(body) {
  const lines = body.split(/\r?\n/);
  return lines.find((l) => l && !l.startsWith('#'));
}

async function fetchSegment(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEG_TIMEOUT);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), SEG_TIMEOUT);
    try {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => {});
      if (!value || value.length === 0) {
        return { ok: false, status: res.status, detail: 'segmento vazio' };
      }
      const b = value;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const isTs = b[0] === 0x47;
      const isFmp4 =
        b.length >= 12 &&
        b[0] === 0 && b[1] === 0 && b[2] === 0 &&
        ['styp', 'moof', 'ftyp', 'moov'].includes(String.fromCharCode(b[4], b[5], b[6], b[7]));
      const isVideo = isTs || isFmp4 || /mp2t|mpeg|octet-stream|video\//.test(ct);
      if (!isVideo) {
        const head = b.toString('utf8').slice(0, 60).replace(/[\r\n\t]+/g, ' ');
        return { ok: false, status: res.status, detail: `não é vídeo: ${head || ct || '?'}` };
      }
      return {
        ok: true,
        status: res.status,
        bytes: value.length,
        detail: isTs ? 'MPEG-TS' : isFmp4 ? 'fMP4' : 'binário',
      };
    } catch (err) {
      clearTimeout(timer2);
      return { ok: false, status: 0, detail: classifyErr(err) };
    } finally {
      clearTimeout(timer2);
    }
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, detail: classifyErr(err) };
  }
}

/** Probe completa: playlist → (master→child) → 1º segmento. */
async function probeFull(url, headers) {
  const pl = await fetchPlaylist(url, headers);
  if (!pl.ok) return { playlist: pl, segment: null, segUrl: null };

  let mediaUrl = pl.playlistUrl;
  let mediaBody = pl.body;
  if (pl.body.includes('#EXT-X-STREAM-INF')) {
    const child = firstEntry(pl.body);
    if (child) {
      try {
        const childUrl = new URL(child, pl.playlistUrl).href;
        const c2 = await fetchPlaylist(childUrl, headers);
        if (c2.ok) {
          mediaUrl = c2.playlistUrl;
          mediaBody = c2.body;
        }
      } catch {
        /* child inacessível: segue com a própria playlist */
      }
    }
  }

  const seg = firstEntry(mediaBody);
  if (!seg) return { playlist: pl, segment: { ok: false, status: 0, detail: 'playlist sem segmento' }, segUrl: null };
  const segUrl = new URL(seg, mediaUrl).href;
  const segment = await fetchSegment(segUrl, headers);
  return { playlist: pl, segment, segUrl };
}

function deriveStatus(cls, probe) {
  if (cls.type === 'PROTECTED') return 'PROTECTED';
  if (cls.type === 'WEB') return 'WEB';
  if (cls.type === 'GETLINK') return 'GETLINK';
  if (cls.type === 'INVALID') return 'INVALID';
  if (!probe) return cls.type === 'UNKNOWN' ? 'UNKNOWN' : 'UNKNOWN';
  const pl = probe.playlist;
  if (!pl.ok) {
    const d = pl.detail;
    if (d === 'ENOTFOUND' || d === 'TLS_ERROR') return 'DEAD_HOST';
    if (d === 'timeout') return 'TIMEOUT';
    if (pl.status === 401) return 'PLAYLIST_401';
    if (pl.status === 403) return 'PLAYLIST_403';
    return 'UNKNOWN';
  }
  const seg = probe.segment;
  if (seg && seg.ok) {
    return cls.type === 'HEADER' ? 'HEADER_WORKING' : 'DIRECT_WORKING';
  }
  if (seg) {
    if (seg.status === 401) return 'SEGMENT_401';
    if (seg.status === 403) return 'SEGMENT_403';
    if (seg.status === 404) return 'SEGMENT_404';
  }
  return 'PLAYLIST_ONLY';
}

function pct(n, total) {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) pool.push(run());
  await Promise.all(pool);
  return results;
}

async function main() {
  const doProbe = !process.argv.includes('--no-probe');
  const limitIdx = process.argv.indexOf('--limit');
  const probeLimit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : Infinity;

  console.log('==========================================');
  console.log('  ANALYZE STREAMS v2 — playlist + segmento');
  console.log('==========================================');

  console.log(`\n[1/3] Baixando canais de ${BASE_API}`);
  const channels = await fetchJson(`${BASE_API}/api/canais/todos?search=`, 25000);
  console.log(`      ${channels.length} canais`);

  console.log('[2/3] Baixando regras de streams (app_start)');
  const appStart = await fetchJson(`${BASE_API}/api/app/app_start.php`, 25000);
  const rules = Array.isArray(appStart.streams_info) ? appStart.streams_info : [];
  console.log(`      ${rules.length} regras`);

  // ---- classificação estática + lista de probes únicos ----
  const bySource = [];
  const seen = new Set();
  for (const ch of channels) {
    if (!Array.isArray(ch.sources)) continue;
    for (const src of ch.sources) {
      if (!src || typeof src.link !== 'string') continue;
      const link = normalizePluto(src.link).trim();
      const cls = classifyStatic(link, rules);
      const needsProbe = ['DIRECT', 'HEADER', 'UNKNOWN'].includes(cls.type);
      if (needsProbe && !seen.has(link)) seen.add(link);
      bySource.push({
        channelId: `${ch.tabela}:${ch.id}`,
        channel: ch.name,
        channelCategory: ch.tabela,
        source: src.name,
        link,
        host: hostOf(link),
        cls,
      });
    }
  }

  // ---- probe por URL única ----
  const probeMap = new Map();
  if (doProbe) {
    const unique = [...seen].slice(0, probeLimit);
    console.log(`[3/3] Probando ${unique.length} URL(s) únicas (playlist + 1º segmento, concorrência ${CONCURRENCY})`);
    let done = 0;
    const results = await mapLimit(unique, CONCURRENCY, async (link) => {
      const cls = bySource.find((s) => s.link === link).cls;
      const r = await probeFull(link, cls.headers);
      done++;
      if (done % 25 === 0 || done === unique.length) console.log(`      probe ${done}/${unique.length}`);
      return r;
    });
    results.forEach((r, i) => probeMap.set(unique[i], r));
  }

  // ---- status por fonte ----
  const statusCounts = {};
  const perSource = bySource.map((s) => {
    const probe = probeMap.get(s.link);
    const status = deriveStatus(s.cls, probe);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    return {
      channelId: s.channelId,
      channel: s.channel,
      category: s.channelCategory,
      source: s.source,
      host: s.host,
      link: s.link,
      status,
      detail: probe ? (probe.segment && probe.segment.ok ? probe.segment.detail : probe.playlist.detail) : '',
      probe: probe
        ? {
            playlist: { ok: probe.playlist.ok, status: probe.playlist.status },
            segment: probe.segment
              ? { ok: probe.segment.ok, status: probe.segment.status, detail: probe.segment.detail }
              : null,
          }
        : undefined,
    };
  });

  // ---- agrupamento por host ----
  const byHost = new Map();
  for (const s of perSource) {
    if (!byHost.has(s.host)) byHost.set(s.host, { sources: 0, status: {} });
    const h = byHost.get(s.host);
    h.sources++;
    h.status[s.status] = (h.status[s.status] || 0) + 1;
  }
  const hostRows = [...byHost.entries()]
    .map(([host, d]) => ({ host, sources: d.sources, status: d.status }))
    .sort((a, b) => b.sources - a.sources);

  // ---- canais por status ----
  const channelStatus = new Map();
  for (const s of perSource) {
    if (!channelStatus.has(s.channelId)) {
      channelStatus.set(s.channelId, { channelId: s.channelId, name: s.channel, category: s.category, byStatus: {} });
    }
    const ch = channelStatus.get(s.channelId);
    ch.byStatus[s.status] = (ch.byStatus[s.status] || 0) + 1;
  }

  const PROXY_ENABLED = process.env.PROXY_ENABLED !== 'false';
  const WORKING_STATUSES = PROXY_ENABLED
    ? ['DIRECT_WORKING', 'HEADER_WORKING']
    : ['DIRECT_WORKING'];
  function channelHas(ch, statuses) {
    return statuses.some((st) => (ch.byStatus[st] || 0) > 0);
  }
  const compatibleChannels = [...channelStatus.values()].filter((c) => channelHas(c, WORKING_STATUSES));
  const directOnlyChannels = [...channelStatus.values()].filter((c) => channelHas(c, ['DIRECT_WORKING']));
  const headerWorkingChannels = [...channelStatus.values()].filter((c) => channelHas(c, ['HEADER_WORKING']));

  // ---- relatório no terminal ----
  const total = perSource.length;
  console.log('\n==========================================');
  console.log('RESULTADO');
  console.log('==========================================');
  console.log(`Canais encontrados : ${channels.length}`);
  console.log(`Sources encontradas: ${total}`);
  console.log('');
  const order = [
    'DIRECT_WORKING',
    'HEADER_WORKING',
    'PLAYLIST_401',
    'PLAYLIST_403',
    'SEGMENT_401',
    'SEGMENT_403',
    'SEGMENT_404',
    'PLAYLIST_ONLY',
    'PROTECTED',
    'WEB',
    'GETLINK',
    'DEAD_HOST',
    'TIMEOUT',
    'UNKNOWN',
    'INVALID',
  ];
  for (const t of order) {
    const n = statusCounts[t] || 0;
    if (n) console.log(`${(t + ':').padEnd(18)} ${String(n).padStart(4)}  (${pct(n, total)})`);
  }
  console.log('');
  console.log(`Canais DIRECT_WORKING (playlist+segmento, sem proxy): ${directOnlyChannels.length}`);
  console.log(`Canais HEADER_WORKING (playlist+segmento, via proxy): ${headerWorkingChannels.length}`);
  console.log(`Canais REPRODUZÍVEIS (${PROXY_ENABLED ? 'DIRECT + proxy' : 'DIRECT only'}): ${compatibleChannels.length}`);
  if (headerWorkingChannels.length) {
    console.log('HEADER_WORKING:');
    for (const c of headerWorkingChannels) console.log(`  ${c.category.padEnd(12)} ${c.name}`);
  }
  console.log('');
  console.log('Hosts (agrupados):');
  for (const h of hostRows) {
    const st = Object.entries(h.status)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`  ${h.host.padEnd(28)} ${String(h.sources).padStart(4)}  ${st}`);
  }
  if (headerWorkingChannels.length === 0) {
    console.log('\n⚠  Nenhuma fonte HEADER_WORKING encontrada → PROXY NÃO JUSTIFICADO.');
  }

  // ---- salvando ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { createChannelId } = require('../src/utils/ids');
  const compatibleList = compatibleChannels
    .map((c) => {
      const [cat, num] = String(c.channelId || '').split(':');
      return cat && num ? { id: createChannelId(cat, num), name: c.name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  fs.writeFileSync(
    path.join(OUT_DIR, 'streams-report.json'),
    JSON.stringify(
      {
        meta: { generatedAt: new Date().toISOString(), channels: channels.length, sources: total, probed: probeMap.size },
        statusCounts,
        compatibleChannels: compatibleChannels.length,
        directOnlyChannels: directOnlyChannels.length,
        headerWorkingChannels: headerWorkingChannels.length,
        hosts: hostRows,
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(OUT_DIR, 'streams-detail.json'), JSON.stringify({ perSource, channelRows: undefined }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'hosts-report.json'), JSON.stringify(hostRows, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, 'compatible-channels.json'),
    JSON.stringify(compatibleList, null, 2)
  );

  // ---- fontes HEADER_WORKING: base do proxy direcionado ----
  const hwRows = perSource
    .filter((s) => s.status === 'HEADER_WORKING')
    .map((s) => ({ channelId: s.channelId, name: s.source, link: s.link, host: s.host }));
  fs.writeFileSync(
    path.join(OUT_DIR, 'header-working-sources.json'),
    JSON.stringify(hwRows, null, 2)
  );

  // ---- histórico ----
  const historyDir = path.join(OUT_DIR, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(historyDir, `${today}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        statusCounts,
        compatible: compatibleList.map((c) => c.id),
        headerWorking: headerWorkingChannels.map((c) => {
          const [cat, num] = String(c.channelId || '').split(':');
          return cat && num ? { id: createChannelId(cat, num), name: c.name } : null;
        }).filter(Boolean),
      },
      null,
      2
    )
  );

  console.log(`\nRelatórios salvos em ${OUT_DIR}/ (incl. history/${today}.json)`);
  console.log(`Canais compatíveis gravados em compatible-channels.json: ${compatibleList.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Falha na análise:', err.message);
  process.exit(1);
});
