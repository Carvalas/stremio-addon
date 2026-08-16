/**
 * hlsProxy — fetch upstream HLS com headers e reescrita de playlist.
 *
 * O proxy NÃO armazena vídeo: a playlist é reescrita e os segmentos/trechos são
 * repassados como fluxo (streaming), sem buffer total. Segmentos do MESMO host
 * da playlist (o CDN) são apontados DIRETO ao upstream — o CDN entrega com UA
 * comum (Chrome/Stremio desktop/VLC) e isso tira o proxy do caminho pesado.
 */
const { Readable } = require('stream');
const security = require('./security');
const logger = require('../utils/logger');

const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT_MS || 15000);
const RETRY_TIMEOUT_MS = Number(process.env.PROXY_RETRY_TIMEOUT_MS || 5000);
const PLAYLIST_CACHE_TTL_MS = Number(process.env.PROXY_PLAYLIST_CACHE_MS || 2500);
const PLAYLIST_STALE_MS = Number(process.env.PROXY_PLAYLIST_STALE_MS || 15000);
const WARM_REFRESH_MS = Number(process.env.PROXY_WARM_REFRESH_MS || 2000);
const WARM_IDLE_MS = Number(process.env.PROXY_WARM_IDLE_MS || 6000);
// segmentos vão pelo proxy (com headers da regra) por padrão: o CDN entrega
// rápido com UA Chrome e o proxy consegue PRÉ-BUSCAR os próximos segmentos.
const DIRECT_SEGMENTS = process.env.PROXY_DIRECT_SEGMENTS === 'true';
const SEGMENT_CACHE_MAX = Number(process.env.PROXY_SEGMENT_CACHE_MAX || 6);
const SEGMENT_PREFETCH_AHEAD = Number(process.env.PROXY_PREFETCH_AHEAD || 2);
const MAX_SEGMENT_BYTES = Number(process.env.PROXY_SEGMENT_MAX_BYTES || 25 * 1024 * 1024);
const MAX_PLAYLIST_BYTES = 200 * 1024;

const PLAYLIST_CT = 'application/vnd.apple.mpegurl';

// cache de playlists reescritas (nunca segmentos/vídeo)
const playlistCache = new Map();
// cache de segmentos pré-buscados (upstreamUrl -> Buffer de MPEG-TS)
const segmentCache = new Map();
const segmentInFlight = new Map();
// loops de aquecimento do cache por URL (enquanto o canal estiver em uso)
const warmLoops = new Map();

/**
 * Segue redirects manualmente (validando cada destino contra a allowlist).
 * @returns {{status:number, headers:Headers, body:ReadableStream|null, url:string}}
 */
async function fetchUpstream(url, headers, maxRedirects, timeoutMs = PROXY_TIMEOUT) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      const detail = err.name === 'AbortError' ? 'timeout' : (err.cause && err.cause.code) || err.message;
      const e = new Error(`upstream falhou (${detail})`);
      e.status = 502;
      throw e;
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, headers: res.headers, body: res.body, url: current };
      const target = new URL(loc, current);
      security.learnHost(target.hostname);
      current = target.href;
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, url: res.url || current };
  }
  const e = new Error('redirect demais');
  e.status = 502;
  throw e;
}

function absolute(value, base) {
  return new URL(value, base).href;
}

