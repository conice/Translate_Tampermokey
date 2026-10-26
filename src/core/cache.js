export const TTL_SUCCESS_MS = 30 * 24 * 60 * 60 * 1000;
export const TTL_FAILURE_MS = 10 * 60 * 1000;
export const MAX_ENTRIES = 5000;

/**
 * Identifies one lookup. Deliberately provider-independent: the chain must be
 * able to swap sources without invalidating everything the user has seen.
 */
export function cacheKey({ source, target, text }) {
  return `${source}|${target}|${text}`;
}

/**
 * Lookup cache backed by a pair of storage callbacks, so the same code runs
 * against GM storage in the browser and a Map in tests.
 *
 * Failures are cached too, with a much shorter TTL: without that, a provider
 * that is down gets retried once per word per inline-gloss pass, which can be
 * thousands of requests a minute.
 *
 * Bounded by `max`, evicting least-recently-used entries, so the store cannot
 * grow without limit as the user browses.
 */
export function createCache({ storage, now = Date.now, max = MAX_ENTRIES }) {
  const records = new Map();

  for (const [key, record] of storage.read()) {
    if (record && typeof record === 'object' && typeof record.expires === 'number') {
      records.set(key, record);
    }
  }

  function prune(now_) {
    for (const [key, record] of records) {
      if (record.expires <= now_) records.delete(key);
    }
  }

  function persist() {
    storage.write([...records.entries()]);
  }

  return {
    get(key) {
      const record = records.get(key);
      if (!record) return undefined;
      const timestamp = now();
      if (record.expires <= timestamp) {
        records.delete(key);
        persist();
        return undefined;
      }
      record.used = timestamp;
      return record.value;
    },

    set(key, value, { ok = true } = {}) {
      const timestamp = now();
      records.set(key, {
        value,
        expires: timestamp + (ok ? TTL_SUCCESS_MS : TTL_FAILURE_MS),
        used: timestamp,
      });
      prune(timestamp);
      if (records.size > max) {
        const oldest = [...records.entries()].sort((a, b) => a[1].used - b[1].used);
        for (const [key_] of oldest.slice(0, records.size - max)) records.delete(key_);
      }
      persist();
    },

    clear() {
      records.clear();
      persist();
    },

    get size() {
      return records.size;
    },
  };
}