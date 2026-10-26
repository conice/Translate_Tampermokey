/**
 * Entry point: wires the modules to this page.
 *
 * Deliberately small — everything with behaviour worth testing lives in
 * core/ (pure) or app/ (injected DOM), so this file is only glue.
 */
import { pageLanguage, resolveTarget } from './core/lang.js';
import { dictionaryDev, freedictionary, createTranslator } from './core/providers.js';
import { createSettings, createBook, createLookupCache, createGmStorage } from './app/storage.js';
import { createLookupFlow, addEntry } from './app/lookup-flow.js';
import { createPopup } from './ui/popup.js';
import { createGlossLayer } from './ui/gloss-layer.js';
import { createPanel } from './ui/panel.js';

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

/** Userscript-manager-native HTTP, which bypasses page CSP and CORS. */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('GM_xmlhttpRequest unavailable'));
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 12000,
      onload(response) {
        if (response.status >= 200 && response.status < 300) resolve(response.responseText);
        else reject(new Error(`HTTP ${response.status}`));
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}

const settings = createSettings(createGmStorage('settings', gm));
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

const popup = createPopup({
  document,
  onAdd: async (entry) => {
    if (!entry) return;
    addEntry(book, entry, () => refreshGlosses());
  },
  onSpeak: (term, lang) => speak(term, lang),
  onClose: () => {},
});

const gloss = createGlossLayer({ document, window, translationMap: new Map() });

const panel = createPanel({
  document,
  settings,
  book,
  host,
  onGlossChange: () => applyGlossSetting(),
  onClearCache: () => cache.clear(),
  onLookupToggle: () => {},
});

const flow = createLookupFlow({
  popup,
  translator: (args) => translator(args),
  book,
  pageLanguage: detectPageLang,
  dictionary,
  speak,
  settings: () => settings,
  host,
});

function speak(term, lang) {
  try {
    const utterance = new SpeechSynthesisUtterance(term);
    if (lang && lang !== 'auto') utterance.lang = lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    /* speech synthesis is optional */
  }
}

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
  const term = flow.readSelection(selection);
  if (!term) return;
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  flow.lookup({ term, anchor: anchorOf(range) });
}

/** Close the popup on the next click elsewhere, and on Escape. */
function onDocumentClick(event) {
  if (!popup.current) return;
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
