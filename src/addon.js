/**
 * addon — define os handlers do Stremio (catalog/meta/stream).
 * Não inicia servidor; isso é feito por server.js.
 */
const { addonBuilder } = require('stremio-addon-sdk');

const manifest = require('./manifest');
const channelService = require('./services/channelService');
const streamService = require('./services/streamService');
const epgService = require('./services/epgService');
const { toMeta } = require('./adapters/maxnettvAdapter');
const logger = require('./utils/logger');

const TAG = 'addon';

const builder = new addonBuilder(manifest);

// ---------------- CATALOG ----------------
builder.defineCatalogHandler(async (args) => {
  const start = Date.now();
  try {
    const search = args.extra && typeof args.extra.search === 'string' ? args.extra.search : '';
    if (search && search.trim().length > 0) {
      logger.info(TAG, `catálogo (busca) ${args.id} q="${search}"`);
      const channels = await channelService.searchChannels(search);
      return { metas: channels.map((c) => ({
        id: c.id, type: 'channel', name: c.name,
        poster: c.logo || undefined, posterThumb: c.logo || undefined,
        background: c.logo || undefined,
      })) };
    }
    logger.info(TAG, `catálogo ${args.id}`);
    const items = await channelService.catalog(args.id);
    return { metas: items };
  } catch (err) {
    logger.error(TAG, `erro no catálogo ${args.id}: ${err.message}`);
    return { metas: [] };
  } finally {
    logger.debug(TAG, `catálogo ${args.id} em ${Date.now() - start}ms`);
  }
});

// ---------------- META ----------------
builder.defineMetaHandler(async (args) => {
  const start = Date.now();
  try {
    const channel = await channelService.getChannelById(args.id);
    if (!channel) {
      logger.warn(TAG, `meta: canal não encontrado ${args.id}`);
      return { meta: undefined };
    }
    let now = null;
    let next = null;
    if (channel.idCanal) {
      try {
        const epg = await epgService.getEpgData();
        const nowMs = Date.now();
        now = epgService.getCurrentProgram(epg, channel.idCanal, nowMs);
        next = epgService.getNextProgram(epg, channel.idCanal, nowMs);
      } catch (err) {
        logger.warn(TAG, `meta: EPG indisponível para ${channel.name}: ${err.message}`);
      }
    }
    return { meta: toMeta(channel, now, next) };
  } catch (err) {
    logger.error(TAG, `erro no meta ${args.id}: ${err.message}`);
    return { meta: undefined };
  } finally {
    logger.debug(TAG, `meta ${args.id} em ${Date.now() - start}ms`);
  }
});

// ---------------- STREAM ----------------
builder.defineStreamHandler(async (args) => {
  const start = Date.now();
  try {
    const streams = await streamService.getStreamsForChannel(args.id);
    logger.info(TAG, `stream ${args.id} -> ${streams.length} fonte(s)`);
    return { streams };
  } catch (err) {
    logger.error(TAG, `erro no stream ${args.id}: ${err.message}`);
    return { streams: [] };
  } finally {
    logger.debug(TAG, `stream ${args.id} em ${Date.now() - start}ms`);
  }
});

module.exports = builder;