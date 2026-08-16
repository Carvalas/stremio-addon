const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[envLevel] !== undefined ? LEVELS[envLevel] : LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function write(level, tag, ...args) {
  if (LEVELS[level] < threshold) return;
  const line = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ')}`;
  /* eslint-disable no-console */
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  /* eslint-enable no-console */
}

const logger = {
  debug: (tag, ...a) => write('debug', tag, ...a),
  info: (tag, ...a) => write('info', tag, ...a),
  warn: (tag, ...a) => write('warn', tag, ...a),
  error: (tag, ...a) => write('error', tag, ...a),
};

module.exports = logger;