import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPanel } from '../src/ui/panel.js';

/**
 * jsdom has no layout, so nothing here can prove the dialog fits on a phone.
 * What it can do is pin the rules that made a long book unreadable: the list
 * must be the scroll container, the dialog must cap itself against the box it
 * is laid out in rather than against `vh`, and the scroll must be visible.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ entries = [], theme = 'system', fileIO, importError } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;

  const removed = [];
  const importCalls = [];
  let store = entries.map((entry) => ({ ...entry }));
  const book = {
    all: () => store.slice(),
    remove: (entryId) => {
      removed.push(entryId);
      store = store.filter((entry) => entry.entryId !== entryId);
    },
    exportCsv: () => 'term,normalized,sourceLang,targetLang,translation\r\n',
    importCsv: (text, options) => {
      importCalls.push({ text, options });
      if (importError) throw new Error(importError);
      return { added: 1, updated: 0, skipped: 0 };
    },
  };
  const settings = {
    lookupEnabled: true,
    theme,
    setLookupEnabled() {},
    setTheme() {},
    glossOn: () => false,
    setGlossOn() {},
    targetOverride: () => '',
    setTargetOverride() {},
  };

  const panel = createPanel({
    document,
    settings,
    book,
    host: 'example.com',
    onGlossChange() {},
    onClearCache() {},
    onLookupToggle() {},
    onThemeChange() {},
    fileIO: fileIO ?? {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => null,
    },
  });
  return { document, panel, removed, importCalls };
}

function openSettings(panel) {
  const root = panel.host.shadowRoot;
  [...root.querySelectorAll('.tabs button')].find((button) => button.textContent === '设置').click();
  return root;
}

function button(root, label) {
  return [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
}

function entry(index, overrides = {}) {
  const term = `word${String(index).padStart(3, '0')}`;
  const sourceLang = overrides.sourceLang ?? 'en';
  return {
    entryId: `${sourceLang}|${term}`,
    term,
    normalized: term,
    sourceLang,
    targetLang: 'zh-CN',
    translation: `词${index}`,
    addedAt: index,
    ...overrides,
  };
}

function css(panel) {
  return panel.host.shadowRoot.querySelector('style').textContent;
}

/** One rule's declarations, so an assertion cannot match a neighbour's. */
function rule(style, selector) {
  const start = style.indexOf(selector);
  assert.notEqual(start, -1, `missing rule ${selector}`);
  return style.slice(start, style.indexOf('}', start));
}

