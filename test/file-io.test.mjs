import test from 'node:test';
import assert from 'node:assert/strict';
import { csvFilename, pickTextFile, saveTextFile } from '../src/app/file-io.js';

function downloadWindow({ picker } = {}) {
  const anchor = { clicked: 0, removed: 0, click() { this.clicked += 1; }, remove() { this.removed += 1; } };
  const revoked = [];
  return {
    anchor,
    revoked,
    showSaveFilePicker: picker,
    URL: {
      createObjectURL: () => 'blob:book',
      revokeObjectURL: (url) => revoked.push(url),
    },
    document: { createElement: () => anchor, body: { append() {} } },
    setTimeout: (fn) => fn(),
  };
}

function writablePicker({ suggestedName, chunks }) {
  return async (options) => {
    if (suggestedName) suggestedName.push(options.suggestedName);
    return {
      createWritable: async () => ({
        write: async (blob) => chunks.push(await blob.text()),
        close: async () => {},
      }),
    };
  };
}

test('the suggested filename is dated and padded', () => {
  assert.equal(csvFilename(new Date(2026, 0, 5)), '生词本-2026-01-05.csv');
});

test('saving uses the file picker when the browser has one', async () => {
  const chunks = [];
  const suggestedName = [];
  const window = downloadWindow({ picker: writablePicker({ suggestedName, chunks }) });

  const result = await saveTextFile(window, { filename: 'book.csv', text: 'a,b\r\n' });

  assert.deepEqual(result, { saved: true, cancelled: false });
  assert.equal(suggestedName[0], 'book.csv');
  assert.deepEqual(chunks, ['a,b\r\n']);
  assert.equal(window.anchor.clicked, 0, 'the picker path must not also start a download');
});

test('a cancelled save dialog reports cancellation, not failure', async () => {
  const window = downloadWindow({
    picker: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });

  assert.deepEqual(await saveTextFile(window, { filename: 'book.csv', text: 'a' }), {
    saved: false,
    cancelled: true,
  });
  assert.equal(window.anchor.clicked, 0);
});

test('a refused picker falls back to a download', async () => {
  const window = downloadWindow({
    picker: async () => {
      throw new Error('sandboxed');
    },
  });

  const result = await saveTextFile(window, { filename: 'book.csv', text: 'a,b' });

  assert.deepEqual(result, { saved: true, cancelled: false });
  assert.equal(window.anchor.download, 'book.csv');
  assert.equal(window.anchor.href, 'blob:book');
  assert.equal(window.anchor.clicked, 1);
  assert.equal(window.anchor.removed, 1);
  assert.deepEqual(window.revoked, ['blob:book']);
});

test('without the picker API the file is still downloaded', async () => {
  const window = downloadWindow();
  await saveTextFile(window, { filename: 'book.csv', text: 'a' });
  assert.equal(window.anchor.clicked, 1);
});

function fileDocument(file) {
  const input = {
    style: {},
    files: file ? [file] : null,
    click() { this.clicked = true; },
    remove() { this.removed = true; },
  };
  const document = {
    createElement: () => input,
    body: { append: (element) => { document.appended = element; } },
  };
  return { document, input };
}

test('picking a file resolves with its text and cleans up the input', async () => {
  const { document, input } = fileDocument({ text: async () => 'term,targetLang\r\n' });
  const reading = pickTextFile(document);

  assert.equal(input.clicked, true);
  assert.equal(input.type, 'file');
  assert.equal(input.accept, '.csv,text/csv');
  await input.onchange();

  assert.equal(await reading, 'term,targetLang\r\n');
  assert.equal(input.removed, true);
});

test('dismissing the picker resolves to nothing', async () => {
  const { document, input } = fileDocument(null);
  const reading = pickTextFile(document);
  input.oncancel();
  assert.equal(await reading, null);
  assert.equal(input.removed, true);
});
