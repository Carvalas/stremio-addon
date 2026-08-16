/**
 * proxyServer — rota Express /proxy (restrita aos hosts de mídia conhecidos).
 */
const express = require('express');
const headerRules = require('./headerRules');
const security = require('./security');
const hlsProxy = require('./hlsProxy');
const logger = require('../utils/logger');

const TAG = 'proxy';

const router = express.Router();

// limite simples por IP (token bucket burro): 60 req/s
const buckets = new Map();
const BUCKET_MAX = 120;
const BUCKET_REFILL_MS = 1000;
function allow(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: BUCKET_MAX, ts: now };
  b.tokens = Math.min(BUCKET_MAX, b.tokens + ((now - b.ts) / BUCKET_REFILL_MS) * 60);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  buckets.set(ip, b);
  if (buckets.size > 5000) {
    const oldest = buckets.keys().next().value;
    buckets.delete(oldest);
  }
  return true;
}

router.get('/proxy', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || '?';
  if (!allow(clientIp)) {
    return res.status(429).json({ error: 'limite de requisições' });
  }

  const u = String(req.query.u || '');
  const start = Date.now();
  try {
    const allowedHosts = await headerRules.getAllowedHostSet();
    const url = await security.validateUrl(u, allowedHosts);
    const headers = headerRules.getHeadersForUrl(url.href);
    const selfBase = `${req.protocol}://${req.get('host')}`;
    const result = await hlsProxy.handleProxyRequest(req, res, url.href, headers, selfBase);
    if (result && result.status === 404) {
      logger.info(TAG, `404 upstream ${url.host} (${Math.round(Date.now() - start)}ms)`);
      return res.status(404).json({ error: 'recurso não encontrado no upstream' });
    }
    logger.debug(TAG, `${url.host} -> ${result && result.playlist ? 'playlist' : 'segmento'} (${Math.round(Date.now() - start)}ms)`);
  } catch (err) {
    const status = err.status || 502;
    logger.warn(TAG, `${status} ${u.slice(0, 80)}: ${err.message}`);
    if (!res.headersSent) res.status(status).json({ error: err.message });
    else res.end();
  }
});

router.get('/proxy-status', async (_req, res) => {
  res.json({
    enabled: true,
    allowedHosts: await headerRules.getAllowedHosts(),
    learned: [...security.isLearned ? [] : []],
  });
});

module.exports = router;