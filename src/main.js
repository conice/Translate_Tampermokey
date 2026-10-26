/**
 * Entry point: wires the modules to this page.
 *
 * Deliberately small — everything with behaviour worth testing lives in
 * core/ (pure) or app/ (injected DOM), so this file is only glue.
 */
import { pageLanguage, resolveTarget } from './core/lang.js';
import { normalizeTerm } from './core/normalize.js';
import { dictionaryDev, freedictionary, createTranslator } from './core/providers.js';
import { createSettings, createBook, createLookupCache } from './app/storage.js';
import { createLookupFlow, addEntry } from './app/lookup-flow.js';
import { createPronouncer } from './app/pronunciation.js';
import { createPopup } from './ui/popup.js';
import { createBubble } from './ui/bubble.js';
import { createHint } from './ui/hint.js';
import { createCopyText } from './app/clipboard.js';
import { createGlossLayer } from './ui/gloss-layer.js';
import { createPanel } from './ui/panel.js';
import { applyPalette } from './ui/palette.js';
import { resolveTheme } from './core/theme.js';
import { isTouchPrimary, shouldOfferBubble, selectionTerm, isOwnSelection, isRectVisible, isEditableSelection, MAX_BUBBLE_CHARS } from './core/gesture.js';

const gm = {
  getValue: (key, fallback) => (typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback),
  setValue: (key, value) => {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  },
  deleteValue: (key) => {
    if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
  },
};

const host = location.hostname;

/**
 * A phone has no reliable double-click (Chrome only fires it with double-tap
 * zoom off, iOS never), so touch devices get a Bubble next to the finished
 * Selection instead. Desktop keeps the double-click.
 */
const touchPrimary = isTouchPrimary(window);

/**
 * Userscript-manager-native HTTP, which bypasses page CSP and CORS.
 *
 * One bridge with a `binary` switch rather than two near-identical functions:
 * the timeout, the status check and the error mapping must stay the same for
 * translations, dictionary entries and pronunciation recordings alike.
 */
function request(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('GM_xmlhttpRequest unavailable'));
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 12000,
      ...(binary ? { responseType: 'blob' } : {}),
      onload(response) {
        if (response.status >= 200 && response.status < 300) {
          resolve(binary ? response.response : response.responseText);
        } else {
          reject(new Error(`HTTP ${response.status}`));
        }
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}

const fetchText = (url) => request(url);
/** A pronunciation recording, as bytes: the text-shaped call cannot carry it. */
const fetchBlob = (url) => request(url, { binary: true });

const settings = createSettings(gm);
const book = createBook(gm);
const cache = createLookupCache(gm);

const translator = createTranslator({
  fetchText,
  cache,
  onProviderError: (id, error) => {
    console.debug(`[tm] provider ${id} failed:`, error.message);
  },
});

/** The Target Language for glosses: the same rule lookups use, including the per-site override. */
function glossTarget() {
  return resolveTarget({
    pageLang: detectPageLang(),
    sourceLang: 'auto',
    override: settings.targetOverride(host),
  });
}

/** Glosses show only entries already translated into this page's Target Language. */
function refreshGlosses({ force = false } = {}) {
  // Never force a pass on a site where glosses are off: `force` exists so the
  // panel can refresh a visible layer, not so it can annotate without consent.
  gloss.refresh(book.translationMap(glossTarget()), { force: force && settings.glossOn(host) });
}

/** Turn the layer on or off for this site, keeping the page clean when off. */
function applyGlossSetting() {
  if (settings.glossOn(host)) {
    gloss.start();
    refreshGlosses({ force: true });
  } else {
    gloss.stop();
    // refresh with an empty map unwraps every annotation we made.
    gloss.refresh(new Map(), { force: true });
  }
}

function detectPageLang() {
  return pageLanguage(document.documentElement.lang, document.body?.innerText?.slice(0, 800) ?? '');
}

/**
 * Dictionary details: IPA, audio and meanings from dictionaryapi.dev, plus the
 * base form from Wiktionary via freedictionaryapi.com. Both are lookup-only and
 * optional, so a failure yields partial or no details rather than an error.
 *
 * Results are cached: without this, every repeat lookup of the same word would
 * re-hit both endpoints even when the translation itself came from cache.
 */
const dictionary = createDictionaryLookup({ fetchText, cache });

