import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPanel } from '../src/ui/panel.js';

/**
 * jsdom has no layout, so nothing here can prove the dialog fits on a phone.
 * What it can do is pin the two things that made a long book unreadable: the
 * list must be the scroll container, and the dialog must cap itself against the
 * viewport that is actually on screen. The rest is ordinary list behaviour.
 */
function setup({ entries = [], theme = 'system' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;

  const removed = [];
  let store = entries.map((entry) => ({ ...entry }));
  const book = {
    all: () => store.slice(),
    remove: (entryId) => {
      removed.push(entryId);
      store = store.filter((entry) => entry.entryId !== entryId);
    },
    exportJson: () => JSON.stringify(store),
    importJson: () => ({ added: 0, updated: 0, skipped: 0 }),
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
  });
  return { document, panel, removed };
}

function entry(index) {
  const term = `word${String(index).padStart(3, '0')}`;
  return {
    entryId: `en|${term}`,
    term,
    normalized: term,
    sourceLang: 'en',
    targetLang: 'zh-CN',
    translation: `词${index}`,
    addedAt: index,
  };
}

function css(panel) {
  return panel.host.shadowRoot.querySelector('style').textContent;
}

test('a long book is listed in full inside a body that can scroll', () => {
  const { panel } = setup({ entries: Array.from({ length: 300 }, (_, i) => entry(i)) });
  panel.open();

  const root = panel.host.shadowRoot;
  assert.equal(root.querySelectorAll('ul.entries li').length, 300);

  const style = css(panel);
  const body = style.slice(style.indexOf('.body {'), style.indexOf('.toolbar {'));
  assert.match(body, /min-height:\s*0/, 'without this a flex item cannot shrink, so the list never scrolls');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(style, /100dvh/, 'the cap must follow the visible viewport, not the large one');
});

test('the search box is pinned above the list it filters', () => {
  const { panel } = setup({ entries: [entry(1), entry(2)] });
  panel.open();

  const root = panel.host.shadowRoot;
  const toolbar = root.querySelector('.toolbar');
  assert.ok(toolbar, 'the search needs a row of its own to pin');
  assert.equal(root.querySelector('.search').parentElement, toolbar);
  assert.equal(toolbar.parentElement, root.querySelector('.body'), 'the toolbar belongs to the scrolling tab body');
  assert.equal(toolbar.nextElementSibling, root.querySelector('ul.entries'));
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