test('a long book is listed in full inside a body that can scroll', () => {
  const { panel } = setup({ entries: Array.from({ length: 300 }, (_, i) => entry(i)) });
  panel.open();

  const root = panel.host.shadowRoot;
  assert.equal(root.querySelectorAll('ul.entries li').length, 300);

  const style = css(panel);
  const body = rule(style, '.body {');
  assert.match(body, /min-height:\s*0/, 'without this a flex item cannot shrink, so the list never scrolls');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(rule(style, '.dialog {'), /max-height:\s*min\(640px,\s*100%\)/,
    'the cap must be a share of the box the dialog is laid out in, not of vh');
  assert.match(body, /scrollbar-width:\s*thin/, 'a phone otherwise shows nothing until you drag');
  assert.match(style, /@supports not \(scrollbar-width: thin\) \{[\s\S]*?-webkit-scrollbar-thumb/,
    'the WebKit rule must be gated: the standard properties switch it off on current engines');
});

test('the dialog cannot overflow the backdrop that holds it', () => {
  const { panel } = setup();
  panel.open();

  const style = css(panel);
  const backdrop = rule(style, '.backdrop {');
  assert.match(backdrop, /padding:\s*16px/, 'the gutter belongs to the box the dialog is capped against');
  assert.match(backdrop, /box-sizing:\s*border-box/, 'otherwise the padding is added on top of the cap');
  assert.match(backdrop, /align-items:\s*safe center/,
    'a dialog that does overflow must lose its bottom, not its title and close button');
  assert.match(style, /\.backdrop \{[^}]*padding:\s*8px/, 'a phone keeps only a thin gutter');
});

test('the header stays outside the scrolling area', () => {
  const { panel } = setup({ entries: Array.from({ length: 40 }, (_, i) => entry(i)) });
  panel.open();

  const root = panel.host.shadowRoot;
  const dialog = root.querySelector('.dialog');
  assert.equal(dialog.querySelector('header').parentElement, dialog);
  assert.equal(root.querySelector('.body').parentElement, dialog);
  assert.equal(dialog.querySelector('header').nextElementSibling, root.querySelector('.body'));
  assert.ok(dialog.querySelector('.close'), 'the close button must not scroll away with the list');
});

test('the search box is pinned above the list it filters', () => {
  const { panel } = setup({ entries: [entry(1), entry(2)] });
  panel.open();

  const root = panel.host.shadowRoot;
  const toolbar = root.querySelector('.toolbar');
  assert.ok(toolbar, 'the search needs a row of its own to pin');
  assert.equal(root.querySelector('.search').parentElement, toolbar);
  assert.equal(toolbar.parentElement, root.querySelector('.body'), 'the toolbar belongs to the scrolling tab body');
  assert.equal(toolbar.nextElementSibling, root.querySelector('.groups'));
  assert.match(css(panel), /\.toolbar \{[^}]*position:\s*sticky/, 'a long book must not scroll the search away');
});

test('typing filters the list without rebuilding the input', () => {
  const { panel } = setup({ entries: [entry(1), entry(2), entry(3)] });
  panel.open();

  const root = panel.host.shadowRoot;
  const search = root.querySelector('.search');
  search.value = 'word00';
  search.dispatchEvent(new (panel.host.ownerDocument.defaultView.Event)('input'));
  assert.equal(root.querySelectorAll('ul.entries li').length, 3);

  search.value = 'word002';
  search.dispatchEvent(new (panel.host.ownerDocument.defaultView.Event)('input'));
  assert.equal(root.querySelectorAll('ul.entries li').length, 1);
  assert.equal(root.querySelector('.search'), search, 'replacing the input would close the keyboard mid-word');

  // Clearing the box brings the whole book back, including from the empty state.
  search.value = 'nothing matches this';
  search.dispatchEvent(new (panel.host.ownerDocument.defaultView.Event)('input'));
  assert.ok(root.querySelector('.empty'));
  search.value = '';
  search.dispatchEvent(new (panel.host.ownerDocument.defaultView.Event)('input'));
  assert.equal(root.querySelectorAll('ul.entries li').length, 3);
});

test('the book is grouped by the language each word is written in', () => {
  const { panel } = setup({
    entries: [
      entry(1),
      entry(2, { sourceLang: 'ja', term: '猫', normalized: '猫', translation: '猫' }),
      entry(3),
      entry(4, { sourceLang: 'en-US', term: 'colour', normalized: 'colour', translation: '颜色' }),
    ],
  });
  panel.open();

  const root = panel.host.shadowRoot;
  assert.deepEqual(
    [...root.querySelectorAll('.group-title')].map((title) => title.textContent),
    ['英语3', '日语1'],
    'one heading per language, region tags folded in, count included',
  );

  const [english, japanese] = root.querySelectorAll('.group');
  assert.deepEqual(
    [...english.querySelectorAll('.term')].map((term) => term.textContent),
    ['colour', 'word003', 'word001'],
    'newest first inside a group',
  );
  assert.deepEqual(
    [...japanese.querySelectorAll('.term')].map((term) => term.textContent),
    ['猫'],
  );
  assert.equal(root.querySelectorAll('ul.entries li').length, 4, 'grouping does not hide any entry');
});

test('group order follows the language, not the newest word', () => {
  const { panel } = setup({
    entries: [
      entry(1, { sourceLang: 'ja', term: '猫', normalized: '猫', translation: '猫' }),
      entry(2, { sourceLang: 'fr', term: 'chat', normalized: 'chat', translation: '猫' }),
      entry(3, { sourceLang: 'en', term: 'cat', normalized: 'cat', translation: '猫' }),
    ],
  });
  panel.open();

  assert.deepEqual(
    [...panel.host.shadowRoot.querySelectorAll('.group-title')].map((title) => title.textContent),
    ['英语1', '日语1', '法语1'],
  );
});

test('a language the table does not name still gets its own group, and a missing one is last', () => {
  const { panel } = setup({
    entries: [
      entry(1, { sourceLang: '' }),
      entry(2, { sourceLang: 'pt', term: 'gato', normalized: 'gato', translation: '猫' }),
      entry(3, { sourceLang: 'en', term: 'cat', normalized: 'cat', translation: '猫' }),
    ],
  });
  panel.open();

  assert.deepEqual(
    [...panel.host.shadowRoot.querySelectorAll('.group-title')].map((title) => title.textContent),
    ['英语1', 'pt1', '未知语言1'],
  );
});

test('filtering leaves only the groups that still have a match', () => {
  const { panel } = setup({
    entries: [
      entry(1, { sourceLang: 'en', term: 'cat', normalized: 'cat', translation: '猫' }),
      entry(2, { sourceLang: 'ja', term: '犬', normalized: '犬', translation: '狗' }),
    ],
  });
  panel.open();

  const root = panel.host.shadowRoot;
  const search = root.querySelector('.search');
  search.value = '犬';
  search.dispatchEvent(new (panel.host.ownerDocument.defaultView.Event)('input'));

  assert.deepEqual(
    [...root.querySelectorAll('.group-title')].map((title) => title.textContent),
    ['日语1'],
    'a heading for a language with no visible row would be an empty section',
  );
});

test('deleting one entry leaves the rest, and the last one leaves the empty state', () => {
  const { panel, removed } = setup({ entries: [entry(1), entry(2)] });
  panel.open();

  const root = panel.host.shadowRoot;
  // Newest first, so the top row is the one added last.
  root.querySelector('ul.entries li button.danger').click();
  assert.deepEqual(removed, ['en|word002']);
  assert.equal(root.querySelectorAll('ul.entries li').length, 1);

  root.querySelector('ul.entries li button.danger').click();
  assert.equal(root.querySelectorAll('ul.entries li').length, 0);
  assert.match(root.querySelector('.empty').textContent, /还是空的/);
});

test('the target language is not a settings field any more', () => {
  const { panel } = setup();
  panel.open();
  const root = openSettings(panel);

  assert.doesNotMatch(root.querySelector('.settings').textContent, /本站目标语言/,
    'the per-site target is changed from the Popup, where the translation is on screen');
});

test('the replace-or-merge question is hidden until a file is chosen', async () => {
  const { panel } = setup({ entries: [entry(1)] });
  panel.open();
  const root = openSettings(panel);

  assert.match(
    rule(css(panel), '[hidden] {'),
    /display:\s*none\s*!important/,
    'the UA rule loses to `.row { display: flex }`, so the panel needs its own',
  );
  assert.equal(
    [...root.querySelectorAll('.row')].some((row) => /覆盖会先清空/.test(row.textContent) && !row.hidden),
    false,
  );
});

test('exporting the book writes a dated CSV file and reports the count', async () => {
  const saves = [];
  const { panel } = setup({
    entries: [entry(1), entry(2)],
    fileIO: {
      saveTextFile: async (view, file) => {
        saves.push(file);
        return { saved: true, cancelled: false };
      },
      pickTextFile: async () => null,
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '导出到文件').click();
  await tick();

  assert.equal(saves.length, 1);
  assert.match(saves[0].filename, /^生词本-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(saves[0].text, /^term,normalized,sourceLang,targetLang,translation/);
  assert.match(button(root, '导出到文件').closest('.row').textContent, /已导出 2 条/);
});

test('a cancelled save dialog says so instead of claiming success', async () => {
  const { panel } = setup({
    entries: [entry(1)],
    fileIO: {
      saveTextFile: async () => ({ saved: false, cancelled: true }),
      pickTextFile: async () => null,
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '导出到文件').click();
  await tick();

  assert.match(root.querySelector('.settings').textContent, /已取消导出/);
});

test('importing reads a file first, then asks whether to replace or merge', async () => {
  const { panel, importCalls } = setup({
    entries: [entry(1), entry(2)],
    fileIO: {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => 'term,normalized,sourceLang,targetLang,translation\r\n',
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '从文件导入').click();
  await tick();
  assert.equal(importCalls.length, 0, 'nothing may be imported before the user chooses');

  const prompt = [...root.querySelectorAll('.row')].find((row) => /生词本现有 2 条/.test(row.textContent));
  assert.ok(prompt, 'the choice must say how many entries are at stake');
  assert.match(prompt.textContent, /覆盖会先清空/);

  button(root, '合并').click();
  assert.deepEqual(importCalls, [
    { text: 'term,normalized,sourceLang,targetLang,translation\r\n', options: { mode: 'merge' } },
  ]);
  assert.match(root.querySelector('.settings').textContent, /导入完成:新增 1/);
  assert.equal(prompt.hidden, true, 'the question goes away once answered');
});

test('choosing overwrite imports in replace mode', async () => {
  const { panel, importCalls } = setup({
    entries: [entry(1)],
    fileIO: {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => 'csv text',
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '从文件导入').click();
  await tick();
  button(root, '覆盖现有').click();

  assert.deepEqual(importCalls, [{ text: 'csv text', options: { mode: 'replace' } }]);
  assert.match(root.querySelector('.settings').textContent, /已覆盖:导入 1 条/);
});

test('a failed import reports the reason and puts the question away', async () => {
  const { panel } = setup({
    entries: [entry(1)],
    importError: 'CSV 缺少列:translation',
    fileIO: {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => 'bad csv',
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '从文件导入').click();
  await tick();
  button(root, '覆盖现有').click();

  assert.match(root.querySelector('.settings').textContent, /导入失败:CSV 缺少列:translation/);
  assert.equal(
    [...root.querySelectorAll('.row')].some((row) => /覆盖会先清空/.test(row.textContent) && !row.hidden),
    false,
    'a failed import must not leave the prompt on screen',
  );
});

test('cancelling or dismissing the import changes nothing', async () => {
  const { panel, importCalls } = setup({
    entries: [entry(1)],
    fileIO: {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => 'csv text',
    },
  });
  panel.open();
  const root = openSettings(panel);

  button(root, '从文件导入').click();
  await tick();
  button(root, '取消').click();
  assert.equal(importCalls.length, 0);
  assert.match(root.querySelector('.settings').textContent, /已取消导入/);

  // A dismissed file picker must not even show the replace/merge question.
  const dismissed = setup({
    entries: [entry(1)],
    fileIO: {
      saveTextFile: async () => ({ saved: true, cancelled: false }),
      pickTextFile: async () => null,
    },
  });
  dismissed.panel.open();
  const otherRoot = openSettings(dismissed.panel);
  button(otherRoot, '从文件导入').click();
  await tick();
  assert.equal(dismissed.importCalls.length, 0);
  assert.equal(
    [...otherRoot.querySelectorAll('.row')].some((row) => /覆盖会先清空/.test(row.textContent)),
    false,
  );
});
