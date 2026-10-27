import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { STORAGE_CODECS } from '../src/app/storage.js';

/**
 * Boots the *built* userscript, not the sources: this is the only test that
 * proves the zero-dependency bundler produced something that runs. Network is
 * stubbed through GM_xmlhttpRequest, so a failure here is our bug, not a
 * provider's.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The exact colour values the script ships. They are asserted as literals
 * rather than imported, so a test failure means the palette changed, not that
 * a constant was renamed.
 *
 * jsdom resolves neither `var()` nor custom properties inside a shadow root,
 * so a surface's painted colour is not observable here. The assertions below
 * therefore check two proxies that together pin the behaviour: the palette
 * reached the host, and the surface's own stylesheet reads those names.
 */
const LIGHT_BG = '#ffffff';
const DARK_BG = '#1c1c1e';
const DARK_FG = '#f2f2f7';

function build() {
  execFileSync(process.execPath, [resolve(ROOT, 'build.mjs')], { cwd: ROOT });
  return readFileSync(resolve(ROOT, 'dist/translate-tampermokey.user.js'), 'utf8');
}

test('the built header carries the version package.json declares', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const header = /^\/\/ @version\s+(\S+)$/m.exec(build());
  assert.ok(header, 'the userscript header must declare a version');
  assert.equal(header[1], pkg.version, 'a release must not bump two places');
});

/**
 * A Tampermonkey-ish sandbox with seeded GM storage and stubbed HTTP.
 *
 * Storage is seeded with the formats the script itself writes, so a test that
 * passes here is testing the real path. `rawStore` bypasses the codecs: it is
 * how a test reproduces what an older version left on disk.
 */
function boot({ url = 'https://example.com/article', html, settings, entries, rawStore, responses = {}, touch = false, prefersDark = false, playFails = false, clipboard = true }) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const store = {};
  if (settings) store.settings = STORAGE_CODECS.settings.encode(settings);
  if (entries) store.entries = STORAGE_CODECS.entries.encode(entries);
  Object.assign(store, rawStore);

  // jsdom has no clipboard. It is stubbed here so "复制译文" has somewhere to
  // copy to; `clipboard: false` exercises the engine that has none at all.
  const copiedText = [];
  if (clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copiedText.push(text);
        },
      },
    });
  }

  const requests = [];
  // Requests that asked for binary bytes: a recording must not be fetched as
  // text, or the blob URL would hold a JSON/UTF-8 re-encoding of the media.
  const downloads = [];
  const menu = [];
  // jsdom has no media-event plumbing: the dark-mode watcher's listeners are
  // kept here so a test can flip the OS preference mid-page.
  let dark = prefersDark;
  const darkListeners = new Set();

  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  // jsdom ships neither matchMedia nor maxTouchPoints; the touch branch of the
  // script keys off exactly these, so a test opts in here.
  window.matchMedia = (query) => {
    if (query === '(prefers-color-scheme: dark)') {
      return {
        get matches() {
          return dark;
        },
        media: query,
        addEventListener: (type, fn) => {
          if (type === 'change') darkListeners.add(fn);
        },
        removeEventListener: (type, fn) => {
          if (type === 'change') darkListeners.delete(fn);
        },
      };
    }
    return { matches: touch && query === '(pointer: coarse)', media: query, addEventListener() {}, removeEventListener() {} };
  };
  const setPrefersDark = (next) => {
    dark = next;
    for (const fn of darkListeners) fn({ matches: next, media: '(prefers-color-scheme: dark)' });
  };
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

  /*
   * jsdom has no media stack: no `Audio`, no object URLs, no speech synthesis.
   * The three are recorded here so a test can tell a recording apart from the
   * system voice without reaching into the script.
   */
  const audio = { played: [], instances: [], revoked: 0, spoken: [] };
  window.Audio = class {
    constructor(src) {
      this.src = src;
      this.paused = false;
      this.ended = false;
      audio.instances.push(this);
    }
    play() {
      if (playFails) return Promise.reject(new Error('cannot decode'));
      audio.played.push(this.src);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  };
  window.URL.createObjectURL = () => `blob:mock/${audio.played.length + audio.instances.length}`;
  window.URL.revokeObjectURL = () => {
    audio.revoked += 1;
  };
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  window.speechSynthesis = {
    cancel() {},
    speak(utterance) {
      audio.spoken.push(utterance.text);
    },
  };

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
    const isBlob = options.responseType === 'blob';
    if (isBlob) downloads.push(options.url);
    options.onload?.({
      status,
      responseText: isBlob ? '' : typeof body === 'string' ? body : JSON.stringify(body),
      response: isBlob ? body : undefined,
    });
  };

  window.eval(build());
  return { window, document: window.document, store, requests, downloads, copiedText, menu, dom, setPrefersDark, audio };
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

