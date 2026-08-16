const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const security = require('../src/proxy/security');
const hlsProxy = require('../src/proxy/hlsProxy');
const { rewritePlaylist, isPlaylistBody } = hlsProxy;

// ---------------- security ----------------
test('security: normalizeHost normaliza', () => {
  assert.strictEqual(security.normalizeHost('DNS.ExploudDev.Com.'), 'dns.explouddev.com');
  assert.strictEqual(security.normalizeHost(''), '');
});

test('security: isPrivateHost detecta IPs privados', () => {
  assert.ok(security.isPrivateHost('127.0.0.1'));
  assert.ok(security.isPrivateHost('10.1.2.3'));
  assert.ok(security.isPrivateHost('192.168.0.10'));
  assert.ok(security.isPrivateHost('172.16.0.5'));
  assert.ok(security.isPrivateHost('169.254.1.1'));
  assert.ok(!security.isPrivateHost('200.150.100.50'));
  assert.ok(!security.isPrivateHost('dns.explouddev.com'));
});

test('security: validateUrl bloqueia não-HTTP e IPs privados', async () => {
  const allowed = new Set(['dns.explouddev.com']);
  await assert.rejects(security.validateUrl('ftp://x/y', allowed), { status: 400 });
  await assert.rejects(security.validateUrl('http://127.0.0.1/x', allowed), { status: 403 });
  await assert.rejects(security.validateUrl('http://10.0.0.5/x', allowed), { status: 403 });
});

test('security: validateUrl recusa host fora da allowlist', async () => {
  await assert.rejects(security.validateUrl('http://evil.com/x', new Set()), { status: 403 });
});

test('security: aprender host permite depois', async () => {
  const allowed = new Set(['dns.explouddev.com']);
  security.learnHost('nazcdn.mantoxp.click');
  const url = await security.validateUrl('http://nazcdn.mantoxp.click/hls/x.ts', allowed);
  assert.strictEqual(url.hostname, 'nazcdn.mantoxp.click');
});

test('security: processRedirect aprende o destino', () => {
  security.learnHost.cacheClear && security.learnHost.cacheClear();
  const url = new URL('https://cdn.example/seg.ts');
  security.processRedirect('https://cdn.example/seg.ts', new Set(), 'dns.explouddev.com');
  assert.ok(security.isLearned('cdn.example'));
});

// ---------------- rewritePlaylist ----------------
const BASE = 'http://dns.explouddev.com:80/live/287945811/148063/289881.m3u8';
const SELF = 'http://localhost:7000';

test('rewrite: default envia segmentos ao proxy (para clientes que o CDN rejeita)', () => {
  const body = '#EXTM3U\n#EXTINF:9.6,\n/hls/289881_2843.ts\n#EXTINF:9.6,\nhttps://cdn.example/seg/2.ts\n';
  const out = rewritePlaylist(body, BASE, SELF);
  assert.ok(out.includes(`${SELF}/proxy?u=${encodeURIComponent('http://dns.explouddev.com/hls/289881_2843.ts')}`));
  assert.ok(out.includes(`${SELF}/proxy?u=${encodeURIComponent('https://cdn.example/seg/2.ts')}`));
  assert.strictEqual(out.split('\n').filter((l) => l && !l.startsWith('#')).length, 2);
});

test('rewrite: directSegments=true mantém mesmo-host (CDN) direto; outro host vai ao proxy', () => {
  const body = '#EXTM3U\n#EXTINF:9.6,\n/hls/289881_2843.ts\n#EXTINF:9.6,\nhttps://cdn.example/seg/2.ts\n';
  const out = rewritePlaylist(body, BASE, SELF, true);
  assert.ok(out.includes('http://dns.explouddev.com/hls/289881_2843.ts')); // direto (mesmo host)
  assert.ok(!out.includes(`${SELF}/proxy?u=${encodeURIComponent('http://dns.explouddev.com/hls/289881_2843.ts')}`));
  assert.ok(out.includes(`${SELF}/proxy?u=${encodeURIComponent('https://cdn.example/seg/2.ts')}`)); // via proxy (outro host)
  assert.strictEqual(out.split('\n').filter((l) => l && !l.startsWith('#')).length, 2);
});

test('rewrite: directSegments=false coloca tudo no proxy', () => {
  const body = '#EXTM3U\n#EXTINF:9.6,\n/hls/289881_2843.ts\n';
  const out = rewritePlaylist(body, BASE, SELF, false);
  assert.ok(out.includes(`${SELF}/proxy?u=${encodeURIComponent('http://dns.explouddev.com/hls/289881_2843.ts')}`));
});

