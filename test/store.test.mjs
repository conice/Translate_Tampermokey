import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, makeEntry } from '../src/core/store.js';

function memoryStorage(initial = undefined) {
  let data = initial;
  return {
    read: () => data,
    write: (value) => {
      data = value;
    },
    peek: () => data,
  };
}

const base = {
  term: 'run',
  normalized: 'run',
  sourceLang: 'en',
  targetLang: 'zh-CN',
  translation: '跑',
};

test('makeEntry builds an entry with a stable identity', () => {
  const entry = makeEntry({ ...base, now: () => 1_700_000_000_000 });
  assert.equal(entry.entryId, 'en|run');
  assert.equal(entry.addedAt, 1_700_000_000_000);
  assert.equal(entry.term, 'run');
});

test('makeEntry treats case variants as the same entry', () => {
  const a = makeEntry({ ...base, term: 'Running', normalized: 'running' });
  const b = makeEntry({ ...base, term: 'running', normalized: 'running' });
  assert.equal(a.entryId, b.entryId);
});

test('makeEntry keeps same-spelling words from different languages apart', () => {
  const en = makeEntry({ ...base, sourceLang: 'en' });
  const ja = makeEntry({ ...base, sourceLang: 'ja' });
  assert.notEqual(en.entryId, ja.entryId);
});

test('store adds and reads back an entry', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  assert.equal(store.get('en|run').translation, '跑');
  assert.equal(store.all().length, 1);
});

test('store re-adding the same entry updates it rather than duplicating', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry({ ...base, translation: '跑' }));
  store.add(makeEntry({ ...base, translation: '奔跑' }));
  assert.equal(store.all().length, 1);
  assert.equal(store.get('en|run').translation, '奔跑');
});

test('store keeps the original addedAt when an entry is refreshed', () => {
  let now = 1;
  const store = createStore({ storage: memoryStorage(), now: () => now });
  store.add(makeEntry({ ...base, now: () => now }));
  now = 2;
  store.add(makeEntry({ ...base, now: () => now }));
  assert.equal(store.get('en|run').addedAt, 1);
});

test('store removes an entry', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  store.remove('en|run');
  assert.equal(store.get('en|run'), undefined);
  assert.equal(store.all().length, 0);
});

test('store persists across instances', () => {
  const storage = memoryStorage();
  const first = createStore({ storage });
  first.add(makeEntry(base));
  const second = createStore({ storage });
  assert.equal(second.get('en|run').translation, '跑');
});

test('store tolerates corrupt storage', () => {
  const store = createStore({ storage: memoryStorage({ not: 'an array' }) });
  assert.deepEqual(store.all(), []);
});

test('store exports CSV and imports it without duplicating', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry({ ...base, now: () => 1_700_000_000_000 }));
  const csv = store.exportCsv();

  const [header, row] = csv.replace(/^\uFEFF/u, '').split('\r\n');
  assert.equal(
    header,
    'term,normalized,sourceLang,targetLang,translation,phonetic,partOfSpeech,addedAt',
  );
  assert.equal(row, 'run,run,en,zh-CN,跑,,,2023-11-14T22:13:20.000Z');

  const target = createStore({ storage: memoryStorage() });
  target.add(makeEntry({ ...base, translation: '旧值' }));
  const report = target.importCsv(csv);
  assert.deepEqual(report, { added: 0, updated: 1, skipped: 0 });
  assert.equal(target.get('en|run').translation, '跑');
});

test('store CSV quoting survives commas, quotes and line breaks', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(
    makeEntry({
      ...base,
      term: 'well, "known"',
      normalized: 'well, "known"',
      translation: '第一行\n第二行',
    }),
  );
  const csv = store.exportCsv();
  assert.match(csv, /"well, ""known"""/, 'a term with a comma and quotes must be wrapped');

  const target = createStore({ storage: memoryStorage() });
  assert.deepEqual(target.importCsv(csv), { added: 1, updated: 0, skipped: 0 });
  const [entry] = target.all();
  assert.equal(entry.term, 'well, "known"');
  assert.equal(entry.translation, '第一行\n第二行');
});

test('store import maps columns by header rather than position', () => {
  const store = createStore({ storage: memoryStorage() });
  const report = store.importCsv(
    'translation,targetLang,sourceLang,normalized\r\n好,zh-CN,en,ok\r\n',
  );
  assert.deepEqual(report, { added: 1, updated: 0, skipped: 0 });
  assert.equal(store.get('en|ok').translation, '好');
  assert.equal(store.get('en|ok').term, 'ok', 'term falls back to normalized');
});

test('store import reports malformed rows as skipped', () => {
  const store = createStore({ storage: memoryStorage() });
  const report = store.importCsv(
    'term,normalized,sourceLang,targetLang,translation\r\n' +
      'ok,ok,en,zh-CN,好\r\n' +
      ',missing-source,en,,好\r\n' +
      ',,en,zh-CN,没有词形\r\n' +
      'nope,nope,en,zh-CN,\r\n',
  );
  assert.deepEqual(report, { added: 1, updated: 0, skipped: 3 });
});

test('a row of nothing but commas is counted, not dropped as a blank line', () => {
  const store = createStore({ storage: memoryStorage() });
  const report = store.importCsv(
    'term,normalized,sourceLang,targetLang,translation\r\n,,,\r\n',
  );
  assert.deepEqual(report, { added: 0, updated: 0, skipped: 1 });
});

