import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clients5,
  lingva,
  mymemory,
  dictionaryDev,
  freedictionary,
  createTranslator,
  ProviderError,
} from '../src/core/providers.js';

// Shapes captured from live responses on 2026-10-26.
const CLIENTS5_BATCH = '[["跑步","en"],["苹果","en"],["跑","zh-CN"]]';
const CLIENTS5_SINGLE = '[["你好","en"]]';
const LINGVA = '{\n    "translation": "跑",\n    "info": {\n        "detectedSource": "en"\n    }\n}';
const MYMEMORY =
  '{"responseData":{"translatedText":"敏捷的棕色狐狸","match":1},"quotaFinished":false,"responseStatus":200}';
const DICT_DEV = JSON.stringify([
  {
    word: 'run',
    phonetics: [
      { text: '/ɹʌn/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/run-us.mp3' },
    ],
    meanings: [
      { partOfSpeech: 'verb', definitions: [{ definition: 'To move rapidly on foot.' }] },
    ],
  },
]);

test('clients5 builds a batch URL with repeated q parameters', () => {
  const url = clients5.request({ text: ['run', 'apple'], source: 'auto', target: 'zh-CN' });
  assert.match(url, /^https:\/\/clients5\.google\.com\/translate_a\/t\?/);
  assert.match(url, /client=dict-chrome-ex/);
  assert.match(url, /sl=auto/);
  assert.match(url, /tl=zh-CN/);
  assert.equal((url.match(/(^|&)q=/g) ?? []).length, 2);
});

test('clients5 parses a batch response, keeping the detected source per item', () => {
  const result = clients5.parse(CLIENTS5_BATCH, { text: ['run', 'apple', '跑'] });
  assert.deepEqual(result, [
    { translation: '跑步', detectedSource: 'en' },
    { translation: '苹果', detectedSource: 'en' },
    { translation: '跑', detectedSource: 'zh-CN' },
  ]);
});

test('clients5 parses a single-item response', () => {
  assert.deepEqual(clients5.parse(CLIENTS5_SINGLE, { text: ['你好'] }), [
    { translation: '你好', detectedSource: 'en' },
  ]);
});

test('clients5 rejects a body that is not JSON', () => {
  assert.throws(
    () => clients5.parse('<html><title>Sorry...</title></html>', { text: ['x'] }),
    ProviderError,
  );
});

test('clients5 rejects a response with the wrong number of items', () => {
  assert.throws(() => clients5.parse(CLIENTS5_SINGLE, { text: ['a', 'b'] }), ProviderError);
});

test('lingva URL-encodes the text into the path', () => {
  const url = lingva.request({ text: ['跑'], source: 'auto', target: 'zh-CN' });
  assert.equal(url, 'https://lingva.ml/api/v1/auto/zh/%E8%B7%91');
});

test('lingva shortens a regioned target code, which it rejects', () => {
  // Verified live: /api/v1/en/zh-CN/run answers 400 "Invalid target language code".
  assert.match(lingva.request({ text: ['run'], source: 'en', target: 'zh-CN' }), /\/en\/zh\//);
});

test('lingva splits a multi-item answer back into one result per item', () => {
  const body = '{"translation":"跑步\\n苹果","info":{"detectedSource":"en"}}';
  const parsed = lingva.parse(body, { text: ['run', 'apple'] });
  assert.deepEqual(parsed[0].parts, ['跑步', '苹果']);
});

test('lingva parses translation and detected source', () => {
  assert.deepEqual(lingva.parse(LINGVA, { text: ['run'] }), [
    { translation: '跑', detectedSource: 'en' },
  ]);
});

test('lingva refuses a batch, which it cannot do', () => {
  assert.equal(lingva.maxBatch, 1);
});

test('mymemory maps a source language and detects nothing', () => {
  const url = mymemory.request({ text: ['The quick brown fox'], source: 'en', target: 'zh-CN' });
  assert.match(url, /langpair=en%7Czh-CN/);
  assert.deepEqual(mymemory.parse(MYMEMORY, { text: ['The quick brown fox'] }), [
    { translation: '敏捷的棕色狐狸', detectedSource: undefined },
  ]);
});

test('mymemory surfaces a quota error as a ProviderError', () => {
  const body = '{"responseData":{"translatedText":"PLEASE SELECT TWO DISTINCT LANGUAGES"},"responseStatus":403}';
  assert.throws(() => mymemory.parse(body, { text: ['x'] }), ProviderError);
});

test('dictionaryDev parses phonetics, part of speech and a definition', () => {
  const info = dictionaryDev.parse(DICT_DEV);
  assert.equal(info.phonetic, '/ɹʌn/');
  assert.equal(info.audio, 'https://api.dictionaryapi.dev/media/pronunciations/en/run-us.mp3');
  assert.deepEqual(info.meanings, [{ pos: 'verb', definition: 'To move rapidly on foot.' }]);
});

test('dictionaryDev returns undefined when the word is unknown', () => {
  const body = '{"title":"No Definitions Found"}';
  assert.equal(dictionaryDev.parse(body), undefined);
});

test('createTranslator falls through to the next provider when one fails', async () => {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (url.includes('clients5')) throw new ProviderError('clients5: 429');
    if (url.includes('lingva')) return LINGVA;
    throw new ProviderError('unexpected');
  };
  const translate = createTranslator({
    providers: [clients5, lingva, mymemory],
    fetchText,
  });

  const [item] = await translate({ text: 'run', source: 'auto', target: 'zh-CN' });
  assert.equal(item.translation, '跑');
  assert.equal(item.provider, 'lingva');
  assert.equal(calls.length, 2);
});

