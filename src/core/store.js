import { decodeCsv, encodeCsv } from './csv.js';
import { normalizeTerm } from './normalize.js';

export const STORAGE_KEY = 'entries';

/**
 * The book's columns, in order. `entryId` is deliberately absent: it is
 * derived from `sourceLang` and `normalized`, so a file cannot disagree with
 * itself. The same columns back the exported file and the stored copy.
 */
export const CSV_COLUMNS = [
  'term',
  'normalized',
  'sourceLang',
  'targetLang',
  'translation',
  'phonetic',
  'partOfSpeech',
  'addedAt',
];

function parseAddedAt(raw, fallback) {
  const text = raw.trim();
  if (text === '') return fallback;
  if (/^\d+$/u.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function exportAddedAt(addedAt) {
  return typeof addedAt === 'number' && Number.isFinite(addedAt)
    ? new Date(addedAt).toISOString()
    : '';
}

/** The book as CSV. A file gets the BOM; what the userscript manager keeps does not. */
export function entriesToCsv(entries, { bom = false } = {}) {
  const row = (entry) =>
    CSV_COLUMNS.map((column) =>
      column === 'addedAt' ? exportAddedAt(entry.addedAt) : entry[column],
    );
  return encodeCsv(CSV_COLUMNS, entries.map(row), { bom });
}

/**
 * Parse a book CSV into records, dropping rows that cannot be an Entry.
 *
 * Throws when the header itself is wrong: that means the wrong file, which is
 * a different problem from a few dirty rows and deserves a different message.
 */
export function readEntriesCsv(text, { now = Date.now } = {}) {
  const rows = decodeCsv(text);
  if (rows.length === 0) throw new Error('CSV 是空的');

  // Columns are matched by name so a hand-edited file may reorder or omit
  // optional ones; these are the fields an entry cannot do without.
  const header = rows.shift().map((name) => name.trim().toLowerCase());
  const column = (name) => header.indexOf(name.toLowerCase());
  const missing = ['sourceLang', 'targetLang', 'translation'].filter(
    (name) => column(name) === -1,
  );
  if (column('term') === -1 && column('normalized') === -1) {
    missing.push('term 或 normalized');
  }
  if (missing.length > 0) throw new Error(`CSV 缺少列:${missing.join('、')}`);

  const read = (cells, name) => {
    const index = column(name);
    return index === -1 ? '' : (cells[index] ?? '').trim();
  };

  const entries = [];
  let skipped = 0;
  for (const cells of rows) {
    const sourceLang = read(cells, 'sourceLang');
    const targetLang = read(cells, 'targetLang');
    const translation = read(cells, 'translation');
    const rawTerm = read(cells, 'term');
    const normalized = read(cells, 'normalized') || normalizeTerm(rawTerm);
    if (!sourceLang || !targetLang || !normalized || !translation) {
      skipped += 1;
      continue;
    }
    entries.push({
      entryId: `${sourceLang}|${normalized}`,
      term: rawTerm || normalized,
      normalized,
      sourceLang,
      targetLang,
      translation,
      phonetic: read(cells, 'phonetic') || undefined,
      partOfSpeech: read(cells, 'partOfSpeech') || undefined,
      addedAt: parseAddedAt(read(cells, 'addedAt'), now()),
    });
  }
  return { entries, skipped };
}

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
 * The Vocabulary Book, held as an entry list and persisted through the storage
 * adapter, so the same code runs on GM storage and an in-memory double in
 * tests. The adapter is what turns that list into CSV; see STORAGE_CODECS.
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

    exportCsv() {
      // A BOM keeps Excel from reading the UTF-8 file as the system code page.
      return entriesToCsv(entries, { bom: true });
    },

    /**
     * Merge a CSV file into the book, or replace the book with it.
     * `mode: 'replace'` clears only after the file has been read and its header
     * checked, so a wrong file leaves the existing book untouched.
     */
    importCsv(text, { mode = 'merge' } = {}) {
      const { entries: incoming, skipped } = readEntriesCsv(text, { now });

      /*
       * Replacing the book with a file that holds no usable row is never what
       * the user meant: the file is empty or malformed, and clearing the book
       * would turn a mistake into data loss. Merge mode has nothing to lose.
       */
      if (mode === 'replace' && incoming.length === 0) {
        throw new Error('文件里没有可导入的词条,已保留现有生词本');
      }

      // The file has parsed and its header checks out: only now is the old
      // book dropped, so a mistyped file cannot erase it.
      if (mode === 'replace') entries = [];

      let added = 0;
      let updated = 0;
      for (const record of incoming) {
        const existingIndex = entries.findIndex((e) => e.entryId === record.entryId);
        if (existingIndex === -1) {
          entries.push(record);
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