function createDictionaryLookup({ fetchText, cache }) {
  const inFlight = new Map();

  return async function lookup(word) {
    const key = `dict|en|en|${word}`;
    const cached = cache.get(key);
    if (cached) return cached.value;
    // Two quick double-clicks on the same word must not fire duplicate requests.
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      const [detailsBody, lemmaBody] = await Promise.allSettled([
        fetchText(dictionaryDev.request({ word })),
        fetchText(freedictionary.request({ word })),
      ]);

      let details;
      if (detailsBody.status === 'fulfilled') {
        details = dictionaryDev.parse(detailsBody.value);
      }
      let lemma;
      if (lemmaBody.status === 'fulfilled') {
        lemma = freedictionary.parseLemma(lemmaBody.value);
      }
      if (!details && !lemma) return undefined;

      const value = { ...(details ?? {}), lemma };
      cache.set(key, value, { ok: true });
      return value;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, pending);
    return pending;
  };
}

const copyText = createCopyText({ navigator: window.navigator, document });

const popup = createPopup({
  document,
  window,
  touch: touchPrimary,
  onAdd: async (entry) => {
    if (!entry) return;
    addEntry(book, entry, () => refreshGlosses());
  },
  onSpeak: (term, lang, audioUrl) => pronouncer.play(term, lang, audioUrl),
  onCopy: copyText,
  onClose: () => {},
});

/** A brief label next to an oversized Selection, so it is not answered with silence. */
const hint = createHint({ document, window });

/**
 * Touch devices get a Bubble next to the finished Selection instead of relying
 * on double-click. Desktop gets a no-op stand-in so the rest of the code does
 * not have to branch — and so no Bubble host is added to a desktop page.
 */
let pendingSelection = null;

const bubble = touchPrimary
  ? createBubble({
      document,
      window,
      onTap: (rect) => {
        const term = pendingSelection;
        pendingSelection = null;
        lookupTerm(term, rect);
      },
    })
  : { show() {}, reposition() {}, hide() {} };

const gloss = createGlossLayer({ document, window, translationMap: new Map() });

const panel = createPanel({
  document,
  settings,
  book,
  host,
  onGlossChange: () => applyGlossSetting(),
  onClearCache: () => cache.clear(),
  onLookupToggle: () => {
    // Turning lookup off must also take the Bubble away.
    if (!settings.lookupEnabled) {
      bubble.hide();
      pendingSelection = null;
    }
  },
  lookupSwitchLabel: touchPrimary ? '选词后点「译」查询' : '双击取词',
  onThemeChange: () => applyTheme(),
  touch: touchPrimary,
});

/**
 * Paint every floating surface for the current theme.
 *
 * The palette lives on each shadow host rather than inside the shadow roots so
 * one theme decision reaches all three surfaces, including the Bubble, which
 * has no other reason to know about settings.
 */
function applyTheme() {
  const theme = resolveTheme({
    setting: settings.theme,
    prefersDark: prefersDarkQuery()?.matches ?? false,
  });
  for (const surface of [popup, bubble, panel]) {
    if (surface?.host) applyPalette(surface.host, theme);
  }
}

let darkQuery;
let darkQueryResolved = false;

/** The OS preference query, looked up once; absent in environments without matchMedia. */
function prefersDarkQuery() {
  if (darkQueryResolved) return darkQuery;
  darkQueryResolved = true;
  try {
    darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? undefined;
  } catch {
    darkQuery = undefined;
  }
  return darkQuery;
}

applyTheme();
// The OS can flip while the page is open; the surfaces follow without a reload.
// Older Safari only has addListener, hence the two spellings.
const darkMedia = prefersDarkQuery();
if (darkMedia?.addEventListener) darkMedia.addEventListener('change', applyTheme);
else darkMedia?.addListener?.(applyTheme);

const flow = createLookupFlow({
  popup,
  translator: (args) => translator(args),
  book,
  pageLanguage: detectPageLang,
  dictionary,
  speak: (term, lang, audioUrl) => pronouncer.play(term, lang, audioUrl),
  settings: () => settings,
  host,
});

/** The system voice, used when there is no recording or it could not play. */
function speakText(term, lang) {
  try {
    const utterance = new SpeechSynthesisUtterance(term);
    if (lang && lang !== 'auto') utterance.lang = lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    /* speech synthesis is optional */
  }
}

/** Pronunciation, with the browser's four audio effects supplied here. */
const pronouncer = createPronouncer({
  fetchBlob,
  createAudio: (url) => new Audio(url),
  objectUrls: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  speakText,
});