test('rewrite: #EXT-X-KEY e #EXT-X-MEDIA também são reescritos', () => {
  const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key/abc",IV=0xf\n#EXT-X-MEDIA:NAME="x",URI="audio.m3u8"\nseg.ts\n';
  const out = rewritePlaylist(body, BASE, SELF);
  assert.ok(out.includes(`URI="${SELF}/proxy?u=${encodeURIComponent('http://dns.explouddev.com/key/abc')}"`));
  assert.ok(out.includes(`URI="${SELF}/proxy?u=${encodeURIComponent('http://dns.explouddev.com/live/287945811/148063/audio.m3u8')}"`));
});

test('rewrite: tags e comentários preservados', () => {
  const body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nx.ts\n';
  const out = rewritePlaylist(body, BASE, SELF, true);
  assert.ok(out.includes('#EXT-X-VERSION:3'));
  assert.ok(!out.split('\n').some((l) => l.trim() === 'x.ts'));
  assert.ok(out.includes('http://dns.explouddev.com/live/287945811/148063/x.ts')); // direto (mesmo host)
});

test('prefetch: upstreamFromProxyLine decodifica a URL de upstream', () => {
  const line = `${SELF}/proxy?u=${encodeURIComponent('http://ngzcdn.mantopx.click/hls/749_12.ts')}`;
  assert.strictEqual(hlsProxy.upstreamFromProxyLine(line), 'http://ngzcdn.mantopx.click/hls/749_12.ts');
  assert.strictEqual(hlsProxy.upstreamFromProxyLine('https://cdn.example/x.m3u8'), null);
});

// ---------------- isPlaylistBody ----------------
test('isPlaylistBody: detecta por MIME e por conteúdo', () => {
  assert.ok(isPlaylistBody(Buffer.from('#EXTM3U\n#EXTINF:1,\nx.ts'), 'text/plain'));
  assert.ok(isPlaylistBody(Buffer.from('o que for'), 'application/vnd.apple.mpegurl'));
  assert.ok(!isPlaylistBody(Buffer.from('NOT A PLAYLIST\n'), 'video/mp2t'));
  assert.ok(!isPlaylistBody(Buffer.from([0x47, 0x00, 0x01, 0x02]), 'video/mp2t'));
});

// ---------------- cache de playlist + stale-on-error ----------------
function startFlakyServer() {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:10,\nseg.ts\n');
    } else {
      res.writeHead(502);
      res.end('boom');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        getHits: () => hits,
        url: `http://127.0.0.1:${server.address().port}/live.m3u8`,
      })
    );
  });
}

function mockRes() {
  const s = { status: 0, headers: {}, body: '' };
  return {
    status(v) { s.status = v; return this; },
    set(k, v) { s.headers[k] = v; return this; },
    send(b) { s.body = b; },
    get state() { return s; },
  };
}

test('hlsProxy: playlist servida do cache dentro da janela (upstream não é tocado de novo)', async () => {
  const { server, getHits, url } = await startFlakyServer();
  try {
    const r1 = await hlsProxy.handleProxyRequest({}, mockRes(), url, { 'User-Agent': 'x' }, 'http://localhost:7000');
    assert.ok(r1.playlist);
    assert.strictEqual(getHits(), 1);
    const r2 = await hlsProxy.handleProxyRequest({}, mockRes(), url, { 'User-Agent': 'x' }, 'http://localhost:7000');
    assert.ok(r2.cached);
    assert.strictEqual(getHits(), 1);
  } finally {
    server.close();
  }
});

test('hlsProxy: stale-on-error serve a última playlist quando o upstream falha', async () => {
  const { server, getHits, url } = await startFlakyServer();
  try {
    const r1 = await hlsProxy.handleProxyRequest({}, mockRes(), url, {}, 'http://localhost:7000');
    assert.ok(r1.playlist);
    const hitsAfter1 = getHits();
    await new Promise((r) => setTimeout(r, 3300)); // passa a janela do cache (2.5s)
    const res = mockRes();
    const r2 = await hlsProxy.handleProxyRequest({}, res, url, {}, 'http://localhost:7000');
    assert.ok(r2.playlist);
    assert.ok(getHits() >= hitsAfter1 + 1); // upstream tentado de novo (agora 502)
    assert.ok(res.state.body.includes('#EXTM3U')); // serviu a cópia stale
  } finally {
    server.close();
  }
});