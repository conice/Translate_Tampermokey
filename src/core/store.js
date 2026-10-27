import { decodeCsv, encodeCsv, unguardCell } from './csv.js';
import { normalizeTerm } from './normalize.js';
import { LANGUAGE_ORDER, languageLabel, normalizeLangTag } from './lang.js';

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

/** The largest timestamp a JavaScript Date can hold, in milliseconds. */
export const MAX_TIME_MS = 8.64e15;

/**
 * A timestamp outside the Date range is not a date. Passing one to
 * `new Date(...).toISOString()` throws, and a throw while encoding would take
 * the whole save down with it — including saves that have nothing to do with
 * the bad row. Values that are not timestamps fall back to the moment of import.
 */
function parseAddedAt(raw, fallback) {
  const text = raw.trim();
  if (text === '') return fallback;
  const numeric = /^-?\d+$/u.test(text);
  const value = numeric ? Number(text) : Date.parse(text);
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : fallback;
}

function exportAddedAt(addedAt) {
  return typeof addedAt === 'number' && Number.isFinite(addedAt) && Math.abs(addedAt) <= MAX_TIME_MS
    ? new Date(addedAt).toISOString()
    : '';
}

/**
 * The book as CSV. A file gets the BOM and the formula guard, because a human
 * opens it in a spreadsheet; what the userscript manager keeps gets neither.
 */
export function entriesToCsv(entries, { bom = false, human = false } = {}) {
  const row = (entry) =>
    CSV_COLUMNS.map((column) =>
      column === 'addedAt' ? exportAddedAt(entry.addedAt) : entry[column],
    );
  return encodeCsv(CSV_COLUMNS, entries.map(row), { bom, formulaSafe: human });
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

  /*
   * Codes and identifiers are trimmed: a hand-edited file picks up stray spaces
   * from a spreadsheet, and `zh-CN ` is not a language tag. The user's own text
   * (translation, phonetic) keeps its edges — the exporter quotes them
   * precisely so they survive, and trimming here would undo that promise.
   */
  const code = (cells, name) => {
    const index = column(name);
    return index === -1 ? '' : unguardCell(cells[index] ?? '').trim();
  };
  const prose = (cells, name) => {
    const index = column(name);
    return index === -1 ? '' : unguardCell(cells[index] ?? '');
  };

  const entries = [];
  let skipped = 0;
  for (const cells of rows) {
    const sourceLang = code(cells, 'sourceLang');
    const targetLang = code(cells, 'targetLang');
    const translation = prose(cells, 'translation');
    const rawTerm = code(cells, 'term');
    /*
     * Identity is always normalizeTerm of the surface form, exactly as the
     * lookup flow computes it. Trusting the `normalized` column would let a
     * hand-edited file mint an entryId that no lookup can ever produce, so the
     * row would sit in the book and never match a gloss.
     */
    const surface = rawTerm || code(cells, 'normalized');
    const normalized = normalizeTerm(surface);
    if (!sourceLang || !targetLang || !normalized || !translation.trim()) {
      skipped += 1;
      continue;
    }
    entries.push({
      entryId: `${sourceLang}|${normalized}`,
      term: surface,
      normalized,
      sourceLang,
      targetLang,
      translation,
      phonetic: prose(cells, 'phonetic') || undefined,
      partOfSpeech: code(cells, 'partOfSpeech') || undefined,
      addedAt: parseAddedAt(prose(cells, 'addedAt'), now()),
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
 * Group Entries by the language they are written in — the language the reader
 * is learning, not the one they read the page in. A word saved from an English
 * page and the same word saved from a Japanese page belong to different
 * groups, because the entry identity is per source language.
 *
 * Groups follow a fixed order (LANGUAGE_ORDER, then unknown codes
 * alphabetically, then entries with no language at all) rather than one sorted
 * by size: adding a word must not reshuffle the book under the reader's
 * finger. Entries keep the order they were handed in, which the Panel makes
 * newest-first.
 */
export function groupBySourceLang(entries) {
  const groups = new Map();
  for (const entry of entries ?? []) {
    const lang = normalizeLangTag(entry?.sourceLang);
    const existing = groups.get(lang);
    if (existing) existing.entries.push(entry);
    else groups.set(lang, { lang, label: languageLabel(lang), entries: [entry] });
  }
  return [...groups.values()].sort((a, b) => {
    const rankA = LANGUAGE_ORDER.indexOf(a.lang);
    const rankB = LANGUAGE_ORDER.indexOf(b.lang);
    if (rankA !== -1 && rankB !== -1) return rankA - rankB;
    if (rankA !== -1) return -1;
    if (rankB !== -1) return 1;
    if (!a.lang) return 1;
    if (!b.lang) return -1;
    return a.lang.localeCompare(b.lang);
  });
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
    // The adapter reports whether the value reached storage; `undefined` means
    // an in-memory double, which cannot fail.
    return storage.write(entries);
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
      /*
       * A BOM keeps Excel from reading the UTF-8 file as the system code page;
       * the formula guard is only for this file, since the book's text comes
       * from arbitrary pages and a cell like `=1+1` is otherwise run on open.
       */
      return entriesToCsv(entries, { bom: true, human: true });
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
      /*
       * The counts above describe this session's copy only. If the write was
       * refused, the next reload shows the old book, so say so rather than
       * reporting an import that did not survive.
       */
      if (save() === false) {
        throw new Error('词条已读入,但没能写入存储,刷新页面后会丢失');
      }
      return { added, updated, skipped };
    },
  };
}
