import test from 'node:test';
import assert from 'node:assert/strict';
import { readSelection, sourceLangOf, createLookupFlow, addEntry } from '../src/app/lookup-flow.js';

function fakeSelection(text, rangeCount = 1) {
  return { rangeCount, toString: () => text };
}

function fakeBook() {
  const map = new Map();
  return {
    has: (id) => map.has(id),
    add: (entry) => {
      map.set(entry.entryId, entry);
      return entry;
    },
    get: (id) => map.get(id),
    size: () => map.size,
  };
}

function recorder() {
  const calls = [];
  return { calls, render: (state) => calls.push(state) };
}

test('readSelection reports what the Selection is worth looking up', () => {
  assert.deepEqual(readSelection(fakeSelection('  Running, ')), { status: 'ok', text: 'Running,' });
  assert.deepEqual(readSelection(fakeSelection('We are all here today.')), {
    status: 'ok',
    text: 'We are all here today.',
  });
  assert.deepEqual(readSelection(fakeSelection('')), { status: 'empty', text: '' });
  assert.deepEqual(readSelection(fakeSelection('   ')), { status: 'empty', text: '' });
  assert.deepEqual(readSelection(fakeSelection('x'.repeat(401))), { status: 'too-long', text: '' });
  assert.equal(readSelection(fakeSelection('hi', 0)).status, 'empty');
  assert.equal(readSelection(null).status, 'empty');
});

test('readSelection keeps the line breaks a sentence was written with', () => {
  assert.equal(readSelection(fakeSelection('One line.\nTwo lines.')).text, 'One line.\nTwo lines.');
});

test('sourceLangOf infers CJK languages and leaves latin as auto', () => {
  assert.equal(sourceLangOf('跑'), 'zh');
  assert.equal(sourceLangOf('りんご'), 'ja');
  assert.equal(sourceLangOf('사과'), 'ko');
  assert.equal(sourceLangOf('run'), 'auto');
});

test('lookup renders loading then the result', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({}),
  });

  await flow.lookup({ term: 'run', anchor: { top: 0, bottom: 10, left: 0 } });
  assert.equal(popup.calls[0].status, 'loading');
  assert.equal(popup.calls.at(-1).status, 'ok');
  assert.equal(popup.calls.at(-1).translation, '跑');
  assert.equal(popup.calls.at(-1).canSave, true);
});

test('lookup marks an entry already in the book', async () => {
  const popup = recorder();
  const book = fakeBook();
  book.add({ entryId: 'en|run', normalized: 'run' });
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book,
    pageLanguage: () => 'en',
    settings: () => ({}),
  });
  await flow.lookup({ term: 'run' });
  assert.equal(popup.calls.at(-1).alreadySaved, true);
});

test('lookup refuses to save a long phrase but still translates it', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '很长的一句话', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({}),
  });
  await flow.lookup({ term: 'this is a rather long phrase to save' });
  assert.equal(popup.calls.at(-1).canSave, false);
  assert.equal(popup.calls.at(-1).translation, '很长的一句话');
});

test('lookup shows an error state and offers a retry', async () => {
  const popup = recorder();
  let attempt = 0;
  const flow = createLookupFlow({
    popup,
    translator: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('down');
      return [{ translation: '跑', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({}),
  });

  await flow.lookup({ term: 'run' });
  assert.equal(popup.calls.at(-1).status, 'error');
  await popup.calls.at(-1).onRetry();
  assert.equal(popup.calls.at(-1).status, 'ok');
});

test('a slow lookup that resolves after a newer one is discarded', async () => {
  const popup = recorder();
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const flow = createLookupFlow({
    popup,
    translator: async () => {
      call += 1;
      if (call === 1) {
        await firstDone;
        return [{ translation: '旧', detectedSource: 'en' }];
      }
      return [{ translation: '新', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({}),
  });

  const slow = flow.lookup({ term: 'run' });
  await flow.lookup({ term: 'apple' });
  releaseFirst();
  await slow;
  assert.equal(popup.calls.at(-1).translation, '新');
});

test('lookup attaches dictionary details when available', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ phonetic: '/rʌn/', meanings: [{ pos: 'verb', definition: 'x' }] }),
    settings: () => ({}),
  });
  await flow.lookup({ term: 'run' });
  assert.equal(popup.calls.at(-1).phonetic, '/rʌn/');
  assert.equal(popup.calls.at(-1).meanings[0].pos, 'verb');
});

test('a failing dictionary call does not fail the lookup', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => {
      throw new Error('nope');
    },
    settings: () => ({}),
  });
  await flow.lookup({ term: 'run' });
  assert.equal(popup.calls.at(-1).status, 'ok');
});

test('a lookup stays silent unless auto-speak is on', async () => {
  const popup = recorder();
  const spoken = [];
  const deps = {
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ phonetic: '/rʌn/', audio: 'https://example.com/run.mp3' }),
    speak: (...args) => spoken.push(args),
  };

  await createLookupFlow({ ...deps, settings: () => ({}) }).lookup({ term: 'run' });
  await createLookupFlow({ ...deps, settings: () => ({ autoSpeak: false }) }).lookup({ term: 'run' });
  assert.deepEqual(spoken, [], 'sound must be opted into, not a default');
});

