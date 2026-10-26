import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  isTouchPrimary,
  shouldOfferBubble,
  selectionTerm,
  isOwnSelection,
  placeNear,
} from '../src/core/gesture.js';

function fakeSelection(text, { collapsed = false, rangeCount = 1 } = {}) {
  return { rangeCount, isCollapsed: collapsed, toString: () => text };
}

test('isTouchPrimary prefers a coarse pointer', () => {
  assert.equal(isTouchPrimary({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isTouchPrimary({ matchMedia: () => ({ matches: false }) }), false);
});

test('isTouchPrimary falls back to touch points when matchMedia is absent', () => {
  assert.equal(isTouchPrimary({ ontouchstart: null, navigator: { maxTouchPoints: 5 } }), true);
  assert.equal(isTouchPrimary({ ontouchstart: null, navigator: { maxTouchPoints: 0 } }), false);
  assert.equal(isTouchPrimary({ navigator: {} }), false);
});

test('a thrown matchMedia does not break detection', () => {
  const windowlike = {
    matchMedia: () => {
      throw new Error('detached');
    },
    ontouchstart: null,
    navigator: { maxTouchPoints: 2 },
  };
  assert.equal(isTouchPrimary(windowlike), true);
});

test('a word selection offers the bubble', () => {
  assert.equal(shouldOfferBubble({ selection: fakeSelection('run') }), true);
  assert.equal(shouldOfferBubble({ selection: fakeSelection('  apple. ') }), true);
  assert.equal(shouldOfferBubble({ selection: fakeSelection('跑') }), true);
});

test('an empty or collapsed selection offers nothing', () => {
  assert.equal(shouldOfferBubble({ selection: fakeSelection('', { collapsed: true }) }), false);
  assert.equal(shouldOfferBubble({ selection: fakeSelection('   ') }), false);
  assert.equal(shouldOfferBubble({ selection: fakeSelection('run', { rangeCount: 0 }) }), false);
  assert.equal(shouldOfferBubble({ selection: null }), false);
});

test('a multi-line or very long selection is treated as a copy gesture', () => {
  assert.equal(shouldOfferBubble({ selection: fakeSelection('run\nand walk') }), false);
  assert.equal(shouldOfferBubble({ selection: fakeSelection('run '.repeat(80)) }), false);
});

test('selections inside our own UI are ignored', () => {
  const target = { closest: (selector) => (selector === '[data-tm]' ? {} : null) };
  assert.equal(shouldOfferBubble({ selection: fakeSelection('run'), target }), false);
});

test('punctuation-only selections offer nothing', () => {
  assert.equal(shouldOfferBubble({ selection: fakeSelection('...') }), false);
});

test('selecting inside a text field or editor does not offer the bubble', () => {
  const dom = new JSDOM(
    `<!doctype html><body>
      <p id="page">hello</p>
      <textarea id="area">run</textarea>
      <div id="editor" contenteditable="true">run</div>
      <div id="off" contenteditable="false">run</div>
    </body>`,
  );
  const { document } = dom.window;
  const selectionIn = (id) => ({
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: document.getElementById(id).firstChild,
    toString: () => 'run',
  });

  assert.equal(shouldOfferBubble({ selection: selectionIn('area') }), false);
  assert.equal(shouldOfferBubble({ selection: selectionIn('editor') }), false);
  assert.equal(shouldOfferBubble({ selection: selectionIn('off') }), true);
  assert.equal(shouldOfferBubble({ selection: selectionIn('page') }), true);
});

test('selectionTerm normalizes the selection', () => {
  assert.equal(selectionTerm(fakeSelection('  Running, ')), 'running');
  assert.equal(selectionTerm(null), '');
});

test('a selection inside our own shadow-rooted UI is recognised', () => {
  const dom = new JSDOM(`<!doctype html><body><p id="page">hello</p></body>`);
  const { document } = dom.window;

  const host = document.createElement('div');
  host.setAttribute('data-tm', 'popup-host');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const text = document.createElement('span');
  text.textContent = 'inside';
  root.appendChild(text);

  // `closest` stops at the shadow root, so the host has to be reached via it.
  assert.equal(text.closest('[data-tm]'), null);
  assert.equal(isOwnSelection({ anchorNode: text }), true);
  assert.equal(isOwnSelection({ anchorNode: document.getElementById('page').firstChild }), false);
  assert.equal(isOwnSelection(null), false);
});

test('placeNear puts the box below the selection when there is room', () => {
  const placed = placeNear({
    rect: { top: 100, height: 20, left: 40 },
    box: { width: 200, height: 80 },
    viewport: { width: 400, height: 800 },
  });
  assert.deepEqual(placed, { top: 128, left: 40 });
});

test('placeNear flips above the selection when it would overflow the bottom', () => {
  const placed = placeNear({
    rect: { top: 740, height: 20, left: 40 },
    box: { width: 200, height: 80 },
    viewport: { width: 400, height: 800 },
  });
  assert.equal(placed.top, 652);
});

test('placeNear keeps the box inside the viewport at the right and bottom edges', () => {
  const placed = placeNear({
    rect: { top: 20, height: 20, left: 380 },
    box: { width: 200, height: 80 },
    viewport: { width: 400, height: 800 },
  });
  assert.equal(placed.left, 192);
  // No room above (it would start at -68), so it stays below the selection.
  assert.equal(placed.top, 48);
});

test('placeNear pins a box taller than the viewport to the top margin', () => {
  const placed = placeNear({
    rect: { top: 100, height: 20, left: 0 },
    box: { width: 200, height: 700 },
    viewport: { width: 400, height: 400 },
  });
  assert.equal(placed.top, 8, 'the top of the box holds the translation, so keep it visible');
  assert.equal(placed.left, 8);
});

test('placeNear accepts a rect with only top/bottom and no height', () => {
  const placed = placeNear({
    rect: { top: 100, bottom: 120, left: 40 },
    box: { width: 100, height: 50 },
    viewport: { width: 400, height: 800 },
  });
  assert.deepEqual(placed, { top: 128, left: 40 });
});