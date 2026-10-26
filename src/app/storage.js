import { createCache } from '../core/cache.js';
import { decodeCsv, encodeCsv } from '../core/csv.js';
import { createStore, entriesToCsv, readEntriesCsv } from '../core/store.js';
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

/*
 * Settings are a `section,key,value` table. Scalars live in `general`; the two
 * host-keyed maps and the provider list are one row each, so a settings dump
 * reads like the panel it mirrors instead of one long enclosed line.
 */
const SETTINGS_COLUMNS = ['section', 'key', 'value'];
const SETTINGS_MAPS = ['glossSites', 'targetOverrides'];
const SETTINGS_LISTS = ['disabledProviders'];

/*
 * One cache row per lookup. `value` is the only cell whose shape is not a flat
 * string — it is a record — so it travels as JSON inside the cell.
 */
const CACHE_COLUMNS = ['key', 'value', 'expires', 'used'];

/** CSV carries text. Booleans and numbers are the only other types settings use. */
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/u;

function scalarText(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === null || value === undefined ? '' : String(value);
}

function scalarValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return NUMBER_RE.test(text) ? Number(text) : text;
}

/**
 * Values written before the switch to CSV are still JSON. Reading them once is
 * the whole migration: the next write replaces them with the new format, so a
 * user's book survives the upgrade without any explicit step.
 */
function legacyJson(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function encodeSettings(values) {
  const rows = [];
  for (const [name, value] of Object.entries(values)) {
    if (SETTINGS_MAPS.includes(name)) {
      for (const [key, entryValue] of Object.entries(value || {})) {
        rows.push([name, key, scalarText(entryValue)]);
      }
    } else if (SETTINGS_LISTS.includes(name)) {
      for (const item of value || []) rows.push([name, '', scalarText(item)]);
    } else {
      rows.push(['general', name, scalarText(value)]);
    }
  }
  return encodeCsv(SETTINGS_COLUMNS, rows);
}

function decodeSettings(text) {
  const legacy = legacyJson(text);
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) return legacy;

  const values = {};
  for (const [section, key, value] of decodeCsv(text)) {
    if (!section) continue;
    if (section === 'general') {
      values[key] = scalarValue(value);
    } else if (SETTINGS_MAPS.includes(section)) {
      if (!values[section]) values[section] = {};
      values[section][key] = scalarValue(value);
    } else if (SETTINGS_LISTS.includes(section)) {
      if (!values[section]) values[section] = [];
      values[section].push(value);
    }
  }
  return values;
}

/** How one storage key is written to, and read back from, the userscript manager. */
const SETTINGS_CODEC = {
  empty: null,
  encode: encodeSettings,
  decode: decodeSettings,
};

const ENTRIES_CODEC = {
  empty: [],
  encode: (entries) => entriesToCsv(entries),
  decode(text) {
    const legacy = legacyJson(text);
    if (legacy !== undefined) {
      if (Array.isArray(legacy)) return legacy;
      return Array.isArray(legacy?.entries) ? legacy.entries : [];
    }
    return readEntriesCsv(text).entries;
  },
};

const CACHE_CODEC = {
  empty: {},
  encode(records) {
    const rows = Object.entries(records).map(([key, record]) => [
      key,
      JSON.stringify(record?.value ?? null),
      scalarText(record?.expires),
      scalarText(record?.used),
    ]);
    return encodeCsv(CACHE_COLUMNS, rows);
  },
  decode(text) {
    const legacy = legacyJson(text);
    if (legacy !== undefined) {
      return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {};
    }
    const records = {};
    for (const [key, value, expires, used] of decodeCsv(text)) {
      if (!key) continue;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      records[key] = { value: parsed, expires: Number(expires), used: Number(used) };
    }
    return records;
  },
};

/** The three on-disk formats, exported so tests can seed and inspect them. */
export const STORAGE_CODECS = {
  settings: SETTINGS_CODEC,
  entries: ENTRIES_CODEC,
  cache: CACHE_CODEC,
};

/**
 * Thin adapter over the userscript manager's key/value store.
 * Every access is wrapped: GM storage throws in some managers, and a broken
 * store must degrade to "nothing remembered", not to a dead script.
 */
export function createGmStorage(key, gm, codec) {
  return {
    read() {
      try {
        const raw = gm.getValue(key, null);
        if (raw === null || raw === undefined || raw === '') return codec.empty;
        return codec.decode(String(raw));
      } catch {
        return codec.empty;
      }
    },
    write(value) {
      try {
        gm.setValue(key, codec.encode(value));
      } catch {
        /* storage full or blocked: the in-memory copy still works this session */
      }
    },
  };
}

export function createSettings(gm) {
  const storage = createGmStorage(SETTINGS_KEY, gm, SETTINGS_CODEC);
  const saved = storage.read();
  const values = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!values.glossSites || typeof values.glossSites !== 'object') values.glossSites = {};
  if (!values.targetOverrides || typeof values.targetOverrides !== 'object') {
    values.targetOverrides = {};
  }
  if (!Array.isArray(values.disabledProviders)) values.disabledProviders = [];

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
  return createStore({ storage: createGmStorage(ENTRIES_KEY, gm, ENTRIES_CODEC) });
}

export function createLookupCache(gm) {
  const storage = createGmStorage(CACHE_KEY, gm, CACHE_CODEC);
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
