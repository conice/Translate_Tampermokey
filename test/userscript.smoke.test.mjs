import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * Boots the *built* userscript, not the sources: this is the only test that
 * proves the zero-dependency bundler produced something that runs. Network is
 * stubbed through GM_xmlhttpRequest, so a failure here is our bug, not a
 * provider's.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function build() {
  execFileSync(process.execPath, [resolve(ROOT, 'build.mjs')], { cwd: ROOT });
  return readFileSync(resolve(ROOT, 'dist/translate-tampermokey.user.js'), 'utf8');
}

/** A Tampermonkey-ish sandbox with seeded GM storage and stubbed HTTP. */
function boot({ url = 'https://example.com/article', html, settings, entries, responses = {}, touch = false }) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const store = {};
  if (settings) store.settings = JSON.stringify(settings);
  if (entries) store.entries = JSON.stringify(entries);

  const requests = [];
  const menu = [];

  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  // jsdom ships neither matchMedia nor maxTouchPoints; the touch branch of the
  // script keys off exactly these, so a test opts in here.
  window.matchMedia = (query) => ({ matches: touch && query === '(pointer: coarse)', media: query });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: touch ? 5 : 0, configurable: true });
  window.Element.prototype.getBoundingClientRect = () => ({
    top: 0,
    bottom: 20,
    left: 0,
    right: 100,
    width: 100,
    height: 20,
  });
  window.requestIdleCallback = (fn) => window.setTimeout(fn, 0);
  window.GM_getValue = (key, fallback) => (key in store ? store[key] : fallback);
  window.GM_setValue = (key, value) => {
    store[key] = value;
  };
  window.GM_deleteValue = (key) => {
    delete store[key];
  };
  window.GM_registerMenuCommand = (name, fn) => menu.push([name, fn]);
  window.GM_xmlhttpRequest = (options) => {
    requests.push(options.url);
    const respond = Object.entries(responses).find(([fragment]) => options.url.includes(fragment));
    if (!respond) {
      options.onerror?.();
      return;
    }
    const [, [status, body]] = respond;
    options.onload?.({ status, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
  };

  window.eval(build());
  return { window, document: window.document, store, requests, menu, dom };
}

function selectAndDoubleClick(window, element, start, end) {
  selectRange(window, element, start, end);
  element.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
}

function selectRange(window, element, start, end) {
  const range = window.document.createRange();
  range.setStart(element.firstChild, start);
  range.setEnd(element.firstChild, end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

/** jsdom never fires `selectionchange`, so the touch path is driven off touchend. */
function touchSelect(window, element, start, end) {
  selectRange(window, element, start, end);
  element.dispatchEvent(new window.Event('touchend', { bubbles: true }));
}

function bubbleHost(document) {
  return document.querySelector('[data-tm=bubble-host]');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds; the async flow crosses several microtask hops. */
async function until(predicate, { timeout = 3000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(step);
  }
  return false;
}

function popupText(document) {
  return document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('.wrap')?.textContent ?? '';
}

test('the built script boots and registers its menu commands', () => {
  const { menu, document } = boot({ html: '<p>hello</p>' });
  assert.ok(document.querySelector('[data-tm=popup-host]'), 'popup host should exist');
  assert.ok(document.querySelector('[data-tm=panel-host]'), 'panel host should exist');
  assert.deepEqual(
    menu.map(([name]) => name),
    ['打开生词本 / 设置', '开启本站注音'],
  );
});

test('double-clicking a word shows the popup with its translation', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  assert.ok(await until(() => /跑/.test(popupText(document))), 'popup should show the translation');

  const host = document.querySelector('[data-tm=popup-host]');
  assert.equal(host.hidden, false);
  const text = popupText(document);
  assert.match(text, /run/);
  assert.match(text, /跑/);
});

test('saving from the popup writes an entry and glides into the gloss layer', async () => {
  const { window, document, store } = boot({
    url: 'https://example.com/article',
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await until(() => popupText(document).includes('加入生词本'));
  const button = document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('button.primary');
  button.click();
  await until(() => Boolean(store.entries));

  const entries = JSON.parse(store.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].normalized, 'run');
  assert.equal(entries[0].translation, '跑');
});

test('a failing first provider falls through to the next and the popup still fills', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: {
      clients5: [429, '<html>Sorry...</html>'],
      mymemory: [200, { responseData: { translatedText: '跑' }, responseStatus: 200 }],
    },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await until(() => /跑/.test(popupText(document)));

  const translationRequests = requests.filter(
    (url) => !url.includes('dictionaryapi') && !url.includes('freedictionaryapi'),
  );
  assert.deepEqual(
    translationRequests.map((url) => new URL(url).hostname),
    ['clients5.google.com', 'api.mymemory.translated.net'],
    'the chain should stop at the first provider that answers',
  );
  const text = document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('.wrap').textContent;
  assert.match(text, /跑/);
});

test('every provider down leaves an error state with a retry button', async () => {
  const { window, document } = boot({ html: '<p id="t">I run every day.</p>' });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await until(() => popupText(document).includes('翻译服务暂不可用'));
  const wrap = document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('.wrap');
  assert.match(wrap.textContent, /翻译服务暂不可用/);
  assert.ok(wrap.querySelector('button'), 'retry button');
});

test('desktop gets no bubble at all', () => {
  const { document } = boot({ html: '<p id="t">I run every day.</p>' });
  assert.equal(bubbleHost(document), null, 'a desktop page should not carry the touch UI');
});

test('on a touch device, selecting a word shows a bubble that opens the popup', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
  });

  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(host, 'touch devices need the bubble host');
  assert.ok(await until(() => host.hidden === false), 'the bubble should appear after the selection settles');
  assert.equal(requests.length, 0, 'merely selecting must not fire a request');

  host.shadowRoot.querySelector('.bubble').click();
  assert.ok(await until(() => /跑/.test(popupText(document))), 'tapping the bubble should look the word up');
});