test('changing the target language in the popup looks the word up again and remembers the site', async () => {
  const { window, document, requests, store } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  assert.ok(await until(() => /跑/.test(popupText(document))));

  const root = document.querySelector('[data-tm=popup-host]').shadowRoot;
  const select = root.querySelector('select.target-select');
  assert.ok(select, 'the Popup carries the site target language');
  select.value = 'ja';
  select.dispatchEvent(new window.Event('change'));

  assert.ok(
    await until(() => requests.some((url) => url.includes('tl=ja'))),
    'the same word should be sent to the new target language',
  );
  assert.ok(await until(() => /跑/.test(popupText(document))));
  assert.match(store.settings, /^targetOverrides,example\.com,ja$/m, 'the choice is per-site and survives a reload');
  assert.equal(root.querySelector('select.target-select').value, 'ja', 'the new result shows the chosen target');
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

  const entries = STORAGE_CODECS.entries.decode(store.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].normalized, 'run');
  assert.equal(entries[0].translation, '跑');
  assert.match(store.entries, /^term,normalized,sourceLang,targetLang,translation/,
    'the book must be stored as CSV, not as one JSON blob');
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

  const translationRequests = requests.filter((url) =>
    ['clients5.google.com', 'api.mymemory.translated.net', 'lingva.ml'].includes(
      new URL(url).hostname,
    ),
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

test('the bubble measures 44px, the smallest target a finger hits', async () => {
  const { window, document } = boot({ html: '<p id="t">I run every day.</p>', touch: true });
  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false));

  const bubble = host.shadowRoot.querySelector('.bubble');
  const style = window.getComputedStyle(bubble);
  assert.equal(style.width, '44px');
  assert.equal(style.height, '44px');
  assert.equal(style.borderRadius, '50%', 'a round button stays round when it grows');
});

/** jsdom has no layout: give the Selection a rect the test can move. */
function stubSelectionRect(window, rect) {
  const current = { ...rect };
  window.Range.prototype.getBoundingClientRect = () => ({ ...current });
  window.Range.prototype.getClientRects = () => [{ ...current }];
  return current;
}

test('scrolling moves the bubble with its selection instead of hiding it', async () => {
  const { window, document } = boot({ html: '<p id="t">I run every day.</p>', touch: true });
  const rect = stubSelectionRect(window, { top: 100, bottom: 120, left: 40, right: 60, width: 20, height: 20 });

  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false));
  const bubble = host.shadowRoot.querySelector('.bubble');
  const before = { top: bubble.style.top, left: bubble.style.left };

  rect.top = 300;
  rect.bottom = 320;
  window.dispatchEvent(new window.Event('scroll'));
  assert.ok(await until(() => bubble.style.top !== before.top), 'the bubble should follow the selection');

  assert.equal(host.hidden, false, 'a still-visible selection keeps its bubble');
  assert.equal(bubble.style.left, before.left, 'only the axis that moved changes');
});

test('scrolling the selection off the screen hides the bubble', async () => {
  const { window, document } = boot({ html: '<p id="t">I run every day.</p>', touch: true });
  const rect = stubSelectionRect(window, { top: 100, bottom: 120, left: 40, right: 60, width: 20, height: 20 });

  touchSelect(window, document.getElementById('t'), 2, 5);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false));

  rect.top = -400;
  rect.bottom = -380;
  window.dispatchEvent(new window.Event('scroll'));
  assert.ok(await until(() => host.hidden === true), 'a selection nobody can see needs no bubble');
});

