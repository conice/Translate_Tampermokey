import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGlossLayer } from '../src/ui/gloss-layer.js';
import { MARKER_CLASS, ANNOTATION_CLASS } from '../src/core/gloss.js';

/**
 * These run in jsdom because the inline-gloss layer is the one part whose bugs
 * live in the DOM: double-wrapping, lost text, and rewriting code blocks.
 * jsdom lacks IntersectionObserver, so it is stubbed; the tests drive `pass()`
 * directly rather than waiting on the observer.
 */
function setup(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  class StubObserver {
    observe() {}
    disconnect() {}
  }
  window.IntersectionObserver = StubObserver;
  window.requestIdleCallback = (fn) => window.setTimeout(fn, 0);
  // jsdom has no layout; give every element a visible rect so the
  // viewport filter keeps it.
  window.Element.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
  };
  return { dom, window, document };
}

function makeLayer(window, document, map) {
  return createGlossLayer({ document, window, translationMap: map });
}

test('gloss layer annotates a matching word with its translation', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });

  const marker = document.querySelector(`.${MARKER_CLASS}`);
  assert.ok(marker, 'expected a marker around the matched word');
  assert.equal(marker.firstChild.nodeValue, 'run');
  assert.equal(marker.querySelector(`.${ANNOTATION_CLASS}`).textContent, '跑');
  // The surrounding text must survive untouched. The parentheses are drawn by
  // CSS, not present in the DOM, so a reader copying the page does not get the
  // translation mixed into the original prose.
  assert.equal(document.querySelector('p').textContent, 'I run跑 every day');
});

test('a second pass does not wrap the same word again', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.pass({ force: true });
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 1);
  assert.equal(document.querySelector('p').textContent, 'I run跑 every day');
});

test('gloss layer leaves words outside the book alone', () => {
  const { window, document } = setup('<p>I walk every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 0);
  assert.equal(document.querySelector('p').textContent, 'I walk every day');
});

test('gloss layer skips code and pre blocks', () => {
  const { window, document } = setup('<pre><span>run</span></pre><p>run</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelector('pre').textContent, 'run');
  assert.ok(document.querySelector('p').querySelector(`.${MARKER_CLASS}`));
});

test('gloss layer skips contenteditable regions', () => {
  const { window, document } = setup('<div contenteditable="true">run here</div>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 0);
});

test('gloss layer annotates every occurrence in a paragraph', () => {
  const { window, document } = setup('<p>run and run and run</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 3);
});

test('refresh restores the original text and clears annotations', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.ok(document.querySelector(`.${ANNOTATION_CLASS}`));

  layer.refresh(new Map([['run', '奔跑']]), { force: true });
  const markers = [...document.querySelectorAll(`.${MARKER_CLASS}`)];
  assert.equal(markers.length, 1);
  assert.equal(markers[0].querySelector(`.${ANNOTATION_CLASS}`).textContent, '奔跑');
  assert.equal(document.querySelector('p').textContent, 'I run奔跑 every day');
});

test('refresh with an emptied book leaves the page as it was', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.refresh(new Map());
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 0);
  assert.equal(document.querySelector('p').textContent, 'I run every day');
});

test('a long phrase in the book is annotated as one unit', () => {
  const { window, document } = setup('<p>we take off at noon</p>');
  const layer = makeLayer(window, document, new Map([['take off', '起飞']]));
  layer.pass({ force: true });
  const marker = document.querySelector(`.${MARKER_CLASS}`);
  assert.equal(marker.firstChild.nodeValue, 'take off');
  assert.equal(document.querySelector('p').textContent, 'we take off起飞 at noon');
});

test('a CJK term is annotated inside CJK text', () => {
  const { window, document } = setup('<p>我们跑得快</p>');
  const layer = makeLayer(window, document, new Map([['跑', 'run']]));
  layer.pass({ force: true });
  assert.equal(document.querySelector('p').textContent, '我们跑run得快');
});
test('a nested container is not walked twice and its paragraphs still get glossed', () => {
  const { window, document } = setup(
    '<div><p>I run here</p><p>you run there</p></div>',
  );
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  const paragraphs = document.querySelectorAll('p');
  assert.equal(paragraphs[0].textContent, 'I run跑 here');
  assert.equal(paragraphs[1].textContent, 'you run跑 there');
  assert.equal(document.querySelectorAll('.tm-gloss-annot').length, 2);
});

test('text directly inside a blockless div is still glossed', () => {
  const { window, document } = setup('<div>we run a lot</div>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelector('div').textContent, 'we run跑 a lot');
});

test('a page-wide wrapper does not defeat the viewport filter', () => {
  const { window, document } = setup(
    '<div id="wrap"><p>visible run</p></div>',
  );
  // Hide everything by reporting zero-size rects, then check nothing is written.
  const realRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = () => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
  });
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  assert.equal(document.querySelectorAll('.tm-gloss-annot').length, 0);
  window.Element.prototype.getBoundingClientRect = realRect;
});
