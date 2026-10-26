import { createStore } from '../core/store.js';
import { createCache } from '../core/cache.js';
import { normalizeTheme } from '../core/theme.js';

const SETTINGS_KEY = 'settings';
const ENTRIES_KEY = 'entries';
const CACHE_KEY = 'cache';

const DEFAULTS = {
  version: 1,
  /** Double-click lookup is on everywhere by default: a silently dead install reads as broken. */
  lookupEnabled: true,
  /** Inline glosses are off by default and opt-in per site, see ADR-0003. */
  glossSites: {},
  /** host -> target language, overrides Page Language inference. */
  targetOverrides: {},
  /** Provider ids the user disabled. */
  disabledProviders: [],
  /** 'system' follows the OS; 'light' / 'dark' force a theme on every surface. */
  theme: 'system',
};

/**
 * Thin adapter over the userscript manager's key/value store.
 * Every access is wrapped: GM storage throws in some managers, and a broken
 * store must degrade to "nothing remembered", not to a dead script.
 */
export function createGmStorage(key, gm) {
  return {
    read() {
      try {
        const raw = gm.getValue(key, null);
        if (raw === null || raw === undefined || raw === '') return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        gm.setValue(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked: the in-memory copy still works this session */
      }
    },
  };
}

export function createSettings(storage) {
  const saved = storage.read();
  const values = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!values.glossSites || typeof values.glossSites !== 'object') values.glossSites = {};

  function persist() {
    storage.write(values);
  }

  return {
    all() {
      return { ...values };
    },
    get lookupEnabled() {
      return values.lookupEnabled !== false;
    },
    setLookupEnabled(on) {
      values.lookupEnabled = Boolean(on);
      persist();
    },
    glossOn(host) {
      return Boolean(values.glossSites[host]);
    },
    setGlossOn(host, on) {
      if (on) values.glossSites[host] = true;
      else delete values.glossSites[host];
      persist();
    },
    targetOverride(host) {
      return values.targetOverrides[host];
    },
    setTargetOverride(host, lang) {
      if (lang) values.targetOverrides[host] = lang;
      else delete values.targetOverrides[host];
      persist();
    },
    disabledProviders() {
      return [...values.disabledProviders];
    },
    get theme() {
      return normalizeTheme(values.theme);
    },
    setTheme(theme) {
      values.theme = normalizeTheme(theme);
      persist();
    },
  };
}

export function createBook(gm) {
  return createStore({ storage: createGmStorage(ENTRIES_KEY, gm) });
}

export function createLookupCache(gm) {
  const storage = createGmStorage(CACHE_KEY, gm);
  return createCache({
    storage: {
      read() {
        const raw = storage.read();
        return raw && typeof raw === 'object' ? Object.entries(raw) : [];
      },
      write(pairs) {
        storage.write(Object.fromEntries(pairs));
      },
    },
  });
}

export { SETTINGS_KEY, ENTRIES_KEY, CACHE_KEY, DEFAULTS };