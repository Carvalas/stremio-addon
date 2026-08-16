const logger = require('../utils/logger');

class TtlCache {
  constructor(options = {}) {
    this.defaultTtl = options.defaultTtl || 300000; // 5 min
    this.maxEntries = options.maxEntries || 5000;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    this.tag = 'cache';
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires <= Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = ttlMs || this.defaultTtl;
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttl });
  }

  getOrSet(key, ttlMs, producer) {
    const existing = this.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    return Promise.resolve()
      .then(producer)
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .catch((err) => {
        logger.warn(this.tag, `producer failed for key ${String(key).slice(0, 80)}: ${err.message}`);
        throw err;
      });
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  stats() {
    return { entries: this.store.size, hits: this.hits, misses: this.misses };
  }
}

module.exports = { TtlCache };