test('a collapsed selection on touch hides the bubble and looks nothing up', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
  });

  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false));

  // Copying/clearing the selection must take the bubble away again.
  window.getSelection().removeAllRanges();
  document.getElementById('t').dispatchEvent(new window.Event('touchend', { bubbles: true }));
  assert.ok(await until(() => host.hidden === true), 'the bubble should disappear');
  assert.equal(requests.length, 0);
});

test('scrolling takes the bubble away, since it would otherwise point at the wrong words', async () => {
  const { window, document } = boot({ html: '<p id="t">I run every day.</p>', touch: true });
  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false));

  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(host.hidden, true);
});

test('one tap on the bubble starts exactly one lookup', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: {
      clients5: [200, [['跑', 'en']]],
      dictionaryapi: [200, []],
      freedictionaryapi: [200, { entries: [] }],
    },
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 2, 5);
  const button = bubbleHost(document).shadowRoot.querySelector('.bubble');
  await until(() => bubbleHost(document).hidden === false);

  // A real tap can deliver touchend *and* a synthetic click; the Bubble must
  // treat the pair as one tap.
  button.dispatchEvent(new window.Event('touchend', { bubbles: true }));
  button.click();
  await until(() => /跑/.test(popupText(document)));
  await wait(120);

  assert.equal(requests.length, 3, `translation + two dictionary calls, got ${requests.length}`);
});

test('a multi-line selection on touch offers no bubble', async () => {
  const { window, document } = boot({
    html: '<p id="t">line one\nline two</p>',
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 0, 17);
  await wait(300);
  assert.equal(bubbleHost(document).hidden, true);
});

test('touch popup uses the compact layout with a close button', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 2, 5);
  await until(() => bubbleHost(document).hidden === false);
  bubbleHost(document).shadowRoot.querySelector('.bubble').click();
  await until(() => /跑/.test(popupText(document)));

  const wrap = document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('.wrap');
  assert.match(wrap.className, /touch/);
  const close = wrap.querySelector('.close');
  assert.ok(close, 'a touch popup needs an explicit close button');
  close.click();
  assert.equal(document.querySelector('[data-tm=popup-host]').hidden, true);
});

test('tapping elsewhere closes the touch popup without the bubble bouncing back', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p><p id="other">unrelated</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 2, 5);
  await until(() => bubbleHost(document).hidden === false);
  bubbleHost(document).shadowRoot.querySelector('.bubble').click();
  await until(() => /跑/.test(popupText(document)));

  // The browser keeps the Selection after a tap, so only the dismissal logic
  // can stop the Bubble from reappearing over the closed Popup.
  document.getElementById('other').dispatchEvent(new window.Event('touchend', { bubbles: true }));
  await wait(200);
  assert.equal(document.querySelector('[data-tm=popup-host]').hidden, true, 'popup closes');
  assert.equal(bubbleHost(document).hidden, true, 'bubble stays hidden');
});

