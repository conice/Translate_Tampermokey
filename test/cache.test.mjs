import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKey,
  createCache,
  TTL_SUCCESS_MS,
  TTL_FAILURE_MS,
} from '../src/core/cache.js';

function memoryStorage() {
  const data = new Map();
  return {
    read: () => [...data.entries()],
    write: (pairs) => {
      data.clear();
      for (const [k, v] of pairs) data.set(k, v);
    },
  };
}

test('cacheKey ignores the provider, so failing over keeps cached answers', () => {
  assert.equal(
    cacheKey({ source: 'en', target: 'zh-CN', text: 'run' }),
    'en|zh-CN|run',
  );
  assert.notEqual(
    cacheKey({ source: 'en', target: 'zh-CN', text: 'run' }),
    cacheKey({ source: 'en', target: 'en', text: 'run' }),
  );
});

test('cache returns a successful translation until its TTL expires', () => {
  let now = 1_000_000;
  const cache = createCache({ storage: memoryStorage(), now: () => now });
  cache.set('k', { translation: '跑' }, { ok: true });
  now += TTL_SUCCESS_MS - 1;
  assert.deepEqual(cache.get('k'), { translation: '跑' });
  now += 2;
  assert.equal(cache.get('k'), undefined);
});

test('cache expires a failed lookup far sooner', () => {
  let now = 1_000_000;
  const cache = createCache({ storage: memoryStorage(), now: () => now });
  cache.set('k', { error: 'unavailable' }, { ok: false });
  now += TTL_FAILURE_MS - 1;
  assert.equal(cache.get('k').error, 'unavailable');
  now += 2;
  assert.equal(cache.get('k'), undefined);
});

test('cache is evicted least-recently-used first once full', () => {
  let now = 1_000_000;
  const cache = createCache({ storage: memoryStorage(), now: () => now, max: 2 });
  cache.set('a', { translation: 'A' }, { ok: true });
  now += 1;
  cache.set('b', { translation: 'B' }, { ok: true });
  now += 1;
  cache.get('a');
  now += 1;
  cache.set('c', { translation: 'C' }, { ok: true });
  assert.deepEqual(cache.get('b'), undefined);
  assert.equal(cache.get('a').translation, 'A');
  assert.equal(cache.get('c').translation, 'C');
});

test('cache survives a round trip through storage', () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const first = createCache({ storage, now: () => now });
  first.set('k', { translation: '跑' }, { ok: true });
  const second = createCache({ storage, now: () => now });
  assert.equal(second.get('k').translation, '跑');
});

test('cache drops corrupt storage entries instead of throwing', () => {
  const storage = { read: () => [['k', 'not-an-object']], write: () => {} };
  const cache = createCache({ storage, now: () => 0 });
  assert.equal(cache.get('k'), undefined);
});