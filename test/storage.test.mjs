import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_KEY,
  ENTRIES_KEY,
  SETTINGS_KEY,
  STORAGE_CODECS,
  createBook,
  createGmStorage,
  createLookupCache,
  createSettings,
} from '../src/app/storage.js';
import { TTL_SUCCESS_MS } from '../src/core/cache.js';

/** A stand-in for GM_getValue / GM_setValue that keeps the raw strings. */
function fakeGm(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    setValue: (key, value) => values.set(key, value),
    raw: (key) => values.get(key),
  };
}

const RUN = {
  entryId: 'en|run',
  term: 'run',
  normalized: 'run',
  sourceLang: 'en',
  targetLang: 'zh-CN',
  translation: '跑',
  addedAt: 1_700_000_000_000,
};

test('the book is stored as CSV with a header, not as one JSON blob', () => {
  const gm = fakeGm();
  createBook(gm).add(RUN);

  const raw = gm.raw(ENTRIES_KEY);
  assert.equal(
    raw.split('\r\n')[0],
    'term,normalized,sourceLang,targetLang,translation,phonetic,partOfSpeech,addedAt',
  );
  assert.match(raw, /^term,normalized.*\r\nrun,run,en,zh-CN,跑,,,2023-11-14T22:13:20\.000Z$/);
  assert.equal(raw.startsWith('{') || raw.startsWith('['), false);
});

test('a book written as CSV is read back by the next page load', () => {
  const gm = fakeGm();
  createBook(gm).add(RUN);

  const book = createBook(gm);
  assert.equal(book.all().length, 1);
  assert.equal(book.get('en|run').translation, '跑');
  assert.equal(book.get('en|run').addedAt, 1_700_000_000_000);
});

test('settings round-trip through CSV, maps and lists included', () => {
  const gm = fakeGm();
  const first = createSettings(gm);
  first.setTheme('dark');
  first.setLookupEnabled(false);
  first.setAutoSpeak(true);
  first.setGlossOn('example.com', true);
  first.setTargetOverride('news.example', 'ja');

  const raw = gm.raw(SETTINGS_KEY);
  assert.match(raw, /^section,key,value\r\n/);
  assert.match(raw, /^general,version,1$/m);
  assert.match(raw, /^general,theme,dark$/m);
  assert.match(raw, /^general,lookupEnabled,false$/m);
  assert.match(raw, /^general,autoSpeak,true$/m);
  assert.match(raw, /^glossSites,example\.com,true$/m);
  assert.match(raw, /^targetOverrides,news\.example,ja$/m);

  const second = createSettings(gm);
  assert.equal(second.theme, 'dark');
  assert.equal(second.lookupEnabled, false);
  assert.equal(second.autoSpeak, true);
  assert.equal(second.glossOn('example.com'), true);
  assert.equal(second.glossOn('other.com'), false);
  assert.equal(second.targetOverride('news.example'), 'ja');
  assert.equal(second.all().version, 1, 'numbers must not come back as strings');
});

test('auto-speak is off until the user asks for it, and only a boolean counts', () => {
  const gm = fakeGm();
  assert.equal(createSettings(gm).autoSpeak, false);

  createSettings(gm).setAutoSpeak(true);
  assert.equal(createSettings(gm).autoSpeak, true);

  createSettings(gm).setAutoSpeak(false);
  assert.equal(createSettings(gm).autoSpeak, false);

  const junk = fakeGm({
    [SETTINGS_KEY]: ['section,key,value', 'general,autoSpeak,yes'].join('\r\n'),
  });
  assert.equal(createSettings(junk).autoSpeak, false, 'a hand-edited cell must not read as true');
});

test('a disabled provider list survives the round trip', () => {
  const gm = fakeGm({
    [SETTINGS_KEY]: ['section,key,value', 'general,version,1', 'disabledProviders,,lingva'].join('\r\n'),
  });
  const settings = createSettings(gm);
  assert.deepEqual(settings.disabledProviders(), ['lingva']);
});

test('the cache is stored as CSV rows, one per lookup', () => {
  const gm = fakeGm();
  const cache = createLookupCache(gm);
  cache.set('en|zh-CN|run', { translation: '跑' });

  const raw = gm.raw(CACHE_KEY);
  assert.equal(raw.split('\r\n')[0], 'key,value,expires,used');
  // The record rides in one cell as JSON, so its own quotes are doubled.
  assert.match(raw, /^en\|zh-CN\|run,"\{""translation"":""跑""\}",/m);

  const reloaded = createLookupCache(gm);
  assert.deepEqual(reloaded.get('en|zh-CN|run'), { translation: '跑' });
});

test('a cache entry with a comma in its key or value survives quoting', () => {
  const gm = fakeGm();
  const cache = createLookupCache(gm);
  cache.set('en|zh-CN|a,b', { translation: 'x,y "z"' });

  assert.deepEqual(createLookupCache(gm).get('en|zh-CN|a,b'), { translation: 'x,y "z"' });
});