test('auto-speak reads the looked-up word with its recording', async () => {
  const popup = recorder();
  const spoken = [];
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ phonetic: '/rʌn/', audio: 'https://example.com/run.mp3' }),
    speak: (...args) => spoken.push(args),
    settings: () => ({ autoSpeak: true }),
  });

  await flow.lookup({ term: 'Running' });
  assert.deepEqual(spoken, [['running', 'en', 'https://example.com/run.mp3']]);
  assert.equal(popup.calls.at(-1).status, 'ok', 'playback must not wait on or alter the render');
});

test('auto-speak leaves a sentence to the speak button', async () => {
  const popup = recorder();
  const spoken = [];
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '我们都在这儿。', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    speak: (...args) => spoken.push(args),
    settings: () => ({ autoSpeak: true }),
  });

  await flow.lookup({ term: 'We are all here today and the weather is fine.' });
  assert.deepEqual(spoken, [], 'reading every selected sentence aloud would be a lecture');
  assert.ok(popup.calls.at(-1).canSpeak, 'the Popup button is still there for one sentence');
});

test('lookup honours a per-site target override', async () => {
  const popup = recorder();
  const seen = [];
  const flow = createLookupFlow({
    popup,
    translator: async ({ text, source, target }) => {
      seen.push({ source, target });
      return [{ translation: 'x', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({ targetOverride: () => 'ja' }),
    host: 'example.com',
  });
  await flow.lookup({ term: 'run' });
  assert.equal(seen[0].target, 'ja');
  assert.equal(popup.calls.at(-1).target, 'ja', 'the Popup shows what is being translated into');
  assert.equal(popup.calls.at(-1).targetOverride, 'ja', 'the Popup needs the override to select it');
});

test('a lookup without an override tells the Popup to follow the page', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async () => [{ translation: '跑', detectedSource: 'en' }],
    book: fakeBook(),
    pageLanguage: () => 'en',
    settings: () => ({ targetOverride: () => undefined }),
    host: 'example.com',
  });

  await flow.lookup({ term: 'run' });
  assert.equal(popup.calls.at(-1).target, 'zh-CN');
  assert.equal(popup.calls.at(-1).targetOverride, '');
});

test('a sentence is translated as written, without dictionary work', async () => {
  const popup = recorder();
  const seen = [];
  let dictionaryCalls = 0;
  const flow = createLookupFlow({
    popup,
    translator: async (args) => {
      seen.push(args);
      return [{ translation: '我们都在这儿。', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => {
      dictionaryCalls += 1;
      return { phonetic: '/x/', lemma: 'be' };
    },
    settings: () => ({}),
  });

  const sentence = 'We are all here.\nAnd the weather is fine.';
  const result = await flow.lookup({ term: sentence });

  assert.deepEqual(result, [], 'a sentence is not an Entry');
  assert.equal(seen[0].text, sentence, 'case, punctuation and line breaks must reach the translator');
  assert.equal(dictionaryCalls, 0, 'a sentence is not in a dictionary');

  const state = popup.calls.at(-1);
  assert.equal(state.sentence, true);
  assert.equal(state.canSave, false);
  assert.equal(state.entry, undefined);
  assert.equal(state.meanings, undefined);
  assert.equal(state.lemma, undefined);
});

test('a sentence that is actually a short phrase stays a word', async () => {
  const popup = recorder();
  const seen = [];
  const flow = createLookupFlow({
    popup,
    translator: async (args) => {
      seen.push(args);
      return [{ translation: '起飞', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ phonetic: '/teɪk ɒf/' }),
    settings: () => ({}),
  });

  await flow.lookup({ term: 'Take off' });

  assert.equal(popup.calls.at(-1).sentence, false);
  assert.equal(seen[0].text, 'take off', 'a saveable phrase is still normalized as a word');
  assert.ok(popup.calls.at(-1).phonetic, 'a word still gets dictionary details');
});

test('addEntry writes the entry and notifies', () => {
  const book = fakeBook();
  const saved = [];
  const entry = {
    term: 'run',
    normalized: 'run',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    translation: '跑',
  };
  assert.equal(addEntry(book, entry, (e) => saved.push(e)), true);
  assert.equal(book.get('en|run').translation, '跑');
  assert.equal(saved.length, 1);
});

test('addEntry refuses an entry with no translation', () => {
  const book = fakeBook();
  assert.equal(addEntry(book, { normalized: 'x', sourceLang: 'en' }), false);
  assert.equal(book.size(), 0);
});
test('a lemma hint is offered with its own translation', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async ({ text }) => [
      { translation: text === 'running' ? '跑步中' : '跑', detectedSource: 'en' },
    ],
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ lemma: 'run' }),
    settings: () => ({}),
  });
  await flow.lookup({ term: 'running' });
  const state = popup.calls.at(-1);
  assert.equal(state.lemma.term, 'run');
  assert.equal(state.lemma.translation, '跑');
  assert.equal(state.translation, '跑步中', 'the saved form must stay what the user selected');
});

test('a failing lemma translation does not turn the lookup into an error', async () => {
  const popup = recorder();
  const flow = createLookupFlow({
    popup,
    translator: async ({ text }) => {
      if (text === 'run') throw new Error('down');
      return [{ translation: '跑步中', detectedSource: 'en' }];
    },
    book: fakeBook(),
    pageLanguage: () => 'en',
    dictionary: async () => ({ lemma: 'run' }),
    settings: () => ({}),
  });
  await flow.lookup({ term: 'running' });
  assert.equal(popup.calls.at(-1).status, 'ok');
  assert.equal(popup.calls.at(-1).lemma, undefined);
});
