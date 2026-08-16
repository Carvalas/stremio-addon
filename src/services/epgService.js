const sax = require('sax');
const api = require('../api/epg');
const { TtlCache } = require('../cache/cache');
const logger = require('../utils/logger');
const { normalizeEpgId, decodeXmlEntities } = require('../utils/normalize');

const tag = 'epg-service';

const EPG_TTL = Number(process.env.EPG_TTL_MS || 6 * 3600 * 1000); // 6 h
const PROG_TTL = Number(process.env.EPG_PROGRAMS_TTL_MS || 2 * 3600 * 1000); // 2 h

const cache = new TtlCache({ defaultTtl: EPG_TTL, maxEntries: 20 });

// -------- parsing (streaming, baixa memória para 9 MB de XML) --------

function parseXmltvStartStop(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, oh, om] = m;
  const wall = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const offsetMinutes = (+oh) * 60 + (+om); // ex.: -0300 → -180
  const utc = wall - offsetMinutes * 60000;
  return utc;
}

function hhmm(utcMs) {
  if (!utcMs) return '';
  const d = new Date(utcMs);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function parseEpgXml(xmlText) {
  const channels = new Map(); // idCanal -> display name
  const programsBy = new Map();
  const parser = sax.parser(true, { trim: true, normalize: true });
  let curChannel = null;
  let curDisplay = '';
  let curProgramme = null;
  let curText = '';

  parser.onopentag = (node) => {
    const name = node.name;
    if (name === 'channel') {
      curChannel = { id: node.attributes.id, displayName: '' };
    } else if (name === 'display-name') {
      curDisplay = 'name';
    } else if (name === 'programme') {
      curProgramme = {
        channel: node.attributes.channel,
        title: '',
        desc: '',
        rating: '',
        startMs: parseXmltvStartStop(node.attributes.start),
        stopMs: parseXmltvStartStop(node.attributes.stop),
      };
    } else if (curProgramme && ['title', 'desc', 'rating'].includes(name)) {
      curText = name;
    }
  };

  parser.ontext = (text) => {
    if (curChannel && curDisplay === 'name') curChannel.displayName += text;
    if (curProgramme && curText) curProgramme[curText] += text;
  };

  parser.onclosetag = (name) => {
    if (name === 'display-name') curDisplay = '';
    if (name === 'channel') {
      if (curChannel && curChannel.id) {
        channels.set(String(curChannel.id), curChannel.displayName || String(curChannel.id));
      }
      curChannel = null;
    }
    if (name === 'programme' && curProgramme) {
      const cid = String(curProgramme.channel || '');
      if (cid && curProgramme.startMs != null && curProgramme.stopMs != null) {
        if (!programsBy.has(cid)) programsBy.set(cid, []);
        programsBy.get(cid).push(curProgramme);
      }
      curProgramme = null;
    }
    curText = '';
  };

  parser.onerror = (err) => {
    // xmltv pode ter pequenas falhas; não aborta tudo
    logger.warn(tag, `erro no parser EPG: ${err.message}`);
    parser.error = null;
  };

  parser.write(xmlText).close();

  let total = 0;
  for (const [cid, list] of programsBy) {
    list.sort((a, b) => a.startMs - b.startMs);
    total += list.length;
  }
  logger.info(tag, `EPG parseado: ${channels.size} canais, ${total} programas`);
  return { channels, programsBy };
}

// -------- acesso --------

async function getEpgData() {
  return cache.getOrSet('epg:parsed', EPG_TTL, async () => {
    const xml = await api.fetchEpgXml();
    return parseEpgXml(xml);
  });
}

function lowerId(idCanal) {
  const n = normalizeEpgId(idCanal);
  return n ? n.toLowerCase() : '';
}

function findListFor(epgData, idCanal) {
  const key = lowerId(idCanal);
  if (!key) return null;
  if (epgData.programsBy.has(idCanal)) return epgData.programsBy.get(idCanal);
  for (const [cid, list] of epgData.programsBy) {
    if (cid.toLowerCase() === key) return list;
  }
  return null;
}

/** Programa atual para um idCanal num instante (ms). */
function getCurrentProgram(epgData, idCanal, nowMs) {
  const list = findListFor(epgData, idCanal);
  if (!list || !list.length) return null;
  // último programa com start <= now
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].startMs <= nowMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans === -1) return null;
  const p = list[ans];
  if (p.stopMs != null && p.stopMs <= nowMs) return null;
  return {
    title: decodeXmlEntities(p.title) || undefined,
    desc: decodeXmlEntities(p.desc) || undefined,
    startMs: p.startMs,
    stopMs: p.stopMs,
    stopText: hhmm(p.stopMs),
  };
}

/** Próximo programa para um idCanal num instante (ms). */
function getNextProgram(epgData, idCanal, nowMs) {
  const list = findListFor(epgData, idCanal);
  if (!list || !list.length) return null;
  for (const p of list) {
    if (p.startMs > nowMs) {
      return decodeXmlEntities(p.title) || undefined;
    }
  }
  return null;
}

/** Disponível para consumo externo (players com suporte XMLTV). */
async function getEpgXmlText() {
  return cache.getOrSet('epg:raw', EPG_TTL, async () => {
    const xml = await api.fetchEpgXml();
    return xml;
  });
}

module.exports = {
  getEpgData,
  getCurrentProgram,
  getNextProgram,
  getEpgXmlText,
  parseEpgXml,
  parseXmltvStartStop,
  hhmm,
};