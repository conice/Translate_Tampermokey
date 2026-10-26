import test from 'node:test';
import assert from 'node:assert/strict';
import { createPronouncer } from '../src/app/pronunciation.js';

/** A pronuncer whose four outside effects are recorded instead of performed. */
function harness({ blob = { bytes: true }, downloadError, playError, constructorError } = {}) {
  const log = { fetched: [], created: [], revoked: [], played: [], paused: [], spoken: [], audios: [] };

  const pronouncer = createPronouncer({
    fetchBlob: async (url) => {
      log.fetched.push(url);
      if (downloadError) throw downloadError;
      return blob;
    },
    createAudio: (url) => {
      if (constructorError) throw constructorError;
      const audio = {
        url,
        paused: false,
        play: async () => {
          if (playError) throw playError;
          log.played.push(url);
        },
        pause() {
          this.paused = true;
          log.paused.push(url);
        },
      };
      log.audios.push(audio);
      return audio;
    },
    objectUrls: {
      create: () => {
        const url = `blob:test/${log.created.length + 1}`;
        log.created.push(url);
        return url;
      },
      revoke: (url) => log.revoked.push(url),
    },
    speakText: (term) => log.spoken.push(term),
  });

  return { pronouncer, log };
}

test('a recording plays instead of the system voice', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  assert.deepEqual(log.fetched, ['https://example.test/run-us.mp3']);
  assert.deepEqual(log.played, ['blob:test/1']);
  assert.deepEqual(log.spoken, []);
});

test('without a recording the system voice speaks and nothing is downloaded', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', undefined);

  assert.deepEqual(log.fetched, []);
  assert.deepEqual(log.spoken, ['run']);
});

test('a download that fails falls back to the system voice', async () => {
  const { pronouncer, log } = harness({ downloadError: new Error('404') });
  await pronouncer.play('run', 'en', 'https://example.test/missing.mp3');

  assert.deepEqual(log.spoken, ['run']);
  assert.deepEqual(log.revoked, [], 'nothing was created, so nothing needs releasing');
});

test('a recording the browser cannot play falls back to the system voice once', async () => {
  const { pronouncer, log } = harness({ playError: new Error('decode') });
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  assert.deepEqual(log.spoken, ['run']);
  assert.deepEqual(log.revoked, ['blob:test/1'], 'the temporary URL must be released');
});

test('an audio element that cannot be built still releases the object URL', async () => {
  const { pronouncer, log } = harness({ constructorError: new Error('no audio') });
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  assert.deepEqual(log.spoken, ['run']);
  assert.deepEqual(log.revoked, ['blob:test/1']);
});

test('a second tap while a recording plays stops it and releases the URL', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');
  assert.equal(pronouncer.playing, true);

  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  assert.equal(log.audios[0].paused, true);
  assert.deepEqual(log.revoked, ['blob:test/1']);
  assert.equal(pronouncer.playing, false);
  assert.equal(log.audios.length, 1, 'the second tap must not start a second recording');
});

test('a tap while a download is in flight cancels it, and the late blob never plays', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const log = { played: [], revoked: [], spoken: [], fetched: 0 };
  const pronouncer = createPronouncer({
    fetchBlob: async () => {
      log.fetched += 1;
      await gate;
      return { bytes: true };
    },
    createAudio: (url) => ({
      play: async () => log.played.push(url),
      pause() {},
    }),
    objectUrls: {
      create: () => 'blob:test/late',
      revoke: (url) => log.revoked.push(url),
    },
    speakText: (term) => log.spoken.push(term),
  });

  const first = pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');
  release();
  await first;

  assert.equal(log.played.length, 0, 'a cancelled download must stay silent');
  assert.equal(log.revoked.length, 0, 'nothing was created, so nothing needs releasing');
});

test('the end of a recording releases its object URL exactly once', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  log.audios[0].onended();
  assert.deepEqual(log.revoked, ['blob:test/1']);
  assert.equal(pronouncer.playing, false);
});

test('an error after the user already stopped does not speak up again', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');
  const audio = log.audios[0];

  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');
  const spokenBefore = log.spoken.length;
  audio.onerror();

  assert.equal(log.spoken.length, spokenBefore, 'a stale error must not trigger the fallback');
});

test('an error before any stop still falls back to the system voice', async () => {
  const { pronouncer, log } = harness();
  await pronouncer.play('run', 'en', 'https://example.test/run-us.mp3');

  log.audios[0].onerror();

  assert.deepEqual(log.spoken, ['run']);
  assert.deepEqual(log.revoked, ['blob:test/1']);
});