function escaped(value) {
  return encodeURIComponent(value);
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * Substitui as URLs de uma playlist HLS contra `baseUrl`:
 *  - segmento no MESMO host da playlist (CDN) → URL direta do upstream;
 *  - chaves/sub-playlists/mídia → via proxy local (podem exigir headers).
 */
function rewritePlaylist(body, baseUrl, selfBase, directSegments = DIRECT_SEGMENTS) {
  const lines = body.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    // #EXT-X-KEY:METHOD=AES-128,URI="..."
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const repl = line.replace(/URI="([^"]+)"/, (_, uri) => {
        const abs = absolute(uri, baseUrl);
        return `URI="${selfBase}/proxy?u=${escaped(abs)}"`;
      });
      out.push(repl);
      continue;
    }
    // #EXT-X-MEDIA:TYPE=...,URI="..."
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const repl = line.replace(/URI="([^"]+)"/, (_, uri) => {
        const abs = absolute(uri, baseUrl);
        return `URI="${selfBase}/proxy?u=${escaped(abs)}"`;
      });
      out.push(repl);
      continue;
    }
    // #EXT-X-MAP:URI="..."
    if (line.startsWith('#EXT-X-MAP:')) {
      const repl = line.replace(/URI="([^"]+)"/, (_, uri) => {
        const abs = absolute(uri, baseUrl);
        return `URI="${selfBase}/proxy?u=${escaped(abs)}"`;
      });
      out.push(repl);
      continue;
    }
    // URIs puras (segmentos / sub-playlists)
    if (!line.startsWith('#') && line.trim() !== '') {
      const abs = absolute(line.trim(), baseUrl);
      if (directSegments && sameHost(abs, baseUrl)) {
        out.push(abs);
      } else {
        out.push(`${selfBase}/proxy?u=${escaped(abs)}`);
      }
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

/** Lê o corpo (cancelando o leitor no final). Para playlists. */
async function readAllUpTo(reader, limit) {
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** Transforma o body web em Readable node (sem cancelar), prepend `first`. */
function toNodeReadable(reader, first) {
  let pushedFirst = false;
  return new Readable({
    read() {
      if (!pushedFirst && first && first.length) {
        pushedFirst = true;
        this.push(Buffer.from(first));
        return;
      }
      if (!pushedFirst) pushedFirst = true;
      reader
        .read()
        .then(({ value, done }) => {
          if (done) this.push(null);
          else this.push(value);
        })
        .catch((err) => this.destroy(err));
    },
  });
}

/** True se o corpo parecer playlist HLS. */
function isPlaylistBody(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpegurl')) return true;
  const head = buf.toString('utf8', 0, 64);
  return head.includes('#EXTM3U') || (head.startsWith('#') && head.includes('#EXT-X-'));
}

function servePlaylist(res, body) {
  res.status(200);
  res.set('Content-Type', PLAYLIST_CT);
  res.set('Cache-Control', 'no-cache');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(body);
}

function serveSegment(res, buf) {
  res.status(200);
  res.set('Content-Type', 'video/mp2t');
  res.set('Content-Length', buf.length);
  res.set('Cache-Control', 'no-cache');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(buf);
}

function rememberPlaylist(url, body) {
  playlistCache.set(url, { body, ts: Date.now() });
  if (playlistCache.size > 3000) {
    // evita crescimento infinito
    const oldest = playlistCache.keys().next().value;
    playlistCache.delete(oldest);
  }
}

/** Lê tudo até o fim (ou o teto `cap`). Retorna null se estourar o teto. */
async function readAllWithCap(reader, cap) {
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
  }
  return Buffer.concat(chunks);
}

function rememberSegment(url, buf) {
  if (!buf || buf.length < 188 || buf[0] !== 0x47) return;
  segmentCache.set(url, buf);
  while (segmentCache.size > SEGMENT_CACHE_MAX) {
    const oldest = segmentCache.keys().next().value;
    segmentCache.delete(oldest);
  }
}

/** Pré-busca um segmento do upstream (com headers da regra) e guarda em memória. */
function prefetchSegment(url, headers) {
  if (segmentCache.has(url)) return Promise.resolve(segmentCache.get(url));
  if (segmentInFlight.has(url)) return segmentInFlight.get(url);
  const p = (async () => {
    try {
      const up = await fetchUpstream(url, headers, security.MAX_REDIRECTS, RETRY_TIMEOUT_MS);
      if (up.status >= 400 || !up.body) return null;
      const buf = await readAllWithCap(up.body.getReader(), MAX_SEGMENT_BYTES);
      rememberSegment(url, buf);
      return buf;
    } catch {
      // falha na pré-busca: o player busca na hora (fetch normal)
      return null;
    }
  })();
  segmentInFlight.set(url, p);
  p.finally(() => segmentInFlight.delete(url));
  return p;
}

/** Extrai a URL de upstream de uma linha "/proxy?u=<encoded>". */
function upstreamFromProxyLine(line) {
  const m = line.match(/\/proxy\?u=([^#\s]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * A partir da playlist reescrita, pré-busca os próximos segmentos ainda não
 * baixados (limitado a `ahead`), para o player recebê-los na hora do cache.
 */
function prefetchAhead(body, headers) {
  let n = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('http')) continue;
    if (t.toLowerCase().endsWith('.m3u8')) continue;
    const u = upstreamFromProxyLine(t);
    if (!u) continue;
    if (segmentCache.has(u) || segmentInFlight.has(u)) continue;
    prefetchSegment(u, headers);
    n += 1;
    if (n >= SEGMENT_PREFETCH_AHEAD) break;
  }
}

function touchWarm(key) {
  const rec = warmLoops.get(key);
  if (rec) rec.lastRequested = Date.now();
}

/** Mantém o cache da playlist quente: reloads do player saem em ~ms. */
function startWarm(key, url, headers, selfBase) {
  if (warmLoops.has(key)) return;
  const rec = { lastRequested: Date.now(), selfBase, busy: false };
  rec.timer = setInterval(() => warmTick(key, url, headers, rec), WARM_REFRESH_MS);
  if (rec.timer.unref) rec.timer.unref();
  warmLoops.set(key, rec);
}

async function warmTick(key, url, headers, rec) {
  if (rec.busy) return;
  if (Date.now() - rec.lastRequested > WARM_IDLE_MS) {
    clearInterval(rec.timer);
    warmLoops.delete(key);
    return;
  }
  rec.busy = true;
  try {
    const up = await fetchUpstream(url, headers, security.MAX_REDIRECTS, RETRY_TIMEOUT_MS);
    if (up.status >= 400 || !up.body) return;
    const reader = up.body.getReader();
    let first;
    try {
      first = await reader.read();
    } catch {
      reader.cancel().catch(() => {});
      return;
    }
    const firstBuf = first.done || !first.value ? Buffer.alloc(0) : Buffer.from(first.value);
    if (!isPlaylistBody(firstBuf, up.headers.get('content-type') || '')) {
      reader.cancel().catch(() => {});
      return;
    }
    const rest = await readAllUpTo(reader, MAX_PLAYLIST_BYTES);
    const body = Buffer.concat([firstBuf, rest]).toString('utf8');
    const rewritten = rewritePlaylist(body, up.url, rec.selfBase);
    rememberPlaylist(key, rewritten);
    prefetchAhead(rewritten, headers);
  } catch {
    // upstream falhou: mantém o cache anterior
  } finally {
    rec.busy = false;
  }
}

/**
 * Recuperação de falha de upstream numa URL de playlist conhecida:
 *  1) stale-on-error (janela curta) → responde e retorna null;
 *  2) senão, um retry curto → retorna upstream ou relança (502).
 */
async function recoverPlaylist(res, upstreamUrl, headers, cached, cause) {
  const age = Date.now() - cached.ts;
  if (age < PLAYLIST_STALE_MS) {
    logger.warn('proxy', `stale-on-error para playlist (${cause && (cause.status || cause.message) || 'net'}); servindo cache de ${Math.round(age / 1000)}s`);
    servePlaylist(res, cached.body);
    return null;
  }
  try {
    return await fetchUpstream(upstreamUrl, headers, security.MAX_REDIRECTS, RETRY_TIMEOUT_MS);
  } catch (err2) {
    const e = new Error(`upstream falhou (${err2.name === 'AbortError' ? 'timeout' : err2.message})`);
    e.status = 502;
    throw e;
  }
}

/**
 * Trata uma requisição ao proxy:
 *  - playlist → reescreve e retorna (com cache curto + stale-on-error)
 *  - segmento/outro → repassa como stream (sem buffer total)
 */
async function handleProxyRequest(req, res, upstreamUrl, headers, selfBase) {
  const key = upstreamUrl;
  const cached = playlistCache.get(key);
  touchWarm(key);

  // segmento já pré-buscado → entrega na hora, sem tocar o upstream
  const segCached = segmentCache.get(key);
  if (segCached) {
    serveSegment(res, segCached);
    return { status: 200, playlist: false, cached: true, bytes: segCached.length };
  }
  // pré-busca em andamento → espera ela terminar (evita baixar 2x do CDN lento)
  const inflight = segmentInFlight.get(key);
  if (inflight) {
    const buf = await inflight;
    if (buf) {
      serveSegment(res, buf);
      return { status: 200, playlist: false, cached: true, bytes: buf.length };
    }
  }

  // reload de playlist dentro da janela → entrega do cache, sem tocar o upstream
  if (cached && Date.now() - cached.ts < PLAYLIST_CACHE_TTL_MS) {
    servePlaylist(res, cached.body);
    return { status: 200, playlist: true, cached: true, bytes: cached.body.length };
  }

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, headers, security.MAX_REDIRECTS);
  } catch (err) {
    if (cached) {
      const recovered = await recoverPlaylist(res, upstreamUrl, headers, cached, err);
      if (recovered === null) return { status: 200, playlist: true, cached: true, bytes: -1 };
      upstream = recovered;
    } else {
      throw err;
    }
  }

  const status = upstream.status;
  if (status >= 500 && cached) {
    const recovered = await recoverPlaylist(res, upstreamUrl, headers, cached, { status });
    if (recovered === null) return { status: 200, playlist: true, cached: true, bytes: -1 };
    upstream = recovered;
  }
  if (status === 404 || status === 410) {
    return { status, body: null, bytes: 0 };
  }
  if (status >= 400) {
    const e = new Error(`upstream HTTP ${status}`);
    e.status = status >= 500 ? 502 : status;
    throw e;
  }
  if (!upstream.body) {
    const e = new Error('sem corpo upstream');
    e.status = 502;
    throw e;
  }

  const reader = upstream.body.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (err) {
    reader.cancel().catch(() => {});
    const e = new Error(`leitura upstream: ${err.message}`);
    e.status = 502;
    throw e;
  }
  const firstBuf = first.done || !first.value ? Buffer.alloc(0) : Buffer.from(first.value);
  const ct = upstream.headers.get('content-type') || '';

  if (isPlaylistBody(firstBuf, ct)) {
    const rest = await readAllUpTo(reader, MAX_PLAYLIST_BYTES);
    const combined = Buffer.concat([firstBuf, rest]).toString('utf8');
    const body = rewritePlaylist(combined, upstream.url, selfBase);
    rememberPlaylist(key, body);
    startWarm(key, upstreamUrl, headers, selfBase);
    prefetchAhead(body, headers);
    servePlaylist(res, body);
    return { status: 200, playlist: true, bytes: body.length };
  }

  // segmento: streaming com o primeiro pedaço já lido
  res.status(200);
  const safe = ct.toLowerCase();
  if (safe && (/video\/|mpeg|octet-stream|audio\//.test(safe) || safe.includes('mpegurl'))) {
    res.set('Content-Type', safe.includes('mpegurl') ? PLAYLIST_CT : ct);
  }
  res.set('Cache-Control', 'no-cache');
  res.set('Access-Control-Allow-Origin', '*');
  const nodeStream = toNodeReadable(reader, firstBuf);
  nodeStream.on('error', (err) => {
    logger.warn('proxy', `stream error: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  nodeStream.pipe(res);
  return new Promise((resolve) => {
    nodeStream.on('end', () => resolve({ status: 200, playlist: false, bytes: undefined }));
    nodeStream.on('close', () => resolve({ status: 200, playlist: false, bytes: undefined }));
  });
}

module.exports = {
  handleProxyRequest,
  rewritePlaylist,
  fetchUpstream,
  isPlaylistBody,
  prefetchAhead,
  upstreamFromProxyLine,
  getSegmentCacheSize: () => segmentCache.size,
  getSegmentCacheBytes: () => {
    let n = 0;
    for (const b of segmentCache.values()) n += b.length;
    return n;
  },
  PLAYLIST_CT,
};