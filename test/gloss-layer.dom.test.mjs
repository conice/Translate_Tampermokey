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

/** Every `prop: value;` pair in a stylesheet, including ones inside at-rules. */
function declarations(css) {
  return [...css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/g)].map(([, prop, value]) => ({
    prop,
    value: value.trim(),
  }));
}

function glossCss(document) {
  const style = document.getElementById('tm-gloss-style');
  assert.ok(style, 'the gloss stylesheet should be injected');
  return style.textContent;
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

test('the gloss stylesheet outranks the page on every property that matters', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });

  const css = glossCss(document);
  const guarded = ['font-size', 'color', 'margin-left', 'margin-right', 'white-space', 'user-select', 'cursor'];
  for (const prop of guarded) {
    const found = declarations(css).filter((decl) => decl.prop === prop);
    assert.ok(found.length > 0, `the gloss style should set ${prop}`);
    for (const decl of found) {
      assert.match(
        decl.value,
        /!important$/u,
        `${prop} must be !important, or a site stylesheet can flatten the gloss`,
      );
    }
  }

  // The elements carry these class names, so renaming either rule would silently
  // stop styling the annotation.
  assert.match(css, new RegExp(`\\.${ANNOTATION_CLASS}\\b`));
});

test('the gloss takes its colour from the text it sits in, and dims it', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });

  const css = glossCss(document);
  // A fixed grey disappears on dark prose and on coloured headings; currentColor
  // is readable wherever the page itself is.
  assert.match(css, /color:\s*currentColor\s*!important/u, 'the base rule follows the host colour');
  assert.match(css, /opacity:\s*0?\.\d+\s*!important/u, 'and dims it, so the gloss does not shout');
  // Browsers without colour mixing still need a working rule; those with it get
  // a real translucent colour instead of a whole-element opacity.
  assert.match(css, /@supports[^{]*color-mix/u, 'the sibling colour has a progressive enhancement');
  assert.match(css, /color-mix\(in srgb,\s*currentColor/u);
});

test('the gloss stylesheet is injected once, however often the layer runs', () => {
  const { window, document } = setup('<p>I run every day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.pass({ force: true });
  layer.refresh(new Map([['run', '奔跑']]), { force: true });
  layer.start();
  layer.pass();
  layer.stop();

  assert.equal(document.querySelectorAll('#tm-gloss-style').length, 1);
});

/*
 * Cleaning up is the dangerous half of this layer. The page's own text nodes
 * are not ours to rearrange: a React or Vue view keeps a reference to the nodes
 * it rendered, so merging text nodes across the document makes the next
 * re-render put back stale content, or put it back in the wrong place.
 */

test('refresh merges text only inside the parent it restored', () => {
  const { window, document } = setup('<p id="a">I run every day</p><p id="b">you run too</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.refresh(new Map());

  const [a, b] = [document.getElementById('a'), document.getElementById('b')];
  for (const paragraph of [a, b]) {
    assert.equal(paragraph.childNodes.length, 1, 'a restored paragraph is one text node again');
    assert.equal(paragraph.firstChild.nodeType, 3);
  }
  assert.equal(a.firstChild, document.getElementById('a').firstChild, 'still the same paragraph');
  assert.equal(a.textContent, 'I run every day');
  assert.equal(b.textContent, 'you run too');
});

test('refresh does not merge a parent that still holds element children', () => {
  const { window, document } = setup('<p>I run <b>every</b> day</p>');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.refresh(new Map());

  const paragraph = document.querySelector('p');
  assert.equal(paragraph.textContent, 'I run every day', 'the text is whole');
  assert.ok(paragraph.querySelector('b'), 'the page element is still there');
  /*
   * "I run " splits into "I ", the marker and " " around it, so restoring
   * leaves five nodes: "I ", "run", " ", the page's <b>, then " day". Merging
   * the first three would quietly replace nodes the page still holds.
   */
  assert.equal(paragraph.childNodes.length, 5, 'a parent with element children must be left as it is');
  assert.equal(paragraph.childNodes[1].nodeValue, 'run');
  // The element the page supplied is the same node, not a rebuilt one.
  assert.equal(paragraph.querySelector('b').textContent, 'every');
});

test('refresh leaves unrelated text nodes alone', () => {
  const { window, document } = setup(
    '<p id="a">I run every day</p><p id="b"></p>',
  );
  const untouched = document.createTextNode('first');
  const second = document.createTextNode('second');
  const target = document.getElementById('b');
  target.append(untouched, second);

  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.pass({ force: true });
  layer.refresh(new Map());

  const after = document.getElementById('b');
  assert.equal(after.childNodes.length, 2, 'a global merge would have joined these two');
  assert.equal(after.firstChild, untouched, 'the page keeps its own node identities');
  assert.equal(after.lastChild, second);
});

test('turning glosses off leaves the page exactly as it was found', () => {
  const html = '<p>I run every day</p><p>we run too</p>';
  const { window, document } = setup(html);
  const before = document.body.innerHTML;

  const layer = makeLayer(window, document, new Map([['run', '跑']]));
  layer.start();
  layer.pass();
  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 2);

  layer.stop();
  layer.refresh(new Map());

  assert.equal(document.querySelectorAll(`.${MARKER_CLASS}`).length, 0, 'no markers left behind');
  assert.equal(document.querySelectorAll(`.${ANNOTATION_CLASS}`).length, 0, 'no annotations left behind');
  assert.equal(document.body.innerHTML, before, 'the page is byte-for-byte its own again');
});

test('turning glosses on and off repeatedly does not multiply text nodes', () => {
  const { window, document } = setup('<p>I run <b>every</b> day</p>');
  const paragraph = document.querySelector('p');
  const layer = makeLayer(window, document, new Map([['run', '跑']]));

  const cycle = () => {
    layer.start();
    layer.pass();
    layer.stop();
    layer.refresh(new Map());
  };

  cycle();
  const countAfterFirst = paragraph.childNodes.length;
  for (let i = 0; i < 3; i += 1) cycle();

  assert.equal(paragraph.textContent, 'I run every day');
  assert.equal(
    paragraph.childNodes.length,
    countAfterFirst,
    'a second cycle must not add nodes to a parent that cannot be merged',
  );
});