/** Anchor rect for the Popup; Range.getBoundingClientRect is missing in some engines. */
function anchorOf(range) {
  if (!range) return null;
  try {
    if (typeof range.getBoundingClientRect === 'function') {
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    }
    const rects = range.getClientRects?.();
    if (rects && rects.length > 0) return rects[0];
    const container = range.commonAncestorContainer;
    const element = container?.nodeType === 1 ? container : container?.parentElement;
    return element?.getBoundingClientRect?.() ?? null;
  } catch {
    return null;
  }
}

/** Double-click handler, installed only when lookup is enabled. */
function onDoubleClick(event) {
  if (!settings.lookupEnabled) return;
  if (event.target?.closest?.('[data-tm]')) return;
  const selection = window.getSelection();
  const read = flow.readSelection(selection);
  if (read.status === 'empty') return;
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  // A browser that does fire dblclick on touch has already answered via the
  // Popup, so the Bubble must not linger over it.
  bubble.hide();
  pendingSelection = null;
  // An oversized Selection is the one case that would otherwise look like a
  // dead script, so it gets words instead of silence.
  if (read.status === 'too-long') {
    hint.show(anchorOf(range));
    return;
  }
  hint.hide();
  flow.lookup({ term: read.text, anchor: anchorOf(range) });
}

/** Start a lookup for `term`, ignoring empty input. */
function lookupTerm(term, anchor) {
  if (!term) return;
  hint.hide();
  if (touchPrimary) {
    // Drop the native highlight: on a phone it covers the words around the one
    // being looked up, and its drag handles sit on top of the Popup.
    window.getSelection()?.removeAllRanges?.();
  }
  flow.lookup({ term, anchor });
}

/** Anchor of the current Selection, for the Bubble and the Popup. */
function currentAnchor() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return anchorOf(selection.getRangeAt(0));
}

/**
 * Touch path: offer the Bubble once a Selection settles.
 *
 * `selectionchange` fires continuously while the user drags the selection
 * handles, so it is debounced until the gesture stops. Called on both
 * `selectionchange` and `touchend` (iOS sometimes settles the selection after
 * the finger lifts, and the debounce swallows the duplicate).
 */
let selectionTimer = null;
/** Set when a tap just dismissed the Popup, so the Bubble does not bounce back. */
let dismissedAt = 0;

function evaluateSelection() {
  if (!settings.lookupEnabled) {
    bubble.hide();
    return;
  }
  /*
   * A tap outside the Popup closes it. Mobile browsers often leave the
   * Selection in place after such a tap, so the very same selection would pop
   * the Bubble back up 60ms later — the user's "dismiss" would look broken.
   */
  if (Date.now() - dismissedAt < 500) {
    bubble.hide();
    pendingSelection = null;
    return;
  }
  const selection = window.getSelection();
  const ownUi = isOwnSelection(selection);
  // Selecting text inside the Popup or Panel is not a lookup; the chain has to
  // be followed through the shadow root to notice it.
  if (!shouldOfferBubble({ selection, isOwnUi: ownUi })) {
    /*
     * An oversized Selection is the one refusal worth explaining: a phone has
     * no other way to tell the user why no bubble appeared. Selections in our
     * own UI and in text fields stay silent, since the user is not asking to
     * translate anything there.
     */
    const text = selectionTerm(selection);
    if (text.length > MAX_BUBBLE_CHARS && !ownUi && !isEditableSelection(selection)) {
      hint.show(currentAnchor());
    }
    // The user collapsed or replaced the selection: the Bubble is stale now.
    bubble.hide();
    pendingSelection = null;
    return;
  }
  const text = selectionTerm(selection);
  // Some mobile browsers do fire dblclick (Chrome, when double-tap zoom is
  // off). The Popup already answering for this word makes the Bubble noise.
  // The Popup holds a word's normalized form, so both spellings are compared.
  if (popup.current && (popup.current.term === text || popup.current.term === normalizeTerm(text))) {
    bubble.hide();
    pendingSelection = null;
    return;
  }
  // A fresh selection supersedes whatever the Popup was showing.
  if (popup.current) popup.hide();

  // The Bubble replaces the "too long" label: keeping both would leave a stale
  // message hovering over the new selection for the rest of its two seconds.
  hint.hide();
  pendingSelection = text;
  bubble.show(currentAnchor());
}

function onSelectionChange() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(evaluateSelection, 250);
}