test('scrolling on touch closes the popup, since it would point at the wrong words', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 2, 5);
  await until(() => bubbleHost(document).hidden === false);
  bubbleHost(document).shadowRoot.querySelector('.bubble').click();
  await until(() => /跑/.test(popupText(document)));

  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(document.querySelector('[data-tm=popup-host]').hidden, true);
});

test('scrolling on desktop leaves the popup open and where it was', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  await until(() => /跑/.test(popupText(document)));

  const host = document.querySelector('[data-tm=popup-host]');
  const wrap = host.shadowRoot.querySelector('.wrap');
  const before = { top: wrap.style.top, left: wrap.style.left };
  window.dispatchEvent(new window.Event('scroll'));

  assert.equal(host.hidden, false, 'a deliberately opened popup survives a scroll');
  assert.equal(wrap.style.top, before.top);
  assert.equal(wrap.style.left, before.left);
});

test('an oversized selection on touch says so, since no bubble will appear', async () => {
  const long = 'word '.repeat(81).trim();
  const { window, document } = boot({ html: `<p id="t">${long}</p>`, touch: true });
  touchSelect(window, document.getElementById('t'), 0, long.length);

  const hintHost = document.querySelector('[data-tm=hint-host]');
  assert.ok(await until(() => hintHost.hidden === false), 'silence would look like a broken script');
  assert.match(hintHost.shadowRoot.textContent, /最多 400 字/);
  assert.equal(bubbleHost(document).hidden, true, 'no bubble for a selection past the limit');

  // Selecting a word afterwards replaces the message with the Bubble; the old
  // label must not hang over the new selection.
  touchSelect(window, document.getElementById('t'), 0, 4);
  assert.ok(await until(() => hintHost.hidden === true), 'a stale label must not outlive its selection');
  assert.equal(bubbleHost(document).hidden, false);
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

test('a selection that wraps across lines on touch still offers a bubble', async () => {
  const { window, document } = boot({
    html: '<p id="t">line one\nline two</p>',
    responses: { clients5: [200, [['第一行\n第二行', 'en']]] },
    touch: true,
  });
  touchSelect(window, document.getElementById('t'), 0, 17);
  const host = bubbleHost(document);
  assert.ok(await until(() => host.hidden === false), 'a drag across lines is still a lookup');

  host.shadowRoot.querySelector('.bubble').click();
  assert.ok(await until(() => popupText(document).includes('第一行')));
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
  assert.match(text, /英语/, 'the book groups its entries by the language they are written in');
});

test('a book and settings saved by the JSON era are still read', async () => {
  const { document, menu, store } = boot({
    html: '<p id="t">I run and walk.</p>',
    rawStore: {
      entries: JSON.stringify([
        {
          entryId: 'en|run',
          term: 'run',
          normalized: 'run',
          sourceLang: 'en',
          targetLang: 'zh-CN',
          translation: '跑',
          addedAt: 1,
        },
      ]),
      settings: JSON.stringify({
        version: 1,
        lookupEnabled: true,
        glossSites: { 'example.com': true },
        targetOverrides: {},
        disabledProviders: [],
      }),
    },
  });

  // The old settings still decide behaviour: glosses are on for this site.
  await until(() => document.getElementById('t').textContent.includes('跑'));
  const open = menu.find(([name]) => name.includes('生词本'));
  open[1]();
  await wait(50);
  assert.match(
    document.querySelector('[data-tm=panel-host]').shadowRoot.querySelector('.dialog').textContent,
    /跑/,
    'the old JSON book must still be listed',
  );

  // The first write replaces the old value with the new format.
  menu.find(([name]) => name.includes('注音'))[1]();
  assert.match(store.settings, /^section,key,value\r\n/, 'settings are rewritten as CSV');
});

test('a cached answer is not requested twice, including the dictionary call', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: {
      clients5: [200, [['跑', 'en']]],
      youdao: [
        200,
        {
          ec: {
            word: [
              {
                usphone: 'rʌn',
                usspeech: 'run&type=2',
                trs: [{ tr: [{ l: { i: ['v. 跑，奔跑'] } }] }],
              },
            ],
          },
        },
      ],
      freedictionaryapi: [200, { entries: [] }],
    },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  // translation + two dictionary endpoints; wait for the Popup so the lookup
  // has actually finished and written its cache entries.
  const ready = await until(() => popupText(document).includes('加入生词本'));
  assert.ok(ready, `popup never filled; text=${JSON.stringify(popupText(document))} reqs=${requests.length}`);
  assert.equal(requests.length, 3);
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  // The cached record must still be the details record, not a wrapper around
  // it: an empty second popup would mean the cache lookup lost the meanings.
  assert.ok(await until(() => /跑，奔跑/.test(popupText(document))),
    `cached dictionary details went missing; text=${JSON.stringify(popupText(document))}`);
  await wait(150);
  assert.equal(requests.length, 3);
});
test('a dictionary set in the Panel is where every new lookup starts', async () => {
  const { window, document, requests } = boot({
    html: '<p id="t">I run every day.</p>',
    settings: { dictionary: 'microsoft' },
    responses: {
      clients5: [200, [['跑', 'en']]],
      'cn.bing.com': [200, '<div class="qdef"><ul><li><span class="pos">v.</span><span class="def b_regtxt">微软释义</span></li></ul></div>'],
    },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);

  assert.ok(await until(() => /微软释义/.test(popupText(document))));
  assert.ok(requests.some((url) => new URL(url).hostname === 'cn.bing.com'));
  assert.equal(requests.some((url) => new URL(url).hostname === 'dict.youdao.com'), false,
    'the default must replace the old dictionary, not add to it');
});

test('switching the dictionary in the Popup refetches meanings and leaves the default alone', async () => {
  const { window, document, requests, store } = boot({
    html: '<p id="t">I run every day.</p>',
    settings: { dictionary: 'youdao' },
    responses: {
      clients5: [200, [['跑', 'en']]],
      'dict.youdao.com': [200, {
        ec: { word: [{ usphone: 'rʌn', trs: [{ tr: [{ l: { i: ['v. 有道释义'] } }] }] }] },
      }],
      'cn.bing.com': [200, '<div class="qdef"><ul><li><span class="pos">v.</span><span class="def b_regtxt">微软释义</span></li></ul></div>'],
    },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);
  assert.ok(await until(() => /有道释义/.test(popupText(document))));

  const root = document.querySelector('[data-tm=popup-host]').shadowRoot;
  const chosen = root.querySelector('button[data-dict="youdao"]');
  assert.equal(chosen.getAttribute('aria-pressed'), 'true');
  root.querySelector('button[data-dict="microsoft"]').click();
  assert.ok(await until(() => /微软释义/.test(popupText(document))),
    'the Popup should show the newly chosen dictionary');
  assert.equal(
    root.querySelector('button[data-dict="microsoft"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.match(store.settings, /^general,dictionary,youdao$/m,
    'a temporary choice must not rewrite the setting');
  assert.doesNotMatch(store.settings, /general,dictionary,microsoft/);
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

test('a dark system paints all three surfaces dark', async () => {
  const { window, document } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
    touch: true,
    prefersDark: true,
  });

  const hosts = ['popup-host', 'bubble-host', 'panel-host'].map((name) =>
    document.querySelector(`[data-tm=${name}]`),
  );
  for (const host of hosts) {
    assert.ok(host, 'every surface should be mounted');
    assert.equal(
      window.getComputedStyle(host).getPropertyValue('--tm-bg').trim(),
      DARK_BG,
      `${host.getAttribute('data-tm')} should use the dark background`,
    );
  }

  touchSelect(window, document.getElementById('t'), 2, 5);
  await until(() => bubbleHost(document).hidden === false);
  assert.equal(
    window.getComputedStyle(bubbleHost(document)).getPropertyValue('--tm-fg').trim(),
    DARK_FG,
    'the bubble must not be the one surface left light',
  );
});

test('a light system paints the surfaces light', () => {
  const { window, document } = boot({ html: '<p>hello</p>', prefersDark: false });
  const host = document.querySelector('[data-tm=popup-host]');
  assert.equal(window.getComputedStyle(host).getPropertyValue('--tm-bg').trim(), LIGHT_BG);
});

test('forcing dark from the panel overrides a light system', async () => {
  const { window, document, menu, store } = boot({ html: '<p>hello</p>', prefersDark: false });
  menu.find(([name]) => name.includes('生词本'))[1]();
  await wait(30);

  const panel = document.querySelector('[data-tm=panel-host]');
  const settingsTab = [...panel.shadowRoot.querySelectorAll('.tabs button')].find((b) => b.textContent === '设置');
  settingsTab.click();
  await wait(20);

  const select = panel.shadowRoot.querySelector('select.theme');
  assert.ok(select, 'the settings page needs a theme control');
  select.value = 'dark';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  assert.equal(
    window.getComputedStyle(document.querySelector('[data-tm=popup-host]')).getPropertyValue('--tm-bg').trim(),
    DARK_BG,
    'the popup should follow the forced theme, not the system one',
  );
  assert.equal(
    window.getComputedStyle(panel).getPropertyValue('--tm-bg').trim(),
    DARK_BG,
    'the panel should repaint itself too',
  );
  assert.equal(STORAGE_CODECS.settings.decode(store.settings).theme, 'dark', 'the choice must survive a reload');
});

test('flipping the system preference repaints without a reload', () => {
  const { window, document, setPrefersDark } = boot({ html: '<p>hello</p>', prefersDark: false });
  const host = document.querySelector('[data-tm=popup-host]');
  assert.equal(window.getComputedStyle(host).getPropertyValue('--tm-bg').trim(), LIGHT_BG);

  setPrefersDark(true);
  assert.equal(
    window.getComputedStyle(host).getPropertyValue('--tm-bg').trim(),
    DARK_BG,
    'the surfaces should follow the OS without a reload',
  );
});

test('a forced theme ignores the system preference flipping', () => {
  const { window, document, setPrefersDark } = boot({
    html: '<p>hello</p>',
    prefersDark: false,
    settings: {
      version: 1,
      lookupEnabled: true,
      glossSites: {},
      targetOverrides: {},
      disabledProviders: [],
      theme: 'light',
    },
  });
  const host = document.querySelector('[data-tm=popup-host]');
  setPrefersDark(true);
  assert.equal(
    window.getComputedStyle(host).getPropertyValue('--tm-bg').trim(),
    LIGHT_BG,
    'a forced theme must not be overridden by the system',
  );
});

test('every surface paints from the shared theme variables', () => {
  const { document } = boot({ html: '<p>hello</p>', touch: true });
  // The Bubble is a solid accent pill, so it reads the accent pair rather than
  // the panel's background/foreground pair.
  const expected = {
    'popup-host': ['--tm-bg', '--tm-fg'],
    'panel-host': ['--tm-bg', '--tm-fg'],
    'bubble-host': ['--tm-accent', '--tm-accent-fg'],
  };
  for (const [name, tokens] of Object.entries(expected)) {
    const host = document.querySelector(`[data-tm=${name}]`);
    const css = [...host.shadowRoot.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    for (const token of tokens) {
      assert.match(
        css,
        new RegExp(`var\\(\\s*${token}`),
        `${name} must read ${token} rather than hard-code a colour`,
      );
    }
  }
});

const RECORDING = 'https://api.dictionaryapi.dev/media/pronunciations/en/run-us.mp3';

/** A dictionary body that offers a pronunciation recording. */
function dictionaryWithAudio(audioUrl = RECORDING) {
  return [
    {
      word: 'run',
      phonetics: [{ text: '/ɹʌn/', audio: audioUrl }],
      meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To move rapidly on foot.' }] }],
    },
  ];
}

/** Boot a page, answer one lookup, and leave its Popup open. */
async function openPopupWithDictionary(
  dictionaryBody,
  {
    recording = [200, { bytes: true }],
    playFails = false,
    settings = { dictionary: 'dictionaryapi' },
  } = {},
) {
  const ctx = boot({
    html: '<p id="t">I run every day.</p>',
    // Pronunciation is independent of which dictionary supplies the meanings;
    // this helper keeps the English-English source so its fixtures stay small.
    settings,
    responses: {
      clients5: [200, [['跑', 'en']]],
      'dictionaryapi.dev/api/v2/entries/en/run': [200, dictionaryBody],
      freedictionaryapi: [200, { entries: [] }],
      pronunciations: recording,
    },
    playFails,
  });
  selectAndDoubleClick(ctx.window, ctx.document.getElementById('t'), 2, 5);
  return ctx;
}

async function speakButton(document) {
  const popup = document.querySelector('[data-tm=popup-host]');
  await until(() => popupText(document).includes('加入生词本'));
  return popup.shadowRoot.querySelector('button.speak');
}

test('默认播放语音 reads the word without a tap', async () => {
  const { audio, downloads } = await openPopupWithDictionary(dictionaryWithAudio(), {
    settings: { dictionary: 'dictionaryapi', autoSpeak: true },
  });

  assert.ok(await until(() => audio.played.length > 0), 'the setting must start playback by itself');
  assert.deepEqual(downloads, [RECORDING], 'auto-speak goes through the same recording path as the button');
  assert.deepEqual(audio.spoken, [], 'one voice, not the recording plus the system voice');
});

test('a lookup stays silent unless the setting is on', async () => {
  const { document, audio } = await openPopupWithDictionary(dictionaryWithAudio());

  await until(() => popupText(document).includes('加入生词本'));
  // Auto-speak would have started by the time the Popup is filled; this extra
  // tick also catches playback scheduled one microtask later.
  await wait(50);
  assert.equal(audio.played.length, 0);
  assert.deepEqual(audio.spoken, []);
});

test('the speak button plays the dictionary recording when one exists', async () => {
  const { document, requests, downloads, audio } = await openPopupWithDictionary(dictionaryWithAudio());

  const button = await speakButton(document);
  assert.ok(button, 'the popup needs a speak button');
  button.click();
  assert.ok(await until(() => audio.played.length > 0), 'a recording should start playing');

  assert.ok(
    requests.some((url) => url === RECORDING),
    'the recording must be downloaded through the userscript HTTP bridge',
  );
  assert.deepEqual(downloads, [RECORDING], 'audio is bytes, so the request must ask for a blob');
  assert.equal(audio.spoken.length, 0, 'a real recording must not also fire the system voice');
});

test('without a recording the speak button uses the system voice', async () => {
  const { document, requests, audio } = await openPopupWithDictionary([
    { word: 'run', phonetics: [{ text: '/ɹʌn/', audio: '' }], meanings: [] },
  ]);

  const button = await speakButton(document);
  button.click();
  await until(() => audio.spoken.length > 0);

  assert.deepEqual(audio.spoken, ['run']);
  assert.equal(
    requests.some((url) => url.includes('pronunciations')),
    false,
    'no recording means no download attempt',
  );
});

test('a second tap on the speak button stops the recording', async () => {
  const { document, audio } = await openPopupWithDictionary(dictionaryWithAudio());

  const button = await speakButton(document);
  button.click();
  await until(() => audio.instances.length === 1);
  assert.equal(audio.instances[0].paused, false);

  button.click();
  assert.ok(await until(() => audio.instances[0].paused === true), 'the second tap should stop playback');
  assert.equal(audio.revoked, 1, 'the temporary audio URL must be released');
});

test('a failed download falls back to the system voice', async () => {
  const { document, audio } = await openPopupWithDictionary(
    dictionaryWithAudio('https://api.dictionaryapi.dev/media/pronunciations/en/missing-us.mp3'),
    { recording: [404, ''] },
  );

  const button = await speakButton(document);
  button.click();
  assert.ok(await until(() => audio.spoken.length > 0), 'a missing recording must not silence the word');
  assert.deepEqual(audio.spoken, ['run']);
  assert.equal(audio.revoked, 0, 'no blob was ever created, so there is nothing to release');
});

test('a recording the browser cannot play falls back to the system voice', async () => {
  const { document, audio } = await openPopupWithDictionary(dictionaryWithAudio(), { playFails: true });

  const button = await speakButton(document);
  button.click();
  assert.ok(await until(() => audio.spoken.length > 0), 'a failed playback must not silence the word');
  assert.deepEqual(audio.spoken, ['run']);
  assert.equal(audio.revoked, 1, 'the blob URL made for the failed recording must be released');
});

test('finishing a recording releases the temporary audio URL', async () => {
  const { document, audio } = await openPopupWithDictionary(dictionaryWithAudio());

  const button = await speakButton(document);
  button.click();
  await until(() => audio.instances.length === 1);

  audio.instances[0].onended();
  assert.equal(audio.revoked, 1, 'an object URL outlives the blob only as long as the sound does');
});

test('the entry saved from a lookup carries no audio field', async () => {
  const { document, store } = await openPopupWithDictionary(dictionaryWithAudio());
  const add = await until(() => {
    const popup = document.querySelector('[data-tm=popup-host]');
    const button = popup.shadowRoot.querySelector('button.primary');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  assert.ok(add, 'the entry should be savable');
  await until(() => Boolean(store.entries));

  const [entry] = STORAGE_CODECS.entries.decode(store.entries);
  assert.equal('audio' in entry, false, 'the recording URL is not part of an Entry');
});

const SENTENCE = 'The quick brown fox jumps over the lazy dog.';
const SENTENCE_TRANSLATION = '敏捷的棕色狐狸跳过了那只懒狗。';

function popupWrap(document) {
  return document.querySelector('[data-tm=popup-host]').shadowRoot.querySelector('.wrap');
}

test('a sentence gets its translation and no dictionary or save affordance', async () => {
  const { window, document, requests } = boot({
    html: `<p id="t">${SENTENCE}</p>`,
    responses: { clients5: [200, [[SENTENCE_TRANSLATION, 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 0, SENTENCE.length);

  assert.ok(await until(() => popupText(document).includes('敏捷的棕色狐狸')), 'the sentence should be translated');

  const wrap = popupWrap(document);
  assert.match(wrap.className, /sentence/, 'the sentence layout preserves line breaks');
  assert.equal(wrap.querySelector('button.primary'), null, 'a sentence cannot be saved to the book');
  assert.doesNotMatch(wrap.textContent, /加入生词本|过长/);
  assert.equal(wrap.querySelector('.term'), null, 'the sentence is already on the page');
  assert.ok(wrap.querySelector('button.copy'), 'a sentence can be copied');
  assert.ok(wrap.querySelector('button.speak'), 'a sentence can be read aloud');
  assert.equal(wrap.querySelector('.close').style.display, 'block');

  assert.equal(
    requests.some((url) => url.includes('dictionaryapi')),
    false,
    'a sentence must not be sent to a dictionary',
  );
});

test('a word result can be copied as well', async () => {
  const { window, document, copiedText } = boot({
    html: '<p id="t">I run every day.</p>',
    responses: { clients5: [200, [['跑', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 2, 5);

  assert.ok(await until(() => popupText(document).includes('跑')));
  const copy = popupWrap(document).querySelector('button.copy');
  assert.ok(copy, 'copying is the same action for a word');
  copy.click();
  assert.ok(await until(() => copy.textContent === '已复制'), 'a working clipboard says so');
  assert.deepEqual(copiedText, ['跑']);
});

test('a selection past the limit says so instead of doing nothing', async () => {
  const long = 'word '.repeat(81).trim();
  assert.ok(long.length > 400, 'the fixture must exceed the limit');
  const { window, document, requests } = boot({
    html: `<p id="t">${long}</p>`,
    responses: { clients5: [200, [['不该发生', 'en']]] },
  });
  selectAndDoubleClick(window, document.getElementById('t'), 0, long.length);

  const hintHost = document.querySelector('[data-tm=hint-host]');
  assert.ok(await until(() => hintHost.hidden === false), 'an oversized selection must answer');
  assert.match(hintHost.shadowRoot.textContent, /最多 400 字/);
  assert.equal(requests.length, 0, 'an oversized selection is not sent anywhere');
});

