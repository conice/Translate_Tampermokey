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

function failingWritePicker({ at }) {
  return async () => ({
    createWritable: async () => ({
      write: async () => {
        if (at === 'write') throw new Error('disk full');
      },
      close: async () => {
        if (at === 'close') throw new Error('flush failed');
      },
    }),
  });
}

test('a write failure after a destination is chosen rejects instead of downloading elsewhere', async () => {
  const window = downloadWindow({ picker: failingWritePicker({ at: 'write' }) });

  await assert.rejects(saveTextFile(window, { filename: 'book.csv', text: 'a' }), /disk full/);
  assert.equal(window.anchor.clicked, 0, 'the text must not silently land somewhere else');
});

test('a close failure after a successful write is reported as a failure', async () => {
  const window = downloadWindow({ picker: failingWritePicker({ at: 'close' }) });

  await assert.rejects(saveTextFile(window, { filename: 'book.csv', text: 'a' }), /flush failed/);
  assert.equal(window.anchor.clicked, 0);
});

function fileDocument(file, view) {
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
  if (view) document.defaultView = view;
  return { document, input };
}

/** A page whose focus comes back when the picker closes, and no `cancel` event. */
function focusView({ fireImmediately }) {
  const handlers = {};
  const timers = [];
  return {
    handlers,
    timers,
    addEventListener: (type, handler) => { handlers[type] = handler; },
    removeEventListener: (type) => { delete handlers[type]; },
    setTimeout: (fn) => {
      if (fireImmediately) fn();
      else timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
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

test('a picker dismissed where the engine never fires cancel still resolves', async () => {
  const view = focusView({ fireImmediately: true });
  const { document, input } = fileDocument(null, view);
  const reading = pickTextFile(document);

  view.handlers.focus();

  assert.equal(await reading, null);
  assert.equal(input.removed, true, 'the hidden input must not outlive the picker');
  assert.equal(view.handlers.focus, undefined, 'and neither must the window listener');
});

test('a chosen file is not mistaken for a dismissal when focus returns first', async () => {
  const view = focusView({ fireImmediately: false });
  const { document, input } = fileDocument({ text: async () => 'term\r\n' }, view);
  const reading = pickTextFile(document);

  view.handlers.focus();
  view.timers[0](); // the fallback runs while a file is selected: it must not settle
  await input.onchange();

  assert.equal(await reading, 'term\r\n');
  assert.equal(input.removed, true);
});