test('storage written by the JSON era is still read', () => {
  const gm = fakeGm({
    [ENTRIES_KEY]: JSON.stringify([RUN]),
    [SETTINGS_KEY]: JSON.stringify({ version: 1, lookupEnabled: false, glossSites: { 'a.com': true } }),
    [CACHE_KEY]: JSON.stringify({ 'en|zh-CN|run': { value: { translation: '跑' }, expires: Date.now() + TTL_SUCCESS_MS, used: Date.now() } }),
  });

  assert.equal(createBook(gm).get('en|run').translation, '跑');
  const settings = createSettings(gm);
  assert.equal(settings.lookupEnabled, false);
  assert.equal(settings.glossOn('a.com'), true);
  assert.deepEqual(createLookupCache(gm).get('en|zh-CN|run'), { translation: '跑' });
});

test('the first write after upgrading replaces the JSON value with CSV', () => {
  const gm = fakeGm({
    [ENTRIES_KEY]: JSON.stringify([RUN]),
    [SETTINGS_KEY]: JSON.stringify({ version: 1, lookupEnabled: true }),
  });

  createBook(gm).add({ ...RUN, term: 'walk', normalized: 'walk', entryId: 'en|walk', translation: '走' });
  createSettings(gm).setTheme('dark');

  assert.match(gm.raw(ENTRIES_KEY), /^term,normalized,sourceLang,targetLang,translation/);
  assert.match(gm.raw(SETTINGS_KEY), /^section,key,value\r\n/);
});

test('an unreadable store degrades to empty instead of throwing', () => {
  const gm = fakeGm({
    [ENTRIES_KEY]: '"unclosed',
    [SETTINGS_KEY]: '"unclosed',
    [CACHE_KEY]: '"unclosed',
  });

  assert.deepEqual(createBook(gm).all(), []);
  assert.equal(createSettings(gm).theme, 'system');
  assert.equal(createLookupCache(gm).size, 0);
});

test('a storage adapter that throws on both calls leaves the script running', () => {
  const broken = {
    getValue() {
      throw new Error('blocked');
    },
    setValue() {
      throw new Error('full');
    },
  };
  const book = createBook(broken);
  book.add(RUN);
  assert.equal(book.get('en|run').translation, '跑', 'the in-memory copy still works');
  assert.deepEqual(createSettings(broken).all().theme, 'system');
});

test('the stored entry list has the same columns as the exported file, minus the BOM', () => {
  const gm = fakeGm();
  const book = createBook(gm);
  book.add(RUN);
  assert.equal(gm.raw(ENTRIES_KEY), book.exportCsv().replace(/^\uFEFF/u, ''));
});

test('the stored copy is not formula-guarded, only the exported file is', () => {
  const gm = fakeGm();
  createBook(gm).add({
    ...RUN,
    entryId: 'en|1+1',
    term: '=1+1',
    normalized: '1+1',
    translation: '-2+3',
  });

  const raw = gm.raw(ENTRIES_KEY);
  assert.match(raw, /^=1\+1,/mu, 'storage is read by this script alone and keeps values raw');
  assert.doesNotMatch(raw, /'/u);
});

test('a cache row whose expiry is not a number is dropped rather than kept forever', () => {
  const gm = fakeGm({
    [CACHE_KEY]: [
      'key,value,expires,used',
      'en|zh-CN|run,"{""translation"":""跑""}",oops,oops',
      'en|zh-CN|ok,"{""translation"":""好""}",9999999999999,123',
    ].join('\r\n'),
  });

  assert.equal(createLookupCache(gm).size, 1, 'NaN <= now is false, so such a row would never expire');
  assert.deepEqual(createLookupCache(gm).get('en|zh-CN|ok'), { translation: '好' });
});

test('a write the manager refuses is reported as false', () => {
  const gm = {
    getValue: () => null,
    setValue: () => {
      throw new Error('full');
    },
  };
  const storage = createGmStorage(ENTRIES_KEY, gm, STORAGE_CODECS.entries);
  assert.equal(storage.write([RUN]), false);
});

test('a value the codec cannot encode surfaces instead of being reported as saved', () => {
  const storage = createGmStorage('custom', fakeGm(), {
    empty: null,
    decode: (text) => text,
    encode: () => {
      throw new Error('bad value');
    },
  });
  assert.throws(() => storage.write('x'), /bad value/u);
});

test('the codec table exposes the same formats the factories use', () => {
  const encoded = STORAGE_CODECS.entries.encode([RUN]);
  assert.deepEqual(STORAGE_CODECS.entries.decode(encoded)[0].normalized, 'run');
  assert.equal(STORAGE_CODECS.settings.decode(STORAGE_CODECS.settings.encode({ theme: 'dark' })).theme, 'dark');
  assert.deepEqual(STORAGE_CODECS.cache.decode(STORAGE_CODECS.cache.encode({})), {});
});

test('createGmStorage reads through the codec it is given', () => {
  const gm = fakeGm({ custom: 'a,b\r\n1,2' });
  const storage = createGmStorage('custom', gm, {
    empty: null,
    decode: (text) => text,
    encode: (value) => value,
  });
  assert.equal(storage.read(), 'a,b\r\n1,2');
  assert.equal(storage.write('wrote'), true);
  assert.equal(gm.raw('custom'), 'wrote');
});