test('createTranslator raises when every provider fails', async () => {
  const translate = createTranslator({
    providers: [clients5, lingva, mymemory],
    fetchText: async () => {
      throw new ProviderError('down');
    },
  });
  await assert.rejects(() => translate({ text: 'run', source: 'auto', target: 'zh-CN' }), ProviderError);
});

test('createTranslator returns one result per text and skips empty inputs', async () => {
  const translate = createTranslator({
    providers: [clients5],
    fetchText: async () => CLIENTS5_BATCH,
  });
  const results = await translate({ text: ['run', 'apple', '跑'], source: 'auto', target: 'zh-CN' });
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.translation),
    ['跑步', '苹果', '跑'],
  );

  const empty = await translate({ text: [], source: 'auto', target: 'zh-CN' });
  assert.deepEqual(empty, []);
});

test('createTranslator splits work into batches of at most the provider limit', async () => {
  const sizes = [];
  const translate = createTranslator({
    providers: [clients5],
    batchSize: 2,
    fetchText: async (url) => {
      const count = (url.match(/(^|&)q=/g) ?? []).length;
      sizes.push(count);
      return JSON.stringify(Array.from({ length: count }, (_, i) => [`t${i}`, 'en']));
    },
  });
  const results = await translate({
    text: ['a', 'b', 'c', 'd', 'e'],
    source: 'auto',
    target: 'zh-CN',
  });
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(results.length, 5);
});

test('createTranslator reuses the cache for repeated text', async () => {
  let requests = 0;
  const translate = createTranslator({
    providers: [clients5],
    fetchText: async (url) => {
      requests += 1;
      const count = (url.match(/(^|&)q=/g) ?? []).length;
      return JSON.stringify(Array.from({ length: count }, () => ['译文', 'en']));
    },
    cache: {
      get: () => undefined,
      set: () => {},
    },
  });
  await translate({ text: ['run', 'run'], source: 'auto', target: 'zh-CN' });
  assert.equal(requests, 1);
});
test('freedictionary reports the base form of an inflected word', () => {
  // Shapes captured live from freedictionaryapi.com on 2026-10-26.
  const running =
    '{"entries":[{"senses":[{"definition":"present participle and gerund of run","tags":["form of","gerund"]},{"definition":"Moving fast","tags":[]}]}]}';
  assert.equal(freedictionary.parseLemma(running), 'run');

  const ran = '{"entries":[{"senses":[{"definition":"simple past of run","tags":["form of","past"]}]}]}';
  assert.equal(freedictionary.parseLemma(ran), 'run');

  const apples = '{"entries":[{"senses":[{"definition":"plural of apple","tags":["form of","plural"]}]}]}';
  assert.equal(freedictionary.parseLemma(apples), 'apple');

  const better =
    '{"entries":[{"senses":[{"definition":"comparative degree of good and well","tags":["comparative","form of"]}]}]}';
  assert.equal(freedictionary.parseLemma(better), 'good');
});

test('freedictionary returns nothing for a base form or a non-dictionary body', () => {
  const base = '{"entries":[{"senses":[{"definition":"To move fast","tags":[]}]}]}';
  assert.equal(freedictionary.parseLemma(base), undefined);
  assert.equal(freedictionary.parseLemma('not json'), undefined);
  assert.equal(freedictionary.parseLemma('{"title":"No Definitions Found"}'), undefined);
  // A JSON array has an `entries` *function*, which a naive `?? []` would
  // hand to a for-of loop and throw on.
  assert.equal(freedictionary.parseLemma('[]'), undefined);
  assert.equal(freedictionary.parseLemma('null'), undefined);
});
