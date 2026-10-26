export const STORAGE_KEY = 'entries';

/** Identity is (source language, normalized form): `Running` and `run` differ. */
export function makeEntry({
  term,
  normalized,
  sourceLang,
  targetLang,
  translation,
  phonetic,
  partOfSpeech,
  now = Date.now,
}) {
  return {
    entryId: `${sourceLang}|${normalized}`,
    term,
    normalized,
    sourceLang,
    targetLang,
    translation,
    phonetic,
    partOfSpeech,
    addedAt: now(),
  };
}

/**
 * The Vocabulary Book, persisted as one JSON blob through the storage adapter
 * so the same code runs on GM storage and an in-memory double in tests.
 */
export function createStore({ storage, now = Date.now }) {
  let entries = load();

  function load() {
    const raw = storage.read();
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidEntry);
  }

  function save() {
    storage.write(entries);
  }

  function isValidEntry(value) {
    return (
      value &&
      typeof value === 'object' &&
      typeof value.entryId === 'string' &&
      typeof value.normalized === 'string' &&
      typeof value.translation === 'string'
    );
  }

  return {
    all() {
      return [...entries];
    },

    get(entryId) {
      return entries.find((entry) => entry.entryId === entryId);
    },

    has(entryId) {
      return entries.some((entry) => entry.entryId === entryId);
    },

    add(entry) {
      const existingIndex = entries.findIndex((e) => e.entryId === entry.entryId);
      if (existingIndex === -1) {
        entries.push({ ...entry });
      } else {
        // Refreshing must not lose when the word was first saved.
        entries[existingIndex] = { ...entry, addedAt: entries[existingIndex].addedAt };
      }
      save();
      return entries.find((e) => e.entryId === entry.entryId);
    },

    remove(entryId) {
      const before = entries.length;
      entries = entries.filter((entry) => entry.entryId !== entryId);
      if (entries.length !== before) save();
    },

    clear() {
      entries = [];
      save();
    },

    /** normalized form -> translation, for one target language. */
    translationMap(targetLang) {
      const map = new Map();
      for (const entry of entries) {
        if (targetLang && entry.targetLang !== targetLang) continue;
        map.set(entry.normalized, entry.translation);
      }
      return map;
    },

    exportJson() {
      return JSON.stringify({ version: 1, exportedAt: new Date(now()).toISOString(), entries }, null, 2);
    },

    importJson(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('不是有效的 JSON');
      }
      const incoming = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(incoming)) throw new Error('缺少 entries 列表');

      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const record of incoming) {
        if (!isValidEntry(record)) {
          skipped += 1;
          continue;
        }
        const existingIndex = entries.findIndex((e) => e.entryId === record.entryId);
        if (existingIndex === -1) {
          entries.push({ ...record });
          added += 1;
        } else {
          entries[existingIndex] = { ...record, addedAt: entries[existingIndex].addedAt };
          updated += 1;
        }
      }
      save();
      return { added, updated, skipped };
    },
  };
}