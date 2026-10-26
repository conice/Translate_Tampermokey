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

test('store exports and imports JSON without duplicating', () => {
  const store = createStore({ storage: memoryStorage() });
  store.add(makeEntry(base));
  const json = store.exportJson();

  const target = createStore({ storage: memoryStorage() });
  target.add(makeEntry({ ...base, translation: '旧值' }));
  const report = target.importJson(json);
  assert.deepEqual(report, { added: 0, updated: 1, skipped: 0 });
  assert.equal(target.get('en|run').translation, '跑');
});

test('store import reports malformed records as skipped', () => {
  const store = createStore({ storage: memoryStorage() });
  const report = store.importJson(
    JSON.stringify({
      entries: [
        { entryId: 'en|ok', term: 'ok', normalized: 'ok', sourceLang: 'en', targetLang: 'zh-CN', translation: '好' },
        { nope: 1 },
        { entryId: 'en|bad' },
      ],
    }),
  );
  assert.equal(report.skipped, 2);
  assert.equal(report.added, 1);
});

test('store import rejects input that is not an entry list', () => {
  const store = createStore({ storage: memoryStorage() });
  assert.throws(() => store.importJson('{"hello":1}'), /entries/);
  assert.throws(() => store.importJson('not json'), /JSON/);
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