/**
 * Scrolling moves the page under UI that is fixed to the screen.
 *
 * On touch, the Bubble follows its Selection and only goes away once the
 * Selection has left the viewport entirely; the Popup closes, because it would
 * otherwise float over words it no longer describes. On desktop the Popup was
 * opened deliberately and stays exactly where it is -- a reader scrolling a
 * long sentence wants to keep the translation beside it.
 */
let scrollFrame = false;

function onScroll() {
  if (!touchPrimary) return;
  popup.hide();
  if (!pendingSelection) {
    bubble.hide();
    return;
  }
  // A scroll fires far more often than the screen refreshes, and each frame
  // costs a rect read, so the work is capped at one reposition per frame.
  if (scrollFrame) return;
  scrollFrame = true;
  const nextFrame = window.requestAnimationFrame ?? ((fn) => window.setTimeout(fn, 16));
  nextFrame(() => {
    scrollFrame = false;
    followSelection();
  });
}

function followSelection() {
  if (!pendingSelection) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    bubble.hide();
    return;
  }
  const rect = anchorOf(selection.getRangeAt(0));
  if (!isRectVisible(rect, viewportBox())) {
    bubble.hide();
    return;
  }
  bubble.reposition(rect);
}

/** The visible part of the window, which on a phone is the visual viewport. */
function viewportBox() {
  const viewport = window.visualViewport;
  return {
    width: Math.min(window.innerWidth || Infinity, viewport?.width ?? Infinity),
    height: Math.min(window.innerHeight || Infinity, viewport?.height ?? Infinity),
  };
}

/** Where the finger went down, so a drag can be told apart from a tap. */
let touchOrigin = null;

function onTouchStart(event) {
  const touch = event.touches?.[0];
  touchOrigin = touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function onTouchEnd(event) {
  const touch = event.changedTouches?.[0];
  const moved =
    touchOrigin && touch
      ? Math.hypot(touch.clientX - touchOrigin.x, touch.clientY - touchOrigin.y) > 12
      : false;
  touchOrigin = null;
  // A drag is a scroll or a selection-handle move; both end with their own
  // `selectionchange`, so nothing needs deciding here.
  if (moved) return;
  // Taps on our own UI (the Bubble, the Popup, the Panel) are that UI's
  // business. Touch events are composed, so at document level their target is
  // retargeted to the shadow host, which carries the marker.
  if (event.target?.closest?.('[data-tm]')) return;

  // A tap elsewhere dismisses the Popup, as a click does on desktop.
  if (popup.current) {
    popup.hide();
    dismissedAt = Date.now();
  }
  // The selection is finalised right after touchend, not during it.
  setTimeout(evaluateSelection, 60);
}

/**
 * Close the popup on the next click elsewhere, and on Escape.
 *
 * This listener is on `document` in the capture phase, so it runs before any
 * listener inside our own UI can stop the event. A tap on the Bubble therefore
 * arrives here first: our own UI must be matched by marker, not by containment,
 * or opening the Popup would close it in the same gesture.
 */
function onDocumentClick(event) {
  if (!popup.current) return;
  if (event.target?.closest?.('[data-tm]')) return;
  if (popup.contains(event.target)) return;
  popup.hide();
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    popup.hide();
    panel.close();
  }
}

function start() {
  document.addEventListener('dblclick', onDoubleClick, true);
  document.addEventListener('mousedown', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  if (touchPrimary) {
    document.addEventListener('selectionchange', onSelectionChange, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, true);
    // Scrolling moves the Selection under the Bubble, which is fixed to the
    // screen, so it follows rather than disappearing.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  }

  applyGlossSetting();

  refreshMenu();
}

let unregisterMenu = [];

/** (Re)register the menu entries; the gloss label follows the current state. */
function refreshMenu() {
  // GM_registerMenuCommand returns an unregister callback only in some
  // managers/versions, so the return value is treated as optional.
  for (const unregister of unregisterMenu) {
    if (typeof unregister === 'function') unregister();
  }
  unregisterMenu = [];
  const register = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null;
  if (!register) return;
  unregisterMenu.push(register('打开生词本 / 设置', () => panel.open()));
  unregisterMenu.push(
    register(settings.glossOn(host) ? '关闭本站注音' : '开启本站注音', () => {
      settings.setGlossOn(host, !settings.glossOn(host));
      applyGlossSetting();
      refreshMenu();
    }),
  );
}

start();