test('glosses only appear when the site is enabled and only for book terms', async () => {
  const entry = {
    entryId: 'en|run',
    term: 'run',
    normalized: 'run',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    translation: '跑',
    addedAt: 1,
  };

  const off = boot({ html: '<p id="t">I run and walk.</p>', entries: [entry] });
  await wait(200);
  assert.equal(off.document.getElementById('t').textContent, 'I run and walk.');

  const on = boot({
    html: '<p id="t">I run and walk.</p>',
    entries: [entry],
    settings: {
      version: 1,
      lookupEnabled: true,
      glossSites: { 'example.com': true },
      targetOverrides: {},
      disabledProviders: [],
    },
  });
  await until(() => on.document.getElementById('t').textContent.includes('跑'));
  assert.equal(on.document.getElementById('t').textContent, 'I run跑 and walk.');
  assert.equal(on.document.querySelectorAll('.tm-gloss-annot').length, 1);
});

test('the panel opens from the menu and lists saved entries', async () => {
  const { document, menu } = boot({
    html: '<p>hi</p>',
    entries: [
      {
        entryId: 'en|run',
        term: 'run',
        normalized: 'run',
        sourceLang: 'en',
        targetLang: 'zh-CN',
        translation: '跑',
        addedAt: 1,
      },
    ],
  });
  const open = menu.find(([name]) => name.includes('生词本'));
  open[1]();
  await wait(50);

  const host = document.querySelector('[data-tm=panel-host]');
  assert.equal(host.hidden, false);
  const text = host.shadowRoot.querySelector('.dialog').textContent;
  assert.match(text, /run/);
  assert.match(text, /跑/);
});

test('a cached answer is not requested twice, including the dictionary call', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: {
      clients5: [200, [['跑', 'en']]],
      dictionaryapi: [
        200,
        [{ word: 'run', phonetics: [{ text: '/rʌn/' }], meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'move fast' }] }] }],
      ],
    },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  // translation + two dictionary endpoints; wait for the Popup so the lookup
  // has actually finished and written its cache entries.
  const ready = await until(() => popupText(document).includes('加入生词本'));
  assert.ok(ready, `popup never filled; text=${JSON.stringify(popupText(document))} reqs=${requests.length}`);
  assert.equal(requests.length, 3);
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await wait(150);
  assert.equal(requests.length, 3);
});
test('turning glosses on from the menu annotates, and off again restores the page', async () => {
  const { document, menu } = boot({
    html: '<p id="t">I run and walk.</p>',
    entries: [
      {
        entryId: 'en|run',
        term: 'run',
        normalized: 'run',
        sourceLang: 'en',
        targetLang: 'zh-CN',
        translation: '跑',
        addedAt: 1,
      },
    ],
  });

  const on = menu.find(([name]) => name === '开启本站注音');
  assert.ok(on, 'menu should offer to turn glosses on');
  on[1]();
  assert.ok(await until(() => document.getElementById('t').textContent.includes('跑')));
  assert.equal(document.getElementById('t').textContent, 'I run跑 and walk.');

  const off = menu.find(([name]) => name === '关闭本站注音');
  assert.ok(off, 'the menu label should flip after turning glosses on');
  off[1]();
  assert.ok(await until(() => !document.getElementById('t').textContent.includes('跑')));
  assert.equal(document.getElementById('t').textContent, 'I run and walk.');
  assert.equal(document.querySelectorAll('.tm-gloss-annot').length, 0);
});

test('turning lookup off from the panel stops double-click lookups', async () => {
  const { window, document, requests, menu } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  menu.find(([name]) => name.includes('生词本'))[1]();
  await wait(30);

  const panel = document.querySelector('[data-tm=panel-host]');
  const settingsTab = [...panel.shadowRoot.querySelectorAll('.tabs button')].find((b) => b.textContent === '设置');
  settingsTab.click();
  await wait(20);
  const lookupBox = panel.shadowRoot.querySelector('input[type=checkbox]');
  lookupBox.click();

  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await wait(120);
  assert.equal(requests.length, 0, 'no lookup should be attempted while disabled');
});