test('replacing with a file that has no usable row keeps the existing book', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));

  assert.throws(
    () => store.importCsv('term,normalized,sourceLang,targetLang,translation\r\n', {
      mode: 'replace',
    }),
    /没有可导入的词条/,
  );
  assert.throws(
    () => store.importCsv('term,normalized,sourceLang,targetLang,translation\r\n,,\r\n', {
      mode: 'replace',
    }),
    /没有可导入的词条/,
  );
  assert.equal(store.get('en|run').translation, '跑');
});

test('store import refuses CSV without the required columns', () => {
  const store = createStore({ storage: memoryStorage() });
  assert.throws(() => store.importCsv('term,translation\r\nrun,跑'), /缺少列/);
});

test('store import refuses an unclosed quoted cell', () => {
  const store = createStore({ storage: memoryStorage() });
  assert.throws(
    () => store.importCsv('term,normalized,sourceLang,targetLang,translation\r\n"run,run,en,zh-CN,跑'),
    /CSV/,
  );
});

test('store import accepts a BOM and LF line endings', () => {
  const store = createStore({ storage: memoryStorage() });
  const report = store.importCsv(
    '\uFEFFterm,normalized,sourceLang,targetLang,translation\nrun,run,en,zh-CN,跑\n',
  );
  assert.deepEqual(report, { added: 1, updated: 0, skipped: 0 });
});

test('store import keeps a missing addedAt in the present', () => {
  const store = createStore({ storage: memoryStorage(), now: () => 123 });
  store.importCsv('normalized,sourceLang,targetLang,translation\r\nrun,en,zh-CN,跑');
  assert.equal(store.get('en|run').addedAt, 123);
});

test('store replace mode drops the entries the file does not contain', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  store.add(makeEntry({ ...base, term: 'apple', normalized: 'apple', translation: '苹果' }));

  const report = store.importCsv(
    'term,normalized,sourceLang,targetLang,translation\r\napple,apple,en,zh-CN,苹果(新)\r\n',
    { mode: 'replace' },
  );

  assert.deepEqual(report, { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(store.all().map((e) => e.entryId), ['en|apple']);
  assert.equal(store.get('en|apple').translation, '苹果(新)');
});

test('store merge mode keeps the entries the file does not mention', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  store.importCsv('term,normalized,sourceLang,targetLang,translation\r\napple,apple,en,zh-CN,苹果');
  assert.deepEqual(store.all().map((e) => e.entryId).sort(), ['en|apple', 'en|run']);
});

test('a file missing required columns cannot erase the book in replace mode', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  assert.throws(() => store.importCsv('term,translation\r\nrun,跑', { mode: 'replace' }), /缺少列/);
  assert.equal(store.get('en|run').translation, '跑');
});

test('store builds a lookup map keyed by normalized term for gloss matching', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  store.add(makeEntry({ ...base, term: 'apple', normalized: 'apple', translation: '苹果' }));
  const map = store.translationMap('zh-CN');
  assert.equal(map.get('run'), '跑');
  assert.equal(map.get('apple'), '苹果');
});

test('store translation map is scoped to the target language', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  assert.equal(store.translationMap('en').has('run'), false);
});

test('a cell a spreadsheet would run as a formula is exported as literal text', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry({ ...base, term: '=1+1', normalized: '1+1', translation: '-2+3' }));
  const csv = store.exportCsv();

  // The apostrophe goes inside the cell, and is present before any quoting.
  assert.match(csv, /^'=1\+1,/mu);
  assert.match(csv, /,'-2\+3,/u);

  const target = createStore({ storage: memoryStorage() });
  target.importCsv(csv);
  const [entry] = target.all();
  assert.equal(entry.term, '=1+1', 'the guard is undone, not kept as part of the word');
  assert.equal(entry.translation, '-2+3');
});

test('an addedAt outside the Date range becomes the import time', () => {
  const store = createStore({ storage: memoryStorage(), now: () => 456 });
  store.importCsv(
    'term,normalized,sourceLang,targetLang,translation,addedAt\r\n' +
      'run,run,en,zh-CN,跑,9999999999999999999999\r\n',
  );
  assert.equal(store.get('en|run').addedAt, 456);
});

test('exporting an entry whose addedAt cannot be a Date does not throw', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add({ ...makeEntry(base), addedAt: 1e20 });
  const row = store.exportCsv().replace(/^\uFEFF/u, '').split('\r\n')[1];
  assert.equal(row.split(',').at(-1), '');
});

test('a hand-edited normalized column cannot mint an identity no lookup can produce', () => {
  const store = createStore({ storage: memoryStorage() });
  store.importCsv('term,normalized,sourceLang,targetLang,translation\r\nRunning,Running,en,zh-CN,跑');
  assert.deepEqual(store.all().map((entry) => entry.entryId), ['en|running']);
  assert.equal(store.get('en|running').term, 'Running', 'the word as written is kept');
});

test('a translation with edge spaces survives the export round trip', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry({ ...base, translation: '  spaced  ' }));
  const target = createStore({ storage: memoryStorage() });
  target.importCsv(store.exportCsv());
  assert.equal(target.get('en|run').translation, '  spaced  ');
});

test('an import whose write is refused says so instead of reporting success', () => {
  const store = createStore({ storage: { read: () => undefined, write: () => false } });
  assert.throws(
    () => store.importCsv('term,normalized,sourceLang,targetLang,translation\r\nrun,run,en,zh-CN,跑'),
    /没能写入存储/,
  );
});