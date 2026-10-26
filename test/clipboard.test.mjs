import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCopyText } from '../src/app/clipboard.js';

/** A page whose old-style copy command records what it was asked to copy. */
function page({ execCommand = () => true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;
  const seen = [];
  document.execCommand = execCommand
    ? (command) => {
        seen.push({ command, value: document.querySelector('textarea')?.value });
        return execCommand();
      }
    : undefined;
  return { document, seen };
}

test('copy uses the clipboard API when the browser offers one', async () => {
  const { document } = page();
  const written = [];
  const copy = createCopyText({
    navigator: { clipboard: { writeText: async (text) => written.push(text) } },
    document,
  });

  assert.equal(await copy('我们在这里。'), true);
  assert.deepEqual(written, ['我们在这里。']);
  assert.equal(document.querySelector('textarea'), null, 'the modern path needs no scratch element');
});

test('a refused clipboard falls back to the old copy command', async () => {
  const { document, seen } = page();
  const copy = createCopyText({
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    },
    document,
  });

  assert.equal(await copy('我们在这里。'), true);
  assert.deepEqual(seen, [{ command: 'copy', value: '我们在这里。' }]);
  assert.equal(document.querySelector('textarea'), null, 'the scratch element must not be left behind');
});

test('a copy nothing can perform reports failure without throwing', async () => {
  const { document } = page({ execCommand: null });
  const copy = createCopyText({ navigator: {}, document });
  assert.equal(await copy('x'), false);
});

test('a command the page refuses reports failure without throwing', async () => {
  const { document } = page({ execCommand: () => false });
  const copy = createCopyText({ navigator: {}, document });
  assert.equal(await copy('x'), false);
});

test('nothing is copied for empty text', async () => {
  const { document, seen } = page();
  const written = [];
  const copy = createCopyText({
    navigator: { clipboard: { writeText: async (text) => written.push(text) } },
    document,
  });

  assert.equal(await copy(''), false);
  assert.deepEqual(written, []);
  assert.deepEqual(seen, []);
});
