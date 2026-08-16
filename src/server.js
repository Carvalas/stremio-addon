const express = require('express');
const { getRouter } = require('stremio-addon-sdk');

const builder = require('./addon');
const epgService = require('./services/epgService');
const m3uService = require('./services/m3uService');
const proxyRouter = require('./proxy/proxyServer');
const { HOST, PORT } = require('./utils/config');
const logger = require('./utils/logger');

const TAG = 'addon';
const startedAt = Date.now();

const app = express();
app.set('json spaces', 2);

app.use(proxyRouter);

const addonInterface = builder.getInterface();
app.use(getRouter({ manifest: addonInterface.manifest, get: addonInterface.get }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: require('../package.json').version,
  });
});

// Playlist M3U para players IPTV (Nuvio, etc.) — mesmo gate do catálogo.
// ?direct=1 → links crus (para M3U estático sem servidor); default → via /proxy.
app.get('/playlist.m3u', async (req, res) => {
  try {
    const raw = String(req.query.direct || '').trim() === '1';
    const text = await m3uService.buildM3uText({ raw });
    res.set('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(text);
  } catch (err) {
    logger.error(TAG, `erro ao gerar playlist M3U: ${err.message}`);
    res.status(502).json({ error: 'Playlist indisponível' });
  }
});

// EPG XMLTV transparente para consumo externo (DizqueTV, Telly, Jellyfin, etc.)
app.get('/epg.xml', async (_req, res) => {
  try {
    const xml = await epgService.getEpgXmlText();
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(xml);
  } catch (err) {
    logger.error(TAG, `erro ao servir EPG: ${err.message}`);
    res.status(502).json({ error: 'EPG indisponível' });
  }
});

app.get('/', (_req, res) => {
  res.json({
    name: require('./manifest').name,
    version: require('../package.json').version,
    manifestUrl: '/manifest.json',
    epgUrl: '/epg.xml',
  });
});

app.listen(PORT, HOST, () => {
  logger.info(TAG, `Addon iniciado em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  logger.info(TAG, `Manifesto: http://localhost:${PORT}/manifest.json`);
  logger.info(TAG, `EPG: http://localhost:${PORT}/epg.xml`);
  logger.info(TAG, `Health: http://localhost:${PORT}/health`);
  logger.info(TAG, `Proxy HLS (headers): http://localhost:${PORT}/proxy`);
});