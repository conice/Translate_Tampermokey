// ==UserScript==
// @name         Translate Tampermokey
// @namespace    https://github.com/local/translate-tampermokey
// @version      0.6.0
// @description  选词弹窗翻译(桌面双击 / 触屏选词后点「译」),收藏进生词本,生词本词条以注音形式常驻原文右侧
// @author       local
// @match        *://*/*
// @exclude      *://localhost/*
// @exclude      *://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      clients5.google.com
// @connect      api.mymemory.translated.net
// @connect      lingva.ml
// @connect      api.dictionaryapi.dev
// @connect      freedictionaryapi.com
// @connect      dict.youdao.com
// @connect      cn.bing.com
// @connect      dict.eudic.net
// @connect      krdict.korean.go.kr
// @connect      krdicmedia.korean.go.kr
// @run-at       document-idle
// @noframes
// ==/UserScript==


(function () {
  'use strict';

let __mod_core_normalize;
let __mod_core_lang;
let __mod_core_cache;
let __mod_core_providers;
let __mod_core_dictionaries;
let __mod_core_csv;
let __mod_core_store;
let __mod_core_theme;
let __mod_app_storage;
let __mod_app_lookup_flow;
let __mod_app_pronunciation;
let __mod_core_gesture;
let __mod_ui_popup;
let __mod_ui_bubble;
let __mod_ui_hint;
let __mod_app_clipboard;
let __mod_core_gloss;
let __mod_ui_gloss_layer;
let __mod_app_file_io;
let __mod_ui_panel;
let __mod_ui_palette;
let __mod_main;

// ---- src/core/normalize.js ----
__mod_core_normalize = (function () {

const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * Reduce a piece of selected text to the identity used for a vocabulary Entry.
 * Trims, collapses internal whitespace, strips leading/trailing punctuation,
 * and lowercases. Internal hyphens and apostrophes survive, so "don't" and
 * "well-known" stay as written.
 */
function normalizeTerm(raw) {
  if (typeof raw !== 'string') return '';
  let term = raw.replace(/\s+/gu, ' ').trim();
  term = term.replace(EDGE_PUNCT, '');
  return term.toLowerCase();
}

/**
 * Tidy selected text that is being looked up as a sentence rather than a word.
 *
 * Only whitespace is touched: runs of spaces and tabs collapse, each line keeps
 * its own break, and leading/trailing blank lines go. Case and punctuation are
 * the sentence — lowercasing it would turn the translation into a run-on line
 * that no longer reads like what the reader selected.
 */
function normalizeSentence(raw) {
  if (typeof raw !== 'string') return '';
  const lines = raw
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

const SCRIPT_PATTERNS = [
  ['kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['latin', /\p{Script=Latin}/u],
];

/**
 * Classify which writing system a term belongs to. Kana wins over Han so mixed
 * Japanese text reports as kana rather than as a Chinese word.
 */
function scriptOf(text) {
  const counts = SCRIPT_PATTERNS.map(([name, pattern]) => {
    let count = 0;
    for (const char of String(text ?? '')) {
      if (pattern.test(char)) count += 1;
    }
    return { name, count };
  });
  let best = null;
  for (const candidate of counts) {
    if (candidate.count === 0) continue;
    if (best === null || candidate.count > best.count) best = candidate;
  }
  return best ? best.name : 'none';
}

/** True when the writing system is one of the CJK scripts. */
function isCjk(text) {
  const script = scriptOf(text);
  return script === 'han' || script === 'kana' || script === 'hangul';
}

/** Number of whitespace-separated words; a run of CJK counts as one. */
function countWords(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

/** Longest term, in words and in characters, an Entry may hold. */
const MAX_ENTRY_WORDS = 5;
const MAX_ENTRY_CHARS = 40;

/** A selection may be looked up (any length) but only short ones can be saved. */
function canBecomeEntry(term) {
  return term.length > 0 && term.length <= MAX_ENTRY_CHARS && countWords(term) <= MAX_ENTRY_WORDS;
}

  return {
    normalizeTerm,
    normalizeSentence,
    scriptOf,
    isCjk,
    countWords,
    MAX_ENTRY_WORDS,
    MAX_ENTRY_CHARS,
    canBecomeEntry,
  };
})();

// ---- src/core/lang.js ----
__mod_core_lang = (function () {
const { scriptOf } = __mod_core_normalize;
/** 'zh-CN' -> 'zh', 'EN-us' -> 'en', undefined -> ''. */
function normalizeLangTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

/**
 * Chinese names for the language codes the UI can meet. One table serves both
 * the Popup's Target Language menu and the Book's group headings, so a
 * language is never called two different things in two places.
 */
const LANGUAGE_NAMES = {
  en: '英语',
  zh: '中文',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
};

/** The order language groups are listed in; languages outside it come after, alphabetically. */
const LANGUAGE_ORDER = Object.keys(LANGUAGE_NAMES);

/**
 * 'en-US' -> '英语'. A code with no name of its own is shown as it is, which is
 * still more useful than calling it unknown; only a missing code says 未知语言.
 */
function languageLabel(tag) {
  const base = normalizeLangTag(tag);
  if (!base) return '未知语言';
  return LANGUAGE_NAMES[base] ?? base;
}

/**
 * The Page Language: the language of the page's main body text.
 * The document's lang attribute wins; only when it is missing do we sample
 * text and guess from the writing system.
 */
function pageLanguage(langAttr, sampleText = '') {
  const fromAttr = normalizeLangTag(langAttr);
  if (fromAttr) return fromAttr;
  return detectFromText(sampleText);
}

/** Guess a language code from a text sample. Defaults to English. */
function detectFromText(sample) {
  let cjk = 0;
  let latin = 0;
  for (const char of String(sample ?? '')) {
    const script = scriptOf(char);
    if (script === 'han' || script === 'kana' || script === 'hangul') cjk += 1;
    else if (script === 'latin' || script === 'cyrillic') latin += 1;
  }
  if (cjk === 0 && latin === 0) return 'en';
  return cjk > latin ? 'zh' : 'en';
}

/** 'ZH_cn' -> 'zh-CN': the language lowercased, a two-letter region uppercased. */
function canonicalLangTag(tag) {
  const [language, ...rest] = tag.split('-');
  return [language.toLowerCase(), ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part))].join('-');
}

/**
 * The Target Language for a lookup.
 *
 * A per-site override wins, unless it would translate a language into itself.
 * The override keeps its region tag (`zh-CN` stays `zh-CN`): an explicit
 * Chinese choice must match the tag the default rule and saved entries use,
 * or the same language would silently stop matching its own glosses.
 * Otherwise: a Chinese page translates into English, a non-Chinese page into
 * Chinese — including the case of a Chinese selection sitting on a
 * non-Chinese page, where Chinese would be a no-op.
 */
function resolveTarget({ pageLang, sourceLang, override } = {}) {
  const page = normalizeLangTag(pageLang);
  const source = normalizeLangTag(sourceLang);
  const overrideTag =
    typeof override === 'string'
      ? canonicalLangTag(override.trim().replace(/_/gu, '-'))
      : '';
  const forced = normalizeLangTag(overrideTag);
  if (forced && forced !== source) return overrideTag;
  if (page === 'zh') return 'en';
  if (source === 'zh') return 'en';
  return 'zh-CN';
}

  return {
    normalizeLangTag,
    LANGUAGE_NAMES,
    LANGUAGE_ORDER,
    languageLabel,
    pageLanguage,
    detectFromText,
    resolveTarget,
  };
})();

// ---- src/core/cache.js ----
__mod_core_cache = (function () {

const TTL_SUCCESS_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_FAILURE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Identifies one lookup. Deliberately provider-independent: the chain must be
 * able to swap sources without invalidating everything the user has seen.
 */
function cacheKey({ source, target, text }) {
  return `${source}|${target}|${text}`;
}

/**
 * Lookup cache backed by a pair of storage callbacks, so the same code runs
 * against GM storage in the browser and a Map in tests.
 *
 * Failures are cached too, with a much shorter TTL: without that, a provider
 * that is down gets retried once per word per inline-gloss pass, which can be
 * thousands of requests a minute.
 *
 * Bounded by `max`, evicting least-recently-used entries, so the store cannot
 * grow without limit as the user browses.
 */
function createCache({ storage, now = Date.now, max = MAX_ENTRIES }) {
  const records = new Map();

  for (const [key, record] of storage.read()) {
    if (record && typeof record === 'object' && typeof record.expires === 'number') {
      records.set(key, record);
    }
  }

  function prune(now_) {
    for (const [key, record] of records) {
      if (record.expires <= now_) records.delete(key);
    }
  }

  function persist() {
    storage.write([...records.entries()]);
  }

  return {
    get(key) {
      const record = records.get(key);
      if (!record) return undefined;
      const timestamp = now();
      if (record.expires <= timestamp) {
        records.delete(key);
        persist();
        return undefined;
      }
      record.used = timestamp;
      return record.value;
    },

    set(key, value, { ok = true } = {}) {
      const timestamp = now();
      records.set(key, {
        value,
        expires: timestamp + (ok ? TTL_SUCCESS_MS : TTL_FAILURE_MS),
        used: timestamp,
      });
      prune(timestamp);
      if (records.size > max) {
        const oldest = [...records.entries()].sort((a, b) => a[1].used - b[1].used);
        for (const [key_] of oldest.slice(0, records.size - max)) records.delete(key_);
      }
      persist();
    },

    clear() {
      records.clear();
      persist();
    },

    get size() {
      return records.size;
    },
  };
}

  return {
    TTL_SUCCESS_MS,
    TTL_FAILURE_MS,
    MAX_ENTRIES,
    cacheKey,
    createCache,
  };
})();

// ---- src/core/providers.js ----
__mod_core_providers = (function () {
const { cacheKey } = __mod_core_cache;
class ProviderError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Google's `dict-chrome-ex` endpoint. Undocumented and not offered for
 * third-party use: it can rate-limit or block at any time with no notice
 * (the sibling `translate_a/single?client=gtx` endpoint already answers 429).
 * It is first in the chain only because it is the one source that translates
 * arbitrary languages *and* batches, which the inline-gloss pass depends on.
 *
 * Batch shape is `q=a&q=b&q=c`; with `sl=auto` each reply is
 * `[translation, detectedSource]`, without it a bare translation string.
 */
const clients5 = {
  id: 'clients5',
  maxBatch: 50,
  request({ text, source, target }) {
    const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: source, tl: target });
    const items = Array.isArray(text) ? text : [text];
    for (const item of items) params.append('q', item);
    return `https://clients5.google.com/translate_a/t?${params.toString()}`;
  },
  parse(body, { text }) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('clients5: response was not JSON');
    }
    const items = Array.isArray(text) ? text : [text];
    if (!Array.isArray(data) || data.length !== items.length) {
      throw new ProviderError('clients5: unexpected response shape');
    }
    return data.map((row) => {
      if (Array.isArray(row)) {
        if (typeof row[0] !== 'string') throw new ProviderError('clients5: malformed item');
        return { translation: row[0], detectedSource: row[1] };
      }
      if (typeof row !== 'string') throw new ProviderError('clients5: malformed item');
      return { translation: row, detectedSource: undefined };
    });
  },
};

/**
 * Lingva, a self-hostable Google Translate front end. Batches by joining with
 * newlines and only accepts two-letter language codes (`zh-CN` is a 400).
 *
 * Operational caveat measured on 2026-10-26: the public instance answers 200
 * for every request but echoes the input back untranslated. It is kept as a
 * fallback because the protocol is right and a self-hosted instance works;
 * `translate()` prefers MyMemory before it for this reason.
 */
const lingva = {
  id: 'lingva',
  maxBatch: 1,
  request({ text, source, target }) {
    const items = Array.isArray(text) ? text : [text];
    const joined = items.join('\n');
    const targetCode = target.split('-')[0];
    return `https://lingva.ml/api/v1/${source}/${targetCode}/${encodeURIComponent(joined)}`;
  },
  parse(body, { text }) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('lingva: response was not JSON');
    }
    if (typeof data?.translation !== 'string') {
      throw new ProviderError(data?.error ? `lingva: ${data.error}` : 'lingva: unexpected response shape');
    }
    const items = Array.isArray(text) ? text : [text];
    const result = { translation: data.translation, detectedSource: data.info?.detectedSource };
    // One request answered several items: split them back apart.
    if (items.length > 1) result.parts = data.translation.split('\n');
    return [result];
  },
};

/**
 * MyMemory. Only reliable for lookup, not for inline-gloss batching: it has no
 * batch parameter and rejects `autodetect`, so every call needs a known source
 * language. Its anonymous quota is small.
 */
const mymemory = {
  id: 'mymemory',
  maxBatch: 1,
  request({ text, source, target }) {
    const items = Array.isArray(text) ? text : [text];
    const sourceCode = source === 'auto' || !source ? 'en' : source;
    const params = new URLSearchParams({ q: items[0] ?? '', langpair: `${sourceCode}|${target}` });
    return `https://api.mymemory.translated.net/get?${params.toString()}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('mymemory: response was not JSON');
    }
    const status = Number(data?.responseStatus);
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== 'string' || (status && status !== 200)) {
      throw new ProviderError(`mymemory: ${data?.responseDetails || 'unexpected response'}`);
    }
    return [{ translation: translated, detectedSource: undefined }];
  },
};

/**
 * Pick one pronunciation recording from a dictionary's `phonetics` list.
 *
 * A word can carry several regions at once and the list order is not
 * meaningful, so an American recording is preferred by name rather than by
 * position; British is the fallback, then whatever else exists. A
 * protocol-relative URL is resolved to https so it can be requested directly.
 */
function chooseAudio(phonetics) {
  const recorded = (Array.isArray(phonetics) ? phonetics : [])
    .map((entry) => entry?.audio)
    .filter((url) => typeof url === 'string' && url.length > 0);
  if (recorded.length === 0) return undefined;
  const preferred =
    recorded.find((url) => /[-_]us\./iu.test(url)) ??
    recorded.find((url) => /[-_]uk\./iu.test(url)) ??
    recorded[0];
  return preferred.startsWith('//') ? `https:${preferred}` : preferred;
}

/**
 * English dictionary: IPA, audio, part of speech, first definition.
 * Lookup only, so it never participates in the failover chain; it is fetched
 * in parallel with the translation and its absence is not an error.
 */
const dictionaryDev = {
  id: 'dictionaryapi',
  request({ word }) {
    return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const entry = data[0];
    const phonetic = entry.phonetics?.find((p) => p.text)?.text;
    const audio = chooseAudio(entry.phonetics);
    const meanings = [];
    for (const meaning of entry.meanings ?? []) {
      const definition = meaning.definitions?.[0]?.definition;
      if (meaning.partOfSpeech && definition) {
        meanings.push({ pos: meaning.partOfSpeech, definition });
      }
      if (meanings.length === 3) break;
    }
    return { phonetic, audio, meanings };
  },
};

const DEFAULT_PROVIDERS = [clients5, mymemory, lingva];

/**
 * Wiktionary-derived dictionary, the only free source that states what word a
 * form belongs to ("simple past of run"). Used only to offer "save the base
 * form instead"; it never rewrites what the user saved.
 */
const freedictionary = {
  id: 'freedictionary',
  request({ word }) {
    return `https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`;
  },
  /** Returns the base form when this word is inflected, else undefined. */
  parseLemma(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    // `data.entries` is a function on an array, hence the explicit check.
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    for (const entry of entries) {
      for (const sense of entry.senses ?? []) {
        if (!(sense.tags ?? []).includes('form of')) continue;
        const match = /^(?:[a-z]+\s+)*of\s+([a-z'-]+)(?:\s+and\s+[a-z'-]+)?$/iu.exec(
          String(sense.definition ?? '').trim(),
        );
        if (match) return match[1].toLowerCase();
      }
    }
    return undefined;
  },
};

/**
 * Translate one or more texts, failing over across providers.
 *
 * The chain is tried in order and the first provider that returns a usable
 * answer wins the whole call: partial results are not mixed between sources,
 * because that would make the cache and the glosses inconsistent. Text
 * already in the cache is not re-requested.
 */
function createTranslator({
  providers = DEFAULT_PROVIDERS,
  fetchText,
  cache,
  batchSize,
  onProviderError = () => {},
}) {
  return async function translate({ text, source = 'auto', target }) {
    const items = (Array.isArray(text) ? text : [text]).filter((t) => typeof t === 'string' && t.length > 0);
    if (items.length === 0) return [];

    const results = new Array(items.length);
    const missing = [];

    items.forEach((item, index) => {
      if (!cache) {
        missing.push(index);
        return;
      }
      const cached = cache.get(cacheKey({ source, target, text: item }));
      if (cached) results[index] = cached;
      else missing.push(index);
    });

    if (missing.length === 0) return results;

    const texts = missing.map((i) => items[i]);
    let lastError;
    let answer = null;

    for (const provider of providers) {
      const chunks = chunk(texts, Math.min(batchSize ?? provider.maxBatch, provider.maxBatch));
      try {
        const collected = [];
        for (const chunkTexts of chunks) {
          const url = provider.request({ text: chunkTexts, source, target });
          const body = await fetchText(url);
          const parsed = provider.parse(body, { text: chunkTexts });
          for (const chunkItem of expand(parsed, chunkTexts)) {
            collected.push({ ...chunkItem, provider: provider.id });
          }
        }
        answer = collected;
        break;
      } catch (error) {
        lastError = error;
        onProviderError(provider.id, error);
      }
    }

    if (!answer) {
      const failure = lastError ?? new ProviderError('no provider available');
      for (const index of missing) {
        if (cache) cache.set(cacheKey({ source, target, text: items[index] }), { error: failure.message }, { ok: false });
      }
      throw failure;
    }

    answer.forEach((item, i) => {
      const original = texts[i];
      results[missing[i]] = item;
      if (cache && original !== undefined) {
        cache.set(cacheKey({ source, target, text: original }), item, { ok: true });
      }
    });

    return results;
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Turn a provider's one-or-many parse output into exactly one item per input. */
function expand(parsed, texts) {
  if (parsed.length === texts.length) return parsed;
  if (parsed.length === 1 && Array.isArray(parsed[0].parts) && parsed[0].parts.length === texts.length) {
    return parsed[0].parts.map((part) => ({
      translation: part,
      detectedSource: parsed[0].detectedSource,
    }));
  }
  if (parsed.length === 1 && texts.length === 1) return parsed;
  throw new ProviderError('provider returned a mismatched number of results');
}

  return {
    ProviderError,
    clients5,
    lingva,
    mymemory,
    chooseAudio,
    dictionaryDev,
    DEFAULT_PROVIDERS,
    freedictionary,
    createTranslator,
  };
})();

// ---- src/core/dictionaries.js ----
__mod_core_dictionaries = (function () {
const { normalizeLangTag } = __mod_core_lang;
const { dictionaryDev } = __mod_core_providers;
/**
 * Dictionary Sources: phonetic, audio and meanings for one word.
 *
 * A Dictionary Source is deliberately separate from a translation Provider
 * (see ADR-0010). Translation must keep working even when a dictionary page
 * changes shape; every parser here returns `undefined` rather than throwing
 * when it cannot recognize the answer.
 *
 * Each source declares the one Source Language it serves. A word is only sent
 * to a dictionary written for its language: an English word to an English-
 * Chinese dictionary, a Korean word to the Korean-Chinese one. Sending `run`
 * to a Korean dictionary would spend a request and get an empty page back.
 *
 * Shapes, as measured on 2026-10-27:
 * - Youdao answers the undocumented `jsonapi` endpoint as JSON.
 * - Microsoft and Eudic have no public JSON endpoint; their web pages are
 *   parsed. Both pages are large and their markup can change without notice.
 * - krdict has no public JSON endpoint without a key either; its Chinese
 *   search page is parsed, and only exact headword matches are used.
 */



/** How much of one part-of-speech definition the Popup shows. */
const MEANING_CHARS = 100;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function codePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_full, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_full, decimal) => codePoint(Number(decimal)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_full, name) => NAMED_ENTITIES[name]);
}

/** HTML fragment -> readable text. Tags are markup here, not content. */
function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/giu, ' ')
      .replace(/<[^>]*>/gu, ''),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Dictionary sites list every sense of a word in one run. A popup that shows
 * the whole of `run`'s verb entry would cover the screen, so each part of
 * speech keeps whole semicolon-separated senses up to a readable length.
 */
function clipDefinition(text, limit = MEANING_CHARS) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (clean.length <= limit) return clean;
  const parts = clean.split(/[；;]/u);
  let out = '';
  for (const part of parts) {
    const next = out ? `${out}；${part}` : part;
    if (out && next.length > limit) break;
    out = next;
    if (out.length >= limit) break;
  }
  if (out.length > limit) out = out.slice(0, limit);
  return `${out.replace(/[；;]\s*$/u, '')}…`;
}

function normalizePhonetic(text) {
  const value = stripTags(text);
  if (!value) return undefined;
  return /^[/[].*[/\]]$/u.test(value) ? value : `/${value}/`;
}

function youdaoSpeech(speech) {
  if (typeof speech !== 'string' || !speech.trim()) return undefined;
  const [audio, query = ''] = speech.split('&');
  const type = new URLSearchParams(query).get('type') ?? '2';
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(audio)}&type=${encodeURIComponent(type)}`;
}

/** "v. 跑，奔跑；…" -> `{ pos: 'v.', definition: '跑，奔跑；…' }`. */
function splitYoudaoMeaning(text) {
  const clean = decodeEntities(String(text ?? ''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return undefined;
  const cn = /^【([^】]+)】\s*(.*)$/u.exec(clean);
  if (cn) return { pos: cn[1].trim(), definition: cn[2].trim() };
  const latin = /^([A-Za-z][A-Za-z.&/\s]{0,20}?)\s+([\s\S]+)$/u.exec(clean);
  if (latin) return { pos: latin[1].trim(), definition: latin[2].trim() };
  return { pos: '', definition: clean };
}

/**
 * Youdao. `dicts` asks for the English-Chinese and pronunciation sections
 * only: the unrestricted answer for `run` is ~500 KB, this one ~2 KB.
 */
const youdao = {
  id: 'youdao',
  label: '有道词典',
  lang: 'en',
  request({ word }) {
    const dicts = encodeURIComponent(JSON.stringify({ count: 1, dicts: [['ec'], ['simple']] }));
    return `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}&dicts=${dicts}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!data || typeof data !== 'object') return undefined;

    const ecWord = data.ec?.word?.[0];
    const simpleWord = data.simple?.word?.[0];
    if (!ecWord && !simpleWord) return undefined;

    const phonetic = normalizePhonetic(
      ecWord?.usphone ?? simpleWord?.usphone ?? ecWord?.ukphone ?? simpleWord?.ukphone,
    );
    const audio = youdaoSpeech(
      ecWord?.usspeech ?? simpleWord?.usspeech ?? ecWord?.ukspeech ?? simpleWord?.ukspeech,
    );

    const meanings = [];
    outer: for (const group of ecWord?.trs ?? []) {
      for (const tr of group.tr ?? []) {
        const raw = tr.l?.i;
        const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        for (const item of items) {
          const parsed = splitYoudaoMeaning(item);
          if (!parsed?.definition) continue;
          meanings.push({ pos: parsed.pos, definition: clipDefinition(parsed.definition) });
          if (meanings.length >= 3) break outer;
        }
      }
    }

    const lemma = typeof ecWord?.prototype === 'string' ? ecWord.prototype : undefined;
    if (!phonetic && !audio && meanings.length === 0 && !lemma) return undefined;
    return { phonetic, audio, meanings, lemma };
  },
};

/** `美 [rʌn]` -> `/rʌn/`; an entry with no bracket has no phonetic to show. */
function bingPhonetic(text) {
  const value = stripTags(text);
  if (!value) return undefined;
  const bracket = /\[([^\]]+)\]/u.exec(value);
  if (bracket) return `/${bracket[1].trim()}/`;
  const slashed = /\/([^/]+)\//u.exec(value);
  return slashed ? slashed[0] : undefined;
}

function bingAudio(html) {
  const tag =
    /<a\b[^>]*\bid=["']bigaud_us["'][^>]*>/iu.exec(html)?.[0] ??
    /<a\b[^>]*\bid=["']bigaud_uk["'][^>]*>/iu.exec(html)?.[0];
  if (!tag) return undefined;
  const link = /data-mp3link=["']([^"']+)["']/iu.exec(tag)?.[1];
  if (!link) return undefined;
  const decoded = decodeEntities(link);
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('/')) return `https://cn.bing.com${decoded}`;
  return decoded;
}

/**
 * Microsoft's dictionary, served as the Bing dictionary page. There is no
 * public JSON endpoint; `qdef` is the block the page itself calls the
 * definition area.
 */
const microsoft = {
  id: 'microsoft',
  label: '微软词典',
  lang: 'en',
  request({ word }) {
    return `https://cn.bing.com/dict/search?q=${encodeURIComponent(word)}`;
  },
  parse(html) {
    if (typeof html !== 'string' || !/<div[^>]*class="[^"]*\bqdef\b[^"]*"/iu.test(html)) {
      return undefined;
    }

    const phonetic =
      bingPhonetic(
        /<div[^>]*class="[^"]*\bhd_prUS\b[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1],
      ) ??
      bingPhonetic(
        /<div[^>]*class="[^"]*\bhd_pr\b[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1],
      );
    const audio = bingAudio(html);

    const meanings = [];
    for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
      const li = match[1];
      const def = /<span[^>]*class="[^"]*\bdef\b[^"]*"[^>]*>([\s\S]*)<\/span>/iu.exec(li)?.[1];
      if (!def) continue;
      const definition = stripTags(def);
      if (!definition) continue;
      const pos = /<span[^>]*class="[^"]*\bpos\b[^"]*"[^>]*>([\s\S]*?)<\/span>/iu.exec(li)?.[1];
      meanings.push({
        pos: pos ? stripTags(pos) : '',
        definition: clipDefinition(definition),
      });
      if (meanings.length >= 3) break;
    }

    if (!phonetic && !audio && meanings.length === 0) return undefined;
    return { phonetic, audio, meanings };
  },
};

function classTokens(attributes) {
  const raw = /class\s*=\s*["']([^"']*)["']/iu.exec(attributes)?.[1] ?? '';
  return raw.split(/\s+/u).filter(Boolean);
}

function hasClass(attributes, name) {
  return classTokens(attributes).includes(name);
}

function eudicPhonetic(html) {
  const values = [];
  /*
   * The class must be one whole token: the wrapper is `phonitic-line`, and a
   * substring match would read the wrapper's first child as a phonetic.
   */
  for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/giu)) {
    if (!hasClass(match[1], 'Phonitic')) continue;
    const value = stripTags(match[2]);
    if (value) values.push(value);
  }
  // The page lists British first and American second; an American recording is
  // the same preference the audio picker uses.
  return normalizePhonetic(values[1] ?? values[0] ?? '');
}

function eudicMeanings(child) {
  const list = /<ol\b[^>]*>([\s\S]*?)<\/ol>/iu.exec(child)?.[1];
  if (!list) {
    const text = stripTags(child);
    return text ? [{ pos: '', definition: clipDefinition(text) }] : [];
  }

  const meanings = [];
  let current;
  for (const match of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
    const li = match[1];
    const text = stripTags(li);
    if (!text) continue;
    const posMarkup = /<i\b[^>]*>([\s\S]*?)<\/i>/iu.exec(li);
    if (posMarkup) {
      current = {
        pos: stripTags(posMarkup[1]),
        definition: stripTags(li.replace(posMarkup[0], '')),
      };
      meanings.push(current);
    } else if (current) {
      current.definition = current.definition
        ? `${current.definition}；${text}`
        : text;
    } else {
      current = { pos: '', definition: text };
      meanings.push(current);
    }
    if (meanings.length >= 3) break;
  }

  return meanings
    .filter((meaning) => meaning.definition)
    .map((meaning) => ({ pos: meaning.pos, definition: clipDefinition(meaning.definition) }));
}

/**
 * Eudic. The English-Chinese entry lives in `#ExpFCchild`: an ordered list
 * whose items change part of speech only where an <i> starts one.
 */
const eudic = {
  id: 'eudic',
  label: '欧陆词典',
  lang: 'en',
  request({ word }) {
    return `https://dict.eudic.net/dicts/en/${encodeURIComponent(word)}`;
  },
  parse(html) {
    if (typeof html !== 'string') return undefined;
    const child = /<div[^>]*\bid=["']ExpFCchild["'][^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1];
    if (!child) return undefined;
    const phonetic = eudicPhonetic(html);
    const meanings = eudicMeanings(child);
    if (!phonetic && meanings.length === 0) return undefined;
    return { phonetic, meanings };
  },
};

/**
 * National Institute of Korean Language. The Chinese edition of krdict lists
 * one <dl> per homograph and one <dd> per sense; the Chinese translation sits
 * in a `manyLang11` cell and the Chinese explanation adds `ml20`.
 *
 * The page is a search result, so it also lists words that merely contain the
 * query. Only the exact headword is used, superscript homograph numbers
 * included in the comparison.
 */
const krdict = {
  id: 'krdict',
  label: '韩国语学习词典',
  lang: 'ko',
  request({ word }) {
    return `https://krdict.korean.go.kr/chn/dicMarinerSearch/search?mainSearchWord=${encodeURIComponent(word)}`;
  },
  parse(html, { word } = {}) {
    if (typeof html !== 'string') return undefined;
    const wanted = String(word ?? '').trim();
    const matches = [];
    for (const block of html.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/giu) ?? []) {
      const headword = kdictHeadword(block);
      if (!headword) continue;
      if (wanted && headword !== wanted) continue;
      const translations = kdictTranslations(block);
      if (translations.length === 0) continue;
      matches.push({
        block,
        meaning: {
          pos: kdictPartOfSpeech(block),
          definition: clipDefinition(translations.join('；')),
        },
      });
      if (matches.length >= 3) break;
    }
    if (matches.length === 0) return undefined;

    const first = matches[0].block;
    return {
      phonetic: normalizePhonetic(kdictPronunciation(first)),
      audio: kdictAudio(first),
      meanings: matches.map((match) => match.meaning),
    };
  },
};

/** The headword as written, without the superscript that numbers homographs. */
function kdictHeadword(block) {
  const raw = /<span[^>]*class="[^"]*\bword_type1_17\b[^"]*"[^>]*>([\s\S]*?)<\/span>/iu.exec(block)?.[1];
  if (!raw) return '';
  return stripTags(raw.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/giu, ''));
}

/** The Chinese part of speech when the page has one, the Korean label otherwise. */
function kdictPartOfSpeech(block) {
  const chinese = /<span[^>]*class="[^"]*\bmanyLang11\b[^"]*"[^>]*>([\s\S]*?)<\/span>/iu.exec(block)?.[1];
  const chineseText = chinese ? stripTags(chinese) : '';
  if (chineseText) return chineseText;
  const korean = /「([^」]+)」/u.exec(block)?.[1];
  return korean ? stripTags(korean) : '';
}

/**
 * `[사과<a … fnSoundPlay(…)>]`: the pronunciation is written in Hangul, which
 * is what a Korean dictionary shows instead of IPA. The recording anchor is
 * inside the brackets on every entry measured.
 */
function kdictPronunciation(block) {
  const withSound = /\[\s*([^[\]<>]+?)\s*<a\b[^>]*fnSoundPlay/u.exec(block)?.[1];
  const value = withSound ?? /\[([^[\]]+)\]/u.exec(block)?.[1];
  const text = value ? stripTags(value) : '';
  // The page already writes the Hangul in brackets, which is how Korean
  // dictionaries show pronunciation; keep them instead of switching to IPA.
  return text ? `[${text}]` : '';
}

function kdictAudio(block) {
  const url = /fnSoundPlay\('([^']+)'\)/u.exec(block)?.[1];
  return url ? decodeEntities(url).trim() || undefined : undefined;
}

/**
 * One <dl> can hold many senses of the same homograph (`먹다` has nine). The
 * Chinese translations are joined with the same `；` separator the other
 * dictionaries use, so `clipDefinition` can keep whole senses.
 */
function kdictTranslations(block) {
  const out = [];
  for (const match of block.matchAll(/<dd\b([^>]*)>([\s\S]*?)<\/dd>/giu)) {
    const classes = classTokens(match[1]);
    if (!classes.includes('manyLang11') || classes.includes('ml20')) continue;
    // Sense numbers are `1.` in front of the translation.
    const text = stripTags(match[2]).replace(/^\d+\s*[.．]\s*/u, '');
    if (!text || text === '(无对应词汇)') continue;
    out.push(text);
  }
  return out;
}

/** The existing English-English source, kept as a fourth choice. */
const englishDictionary = { ...dictionaryDev, label: '英英词典', lang: 'en' };

const DICTIONARIES = [youdao, microsoft, eudic, englishDictionary, krdict];

const DEFAULT_DICTIONARY = 'youdao';

const DICTIONARY_IDS = DICTIONARIES.map((source) => source.id);

/** Sources that serve one Source Language, in selector order. */
function dictionariesFor(lang) {
  const base = normalizeLangTag(lang);
  return DICTIONARIES.filter((source) => source.lang === base);
}

/**
 * The source a Lookup should ask. The Default Dictionary only wins when it is
 * written for this language; otherwise the language's own first source is used
 * (and a language with no dictionary gets `undefined`, not a wasted request).
 */
function dictionaryFor(lang, preferred = DEFAULT_DICTIONARY) {
  const candidates = dictionariesFor(lang);
  return candidates.find((source) => source.id === preferred) ?? candidates[0];
}

/** [id, label] pairs for the switch row, in the order the selectors list them. */
function dictionaryChoicesFor(lang) {
  return dictionariesFor(lang).map(({ id, label }) => [id, label]);
}

/**
 * [id, label] pairs the Default Dictionary may hold. Only English sources are
 * choices: a language served by a single dictionary needs no setting, and a
 * Korean source chosen as the global default would answer no English word.
 */
const DICTIONARY_CHOICES = dictionaryChoicesFor('en');

const DEFAULT_DICTIONARY_IDS = DICTIONARY_CHOICES.map(([id]) => id);

function dictionaryById(id) {
  return DICTIONARIES.find((source) => source.id === id);
}

  return {
    decodeEntities,
    youdao,
    microsoft,
    eudic,
    krdict,
    DICTIONARIES,
    DEFAULT_DICTIONARY,
    DICTIONARY_IDS,
    dictionariesFor,
    dictionaryFor,
    dictionaryChoicesFor,
    DICTIONARY_CHOICES,
    DEFAULT_DICTIONARY_IDS,
    dictionaryById,
  };
})();

// ---- src/core/csv.js ----
__mod_core_csv = (function () {

/**
 * The one CSV dialect this script reads and writes: RFC 4180, UTF-8, CRLF
 * between rows. Used both for the file the user exports and for what the
 * userscript manager keeps on disk, so a value written into storage can be
 * read by the same parser as a hand-edited file.
 */

const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/u;
/**
 * A cell a spreadsheet would evaluate: Excel treats a leading `=`, `+`, `-`,
 * `@`, tab or CR as the start of a formula, and the book's text comes from
 * whatever page the user was reading.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;

/** One cell: quote only when the text would otherwise break the grid. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * Prefix a cell a spreadsheet would run as a formula with an apostrophe, the
 * standard way to make it literal text. Only the file written for a human goes
 * through this; storage is read by this script alone and keeps its values raw.
 */
function formulaSafeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** Undo `formulaSafeCell`, so a guarded file round-trips to the same values. */
function unguardCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.startsWith("'") && FORMULA_LEAD.test(text.slice(1)) ? text.slice(1) : text;
}

/**
 * `columns` is the header row; `rows` are arrays of cell values in that order.
 * The BOM is for files opened in a spreadsheet — an Excel on a Windows code
 * page reads a BOM-less UTF-8 file as mojibake. Storage never needs it.
 * `formulaSafe` guards every cell against being run as a formula.
 */
function encodeCsv(columns, rows, { bom = false, formulaSafe = false } = {}) {
  // Guard before quoting: a quoted `"=1,2"` is still evaluated by Excel once
  // the CSV layer is stripped, so the apostrophe has to be inside the quotes.
  const cell = formulaSafe ? (value) => csvCell(formulaSafeCell(value)) : csvCell;
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}`;
}

/**
 * Read RFC 4180 text into rows of cells. Quoted cells may hold commas, quotes
 * and line breaks. A stray quote inside an unquoted cell stays literal; an
 * unclosed quote throws, because guessing would silently corrupt the result.
 * Blank lines, including the one a trailing newline leaves behind, are dropped.
 */
function decodeCsv(source) {
  const text = String(source ?? '').replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('不是有效的 CSV:引号没有闭合');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A line of nothing but commas is a row of empty cells, not a blank line:
  // dropping it would make a malformed row vanish without being counted.
  return rows.filter((cells) => cells.length > 1 || cells[0].trim() !== '');
}

  return {
    csvCell,
    formulaSafeCell,
    unguardCell,
    encodeCsv,
    decodeCsv,
  };
})();

// ---- src/core/store.js ----
__mod_core_store = (function () {
const { decodeCsv, encodeCsv, unguardCell } = __mod_core_csv;
const { normalizeTerm } = __mod_core_normalize;
const { LANGUAGE_ORDER, languageLabel, normalizeLangTag } = __mod_core_lang;
const STORAGE_KEY = 'entries';

/**
 * The book's columns, in order. `entryId` is deliberately absent: it is
 * derived from `sourceLang` and `normalized`, so a file cannot disagree with
 * itself. The same columns back the exported file and the stored copy.
 */
const CSV_COLUMNS = [
  'term',
  'normalized',
  'sourceLang',
  'targetLang',
  'translation',
  'phonetic',
  'partOfSpeech',
  'addedAt',
];

/** The largest timestamp a JavaScript Date can hold, in milliseconds. */
const MAX_TIME_MS = 8.64e15;

/**
 * A timestamp outside the Date range is not a date. Passing one to
 * `new Date(...).toISOString()` throws, and a throw while encoding would take
 * the whole save down with it — including saves that have nothing to do with
 * the bad row. Values that are not timestamps fall back to the moment of import.
 */
function parseAddedAt(raw, fallback) {
  const text = raw.trim();
  if (text === '') return fallback;
  const numeric = /^-?\d+$/u.test(text);
  const value = numeric ? Number(text) : Date.parse(text);
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : fallback;
}

function exportAddedAt(addedAt) {
  return typeof addedAt === 'number' && Number.isFinite(addedAt) && Math.abs(addedAt) <= MAX_TIME_MS
    ? new Date(addedAt).toISOString()
    : '';
}

/**
 * The book as CSV. A file gets the BOM and the formula guard, because a human
 * opens it in a spreadsheet; what the userscript manager keeps gets neither.
 */
function entriesToCsv(entries, { bom = false, human = false } = {}) {
  const row = (entry) =>
    CSV_COLUMNS.map((column) =>
      column === 'addedAt' ? exportAddedAt(entry.addedAt) : entry[column],
    );
  return encodeCsv(CSV_COLUMNS, entries.map(row), { bom, formulaSafe: human });
}

/**
 * Parse a book CSV into records, dropping rows that cannot be an Entry.
 *
 * Throws when the header itself is wrong: that means the wrong file, which is
 * a different problem from a few dirty rows and deserves a different message.
 */
function readEntriesCsv(text, { now = Date.now } = {}) {
  const rows = decodeCsv(text);
  if (rows.length === 0) throw new Error('CSV 是空的');

  // Columns are matched by name so a hand-edited file may reorder or omit
  // optional ones; these are the fields an entry cannot do without.
  const header = rows.shift().map((name) => name.trim().toLowerCase());
  const column = (name) => header.indexOf(name.toLowerCase());
  const missing = ['sourceLang', 'targetLang', 'translation'].filter(
    (name) => column(name) === -1,
  );
  if (column('term') === -1 && column('normalized') === -1) {
    missing.push('term 或 normalized');
  }
  if (missing.length > 0) throw new Error(`CSV 缺少列:${missing.join('、')}`);

  /*
   * Codes and identifiers are trimmed: a hand-edited file picks up stray spaces
   * from a spreadsheet, and `zh-CN ` is not a language tag. The user's own text
   * (translation, phonetic) keeps its edges — the exporter quotes them
   * precisely so they survive, and trimming here would undo that promise.
   */
  const code = (cells, name) => {
    const index = column(name);
    return index === -1 ? '' : unguardCell(cells[index] ?? '').trim();
  };
  const prose = (cells, name) => {
    const index = column(name);
    return index === -1 ? '' : unguardCell(cells[index] ?? '');
  };

  const entries = [];
  let skipped = 0;
  for (const cells of rows) {
    const sourceLang = code(cells, 'sourceLang');
    const targetLang = code(cells, 'targetLang');
    const translation = prose(cells, 'translation');
    const rawTerm = code(cells, 'term');
    /*
     * Identity is always normalizeTerm of the surface form, exactly as the
     * lookup flow computes it. Trusting the `normalized` column would let a
     * hand-edited file mint an entryId that no lookup can ever produce, so the
     * row would sit in the book and never match a gloss.
     */
    const surface = rawTerm || code(cells, 'normalized');
    const normalized = normalizeTerm(surface);
    if (!sourceLang || !targetLang || !normalized || !translation.trim()) {
      skipped += 1;
      continue;
    }
    entries.push({
      entryId: `${sourceLang}|${normalized}`,
      term: surface,
      normalized,
      sourceLang,
      targetLang,
      translation,
      phonetic: prose(cells, 'phonetic') || undefined,
      partOfSpeech: code(cells, 'partOfSpeech') || undefined,
      addedAt: parseAddedAt(prose(cells, 'addedAt'), now()),
    });
  }
  return { entries, skipped };
}

/** Identity is (source language, normalized form): `Running` and `run` differ. */
function makeEntry({
  term,
  normalized,
  sourceLang,
  targetLang,
  translation,
  phonetic,
  partOfSpeech,
  now = Date.now,
}) {
  return {
    entryId: `${sourceLang}|${normalized}`,
    term,
    normalized,
    sourceLang,
    targetLang,
    translation,
    phonetic,
    partOfSpeech,
    addedAt: now(),
  };
}

/**
 * Group Entries by the language they are written in — the language the reader
 * is learning, not the one they read the page in. A word saved from an English
 * page and the same word saved from a Japanese page belong to different
 * groups, because the entry identity is per source language.
 *
 * Groups follow a fixed order (LANGUAGE_ORDER, then unknown codes
 * alphabetically, then entries with no language at all) rather than one sorted
 * by size: adding a word must not reshuffle the book under the reader's
 * finger. Entries keep the order they were handed in, which the Panel makes
 * newest-first.
 */
function groupBySourceLang(entries) {
  const groups = new Map();
  for (const entry of entries ?? []) {
    const lang = normalizeLangTag(entry?.sourceLang);
    const existing = groups.get(lang);
    if (existing) existing.entries.push(entry);
    else groups.set(lang, { lang, label: languageLabel(lang), entries: [entry] });
  }
  return [...groups.values()].sort((a, b) => {
    const rankA = LANGUAGE_ORDER.indexOf(a.lang);
    const rankB = LANGUAGE_ORDER.indexOf(b.lang);
    if (rankA !== -1 && rankB !== -1) return rankA - rankB;
    if (rankA !== -1) return -1;
    if (rankB !== -1) return 1;
    if (!a.lang) return 1;
    if (!b.lang) return -1;
    return a.lang.localeCompare(b.lang);
  });
}

/**
 * The Vocabulary Book, held as an entry list and persisted through the storage
 * adapter, so the same code runs on GM storage and an in-memory double in
 * tests. The adapter is what turns that list into CSV; see STORAGE_CODECS.
 */
function createStore({ storage, now = Date.now }) {
  let entries = load();

  function load() {
    const raw = storage.read();
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidEntry);
  }

  function save() {
    // The adapter reports whether the value reached storage; `undefined` means
    // an in-memory double, which cannot fail.
    return storage.write(entries);
  }

  function isValidEntry(value) {
    return (
      value &&
      typeof value === 'object' &&
      typeof value.entryId === 'string' &&
      typeof value.normalized === 'string' &&
      typeof value.translation === 'string'
    );
  }

  return {
    all() {
      return [...entries];
    },

    get(entryId) {
      return entries.find((entry) => entry.entryId === entryId);
    },

    has(entryId) {
      return entries.some((entry) => entry.entryId === entryId);
    },

    add(entry) {
      const existingIndex = entries.findIndex((e) => e.entryId === entry.entryId);
      if (existingIndex === -1) {
        entries.push({ ...entry });
      } else {
        // Refreshing must not lose when the word was first saved.
        entries[existingIndex] = { ...entry, addedAt: entries[existingIndex].addedAt };
      }
      save();
      return entries.find((e) => e.entryId === entry.entryId);
    },

    remove(entryId) {
      const before = entries.length;
      entries = entries.filter((entry) => entry.entryId !== entryId);
      if (entries.length !== before) save();
    },

    clear() {
      entries = [];
      save();
    },

    /** normalized form -> translation, for one target language. */
    translationMap(targetLang) {
      const map = new Map();
      for (const entry of entries) {
        if (targetLang && entry.targetLang !== targetLang) continue;
        map.set(entry.normalized, entry.translation);
      }
      return map;
    },

    exportCsv() {
      /*
       * A BOM keeps Excel from reading the UTF-8 file as the system code page;
       * the formula guard is only for this file, since the book's text comes
       * from arbitrary pages and a cell like `=1+1` is otherwise run on open.
       */
      return entriesToCsv(entries, { bom: true, human: true });
    },

    /**
     * Merge a CSV file into the book, or replace the book with it.
     * `mode: 'replace'` clears only after the file has been read and its header
     * checked, so a wrong file leaves the existing book untouched.
     */
    importCsv(text, { mode = 'merge' } = {}) {
      const { entries: incoming, skipped } = readEntriesCsv(text, { now });

      /*
       * Replacing the book with a file that holds no usable row is never what
       * the user meant: the file is empty or malformed, and clearing the book
       * would turn a mistake into data loss. Merge mode has nothing to lose.
       */
      if (mode === 'replace' && incoming.length === 0) {
        throw new Error('文件里没有可导入的词条,已保留现有生词本');
      }

      // The file has parsed and its header checks out: only now is the old
      // book dropped, so a mistyped file cannot erase it.
      if (mode === 'replace') entries = [];

      let added = 0;
      let updated = 0;
      for (const record of incoming) {
        const existingIndex = entries.findIndex((e) => e.entryId === record.entryId);
        if (existingIndex === -1) {
          entries.push(record);
          added += 1;
        } else {
          entries[existingIndex] = { ...record, addedAt: entries[existingIndex].addedAt };
          updated += 1;
        }
      }
      /*
       * The counts above describe this session's copy only. If the write was
       * refused, the next reload shows the old book, so say so rather than
       * reporting an import that did not survive.
       */
      if (save() === false) {
        throw new Error('词条已读入,但没能写入存储,刷新页面后会丢失');
      }
      return { added, updated, skipped };
    },
  };
}

  return {
    STORAGE_KEY,
    CSV_COLUMNS,
    MAX_TIME_MS,
    entriesToCsv,
    readEntriesCsv,
    makeEntry,
    groupBySourceLang,
    createStore,
  };
})();

// ---- src/core/theme.js ----
__mod_core_theme = (function () {

/**
 * Theme resolution.
 *
 * The three floating surfaces (Popup, Bubble, Panel) share one decision, so it
 * is made once, in pure code, rather than by a `prefers-color-scheme` rule
 * inside each shadow root: a user-forced theme has to override the system one
 * everywhere, and a media query cannot express that.
 */

const THEMES = ['system', 'light', 'dark'];

/** Map whatever is in storage onto a known setting. */
function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'system';
}

/**
 * @param {object} input
 * @param {string} input.setting      'system' | 'light' | 'dark'
 * @param {boolean} input.prefersDark whether the OS currently prefers dark
 * @returns {'light' | 'dark'} the theme to render
 */
function resolveTheme({ setting, prefersDark } = {}) {
  const wanted = normalizeTheme(setting);
  if (wanted === 'light' || wanted === 'dark') return wanted;
  return prefersDark ? 'dark' : 'light';
}

  return {
    THEMES,
    normalizeTheme,
    resolveTheme,
  };
})();

// ---- src/app/storage.js ----
__mod_app_storage = (function () {
const { createCache } = __mod_core_cache;
const { decodeCsv, encodeCsv } = __mod_core_csv;
const { DEFAULT_DICTIONARY, DEFAULT_DICTIONARY_IDS } = __mod_core_dictionaries;
const { createStore, entriesToCsv, readEntriesCsv } = __mod_core_store;
const { normalizeTheme } = __mod_core_theme;
const SETTINGS_KEY = 'settings';
const ENTRIES_KEY = 'entries';
const CACHE_KEY = 'cache';

const DEFAULTS = {
  version: 1,
  /** Double-click lookup is on everywhere by default: a silently dead install reads as broken. */
  lookupEnabled: true,
  /** Read every looked-up word aloud. Off by default: sound is intrusive until asked for. */
  autoSpeak: false,
  /** Inline glosses are off by default and opt-in per site, see ADR-0003. */
  glossSites: {},
  /** host -> target language, overrides Page Language inference. */
  targetOverrides: {},
  /** Provider ids the user disabled. */
  disabledProviders: [],
  /** Dictionary Source used for meanings, unless the Popup is switched for one lookup. */
  dictionary: DEFAULT_DICTIONARY,
  /** 'system' follows the OS; 'light' / 'dark' force a theme on every surface. */
  theme: 'system',
};

/*
 * Settings are a `section,key,value` table. Scalars live in `general`; the two
 * host-keyed maps and the provider list are one row each, so a settings dump
 * reads like the panel it mirrors instead of one long enclosed line.
 */
const SETTINGS_COLUMNS = ['section', 'key', 'value'];
const SETTINGS_MAPS = ['glossSites', 'targetOverrides'];
const SETTINGS_LISTS = ['disabledProviders'];

/*
 * One cache row per lookup. `value` is the only cell whose shape is not a flat
 * string — it is a record — so it travels as JSON inside the cell.
 */
const CACHE_COLUMNS = ['key', 'value', 'expires', 'used'];

/** CSV carries text. Booleans and numbers are the only other types settings use. */
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/u;

function scalarText(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === null || value === undefined ? '' : String(value);
}

function scalarValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return NUMBER_RE.test(text) ? Number(text) : text;
}

/**
 * Values written before the switch to CSV are still JSON. Reading them once is
 * the whole migration: the next write replaces them with the new format, so a
 * user's book survives the upgrade without any explicit step.
 */
function legacyJson(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function encodeSettings(values) {
  const rows = [];
  for (const [name, value] of Object.entries(values)) {
    if (SETTINGS_MAPS.includes(name)) {
      for (const [key, entryValue] of Object.entries(value || {})) {
        rows.push([name, key, scalarText(entryValue)]);
      }
    } else if (SETTINGS_LISTS.includes(name)) {
      for (const item of value || []) rows.push([name, '', scalarText(item)]);
    } else {
      rows.push(['general', name, scalarText(value)]);
    }
  }
  return encodeCsv(SETTINGS_COLUMNS, rows);
}

function decodeSettings(text) {
  const legacy = legacyJson(text);
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) return legacy;

  const values = {};
  for (const [section, key, value] of decodeCsv(text)) {
    if (!section) continue;
    if (section === 'general') {
      values[key] = scalarValue(value);
    } else if (SETTINGS_MAPS.includes(section)) {
      if (!values[section]) values[section] = {};
      values[section][key] = scalarValue(value);
    } else if (SETTINGS_LISTS.includes(section)) {
      if (!values[section]) values[section] = [];
      values[section].push(value);
    }
  }
  return values;
}

/** How one storage key is written to, and read back from, the userscript manager. */
const SETTINGS_CODEC = {
  empty: null,
  encode: encodeSettings,
  decode: decodeSettings,
};

const ENTRIES_CODEC = {
  empty: [],
  encode: (entries) => entriesToCsv(entries),
  decode(text) {
    const legacy = legacyJson(text);
    if (legacy !== undefined) {
      if (Array.isArray(legacy)) return legacy;
      return Array.isArray(legacy?.entries) ? legacy.entries : [];
    }
    return readEntriesCsv(text).entries;
  },
};

const CACHE_CODEC = {
  empty: {},
  encode(records) {
    const rows = Object.entries(records).map(([key, record]) => [
      key,
      JSON.stringify(record?.value ?? null),
      scalarText(record?.expires),
      scalarText(record?.used),
    ]);
    return encodeCsv(CACHE_COLUMNS, rows);
  },
  decode(text) {
    const legacy = legacyJson(text);
    if (legacy !== undefined) {
      return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {};
    }
    const records = {};
    for (const [key, value, expires, used] of decodeCsv(text)) {
      if (!key) continue;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      const expiresAt = Number(expires);
      /*
       * `NaN` is a number, so it would pass the cache's own type check and then
       * never satisfy its expiry test — a row that lives in the cache forever.
       * A missing `used` only disturbs eviction order, so it can borrow the
       * expiry instead of dropping an otherwise good entry.
       */
      if (!Number.isFinite(expiresAt)) continue;
      const usedAt = Number(used);
      records[key] = {
        value: parsed,
        expires: expiresAt,
        used: Number.isFinite(usedAt) ? usedAt : expiresAt,
      };
    }
    return records;
  },
};

/** The three on-disk formats, exported so tests can seed and inspect them. */
const STORAGE_CODECS = {
  settings: SETTINGS_CODEC,
  entries: ENTRIES_CODEC,
  cache: CACHE_CODEC,
};

/**
 * Thin adapter over the userscript manager's key/value store.
 * Every access is wrapped: GM storage throws in some managers, and a broken
 * store must degrade to "nothing remembered", not to a dead script.
 */
function createGmStorage(key, gm, codec) {
  return {
    read() {
      try {
        const raw = gm.getValue(key, null);
        if (raw === null || raw === undefined || raw === '') return codec.empty;
        return codec.decode(String(raw));
      } catch {
        return codec.empty;
      }
    },
    /**
     * Resolves to whether the value reached the manager. Encoding runs before
     * the catch: it is this script's own code, so a value it cannot represent is
     * a bug, not a storage permission the user can do nothing about, and
     * reporting success would claim a save that never happened.
     */
    write(value) {
      const text = codec.encode(value);
      try {
        gm.setValue(key, text);
        return true;
      } catch {
        /* storage full or blocked: the in-memory copy still works this session */
        return false;
      }
    },
  };
}

function createSettings(gm) {
  const storage = createGmStorage(SETTINGS_KEY, gm, SETTINGS_CODEC);
  const saved = storage.read();
  const values = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!values.glossSites || typeof values.glossSites !== 'object') values.glossSites = {};
  if (!values.targetOverrides || typeof values.targetOverrides !== 'object') {
    values.targetOverrides = {};
  }
  if (!Array.isArray(values.disabledProviders)) values.disabledProviders = [];
  if (typeof values.autoSpeak !== 'boolean') values.autoSpeak = false;
  if (!DEFAULT_DICTIONARY_IDS.includes(values.dictionary)) values.dictionary = DEFAULT_DICTIONARY;

  function persist() {
    storage.write(values);
  }

  return {
    all() {
      return { ...values };
    },
    get lookupEnabled() {
      return values.lookupEnabled !== false;
    },
    setLookupEnabled(on) {
      values.lookupEnabled = Boolean(on);
      persist();
    },
    /**
     * Whether a successful word Lookup reads itself aloud. Sentences never do:
     * a page reader should not turn every selected paragraph into speech.
     */
    get autoSpeak() {
      return values.autoSpeak === true;
    },
    setAutoSpeak(on) {
      values.autoSpeak = Boolean(on);
      persist();
    },
    glossOn(host) {
      return Boolean(values.glossSites[host]);
    },
    setGlossOn(host, on) {
      if (on) values.glossSites[host] = true;
      else delete values.glossSites[host];
      persist();
    },
    targetOverride(host) {
      return values.targetOverrides[host];
    },
    setTargetOverride(host, lang) {
      if (lang) values.targetOverrides[host] = lang;
      else delete values.targetOverrides[host];
      persist();
    },
    disabledProviders() {
      return [...values.disabledProviders];
    },
    /** The Default Dictionary: the source every new Popup starts with. */
    get dictionary() {
      return values.dictionary;
    },
    setDictionary(id) {
      if (!DEFAULT_DICTIONARY_IDS.includes(id)) return;
      values.dictionary = id;
      persist();
    },
    get theme() {
      return normalizeTheme(values.theme);
    },
    setTheme(theme) {
      values.theme = normalizeTheme(theme);
      persist();
    },
  };
}

function createBook(gm) {
  return createStore({ storage: createGmStorage(ENTRIES_KEY, gm, ENTRIES_CODEC) });
}

function createLookupCache(gm) {
  const storage = createGmStorage(CACHE_KEY, gm, CACHE_CODEC);
  return createCache({
    storage: {
      read() {
        const raw = storage.read();
        return raw && typeof raw === 'object' ? Object.entries(raw) : [];
      },
      write(pairs) {
        storage.write(Object.fromEntries(pairs));
      },
    },
  });
}

  return {
    SETTINGS_KEY,
    ENTRIES_KEY,
    CACHE_KEY,
    DEFAULTS,
    STORAGE_CODECS,
    createGmStorage,
    createSettings,
    createBook,
    createLookupCache,
  };
})();

// ---- src/app/lookup-flow.js ----
__mod_app_lookup_flow = (function () {
const { normalizeTerm, normalizeSentence, scriptOf, canBecomeEntry } = __mod_core_normalize;
const { resolveTarget } = __mod_core_lang;
const { dictionaryChoicesFor, dictionaryFor } = __mod_core_dictionaries;
/**
 * Turns a raw Selection into a Lookup, and wires the Popup's actions to the
 * Vocabulary Book.
 *
 * DOM access is limited to reading the document language; everything else is
 * injected, so the flow can be exercised without a browser.
 */




/** Longest Selection worth a Lookup, in characters. */
const MAX_SELECTION_CHARS = 400;

/**
 * Read the Selection, tidied.
 *
 * Returns a status rather than an empty string for everything that cannot be
 * looked up: "too long" has to be told apart from "nothing selected", because
 * one deserves a short explanation next to the Selection and the other
 * deserves silence. Text is only whitespace-tidied here — whether it is a word
 * or a sentence is the Lookup's decision, not the Selection's.
 */
function readSelection(selection) {
  if (!selection || selection.rangeCount === 0) return { status: 'empty', text: '' };
  const text = normalizeSentence(String(selection.toString() ?? ''));
  if (text.length > MAX_SELECTION_CHARS) return { status: 'too-long', text: '' };
  if (text.length === 0) return { status: 'empty', text: '' };
  return { status: 'ok', text };
}

/**
 * Language of the selection, when the writing system gives it away.
 * Latin text could be English, French or German, so it stays 'auto' and the
 * provider's own detection is trusted instead.
 */
function sourceLangOf(term) {
  const script = scriptOf(term);
  if (script === 'han') return 'zh';
  if (script === 'kana') return 'ja';
  if (script === 'hangul') return 'ko';
  if (script === 'cyrillic') return 'ru';
  return 'auto';
}

/**
 * @param {object} deps
 * @param {object} deps.popup           render/hide surface
 * @param {Function} deps.translator    (text, source, target) => [{translation, detectedSource}]
 * @param {object} deps.book            Vocabulary Book
 * @param {Function} [deps.pageLanguage]  () => Page Language code
 * @param {Function} [deps.dictionary]    (word, dictionaryId) => {phonetic, meanings} | undefined
 * @param {Function} [deps.speak]         (term, lang, audioUrl) => void, called for a word when auto-speak is on
 * @param {Function} deps.settings        () => settings snapshot
 * @param {string} deps.host              current hostname
 */
function createLookupFlow({
  popup,
  translator,
  book,
  pageLanguage = () => '',
  dictionary,
  speak,
  settings,
  host = '',
}) {
  let requestId = 0;

  async function lookup({ term, anchor, sourceLang }) {
    const text = normalizeSentence(term);
    if (!text) return [];

    /*
     * A word is an identity: it is lowercased, stripped of surrounding
     * punctuation, and may be saved to the Vocabulary Book. Anything longer
     * than a word is a sentence, and a sentence is only ever shown — keeping
     * its case, punctuation and line breaks is what makes the translation read
     * as the sentence the user selected.
     */
    const sentence = !canBecomeEntry(text);
    const normalized = sentence ? text : normalizeTerm(text);
    if (!normalized) return [];

    const config = settings();
    const source = sourceLang ?? sourceLangOf(normalized);
    const targetOverride = config.targetOverride?.(host) ?? '';
    const target = resolveTarget({
      pageLang: pageLanguage(),
      sourceLang: source,
      override: targetOverride,
    });

    const current = ++requestId;
    const canSave = !sentence;

    popup.render({
      status: 'loading',
      sentence,
      term: normalized,
      anchor,
      sourceLang: source,
    });

    try {
      const [result] = await translator({ text: normalized, source, target });
      if (current !== requestId) return [];

      const detectedSource = result?.detectedSource;
      const entrySource = detectedSource
        ? detectedSource.split('-')[0]
        : source === 'auto'
          ? 'en'
          : source;
      const translation = result?.translation ?? '';

      /*
       * Dictionary details are a bonus for a word. A sentence has no entry in
       * a dictionary, and a word in a language no source covers would only
       * spend a request: every source declares the language it serves, so the
       * Default Dictionary is followed only when it is written for this one.
       * A failure is shown in the Popup but never turns the Lookup into an
       * error.
       */
      const dictionarySource = dictionaryFor(entrySource, config.dictionary);
      const dictionaryId = dictionarySource?.id;
      const usesDictionary = Boolean(dictionary) && !sentence && Boolean(dictionaryId);
      let details;
      let dictionaryStatus;
      if (usesDictionary) {
        dictionaryStatus = 'ok';
        try {
          details = await dictionary(normalized, dictionaryId);
          if (!details) dictionaryStatus = 'empty';
        } catch (error) {
          console.debug('[tm] dictionary lookup failed:', error);
          dictionaryStatus = 'error';
        }
      }
      if (current !== requestId) return [];

      if (sentence) {
        popup.render({
          status: 'ok',
          sentence: true,
          term: normalized,
          translation,
          canSpeak: Boolean(speak),
          canSave: false,
          anchor,
          sourceLang: entrySource,
          target,
          targetOverride,
          onRetry: () => lookup({ term: normalized, anchor, sourceLang }),
        });
        return [];
      }

      const entry = {
        term: normalized,
        normalized,
        sourceLang: entrySource,
        targetLang: target,
        translation,
        phonetic: details?.phonetic,
        partOfSpeech: details?.meanings?.[0]?.pos,
      };

      // The base-form hint is a suggestion only: it never changes what is saved
      // unless the user presses the Popup's "save the base form" button. A
      // failure fetching it is ignored, like the dictionary details.
      let lemma;
      const baseForm = details?.lemma;
      if (baseForm && baseForm !== normalized) {
        try {
          const [baseResult] = await translator({ text: baseForm, source, target });
          if (current !== requestId) return [];
          if (baseResult?.translation) {
            lemma = {
              term: baseForm,
              normalized: baseForm,
              sourceLang: entrySource,
              targetLang: target,
              translation: baseResult.translation,
              phonetic: details?.phonetic,
            };
          }
        } catch {
          lemma = undefined;
        }
      }
      if (current !== requestId) return [];

      popup.render({
        status: 'ok',
        sentence: false,
        term: normalized,
        translation: entry.translation,
        detectedSource,
        phonetic: details?.phonetic,
        audio: details?.audio,
        meanings: details?.meanings,
        dictionaryId: usesDictionary ? dictionaryId : undefined,
        // One source for a language means nothing to switch to; the Popup
        // hides the row and the meanings still show.
        dictionaryChoices: usesDictionary ? dictionaryChoicesFor(entrySource) : undefined,
        dictionaryStatus,
        canSpeak: Boolean(speak),
        canSave,
        lemma,
        // Checked against the resolved source language, not the guess we made
        // before detection: an 'auto' guess would never match a saved 'en|run'.
        alreadySaved: book.has(`${entrySource}|${normalized}`),
        entry,
        anchor,
        sourceLang: entrySource,
        target,
        targetOverride,
        onRetry: () => lookup({ term: normalized, anchor, sourceLang }),
      });

      /*
       * Auto-speak is opt-in and words only: hearing every selected sentence
       * would turn browsing into a lecture, while the manual button is still
       * there for one. Playback is best-effort, like every other extra here.
       */
      if (config.autoSpeak && speak) speak(normalized, entrySource, details?.audio);

      return [entry];
    } catch (error) {
      if (current !== requestId) return [];
      console.debug('[tm] lookup failed:', error);
      popup.render({
        status: 'error',
        sentence,
        term: normalized,
        anchor,
        sourceLang: source,
        onRetry: () => lookup({ term: normalized, anchor, sourceLang }),
      });
      return [];
    }
  }

  /**
   * Show the same word's meanings from another Dictionary Source. This is the
   * Popup's temporary choice: it never writes the setting, so the next Lookup
   * starts from the Default Dictionary again.
   */
  async function changeDictionary(nextId, state) {
    if (!dictionary || !state || state.sentence || !state.term || !state.dictionaryId) return;
    const id = nextId || DEFAULT_DICTIONARY;
    const current = ++requestId;

    // Clearing the old list first is what keeps the Popup from showing one
    // dictionary's meanings under another dictionary's name while we wait.
    popup.render({ ...state, dictionaryId: id, dictionaryStatus: 'loading', meanings: undefined });

    let details;
    try {
      details = await dictionary(state.term, id);
    } catch (error) {
      if (current !== requestId) return;
      console.debug('[tm] dictionary switch failed:', error);
      popup.render({ ...state, dictionaryId: id, dictionaryStatus: 'error', meanings: undefined });
      return;
    }
    if (current !== requestId) return;

    const firstPos = details?.meanings?.[0]?.pos;
    popup.render({
      ...state,
      dictionaryId: id,
      dictionaryStatus: details ? 'ok' : 'empty',
      phonetic: details?.phonetic ?? state.phonetic,
      audio: details?.audio ?? state.audio,
      meanings: details?.meanings,
      entry: state.entry
        ? {
            ...state.entry,
            phonetic: details?.phonetic ?? state.entry.phonetic,
            partOfSpeech: firstPos || state.entry.partOfSpeech,
          }
        : state.entry,
    });
  }

  return { lookup, readSelection, changeDictionary };
}

/** Save an Entry from the Popup, refreshing the gloss layer afterwards. */
function addEntry(book, entry, onSaved) {
  if (!entry || !entry.translation) return false;
  const written = book.add({
    entryId: `${entry.sourceLang}|${entry.normalized}`,
    term: entry.term,
    normalized: entry.normalized,
    sourceLang: entry.sourceLang,
    targetLang: entry.targetLang,
    translation: entry.translation,
    phonetic: entry.phonetic,
    partOfSpeech: entry.partOfSpeech,
    addedAt: Date.now(),
  });
  onSaved?.(written);
  return true;
}

/** Remove an Entry from the Popup, refreshing the gloss layer afterwards. */
function removeEntry(book, entry, onRemoved) {
  if (!entry?.sourceLang || !entry?.normalized) return false;
  const entryId = `${entry.sourceLang}|${entry.normalized}`;
  if (!book.has(entryId)) return false;
  book.remove(entryId);
  onRemoved?.(entryId);
  return true;
}

  return {
    MAX_SELECTION_CHARS,
    readSelection,
    sourceLangOf,
    createLookupFlow,
    addEntry,
    removeEntry,
  };
})();

// ---- src/app/pronunciation.js ----
__mod_app_pronunciation = (function () {

/**
 * Pronunciation playback.
 *
 * A recording from the Dictionary Source is preferred, because the system voice
 * is a synthesis rather than the word as a person says it. Everything about the
 * recording is best-effort: the download, the page's CSP and the audio decoder
 * can each fail on a given word or site, and none of that deserves an error
 * message when the system voice is already there as a fallback.
 *
 * Cancellation is one counter rather than a set of flags: a second tap has to
 * cancel both a playback in progress and a download still in flight, and an
 * `await` that resumes afterwards must not start playing stale audio. Every
 * handler therefore carries the counter value it was created under.
 *
 * All four effects are injected — the network, the audio element, the object
 * URL and the system voice — so this module runs without a browser.
 */
function createPronouncer({ fetchBlob, createAudio, objectUrls, speakText }) {
  let token = 0;
  let playing = null;
  let downloading = false;

  function stop() {
    token += 1;
    downloading = false;
    const current = playing;
    playing = null;
    if (!current) return;
    try {
      current.audio?.pause?.();
    } catch {
      /* already torn down */
    }
    try {
      objectUrls.revoke(current.url);
    } catch {
      /* not every engine has it */
    }
  }

  async function play(term, lang, audioUrl) {
    // One voice at a time: a tap while anything is audible stops it instead.
    if (playing || downloading) {
      stop();
      return;
    }
    if (!audioUrl) {
      speakText(term, lang);
      return;
    }

    const mine = (token += 1);
    downloading = true;
    try {
      const blob = await fetchBlob(audioUrl);
      if (mine !== token) return;
      const url = objectUrls.create(blob);
      // Recorded before the element exists, so a constructor that throws still
      // leaves the temporary URL reachable by `stop`.
      playing = { audio: null, url };
      const audio = createAudio(url);
      playing.audio = audio;
      downloading = false;

      audio.onended = () => {
        if (mine === token) stop();
      };
      audio.onerror = () => {
        if (mine !== token) return;
        stop();
        speakText(term, lang);
      };
      await audio.play();
    } catch {
      if (mine !== token) return;
      stop();
      speakText(term, lang);
    }
  }

  return {
    play,
    stop,
    get playing() {
      return Boolean(playing) || downloading;
    },
  };
}

  return {
    createPronouncer,
  };
})();

// ---- src/core/gesture.js ----
__mod_core_gesture = (function () {
const { normalizeTerm, normalizeSentence } = __mod_core_normalize;
/**
 * Longest selection the bubble will offer to translate.
 *
 * This is the Lookup limit, not an Entry limit: a phone user dragging out a
 * sentence is doing what a desktop user does by double-clicking a paragraph,
 * and a sentence is only ever translated. Anything longer is a copy gesture.
 */
const MAX_BUBBLE_CHARS = 400;

/**
 * True on devices whose primary input is a finger.
 *
 * Mobile browsers do not reliably fire `dblclick` on a double tap — Chrome on
 * Android only does when double-tap zoom is off, iOS never does — so the
 * desktop gesture cannot be the only way in. `pointer: coarse` is the honest
 * signal; the touch-point fallback covers browsers that omit the media query.
 */
function isTouchPrimary(windowlike) {
  try {
    const coarse = windowlike.matchMedia?.('(pointer: coarse)');
    if (coarse) return Boolean(coarse.matches);
  } catch {
    /* matchMedia can throw on detached windows */
  }
  const touchPoints = windowlike.navigator?.maxTouchPoints;
  if (typeof touchPoints === 'number') return touchPoints > 0;
  // Browsers old enough to lack maxTouchPoints still expose the touch
  // handler property; `in` is used because the value itself is usually null.
  return 'ontouchstart' in windowlike;
}

/**
 * True when the node sits inside a field the user types into.
 *
 * Long-pressing a word inside a text box is a normal editing gesture (the
 * user's next move is the paste menu, or to type over it), so offering the
 * Bubble there would fight the field for the tap.
 */
function isEditableSelection(selection) {
  const node = selection?.anchorNode;
  if (!node) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!element?.closest) return false;
  if (element.closest('input, textarea, select')) return true;
  const editable = element.closest('[contenteditable]');
  return Boolean(editable && editable.getAttribute('contenteditable') !== 'false');
}

/**
 * Decide whether a finished selection deserves the translate bubble.
 *
 * The bubble exists because a phone has no double-click: the user long-presses
 * to select a word, which is the gesture they already use to copy. We only
 * react to a *finished* gesture, and never to an empty or huge selection, so
 * ordinary reading and copying stay untouched.
 */
function shouldOfferBubble({ selection, target, isOwnUi = false } = {}) {
  if (isOwnUi) return false;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (target?.closest?.('[data-tm]')) return false;
  if (isEditableSelection(selection)) return false;

  const raw = String(selection.toString() ?? '');
  const text = normalizeSentence(raw);
  if (text.length === 0) return false;
  // A sentence may wrap across lines, and drag-selecting one is still a lookup;
  // only a selection too long to be one is a copy gesture.
  if (text.length > MAX_BUBBLE_CHARS) return false;

  // Punctuation on its own is not something to translate.
  return normalizeTerm(text).length > 0;
}

/** The text to look up from a selection, tidied but not re-cased. */
function selectionTerm(selection) {
  return normalizeSentence(selection?.toString?.() ?? '');
}

/**
 * True while any part of the rect is inside the viewport.
 *
 * A Bubble is fixed on the screen, so it has to follow the Selection it points
 * at. It only goes away once the Selection has left the screen entirely:
 * straddling an edge means the reader can still see what it refers to.
 */
function isRectVisible(rect, viewport) {
  if (!rect) return false;
  const top = rect.top ?? 0;
  const bottom = rect.bottom ?? top + (rect.height ?? 0);
  const left = rect.left ?? 0;
  const right = rect.right ?? left + (rect.width ?? 0);
  const width = viewport?.width ?? Infinity;
  const height = viewport?.height ?? Infinity;
  return bottom > 0 && top < height && right > 0 && left < width;
}

/**
 * Where to put a floating box next to a Selection.
 *
 * Below the Selection by default — that is where the eye already is, and it
 * keeps clear of the native selection handles above the word. It flips above
 * when there is no room, and the result is always clamped inside the viewport
 * so a Selection at the page edge cannot push the Popup off screen.
 *
 * All three rects must be in the same coordinate space; the caller passes the
 * viewport size it measured, since that is the only part that differs between
 * a desktop window and a phone with a keyboard open.
 */
function placeNear({ rect, box, viewport, margin = 8, gap = 8 }) {
  const width = viewport?.width ?? 0;
  const height = viewport?.height ?? 0;
  const boxWidth = box?.width ?? 0;
  const boxHeight = box?.height ?? 0;

  // A Selection rect's height is only reliable as `bottom - top` on some
  // engines, so both spellings are accepted.
  const rectTop = rect?.top ?? 0;
  const rectHeight = rect?.height ?? Math.max(0, (rect?.bottom ?? 0) - rectTop);

  const below = rectTop + rectHeight + gap;
  const above = rectTop - gap - boxHeight;
  // Prefer below; flip above only when below would not fit but above would.
  let top = below + boxHeight > height - margin && above >= margin ? above : below;
  // Then keep the box on screen. A box taller than the viewport cannot fit
  // anywhere, so pin its top and let the bottom run off: the translation is at
  // the top of the box, and that is the part worth keeping visible.
  const maxTop = height - margin - boxHeight;
  top = maxTop < margin ? margin : Math.min(Math.max(top, margin), maxTop);

  const maxLeft = width - margin - boxWidth;
  const left = maxLeft < margin ? margin : Math.min(Math.max(rect?.left ?? 0, margin), maxLeft);

  return { top, left };
}

/**
 * True when the Selection lives inside our own UI.
 *
 * Text in the Popup or Panel is real, selectable text, so the user can select
 * it. `closest` alone is not enough: our UI sits behind a Shadow DOM, and a
 * node's ancestor chain stops at the shadow root, so the chain has to be
 * followed out through `root.host` explicitly.
 */
function isOwnSelection(selection) {
  const node = selection?.anchorNode;
  if (!node) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!element) return false;
  if (element.closest?.('[data-tm]')) return true;
  const root = element.getRootNode?.();
  return Boolean(root?.host?.matches?.('[data-tm]'));
}

  return {
    MAX_BUBBLE_CHARS,
    isTouchPrimary,
    isEditableSelection,
    shouldOfferBubble,
    selectionTerm,
    isRectVisible,
    placeNear,
    isOwnSelection,
  };
})();

// ---- src/ui/popup.js ----
__mod_ui_popup = (function () {
const { placeNear } = __mod_core_gesture;
const { languageLabel, normalizeLangTag } = __mod_core_lang;
const { DEFAULT_DICTIONARY, DICTIONARY_CHOICES } = __mod_core_dictionaries;
/**
 * The Popup: a float anchored near the Selection showing the translation,
 * dictionary details, and the add-to-book action.
 *
 * Rendered into a Shadow DOM host so the host page's CSS cannot restyle it and
 * our CSS cannot leak out. All styles are inline in one stylesheet string.
 */




/**
 * Target Languages the Popup offers, as distinct tags. The list is
 * deliberately short: these are the languages the free providers handle
 * reliably, and a select is easier to hit than the old free-text setting. The
 * names come from the shared table, so they match the Book's group headings.
 * An override left over from the text-field era is added as its own option
 * rather than dropped.
 */
const TARGET_CHOICES = [
  ['', '自动'],
  ...['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'].map((tag) => [tag, languageLabel(tag)]),
];

/**
 * The mark on a Dictionary Source's logo. Three sources have a wordmark colour
 * of their own (Youdao red, Eudic blue) or no mark at all; Microsoft's four
 * squares are drawn as shapes, since no letter can stand in for them.
 */
const DICTIONARY_MARKS = {
  youdao: { text: '有' },
  microsoft: { squares: ['#f25022', '#7fba00', '#00a4ef', '#ffb900'] },
  eudic: { text: 'E' },
  dictionaryapi: { text: 'EN' },
  krdict: { text: '한' },
};

/** Inline icons, drawn as strokes so they take the surface's colour. */
const ICONS = {
  globe:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c2.5 2.4 4 5.4 4 10s-1.5 7.6-4 10c-2.5-2.4-4-5.4-4-10s1.5-7.6 4-10ZM2 12h20',
  speaker: 'M4 9h4l5-4v14l-5-4H4V9ZM16 8.5a4.5 4.5 0 0 1 0 7M18.8 5.8a8.2 8.2 0 0 1 0 12.4',
  copy: 'M9 9h10v10H9V9ZM5 15H4V5h10v1',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
};

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  max-width: 320px;
  min-width: 180px;
  background: var(--tm-bg, #fff);
  color: var(--tm-fg, #1a1a1a);
  border: 1px solid var(--tm-border, #d8d8d8);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  padding: 10px 12px;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .12s ease, transform .12s ease;
  /*
   * The host zeroes its own box, so the browser's attribute-hiding rule cannot
   * be relied on to hide this: before the first render the Popup sits
   * unpositioned at the viewport corner. Invisible boxes still eat clicks, so
   * it must be untouchable until shown.
   */
  visibility: hidden;
  pointer-events: none;
}
.wrap.show {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  pointer-events: auto;
}
.head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.term { font-weight: 650; font-size: 16px; letter-spacing: .01em; word-break: break-word; }
.phonetic {
  color: var(--tm-muted, #6b6b6b); font-size: 12px;
  background: var(--tm-chip, rgba(127,127,127,.1)); border-radius: 5px; padding: 1px 5px;
}
.speak {
  all: unset; cursor: pointer; flex: none; width: 24px; height: 24px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--tm-accent, #2563eb); background: var(--tm-accent-soft, #e8f0fe);
}
.speak:hover { background: var(--tm-hover, #eff6ff); }
.speak svg { width: 14px; height: 14px; }
.translation { margin-top: 7px; font-size: 16px; line-height: 1.45; word-break: break-word; }
/* A sentence was written with line breaks; flattening them changes the meaning
   of what the reader selected. */
.wrap.sentence .translation { white-space: pre-wrap; }
.detected { margin-top: 3px; color: var(--tm-muted, #8a8a8a); font-size: 11px; }
/*
 * Two per-lookup decisions, in the two corners where they belong: the
 * Dictionary Source is a row of logos at the top right, beside the word it
 * describes; the Target Language is a dropdown at the bottom right, beside the
 * actions whose result it changes.
 */
.dict { display: flex; align-items: center; gap: 1px; margin-left: auto; }
.logo {
  all: unset; box-sizing: border-box; cursor: pointer;
  width: 24px; height: 24px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  opacity: .45; transition: opacity .12s ease, box-shadow .12s ease;
}
.logo:hover { opacity: .8; }
/* The chosen source is the only one at full strength, ringed in the accent. */
.logo[aria-pressed="true"] { opacity: 1; box-shadow: 0 0 0 2px var(--tm-accent, #2563eb); }
.logo:focus-visible { outline: 2px solid var(--tm-accent, #2563eb); outline-offset: 1px; }
.logo-mark {
  width: 18px; height: 18px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: -.02em;
}
/*
 * Each logo keeps its own brand colour rather than a theme colour: a dictionary
 * is recognised by its mark, and the same red or blue is what the reader knows
 * from the site.
 */
.logo-mark[data-logo="youdao"] { background: #d9271e; color: #fff; }
.logo-mark[data-logo="eudic"] { background: #1f6ff2; color: #fff; }
.logo-mark[data-logo="dictionaryapi"] { background: #5b6472; color: #fff; font-size: 8px; }
.logo-mark[data-logo="krdict"] { background: #0b6bb6; color: #fff; }
.logo-mark.logo-ms svg { width: 15px; height: 15px; }
.target {
  display: flex; align-items: center; gap: 5px; margin-left: auto;
  color: var(--tm-muted, #8a8a8a); font-size: 11px;
}
.target select {
  padding: 2px 4px; border: 1px solid var(--tm-border, #d8d8d8); border-radius: 6px;
  font: inherit; font-size: 11px; max-width: 132px;
  background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
.tool-icon { display: inline-flex; color: var(--tm-muted, #9a9a9a); flex: none; }
.tool-icon svg { width: 12px; height: 12px; }
.meanings-state { margin-top: 7px; color: var(--tm-muted, #8a8a8a); font-size: 12px; }
.meanings { margin: 7px 0 0; padding: 0; list-style: none; }
.meanings li {
  display: flex; gap: 6px; align-items: baseline;
  color: var(--tm-fg, #3f3f46); font-size: 12px; line-height: 1.5; margin-top: 4px;
}
.pos {
  flex: none; color: var(--tm-pos, #9a6b00); font-size: 11px; font-weight: 600;
  background: var(--tm-pos-bg, rgba(154,107,0,.12)); border-radius: 4px; padding: 0 4px;
}
.actions { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
button.primary {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  background: var(--tm-accent, #2563eb); color: var(--tm-accent-fg, #fff);
  border-radius: 8px; padding: 6px 13px; font-size: 13px; font-weight: 550;
}
button.primary svg { width: 13px; height: 13px; }
button.primary:hover { filter: brightness(1.08); }
button.primary[disabled] { background: var(--tm-accent, #2563eb); opacity: .45; cursor: default; }
/*
 * Already in the book: the same button now removes the Entry. It keeps the
 * position and size of the save button, but the accent colour would read as
 * "save", so it takes the removal colour instead.
 */
button.primary.saved { background: var(--tm-chip, #f1f3f5); color: var(--tm-danger, #b91c1c); }
button.primary.saved:hover { background: var(--tm-hover, #eff6ff); }
button.primary.saved[disabled] { background: var(--tm-chip, #f1f3f5); }
button.ghost {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  color: var(--tm-muted, #6b6b6b); font-size: 12px; padding: 4px 5px; border-radius: 6px;
}
button.ghost:hover { background: var(--tm-hover, #f2f4f7); }
button.ghost svg { width: 13px; height: 13px; }
.hint { color: var(--tm-muted, #9a9a9a); font-size: 11px; }
.error { color: var(--tm-danger, #b91c1c); }
.row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }

/*
 * Touch screens: the Popup is the main surface, so it may use the full width
 * and every control gets a finger-sized hit area (44px is the usual minimum).
 */
.wrap.touch {
  max-width: none;
  /* Full width on a phone, but not a 900px ribbon on a tablet. */
  width: min(420px, calc(100vw - 20px));
  padding: 12px 14px;
  font-size: 15px;
}
.wrap.touch button.primary { padding: 10px 16px; font-size: 15px; border-radius: 10px; }
.wrap.touch button.primary svg { width: 15px; height: 15px; }
.wrap.touch button.ghost { padding: 8px 10px; font-size: 14px; border-radius: 8px; }
.wrap.touch .speak { width: 34px; height: 34px; }
.wrap.touch .speak svg { width: 17px; height: 17px; }
.wrap.touch .logo { width: 32px; height: 32px; }
.wrap.touch .logo-mark { width: 22px; height: 22px; font-size: 13px; }
.wrap.touch .logo-mark.logo-ms svg { width: 18px; height: 18px; }
.wrap.touch .target { font-size: 13px; }
.wrap.touch .target select { padding: 8px 10px; font-size: 14px; max-width: 150px; }
.wrap.touch .tool-icon svg { width: 15px; height: 15px; }
.wrap.touch .meanings-state { font-size: 14px; }
.wrap.touch .meanings li { font-size: 13px; }
/* Only the head row shares space with the close button; everything below it
   starts under the button's 36px box. */
.wrap.touch .head,
.wrap.touch > .term,
.wrap.sentence > .translation { padding-right: 36px; }
.close {
  all: unset; display: none; position: absolute; top: 2px; right: 2px;
  width: 36px; height: 36px; text-align: center; line-height: 36px;
  color: var(--tm-muted, #8a8a8a); font-size: 18px; cursor: pointer;
}
`;

function createPopup({ document, window, onAdd, onRemove, onSpeak, onCopy, onTargetChange, onDictionaryChange, onClose, touch = false }) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const host = document.createElement('div');
  host.setAttribute('data-tm', 'popup-host');
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = touch ? 'wrap touch' : 'wrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-live', 'polite');
  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  close.onclick = () => hide();
  shadow.append(style, wrap);

  /*
   * `host.hidden` alone would not hide this: the host's inline `all: initial`
   * sets `display: inline` in the author origin, which outranks the UA sheet's
   * `[hidden] { display: none }`. The display has to be toggled inline so the
   * invisible box cannot sit over the page.
   */
  function setHidden(hidden) {
    host.hidden = hidden;
    host.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(host);

  let current = null;

  /** An inline stroke icon; `aria-hidden` because the button carries the name. */
  function icon(path) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const shape = document.createElementNS(NS, 'path');
    shape.setAttribute('d', path);
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.7');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.append(shape);
    return svg;
  }

  /** The small glyph that names a control group, e.g. a globe for languages. */
  function groupIcon(path, label) {
    const box = el('span', 'tool-icon');
    box.title = label;
    box.append(icon(path));
    return box;
  }

  /**
   * The per-site Target Language, as a dropdown. It sits at the bottom right of
   * the Popup rather than in the Panel because it is a reading decision made in
   * the moment: change it and the same word is looked up again without leaving
   * the page.
   */
  function targetRow(state) {
    const saved = String(state.targetOverride ?? '').trim().replace(/_/gu, '-');
    const savedBase = normalizeLangTag(saved);
    const row = el('div', 'target');
    row.append(groupIcon(ICONS.globe, '本站目标语言'));
    const select = document.createElement('select');
    select.className = 'target-select';
    select.setAttribute('aria-label', '本站目标语言');

    const choices = [...TARGET_CHOICES];
    // Match by base language so a saved `zh` still selects 「中文」, whose
    // option carries the `zh-CN` tag the default Target Language uses.
    let selected = '';
    if (savedBase) {
      const match = choices.find(([value]) => value && normalizeLangTag(value) === savedBase);
      if (match) {
        selected = match[0];
      } else {
        // A language the short list does not name must still be visible, or
        // choosing another one would silently discard what was saved.
        choices.push([saved, saved]);
        selected = saved;
      }
    }
    for (const [value, label] of choices) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = selected;
    select.onchange = () => onTargetChange?.(select.value, state);
    row.append(select);
    return row;
  }

  /** A Dictionary Source's logo: its own mark, not a letter in our colours. */
  function dictionaryLogo(id) {
    const mark = document.createElement('span');
    mark.className = 'logo-mark';
    const spec = DICTIONARY_MARKS[id];
    if (spec?.squares) {
      // Microsoft: the four squares, drawn rather than lettered.
      mark.classList.add('logo-ms');
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const cells = [
        [1.5, 1.5],
        [13, 1.5],
        [1.5, 13],
        [13, 13],
      ];
      cells.forEach(([x, y], index) => {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', '9.5');
        rect.setAttribute('height', '9.5');
        rect.setAttribute('fill', spec.squares[index]);
        svg.append(rect);
      });
      mark.append(svg);
      return mark;
    }
    mark.dataset.logo = id;
    mark.textContent = spec?.text ?? '';
    return mark;
  }

  /**
   * The Dictionary Source for this Popup, as a row of logos in the top right.
   * It is deliberately not a setting: switching here is a reading decision for
   * one word, so the next Lookup starts from the Default Dictionary again.
   *
   * Returns `null` when the word's language has only one dictionary: a row of
   * one logo would be a control that cannot do anything.
   */
  function dictionaryRow(state) {
    const choices = state.dictionaryChoices ?? DICTIONARY_CHOICES;
    if (choices.length < 2) return null;

    const row = el('div', 'dict');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '释义词典 · 仅本次');
    row.title = '释义词典(仅本次,不改变默认词典)';

    let selected = state.dictionaryId;
    if (!choices.some(([value]) => value === selected)) {
      selected = choices[0][0] ?? DEFAULT_DICTIONARY;
    }
    for (const [value, label] of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'logo';
      button.dataset.dict = value;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', value === selected ? 'true' : 'false');
      button.append(dictionaryLogo(value));
      button.onclick = () => onDictionaryChange?.(value, state);
      row.append(button);
    }
    return row;
  }

  function render(state) {
    current = state;
    wrap.classList.remove('show');
    wrap.classList.toggle('sentence', Boolean(state.sentence));
    // `replaceChildren` would drop the close button, so re-seat it each time.
    wrap.replaceChildren(close);
    // A sentence has no page text to click away from, so it always offers the
    // explicit close; a desktop word box keeps the quieter click-away.
    close.style.display = state.sentence || touch ? 'block' : 'none';

    if (state.status === 'loading') {
      if (!state.sentence) wrap.append(el('div', 'term', state.term));
      wrap.append(el('div', 'translation hint', '翻译中…'));
    } else if (state.status === 'error') {
      if (!state.sentence) wrap.append(el('div', 'term', state.term));
      wrap.append(el('div', 'translation error', '翻译服务暂不可用'));
      const actions = el('div', 'actions');
      const retry = el('button', 'ghost', '重试');
      retry.onclick = () => state.onRetry?.();
      actions.append(retry);
      wrap.append(actions);
    } else if (state.sentence) {
      wrap.append(el('div', 'translation', state.translation));
      const actions = el('div', 'actions');
      addCopy(actions, state);
      if (state.canSpeak) actions.append(speakButton(state));
      actions.append(targetRow(state));
      wrap.append(actions);
    } else {
      const head = el('div', 'head');
      head.append(el('span', 'term', state.term));
      if (state.phonetic) head.append(el('span', 'phonetic', state.phonetic));
      if (state.canSpeak) head.append(speakButton(state));
      const dictRow = state.dictionaryId ? dictionaryRow(state) : null;
      if (dictRow) head.append(dictRow);
      wrap.append(head);
      wrap.append(el('div', 'translation', state.translation));
      if (state.detectedSource) {
        wrap.append(el('div', 'detected', `检测语言:${state.detectedSource}`));
      }
      if (state.dictionaryId) {
        if (state.dictionaryStatus === 'loading') {
          wrap.append(el('div', 'meanings-state', '正在查询释义…'));
        } else if (state.dictionaryStatus === 'empty') {
          wrap.append(el('div', 'meanings-state', '该词典暂无释义'));
        } else if (state.dictionaryStatus === 'error') {
          wrap.append(el('div', 'meanings-state error', '释义加载失败'));
        }
      }
      if (state.meanings?.length) {
        const list = el('ul', 'meanings');
        for (const meaning of state.meanings) {
          const li = document.createElement('li');
          if (meaning.pos) li.append(el('span', 'pos', meaning.pos));
          li.append(String(meaning.definition));
          list.append(li);
        }
        wrap.append(list);
      }
      if (state.lemma) {
        const row = el('div', 'row');
        row.append(
          el('span', 'hint', `原形:${state.lemma.term}`),
          (() => {
            const b = el('button', 'ghost', '改存原形');
            b.onclick = () => onAdd?.(state.lemma, state);
            return b;
          })(),
        );
        wrap.append(row);
      }
      const actions = el('div', 'actions');
      /*
       * One button, two meanings. An Entry already in the book must still be
       * removable from here — otherwise the only way back is the Panel — so the
       * same button flips between "加入生词本" and "移出生词本" instead of
       * sitting disabled.
       */
      const save = el('button', 'primary');
      const saveLabel = el('span', 'label');
      /*
       * The label follows the book, and the state object follows the label, so
       * a re-render of this Popup (switching the Dictionary Source, say) keeps
       * whichever side the user is on.
       */
      const showSaved = (saved) => {
        state.alreadySaved = saved;
        save.classList.toggle('saved', saved);
        save.replaceChildren(icon(saved ? ICONS.minus : ICONS.plus), saveLabel);
        saveLabel.textContent = saved ? '移出生词本' : '加入生词本';
      };
      showSaved(Boolean(state.alreadySaved));
      save.disabled = !state.canSave;
      save.onclick = async () => {
        save.disabled = true;
        try {
          if (state.alreadySaved) {
            // Whatever the book held for this Entry, it does not hold it now.
            // A stale "saved" state (removed from the Panel meanwhile) must not
            // leave the button claiming a removal that already happened.
            await onRemove?.(state.entry, state);
            showSaved(false);
          } else {
            // Saving is only claimed when the book actually took the Entry.
            showSaved((await onAdd?.(state.entry, state)) !== false);
          }
        } finally {
          // Never leave a dead button behind, whatever the book did.
          save.disabled = false;
        }
      };
      actions.append(save);
      if (!state.canSave) actions.append(el('span', 'hint', '过长,仅可查看'));
      addCopy(actions, state);
      actions.append(targetRow(state));
      wrap.append(actions);
    }
    setHidden(false);
    // Force a frame so the transition runs on first paint.
    host.getBoundingClientRect();
    wrap.classList.add('show');
    place(state.anchor);
  }

  /**
   * The speak action: one icon in both the word and the sentence layout, since
   * playing a recording is the same action for both.
   */
  function speakButton(state) {
    const speak = document.createElement('button');
    speak.className = 'speak';
    speak.title = '发音';
    speak.setAttribute('aria-label', '发音');
    speak.append(icon(ICONS.speaker));
    speak.onclick = () => onSpeak?.(state.term, state.sourceLang, state.audio);
    return speak;
  }

  /**
   * "Copy translation", the one action a sentence and a word have in common.
   * A refusal (permission policies block the clipboard on plenty of sites) is
   * not worth a message: the label simply stays put.
   */
  function addCopy(actions, state) {
    const button = el('button', 'ghost copy');
    const label = el('span', 'label', '复制译文');
    button.append(icon(ICONS.copy), label);
    button.onclick = async () => {
      let copied = false;
      try {
        copied = (await onCopy?.(state.translation)) === true;
      } catch {
        copied = false;
      }
      label.textContent = copied ? '已复制' : '复制译文';
    };
    actions.append(button);
    return button;
  }

  function place(anchor) {
    /*
     * Selection rects and `position: fixed` share the layout viewport's
     * coordinate space. The visual viewport's size is the honest bound on a
     * phone, where the on-screen keyboard shrinks what is visible while
     * `innerHeight` stays put; its offsets mark the part scrolled off when the
     * page is pinch-zoomed. Fall back to the window when it is unavailable.
     */
    const viewport = window.visualViewport;
    const viewportBox = {
      width: Math.min(window.innerWidth || Infinity, viewport?.width ?? Infinity),
      height: Math.min(window.innerHeight || Infinity, viewport?.height ?? Infinity),
    };
    const offsetTop = viewport?.offsetTop ?? 0;
    const offsetLeft = viewport?.offsetLeft ?? 0;

    const rect = anchor ?? { top: offsetTop + 20, height: 20, left: offsetLeft + 20 };
    const box = wrap.getBoundingClientRect();
    const { top, left } = placeNear({
      rect,
      box: { width: box.width, height: box.height },
      viewport: viewportBox,
      margin: touch ? 8 : 10,
    });
    Object.assign(wrap.style, { top: `${top}px`, left: `${left}px` });
  }

  function hide() {
    if (host.hidden) return;
    setHidden(true);
    wrap.classList.remove('show');
    current = null;
    onClose?.();
  }

  function contains(target) {
    return shadow.contains(target) || host.contains(target);
  }

  return { render, hide, contains, host, get current() { return current; } };
}

  return {
    createPopup,
  };
})();

// ---- src/ui/bubble.js ----
__mod_ui_bubble = (function () {
const { placeNear } = __mod_core_gesture;
/**
 * The Translate Bubble: a small floating button that appears next to a
 * finished Selection.
 *
 * It exists because phones have no double-click. Long-press-to-select is the
 * gesture phone users already know for copying, so the bubble hangs off that
 * gesture instead of asking for a new one. Tapping it opens the Popup.
 *
 * Desktop users never see it: they get the double-click.
 */


/**
 * The Bubble's side, in CSS pixels.
 *
 * 44 is the smallest target a finger hits reliably (and what the touch Popup's
 * buttons use), so it is written once and interpolated into the stylesheet and
 * the placement maths rather than kept in two places.
 */
const BUBBLE_SIZE = 44;

const STYLE = `
:host { all: initial; }
.bubble {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${BUBBLE_SIZE}px;
  height: ${BUBBLE_SIZE}px;
  border-radius: 50%;
  background: var(--tm-accent, #2563eb);
  color: var(--tm-accent-fg, #fff);
  font: 600 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.28);
  opacity: 0;
  transform: scale(.85);
  transition: opacity .1s ease, transform .1s ease;
  /* The host is a 0x0 fixed box at the viewport corner, so an invisible Bubble
     would sit on top of the page and swallow taps. It must not take pointers
     until it is shown. */
  visibility: hidden;
  pointer-events: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
}
.bubble.show {
  opacity: 1;
  transform: scale(1);
  visibility: visible;
  pointer-events: auto;
}
`;

function createBubble({ document, window, onTap }) {
  const host = document.createElement('div');
  host.setAttribute('data-tm', 'bubble-host');
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const button = document.createElement('div');
  button.className = 'bubble';
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', '翻译选中的词');
  button.textContent = '译';
  shadow.append(style, button);

  /*
   * `hidden` alone would not hide this: the host's inline `all: initial` sets
   * `display: inline`, which outranks the UA sheet's `[hidden]` rule, so the
   * zero-sized box would still sit at the viewport corner taking taps. The
   * display has to be toggled inline.
   */
  function setHidden(hidden) {
    host.hidden = hidden;
    host.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(host);

  let anchor = null;
  let lastActivation = 0;

  /*
   * Cancelling the touches that would normally start a new gesture keeps the
   * Selection alive: without this, tapping the Bubble counts as "a tap
   * elsewhere" and the browser collapses the Selection underneath us.
   */
  button.addEventListener('touchstart', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  function activate() {
    // A tap can deliver touchend *and* a synthetic click; only one may count.
    const now = Date.now();
    if (now - lastActivation < 500) return;
    lastActivation = now;
    if (!anchor) return;
    const rect = anchor;
    hide();
    onTap?.(rect);
  }

  // touchend is the reliable one on phones: cancelling touchstart above means
  // some engines never synthesise the click.
  button.addEventListener('touchend', (event) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  }, { capture: true });

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  }, { capture: true });

  function show(rect) {
    anchor = rect;
    place();
    setHidden(false);
    button.classList.add('show');
  }

  /**
   * Move the Bubble to follow its Selection while the page scrolls.
   *
   * The Bubble is `position: fixed`, so without this it would stay put over
   * whatever text happened to scroll underneath it and point at the wrong
   * words. A missing rect keeps the last known position: a transient layout
   * gap is not a reason to jump.
   */
  function reposition(rect) {
    if (host.hidden) return;
    anchor = rect ?? anchor;
    place();
  }

  function place() {
    const viewport = window.visualViewport;
    const margin = 8;

    /*
     * Centre the bubble on the Selection's first line and sit it just below.
     * `visualViewport` bounds it on a phone, where the keyboard and pinch-zoom
     * make `innerHeight` the wrong bound. The Selection is worth reporting even
     * when the rect is missing: the Popup anchors on the same rect.
     */
    const viewportBox = {
      width: Math.min(window.innerWidth || Infinity, viewport?.width ?? Infinity),
      height: Math.min(window.innerHeight || Infinity, viewport?.height ?? Infinity),
    };
    const offsetTop = viewport?.offsetTop ?? 0;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const fallback = { top: offsetTop + 24, height: 20, left: offsetLeft + 16, width: 0 };
    const target = anchor ?? fallback;
    const centred = {
      top: target.top,
      height: target.height ?? 20,
      left: (target.left ?? 0) + Math.max(0, ((target.width ?? 0) - BUBBLE_SIZE) / 2),
    };
    const { top, left } = placeNear({
      rect: centred,
      box: { width: BUBBLE_SIZE, height: BUBBLE_SIZE },
      viewport: viewportBox,
      margin,
      gap: 10,
    });

    Object.assign(button.style, { top: `${top}px`, left: `${left}px` });
  }

  function hide() {
    if (host.hidden) return;
    setHidden(true);
    button.classList.remove('show');
    anchor = null;
  }

  function contains(target) {
    return shadow.contains(target) || host.contains(target);
  }

  return {
    show,
    reposition,
    hide,
    contains,
    host,
    get visible() {
      return !host.hidden;
    },
  };
}

  return {
    createBubble,
  };
})();

// ---- src/ui/hint.js ----
__mod_ui_hint = (function () {
const { placeNear } = __mod_core_gesture;
/**
 * A short-lived label next to the Selection.
 *
 * It exists so an oversized selection answers with words instead of silence:
 * before this, selecting a whole page looked exactly like a broken script.
 * It reuses the Bubble's placement rule, then takes itself away.
 */


const STYLE = `
:host { all: initial; }
.hint {
  position: fixed;
  z-index: 2147483647;
  background: var(--tm-bg, #fff);
  color: var(--tm-fg, #1a1a1a);
  border: 1px solid var(--tm-border, #d8d8d8);
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,.18);
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  padding: 5px 9px;
  white-space: nowrap;
  opacity: 0;
  transition: opacity .12s ease;
  visibility: hidden;
  pointer-events: none;
}
.hint.show { opacity: 1; visibility: visible; }
`;

/** How long the hint stays: long enough to read, short enough not to nag. */
const VISIBLE_MS = 2000;

function createHint({ document, window, timers }) {
  const clock = timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id),
  };

  const host = document.createElement('div');
  host.setAttribute('data-tm', 'hint-host');
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const label = document.createElement('div');
  label.className = 'hint';
  label.setAttribute('role', 'status');
  label.textContent = '最多 400 字';
  shadow.append(style, label);

  /* Same reason as the Popup and the Bubble: the host's `all: initial` keeps
     an invisible box in the page, where it would swallow taps. */
  function setHidden(hidden) {
    host.hidden = hidden;
    host.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(host);

  let timer = null;

  function clearTimer() {
    if (timer === null) return;
    clock.clear(timer);
    timer = null;
  }

  function show(rect) {
    clearTimer();
    setHidden(false);
    label.classList.add('show');
    place(rect);
    timer = clock.set(() => {
      timer = null;
      hide();
    }, VISIBLE_MS);
  }

  function hide() {
    clearTimer();
    if (host.hidden) return;
    label.classList.remove('show');
    setHidden(true);
  }

  function place(rect) {
    // Measured after showing: a `display: none` box reports no size.
    const box = label.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportBox = {
      width: Math.min(window.innerWidth || Infinity, viewport?.width ?? Infinity),
      height: Math.min(window.innerHeight || Infinity, viewport?.height ?? Infinity),
    };
    const { top, left } = placeNear({
      rect: rect ?? { top: 24, left: 16, height: 20 },
      box: { width: box.width, height: box.height },
      viewport: viewportBox,
      margin: 8,
      gap: 10,
    });
    Object.assign(label.style, { top: `${top}px`, left: `${left}px` });
  }

  return { show, hide };
}

  return {
    createHint,
  };
})();

// ---- src/app/clipboard.js ----
__mod_app_clipboard = (function () {

/**
 * Copying a translation to the clipboard.
 *
 * Two paths, because neither is dependable on its own: the async Clipboard API
 * is missing on older engines and refused outright on many pages (the document
 * is not focused, the site's permission policy blocks it), while the old
 * `execCommand('copy')` still works in more places but needs a real selection.
 * A failure is reported as `false` and never thrown: copying is a convenience,
 * not something that should ever look like an error in the Popup.
 */
function createCopyText({ navigator, document }) {
  return async function copyText(text) {
    if (!text) return false;

    const clipboard = navigator?.clipboard;
    if (typeof clipboard?.writeText === 'function') {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        /* fall through to the old command */
      }
    }

    return copyWithSelection(text, document);
  };
}

/**
 * The legacy path: put the text in a scratch textarea, select it, run `copy`.
 *
 * The textarea must be out of the way but still selectable, and it must be
 * removed afterwards -- leaving it in the page would both litter the host DOM
 * and steal the focus the next time the user typed.
 */
function copyWithSelection(text, document) {
  if (typeof document?.execCommand !== 'function') return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area?.remove?.();
  }
}

  return {
    createCopyText,
  };
})();

// ---- src/core/gloss.js ----
__mod_core_gloss = (function () {
const { normalizeTerm, scriptOf } = __mod_core_normalize;
/**
 * Build the matcher for one page pass.
 *
 * Only words already in the Vocabulary Book are matched: the glossary is not a
 * full-page translation feature, and matching arbitrary words would turn every
 * scroll into thousands of provider requests.
 *
 * Latin terms match as whole words, longest first, so "take off" wins over
 * "take" and "run" does not match inside "running". CJK terms need no word
 * boundaries, so they match by plain substring.
 */
function createMatcher(translationMap) {
  const terms = [...translationMap.keys()]
    .map((term) => ({ term, translation: translationMap.get(term) }))
    .filter(({ term }) => term.length > 0)
    .sort((a, b) => b.term.length - a.term.length);

  if (terms.length === 0) {
    return { terms: [], find: () => [] };
  }

  const latin = terms.filter(({ term }) => scriptOf(term) === 'latin');
  const other = terms.filter(({ term }) => scriptOf(term) !== 'latin');

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [];
  if (latin.length) {
    parts.push(
      `(?<![\\p{L}\\p{N}])(${latin.map(({ term }) => escape(term)).join('|')})(?![\\p{L}\\p{N}])`,
    );
  }
  for (const { term } of other) parts.push(`(${escape(term)})`);

  const pattern = new RegExp(parts.join('|'), 'giu');
  const lookup = new Map(terms.map(({ term, translation }) => [term, translation]));

  return {
    terms,
    find(text) {
      const matches = [];
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        const translation = lookup.get(match[0].toLowerCase());
        if (translation === undefined) continue;
        matches.push({ start: match.index, end: match.index + match[0].length, translation });
      }
      return matches;
    },
  };
}

/**
 * Split a text node's content into plain and glossed runs.
 * Returns `[]` when nothing matches, so callers can skip the DOM entirely.
 */
function segment(text, matcher) {
  const matches = matcher.find(text);
  if (matches.length === 0) return [];
  const pieces = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) pieces.push({ type: 'text', text: text.slice(cursor, match.start) });
    pieces.push({ type: 'gloss', text: text.slice(match.start, match.end), translation: match.translation });
    cursor = match.end;
  }
  if (cursor < text.length) pieces.push({ type: 'text', text: text.slice(cursor) });
  return pieces;
}

/** Text that must never be rewritten: code, scripts, and anything not prose. */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS',
]);

function isSkippableElement(element) {
  if (!element) return false;
  if (SKIP_TAGS.has(element.tagName)) return true;
  // `isContentEditable` is missing in some DOM implementations, so the
  // attribute is checked as well.
  if (element.isContentEditable) return true;
  if (element.getAttribute?.('contenteditable') === '' || element.getAttribute?.('contenteditable') === 'true') {
    return true;
  }
  const role = element.getAttribute?.('role');
  if (role === 'textbox' || role === 'code' || role === 'presentation') return true;
  return false;
}

/**
 * Cheap pre-filter: does this text plausibly contain a term at all?
 * Skips short fragments and text that is only digits or whitespace.
 */
function isProseText(text, minLength = 2) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < minLength) return false;
  if (/^[\s\d\p{P}]+$/u.test(trimmed)) return false;
  return true;
}

/** Guard against re-processing our own DOM writes. */
const MARKER_CLASS = 'tm-gloss-wrapped';
const ANNOTATION_CLASS = 'tm-gloss-annot';

function shouldSkipNode(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest(`.${MARKER_CLASS}`)) return true;
  let element = parent;
  while (element) {
    if (isSkippableElement(element)) return true;
    element = element.parentElement;
  }
  return false;
}

  return {
    normalizeTerm,
    createMatcher,
    segment,
    SKIP_TAGS,
    isSkippableElement,
    isProseText,
    MARKER_CLASS,
    ANNOTATION_CLASS,
    shouldSkipNode,
  };
})();

// ---- src/ui/gloss-layer.js ----
__mod_ui_gloss_layer = (function () {
const { MARKER_CLASS, ANNOTATION_CLASS, createMatcher, segment, isProseText, shouldSkipNode } = __mod_core_gloss;
const STYLE_ID = 'tm-gloss-style';
/*
 * The gloss lives inside the host page's prose, so it must not fight it:
 *
 *   - `color: currentColor` rather than a fixed grey. A grey that reads on a
 *     white article vanishes on a dark theme and on a coloured heading; the
 *     colour of the text around it is legible wherever that text is.
 *   - The colour is then dimmed, so the gloss stays secondary. `opacity` is the
 *     fallback every engine has; `color-mix` is the upgrade, because a real
 *     translucent colour leaves the parentheses at the same weight instead of
 *     multiplying the whole element's alpha.
 *   - Every property that decides how the gloss looks or behaves is marked
 *     `!important`. This stylesheet shares an origin and a cascade with the
 *     page's own CSS, so without it a single `article span { ... }` rule would
 *     take the gloss back.
 */
const STYLE_TEXT = `
.${ANNOTATION_CLASS} {
  font-size: 0.78em !important;
  color: currentColor !important;
  opacity: 0.62 !important;
  margin-left: 0.18em !important;
  margin-right: 0.12em !important;
  white-space: nowrap !important;
  user-select: none !important;
  cursor: help !important;
}
@supports (color: color-mix(in srgb, currentColor 62%, transparent)) {
  .${ANNOTATION_CLASS} {
    color: color-mix(in srgb, currentColor 62%, transparent) !important;
    opacity: 1 !important;
  }
}
.${ANNOTATION_CLASS}::before { content: "("; }
.${ANNOTATION_CLASS}::after { content: ")"; }
`;

/**
 * Inject inline glosses (the term's translation, in parentheses, right after
 * the word) for terms already in the Vocabulary Book.
 *
 * This is the part most likely to break a page: it rewrites text nodes, so the
 * host site's own re-renders can wipe the annotation, and a careless scan can
 * corrupt code blocks or editable fields. Hence:
 *   - one pass over visible text only, via IntersectionObserver;
 *   - every text node it touches gets wrapped in a marker element, so a
 *     re-scan cannot double-wrap and `shouldSkipNode` skips our own output;
 *   - our own DOM writes are flagged with `suppressed`, so the MutationObserver
 *     does not loop.
 */
function createGlossLayer({ document, window, translationMap }) {
  let matcher = createMatcher(translationMap);
  let observer = null;
  let mutationObserver = null;
  let running = false;
  let active = false;
  // Set while we are rewriting the DOM ourselves, so the MutationObserver does
  // not treat our own annotations as new content and rescan forever.
  let suppressed = false;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function glossTextNode(node) {
    if (!node.isConnected) return;
    if (shouldSkipNode(node)) return;
    const text = node.nodeValue;
    if (!isProseText(text)) return;
    const pieces = segment(text, matcher);
    if (pieces.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const piece of pieces) {
      if (piece.type === 'text') {
        fragment.append(document.createTextNode(piece.text));
        continue;
      }
      const marker = document.createElement('span');
      marker.className = MARKER_CLASS;
      marker.append(document.createTextNode(piece.text));
      const annot = document.createElement('span');
      annot.className = ANNOTATION_CLASS;
      annot.textContent = piece.translation;
      marker.append(annot);
      fragment.append(marker);
    }

    suppressed = true;
    try {
      node.parentNode.replaceChild(fragment, node);
    } finally {
      suppressed = false;
    }
  }

  function walk(root) {
    if (!root) return;
    // NodeFilter is read off the injected window rather than the global, so the
    // layer also runs under jsdom, where the global does not exist.
    const { NodeFilter } = window;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isProseText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) glossTextNode(node);
  }

  /**
   * Block elements currently near the viewport that contain no block-level
   * children — the actual paragraphs of prose. Containers are skipped so the
   * same text node is never visited twice.
   */
  function visibleRoots() {
    const BLOCK_LIST = ['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dd', 'dt', 'blockquote', 'figcaption', 'article', 'section', 'div'];
    const BLOCKS = BLOCK_LIST.join(',');
    const vh = window.innerHeight || 800;
    const roots = [];
    for (const element of document.querySelectorAll(BLOCKS)) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom < -200 || rect.top > vh + 400) continue;
      if (rect.width === 0 && rect.height === 0) continue;
      // Keep only the deepest blocks in view: a container is skipped in favour
      // of the paragraphs inside it, so no text node is visited twice and the
      // viewport filter is not defeated by one page-wide <div>.
      if (element.querySelector(BLOCKS)) continue;
      roots.push(element);
    }
    return roots;
  }

  /**
   * One annotation pass over whatever is currently in the viewport.
   * `force` runs it even while the layer is stopped, which is what tests and
   * the panel's refresh need.
   */
  function pass({ force = false } = {}) {
    if ((!active && !force) || running) return;
    running = true;
    suppressed = true;
    try {
      ensureStyle();
      for (const root of visibleRoots()) {
        // No "already has a marker -> skip the whole root" shortcut: roots
        // overlap (a <div> contains every <p> in it), so that check would stop
        // glossing new content under a container we had already touched.
        walk(root);
      }
    } finally {
      suppressed = false;
      running = false;
    }
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    (window.requestIdleCallback ?? ((fn) => window.setTimeout(fn, 120)))(() => {
      pending = false;
      pass();
    });
  }

  function start() {
    if (active) return;
    active = true;
    ensureStyle();
    pass();
    observer = new window.IntersectionObserver(() => schedule(), { rootMargin: '300px' });
    for (const element of document.querySelectorAll('p, li, td, article, section')) {
      observer.observe(element);
    }
    mutationObserver = new window.MutationObserver((records) => {
      if (suppressed) return;
      for (const record of records) {
        if (record.type === 'childList' && record.addedNodes.length > 0) {
          schedule();
          return;
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule, { passive: true });
  }

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    window.removeEventListener('resize', schedule);
  }

  /**
   * Undo every annotation this layer made, and put the page back.
   *
   * Each marker is replaced by the text it wrapped — the marker's first child,
   * which is the word as the page had it, never `textContent`, which would
   * splice the translation into the prose.
   *
   * Text nodes are then merged only inside a parent whose children are *all*
   * text. A parent that still holds an element belongs to the page's own
   * structure: a React or Vue view holds references to the nodes it rendered,
   * so merging across them makes its next re-render restore stale content or
   * place it wrong. `document.normalize()` would merge the whole document,
   * which is exactly the failure this avoids.
   */
  function restoreMarkers() {
    const touched = new Set();
    suppressed = true;
    try {
      for (const marker of [...document.querySelectorAll(`.${MARKER_CLASS}`)]) {
        const parent = marker.parentNode;
        marker.replaceWith(document.createTextNode(originalTextOf(marker)));
        if (parent) touched.add(parent);
      }

      for (const parent of touched) {
        if (!parent.isConnected) continue;
        const textOnly = [...parent.childNodes].every((node) => node.nodeType === 3);
        if (textOnly) parent.normalize();
      }
    } finally {
      suppressed = false;
    }
  }

  function refresh(nextMap, { force = false } = {}) {
    matcher = createMatcher(nextMap);
    // Drop every annotation we made and restore the original text, so a changed
    // vocabulary never leaves stale translations on the page.
    restoreMarkers();
    if (active || force) pass({ force });
  }

  return { start, stop, refresh, pass, get active() { return active; } };
}

/**
 * The text a marker wrapped.
 *
 * A marker is the original text node followed by the annotation, so the first
 * child is the word exactly as the page had it. The fallback rebuilds that word
 * from every child except the annotation — `marker.textContent` would splice
 * the translation into the prose.
 */
function originalTextOf(marker) {
  const first = marker.firstChild;
  if (first?.nodeType === 3) return first.nodeValue;
  const annotation = marker.querySelector(`.${ANNOTATION_CLASS}`);
  return [...marker.childNodes]
    .filter((node) => node !== annotation)
    .map((node) => node.textContent ?? '')
    .join('');
}

  return {
    createGlossLayer,
  };
})();

// ---- src/app/file-io.js ----
__mod_app_file_io = (function () {

/**
 * Moving the Vocabulary Book in and out of the browser as a file.
 *
 * Saving prefers the File System Access API, which is the only path that gives
 * the user a real "choose where to save" dialog; every other engine (Firefox,
 * older Chromium, a userscript sandbox that hides the API) falls back to a
 * blob download, which still lands in the browser's download flow.
 *
 * Opening uses an `<input type="file">`. It is the one picker that works in
 * every engine and needs no secure context, and unlike `showOpenFilePicker`
 * it also works on mobile browsers.
 */

const CSV_ACCEPT = '.csv,text/csv';

/** `生词本-2026-10-26.csv`: sorts by date in a folder of exports. */
function csvFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `生词本-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

/**
 * Write `text` to a file the user picks. Resolves to `{saved, cancelled}`;
 * only a picker that never opened falls through to the download path, an
 * explicit cancel from the user ends here, and a failure after a destination
 * has been chosen rejects — the text must not land somewhere else silently.
 */
async function saveTextFile(window, { filename, text, type = 'text/csv' }) {
  const view = window;
  const blob = new Blob([text], { type: `${type};charset=utf-8` });

  if (typeof view?.showSaveFilePicker === 'function') {
    let handle = null;
    try {
      handle = await view.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }],
      });
    } catch (error) {
      if (error?.name === 'AbortError') return { saved: false, cancelled: true };
      /*
       * The API exists but refused before any file was chosen (a userscript
       * sandbox, permissions): the download below is still the export the user
       * asked for.
       */
    }

    if (handle) {
      /*
       * Past this point the user has picked a destination. If the write fails,
       * a download would put the same text somewhere else without saying so;
       * the rejection goes to the panel instead.
       */
      const writable = await handle.createWritable();
      let failure = null;
      try {
        await writable.write(blob);
      } catch (error) {
        failure = error;
      } finally {
        // Closing releases the temporary file even when the write failed.
        try {
          await writable.close();
        } catch (error) {
          if (!failure) failure = error;
        }
      }
      if (failure) throw failure;
      return { saved: true, cancelled: false };
    }
  }

  const url = view.URL.createObjectURL(blob);
  const link = view.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  (view.document.body ?? view.document.documentElement).append(link);
  link.click();
  link.remove();
  // The click starts the download; the URL must outlive this tick to be read.
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
  return { saved: true, cancelled: false };
}

/**
 * How long after the page regains focus to wait for the picker's `change`
 * event. Chromium fires `cancel` when the dialog is dismissed, but other
 * engines only refocus the page, which would leave the promise pending forever.
 */
const PICKER_SETTLE_MS = 1000;

/**
 * Ask for a text file and resolve with its contents, or `null` if the user
 * closed the picker without choosing one.
 */
function pickTextFile(document, { accept = CSV_ACCEPT } = {}) {
  return new Promise((resolve, reject) => {
    const view = document.defaultView ?? globalThis;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // Kept selectable but invisible: the picker only opens from a real input.
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';

    let settled = false;
    let timer = null;

    const cleanup = () => {
      input.remove();
      if (timer !== null) {
        view.clearTimeout(timer);
        timer = null;
      }
      view.removeEventListener?.('focus', onFocus);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    /*
     * The picker closes (or the engine brings the page back) before `change`
     * where that event exists. Looking at the file list a moment later catches
     * the engines that never fire `cancel`; an empty list means dismissal,
     * while a chosen file's `change` arrives first and calls off the timer.
     */
    function onFocus() {
      if (settled) return;
      timer = view.setTimeout(() => {
        timer = null;
        if (!input.files?.length) finish(null);
      }, PICKER_SETTLE_MS);
    }

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish(await readText(file));
      } catch (error) {
        fail(error);
      }
    };
    // Chromium 113+ fires this when the picker is dismissed.
    input.oncancel = () => finish(null);

    view.addEventListener?.('focus', onFocus, { once: true });
    (document.body ?? document.documentElement).append(input);
    input.click();
  });
}

function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

  return {
    CSV_ACCEPT,
    csvFilename,
    saveTextFile,
    pickTextFile,
  };
})();

// ---- src/ui/panel.js ----
__mod_ui_panel = (function () {
const { THEMES } = __mod_core_theme;
const { DEFAULT_DICTIONARY, DICTIONARY_CHOICES } = __mod_core_dictionaries;
const { groupBySourceLang } = __mod_core_store;
const { CSV_ACCEPT, csvFilename, pickTextFile, saveTextFile } = __mod_app_file_io;
/**
 * The Panel: vocabulary management and settings, as an in-page overlay.
 *
 * Everything lives behind a Shadow DOM so host styles cannot reach it. The
 * panel is opened from the userscript menu, because it is not part of normal
 * reading and should not be one stray click away.
 */





/** How each theme reads in the settings control. UI text, so it lives here. */
const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };

/** Words a folded group shows: the newest ones, since those were just saved. */
const GROUP_PREVIEW = 3;

const STYLE = `
:host { all: initial; }
.backdrop {
  /* padding + border-box, rather than margins carved out of the dialog's own
     width and height: the dialog below then sizes itself as a percentage of
     this box, and the two cannot disagree about how much room there is. */
  position: fixed; inset: 0; z-index: 2147483646;
  box-sizing: border-box; padding: 16px;
  background: rgba(0,0,0,.35);
  display: flex;
  /* "safe" falls back to flex-start when the dialog is taller than the box, so
     the title, the tabs and the close button stay on screen instead of being
     pushed off both ends by centring. */
  align-items: center; align-items: safe center;
  justify-content: center;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: var(--tm-fg, #1a1a1a);
}
.dialog {
  width: min(720px, 100%);
  /* A percentage of the backdrop, not vh. On a phone the fixed box, the
     visible viewport and vh can each mean something different: vh ignores the
     browser chrome, and a pinch-zoom shrinks what is visible without
     shrinking the box. Measuring against the very box the dialog is laid out in
     is the only cap that always matches what the user can see; it is what kept
     a long book from pushing the title under the status bar. */
  max-height: min(640px, 100%);
  background: var(--tm-bg, #fff); border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.3);
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid var(--tm-border, #ececec);
}
h1 { font-size: 16px; margin: 0; font-weight: 600; }
.tabs { display: flex; gap: 4px; margin-left: auto; }
.tabs button {
  all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px;
  color: var(--tm-muted, #555); font-size: 13px;
}
.tabs button[aria-selected="true"] { background: var(--tm-hover, #eef2ff); color: var(--tm-accent, #1d4ed8); }
.close { all: unset; cursor: pointer; color: var(--tm-muted, #888); padding: 4px 8px; font-size: 18px; }
.body {
  /* The list scrolls here, never in the dialog. A flex item refuses to shrink
     below its content unless min-height is zeroed, so without this a long book
     would overflow the cap above: the rows past the edge would simply be cut
     off with no way to scroll to them. */
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 0;
  /* A visible scrollbar, not the phone's hit-and-miss overlay one: with a few
     hundred entries there is otherwise nothing on screen saying the list goes
     on below the fold. */
  scrollbar-width: thin;
  scrollbar-color: var(--tm-muted, #8a8a8a) transparent;
}
/*
 * Chromium 121+ and Safari 18.2+ honour the two standard properties above and
 * then ignore ::-webkit-scrollbar entirely, so these rules only take effect
 * where the standard ones are unknown — older WebKit, which otherwise draws
 * its own overlay scrollbar.
 */
@supports not (scrollbar-width: thin) {
  .body::-webkit-scrollbar { width: 8px; }
  .body::-webkit-scrollbar-track { background: transparent; }
  .body::-webkit-scrollbar-thumb {
    background: var(--tm-muted, #8a8a8a); border-radius: 8px;
    border: 2px solid var(--tm-bg, #fff); /* thins the thumb without a second colour */
  }
}
.toolbar {
  /* The search box outlives the scroll. With a few hundred entries, scrolling
     back to the top to filter again is otherwise the only way to find a word. */
  position: sticky; top: 0; z-index: 1;
  padding: 14px 18px 10px;
  background: var(--tm-bg, #fff);
}
.search {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--tm-border, #ddd); border-radius: 8px; font: inherit;
  background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
ul.entries { list-style: none; margin: 0; padding: 0 18px; }
/*
 * A language heading, not a list row: the entries are grouped under it, so the
 * count travels with the name instead of repeating on every row.
 */
.group-title {
  margin: 0; padding: 12px 18px 2px;
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
  color: var(--tm-muted, #6b6b6b);
}
/*
 * The heading is the control that unfolds the group. A group of three or fewer
 * has nothing to unfold, so its heading stays plain text.
 */
.group-title > .group-toggle {
  all: unset; cursor: pointer;
  display: inline-flex; align-items: baseline; gap: 6px;
  border-radius: 6px; padding: 3px 7px; margin: -3px -7px;
}
.group-title > .group-toggle:hover { background: var(--tm-hover, #f7f7f7); color: var(--tm-fg, #1a1a1a); }
.group-title > .group-toggle:focus-visible { outline: 2px solid var(--tm-accent, #2563eb); outline-offset: 1px; }
.group-toggle .chevron {
  flex: none; width: 9px; height: 9px; align-self: center;
  transition: transform .15s ease;
}
.group-toggle[aria-expanded="true"] .chevron { transform: rotate(90deg); }
.group-count { font-weight: 400; opacity: .75; }
ul.entries li {
  display: flex; gap: 10px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px solid var(--tm-border, #f2f2f2);
}
.term { font-weight: 600; }
.meta { color: var(--tm-muted, #8a8a8a); font-size: 12px; }
.translation { margin-left: auto; color: var(--tm-fg, #333); opacity: .82; }
button.danger { all: unset; cursor: pointer; color: var(--tm-danger, #b91c1c); font-size: 12px; padding: 2px 6px; }
button.small {
  all: unset; cursor: pointer; border: 1px solid var(--tm-border, #ddd); border-radius: 7px;
  padding: 4px 10px; font-size: 12px; color: var(--tm-fg, #1a1a1a);
}
button.small:hover { background: var(--tm-hover, #f7f7f7); }
.row { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
label.switch { display: flex; gap: 8px; align-items: center; cursor: pointer; }
select.theme, select.dictionary {
  padding: 6px 8px; border: 1px solid var(--tm-border, #ddd); border-radius: 7px;
  font: inherit; background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
.empty { color: var(--tm-muted, #999); padding: 24px 18px; text-align: center; }
/* The UA sheet's [hidden] rule loses to any author display declaration, and
   .row sets one; without this, a hidden row and a hidden button still paint. */
[hidden] { display: none !important; }
.settings { padding: 14px 18px; }
.status { font-size: 12px; color: var(--tm-muted, #555); }

/* Finger-sized hit areas; the desktop sizes assume a mouse. */
@media (pointer: coarse) {
  .tabs button { padding: 10px 12px; font-size: 14px; }
  .close { padding: 10px 14px; }
  button.small, button.danger { padding: 9px 12px; font-size: 13px; }
  ul.entries li { padding: 11px 0; }
  .search { font-size: 16px; } /* below 16px iOS zooms the page on focus */
  .backdrop { padding: 8px; }
  .body::-webkit-scrollbar { width: 10px; }
  .toolbar { padding: 12px 14px 10px; }
  ul.entries { padding: 0 14px; }
  .group-title { padding: 12px 14px 2px; }
  .group-title > .group-toggle { padding: 9px 10px; margin: -9px -10px; }
  .empty { padding: 24px 14px; }
  .settings { padding: 12px 14px; }
}
`;

function createPanel({
  document,
  settings,
  book,
  host,
  onGlossChange,
  onClearCache,
  onLookupToggle,
  onThemeChange,
  lookupSwitchLabel = '双击取词',
  touch = false,
  fileIO = { saveTextFile, pickTextFile },
}) {
  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-tm', 'panel-host');
  hostEl.style.cssText = 'all:initial;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.append(style);

  /*
   * The inline `all: initial` defeats the UA sheet's `[hidden]` rule (author
   * origin wins), so the display has to be toggled inline as well.
   */
  function setHidden(hidden) {
    hostEl.hidden = hidden;
    hostEl.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(hostEl);

  let tab = 'book';
  let filter = '';
  /*
   * Which language groups the reader has unfolded. Kept outside the render so
   * deleting a word or switching tabs does not fold a group they just opened.
   */
  const expandedGroups = new Set();

  function close() {
    setHidden(true);
    shadow.querySelector('.backdrop')?.remove();
  }

  function render() {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    const header = document.createElement('header');
    const title = document.createElement('h1');
    title.textContent = '翻译生词本';
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const [id, label] of [['book', '生词本'], ['settings', '设置']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('aria-selected', String(tab === id));
      button.onclick = () => {
        tab = id;
        render();
      };
      tabs.append(button);
    }
    const closeButton = document.createElement('button');
    closeButton.className = 'close';
    closeButton.textContent = '×';
    closeButton.title = '关闭';
    closeButton.onclick = close;
    header.append(title, tabs, closeButton);

    const body = document.createElement('div');
    body.className = 'body';
    body.append(tab === 'book' ? renderBook() : renderSettings());

    dialog.append(header, body);
    backdrop.append(dialog);
    shadow.querySelector('.backdrop')?.remove();
    shadow.append(backdrop);
    setHidden(false);
  }

  function renderBook() {
    /*
     * The search sits in its own sticky row above the list rather than inside
     * the scroll area, so a book with hundreds of entries can still be
     * filtered without scrolling back to the top first.
     */
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const search = document.createElement('input');
    search.className = 'search';
    search.placeholder = '搜索单词或译文…';
    search.value = filter;
    toolbar.append(search);

    let listed = buildList();
    // Only the list is rebuilt on input: replacing the input too would take
    // the caret and the on-screen keyboard's composition with it.
    search.oninput = () => {
      filter = search.value;
      const next = buildList();
      listed.replaceWith(next);
      listed = next;
    };

    const fragment = document.createDocumentFragment();
    fragment.append(toolbar, listed);
    return fragment;
  }

  function buildList() {
    const entries = book
      .all()
      .filter((entry) => {
        if (!filter) return true;
        const needle = filter.toLowerCase();
        return entry.term.toLowerCase().includes(needle) || entry.translation.includes(filter);
      })
      .sort((a, b) => b.addedAt - a.addedAt);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = filter ? '没有匹配的词条' : '生词本还是空的。双击网页上的词试试。';
      return empty;
    }

    /*
     * Newest first inside a group, but groups themselves keep a language order:
     * sorting by recency alone would move a whole language up the book because
     * of one word added today.
     */
    const container = document.createElement('div');
    container.className = 'groups';
    for (const group of groupBySourceLang(entries)) {
      container.append(renderGroup(group));
    }
    return container;
  }

  function chevron() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'chevron');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M9 5l7 7-7 7');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  /**
   * One language section. It opens folded to the newest few words: a book of
   * hundreds would otherwise be a wall of rows, and the newest words are the
   * ones just saved. The full group is one click on its heading away.
   */
  function renderGroup(group) {
    const total = group.entries.length;
    // A search is a request to find one particular word; folding a match away
    // would hide the very row the reader asked for.
    const searching = Boolean(filter);
    const expanded = searching || expandedGroups.has(group.lang);
    const visible = expanded ? group.entries : group.entries.slice(0, GROUP_PREVIEW);

    const section = document.createElement('section');
    section.className = 'group';
    section.dataset.lang = group.lang;

    const title = document.createElement('h2');
    title.className = 'group-title';
    const label = document.createTextNode(group.label);
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(total);

    if (total > GROUP_PREVIEW && !searching) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'group-toggle';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.title = expanded ? '收起' : `展开全部 ${total} 个`;
      toggle.append(label, count, chevron());
      toggle.onclick = () => {
        if (expandedGroups.has(group.lang)) expandedGroups.delete(group.lang);
        else expandedGroups.add(group.lang);
        const next = renderGroup(group);
        section.replaceWith(next);
        // The clicked button was just replaced, so put focus on its successor
        // instead of dropping it back to the top of the page.
        next.querySelector('.group-toggle')?.focus({ preventScroll: true });
      };
      title.append(toggle);
    } else {
      title.append(label, count);
    }

    const list = document.createElement('ul');
    list.className = 'entries';
    for (const entry of visible) {
      const li = document.createElement('li');
      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = entry.term;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [entry.phonetic, `${entry.sourceLang}→${entry.targetLang}`].filter(Boolean).join(' · ');
      const translation = document.createElement('span');
      translation.className = 'translation';
      translation.textContent = entry.translation;
      const remove = document.createElement('button');
      remove.className = 'danger';
      remove.textContent = '删除';
      remove.onclick = () => {
        book.remove(entry.entryId);
        onGlossChange?.();
        rerenderBody();
      };
      li.append(term, meta, translation, remove);
      list.append(li);
    }
    section.append(title, list);
    return section;
  }

  function rerenderBody() {
    const body = shadow.querySelector('.body');
    if (!body) return;
    body.replaceChildren(tab === 'book' ? renderBook() : renderSettings());
  }

  function renderSettings() {
    const wrap = document.createElement('div');
    wrap.className = 'settings';

    const lookupRow = document.createElement('div');
    lookupRow.className = 'row';
    const lookupLabel = document.createElement('label');
    lookupLabel.className = 'switch';
    const lookupBox = document.createElement('input');
    lookupBox.type = 'checkbox';
    lookupBox.checked = settings.lookupEnabled;
    lookupBox.onchange = () => {
      settings.setLookupEnabled(lookupBox.checked);
      onLookupToggle?.(lookupBox.checked);
    };
    lookupLabel.append(lookupBox, document.createTextNode(lookupSwitchLabel));
    lookupRow.append(lookupLabel);

    /*
     * A reading preference, not a per-lookup choice: someone who wants sound
     * wants it on every word, so it is a setting rather than a Popup toggle.
     */
    const autoSpeakRow = document.createElement('div');
    autoSpeakRow.className = 'row';
    const autoSpeakLabel = document.createElement('label');
    autoSpeakLabel.className = 'switch';
    const autoSpeakBox = document.createElement('input');
    autoSpeakBox.type = 'checkbox';
    autoSpeakBox.checked = Boolean(settings.autoSpeak);
    autoSpeakBox.onchange = () => settings.setAutoSpeak?.(autoSpeakBox.checked);
    autoSpeakLabel.append(autoSpeakBox, document.createTextNode('默认播放语音'));
    const autoSpeakHint = document.createElement('span');
    autoSpeakHint.className = 'status';
    autoSpeakHint.textContent = '查到单词后自动朗读';
    autoSpeakRow.append(autoSpeakLabel, autoSpeakHint);

    const themeRow = document.createElement('div');
    themeRow.className = 'row';
    const themeLabel = document.createElement('span');
    themeLabel.textContent = '外观:';
    const themeSelect = document.createElement('select');
    themeSelect.className = 'theme';
    for (const value of THEMES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = THEME_LABELS[value];
      themeSelect.append(option);
    }
    themeSelect.value = settings.theme;
    themeSelect.onchange = () => {
      settings.setTheme(themeSelect.value);
      onThemeChange?.();
    };
    themeRow.append(themeLabel, themeSelect);

    /*
     * The Default Dictionary is a setting because it is the source every new
     * Popup starts with. It only covers English: Korean has one source, so
     * there is nothing to choose there. The Popup's own select is the
     * temporary override.
     */
    const dictionaryRow = document.createElement('div');
    dictionaryRow.className = 'row';
    const dictionaryLabel = document.createElement('span');
    dictionaryLabel.textContent = '英文释义词典:';
    const dictionarySelect = document.createElement('select');
    dictionarySelect.className = 'dictionary';
    for (const [value, label] of DICTIONARY_CHOICES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      dictionarySelect.append(option);
    }
    const savedDictionary = settings.dictionary ?? DEFAULT_DICTIONARY;
    dictionarySelect.value = DICTIONARY_CHOICES.some(([value]) => value === savedDictionary)
      ? savedDictionary
      : DEFAULT_DICTIONARY;
    dictionarySelect.onchange = () => settings.setDictionary?.(dictionarySelect.value);
    const dictionaryHint = document.createElement('span');
    dictionaryHint.className = 'status';
    dictionaryHint.textContent = '浮窗里可临时换;韩语词另有词典';
    dictionaryRow.append(dictionaryLabel, dictionarySelect, dictionaryHint);

    const glossRow = document.createElement('div');
    glossRow.className = 'row';
    const glossLabel = document.createElement('label');
    glossLabel.className = 'switch';
    const glossBox = document.createElement('input');
    glossBox.type = 'checkbox';
    glossBox.checked = settings.glossOn(host);
    glossBox.onchange = () => {
      settings.setGlossOn(host, glossBox.checked);
      onGlossChange?.();
    };
    glossLabel.append(glossBox, document.createTextNode(`在当前站点 (${host}) 显示注音`));
    glossRow.append(glossLabel);

    const ioRow = document.createElement('div');
    ioRow.className = 'row';
    const exportButton = document.createElement('button');
    exportButton.className = 'small';
    exportButton.textContent = '导出到文件';
    const importButton = document.createElement('button');
    importButton.className = 'small';
    importButton.textContent = '从文件导入';
    const ioStatus = document.createElement('span');
    ioStatus.className = 'status';
    ioRow.append(exportButton, importButton, ioStatus);

    /*
     * Import replaces or merges, and only the user knows which one they want,
     * so the file is read first and the choice is asked afterwards. Asking
     * before choosing a file would put a modal in front of a cancelled dialog.
     */
    const importPrompt = document.createElement('div');
    importPrompt.className = 'row';
    importPrompt.hidden = true;
    const importQuestion = document.createElement('span');
    importQuestion.className = 'status';
    const overwriteButton = document.createElement('button');
    overwriteButton.className = 'small';
    overwriteButton.textContent = '覆盖现有';
    const mergeButton = document.createElement('button');
    mergeButton.className = 'small';
    mergeButton.textContent = '合并';
    const cancelImportButton = document.createElement('button');
    cancelImportButton.className = 'small';
    cancelImportButton.textContent = '取消';
    importPrompt.append(importQuestion, overwriteButton, mergeButton, cancelImportButton);

    let pendingCsv = null;

    function closeImportPrompt() {
      pendingCsv = null;
      importPrompt.hidden = true;
    }

    function runImport(mode) {
      try {
        const report = book.importCsv(pendingCsv, { mode });
        ioStatus.textContent =
          mode === 'replace'
            ? `已覆盖:导入 ${report.added} 条,跳过 ${report.skipped} 条`
            : `导入完成:新增 ${report.added},更新 ${report.updated},跳过 ${report.skipped}`;
        onGlossChange?.();
      } catch (error) {
        ioStatus.textContent = `导入失败:${error.message}`;
      } finally {
        closeImportPrompt();
      }
    }

    exportButton.onclick = async () => {
      const count = book.all().length;
      if (count === 0) {
        ioStatus.textContent = '生词本是空的,没有可导出的内容';
        return;
      }
      ioStatus.textContent = '正在导出…';
      try {
        const result = await fileIO.saveTextFile(document.defaultView ?? globalThis, {
          filename: csvFilename(),
          text: book.exportCsv(),
        });
        ioStatus.textContent = result?.cancelled ? '已取消导出' : `已导出 ${count} 条`;
      } catch (error) {
        ioStatus.textContent = `导出失败:${error.message}`;
      }
    };

    importButton.onclick = async () => {
      ioStatus.textContent = '';
      let text;
      try {
        text = await fileIO.pickTextFile(document, { accept: CSV_ACCEPT });
      } catch (error) {
        ioStatus.textContent = `读取文件失败:${error.message}`;
        return;
      }
      if (text === null || text === undefined) return; // picker dismissed
      pendingCsv = text;
      const existing = book.all().length;
      importQuestion.textContent =
        existing === 0
          ? '生词本当前为空,导入会加入文件里的词条。'
          : `生词本现有 ${existing} 条:合并会保留它们,覆盖会先清空再导入。`;
      importPrompt.hidden = false;
    };

    overwriteButton.onclick = () => runImport('replace');
    mergeButton.onclick = () => runImport('merge');
    cancelImportButton.onclick = () => {
      closeImportPrompt();
      ioStatus.textContent = '已取消导入';
    };

    const cacheRow = document.createElement('div');
    cacheRow.className = 'row';
    const clearButton = document.createElement('button');
    clearButton.className = 'small';
    clearButton.textContent = '清空翻译缓存';
    clearButton.onclick = () => {
      onClearCache?.();
      ioStatus.textContent = '缓存已清空';
    };
    cacheRow.append(clearButton);

    wrap.append(
      lookupRow,
      autoSpeakRow,
      themeRow,
      dictionaryRow,
      glossRow,
      document.createElement('hr'),
      ioRow,
      importPrompt,
      cacheRow,
      helpText(),
    );
    return wrap;
  }

  function helpText() {
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent = touch
      ? '长按选中网页上的词,再点选区旁的「译」即可查询。注音只对生词本里已有的词生效,默认关闭,按站点开启。'
      : '双击网页上的词即可查询。注音只对生词本里已有的词生效,默认关闭,按站点开启。';
    return p;
  }

  return {
    open() {
      render();
    },
    close,
    get isOpen() {
      return !hostEl.hidden;
    },
    host: hostEl,
    destroy() {
      hostEl.remove();
    },
  };
}

  return {
    createPanel,
  };
})();

// ---- src/ui/palette.js ----
__mod_ui_palette = (function () {

/**
 * The palette shared by every floating surface.
 *
 * Values are applied as inline custom properties on each shadow host, so one
 * set of names works everywhere: the Popup, the Bubble and the Panel each read
 * `var(--tm-bg)` and so on, and nothing has to know which surface it is.
 *
 * Inline and per host, rather than a class plus `:host(.theme-dark)` rules or a
 * `@media (prefers-color-scheme: dark)` block, for two reasons: a media query
 * cannot express "the user forced this theme", and keeping the values here
 * leaves exactly one copy of them instead of a JS copy and a CSS copy that can
 * drift apart.
 */

function applyPalette(host, theme) {
  const dark = theme === 'dark';
  const values = dark
    ? {
        '--tm-bg': '#1c1c1e',
        '--tm-fg': '#f2f2f7',
        '--tm-muted': '#9b9ba1',
        '--tm-border': '#3a3a3e',
        '--tm-accent': '#60a5fa',
        '--tm-accent-fg': '#0b1220',
        '--tm-hover': '#2c2c31',
        /* A one-step surface for chips and the phonetic pill. */
        '--tm-chip': '#2c2c31',
        /* The speak button's filled circle: accent without competing with it. */
        '--tm-accent-soft': '#1d3350',
        '--tm-danger': '#ff7b72',
        // The part-of-speech label. Kept out of --tm-muted so it stays
        // recognisable as a label rather than as quieter body text.
        '--tm-pos': '#e0a83c',
        '--tm-pos-bg': 'rgba(224,168,60,.16)',
        'color-scheme': 'dark',
      }
    : {
        '--tm-bg': '#ffffff',
        '--tm-fg': '#1a1a1a',
        '--tm-muted': '#6b6b6b',
        '--tm-border': '#d8d8d8',
        '--tm-accent': '#2563eb',
        '--tm-accent-fg': '#ffffff',
        '--tm-hover': '#eff6ff',
        '--tm-chip': '#f1f3f5',
        '--tm-accent-soft': '#e8f0fe',
        '--tm-danger': '#b91c1c',
        '--tm-pos': '#9a6b00',
        '--tm-pos-bg': 'rgba(154,107,0,.12)',
        'color-scheme': 'light',
      };
  for (const [name, value] of Object.entries(values)) {
    host.style.setProperty(name, value);
  }
}

  return {
    applyPalette,
  };
})();

// ---- src/main.js ----
__mod_main = (function () {
const { pageLanguage, resolveTarget } = __mod_core_lang;
const { normalizeTerm } = __mod_core_normalize;
const { freedictionary, createTranslator } = __mod_core_providers;
const { DEFAULT_DICTIONARY, DICTIONARIES } = __mod_core_dictionaries;
const { createSettings, createBook, createLookupCache } = __mod_app_storage;
const { createLookupFlow, addEntry, removeEntry } = __mod_app_lookup_flow;
const { createPronouncer } = __mod_app_pronunciation;
const { createPopup } = __mod_ui_popup;
const { createBubble } = __mod_ui_bubble;
const { createHint } = __mod_ui_hint;
const { createCopyText } = __mod_app_clipboard;
const { createGlossLayer } = __mod_ui_gloss_layer;
const { createPanel } = __mod_ui_panel;
const { applyPalette } = __mod_ui_palette;
const { resolveTheme } = __mod_core_theme;
const { isTouchPrimary, shouldOfferBubble, selectionTerm, isOwnSelection, isRectVisible, isEditableSelection, MAX_BUBBLE_CHARS } = __mod_core_gesture;
/**
 * Entry point: wires the modules to this page.
 *
 * Deliberately small — everything with behaviour worth testing lives in
 * core/ (pure) or app/ (injected DOM), so this file is only glue.
 */

















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
 * Dictionary details: phonetic, audio and meanings from the selected
 * Dictionary Source, plus the base form from Wiktionary via
 * freedictionaryapi.com. Both are lookup-only and optional; a dictionary
 * failure is shown in the Popup but never fails the Lookup.
 *
 * Results are cached per source: without this, every repeat lookup of the same
 * word would re-hit both endpoints even when the translation came from cache.
 */
const dictionary = createDictionaryLookup({ fetchText, cache });

function createDictionaryLookup({ fetchText, cache, sources = DICTIONARIES }) {
  const inFlight = new Map();

  function sourceFor(id) {
    return (
      sources.find((source) => source.id === id) ??
      sources.find((source) => source.id === DEFAULT_DICTIONARY) ??
      sources[0]
    );
  }

  return async function lookup(word, dictionaryId = DEFAULT_DICTIONARY) {
    const source = sourceFor(dictionaryId);
    if (!source) return undefined;
    const key = `dict|${source.id}|${source.lang ?? 'en'}|${word}`;
    const cached = cache.get(key);
    // `cache.get` already returns the stored record value, not a wrapper.
    if (cached) return cached;
    // Two quick double-clicks on the same word must not fire duplicate requests.
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      const [detailsBody, lemmaBody] = await Promise.allSettled([
        fetchText(source.request({ word })).then((body) => source.parse(body, { word })),
        // The base-form lookup is an English dictionary service; asking it
        // about a Korean word would only spend a request on an empty answer.
        source.lang === 'en'
          ? fetchText(freedictionary.request({ word })).then((body) =>
              freedictionary.parseLemma(body),
            )
          : Promise.resolve(undefined),
      ]);

      // A source that cannot be reached is worth reporting to the Popup; one
      // that simply has no entry parses to undefined and is not an error.
      if (detailsBody.status === 'rejected') throw detailsBody.reason;
      const details = detailsBody.value;
      const lemma =
        details?.lemma ?? (lemmaBody.status === 'fulfilled' ? lemmaBody.value : undefined);
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
    if (!entry) return false;
    return addEntry(book, entry, () => refreshGlosses());
  },
  /*
   * The Popup's save button turns into a remove button for an Entry already in
   * the book. Removing must reach the page as well as the store: the gloss for
   * this word has to disappear with it, so the layer is refreshed from the
   * new book, not left showing a translation that is no longer saved.
   */
  onRemove: async (entry) => {
    if (!entry) return false;
    return removeEntry(book, entry, () => refreshGlosses({ force: true }));
  },
  onSpeak: (term, lang, audioUrl) => pronouncer.play(term, lang, audioUrl),
  onCopy: copyText,
  /*
   * Changing the Target Language is a site-wide setting, but the decision is
   * made while reading, so it lives in the Popup. The same selection is looked
   * up again under the new target; an empty value clears the override and
   * returns to Page Language inference.
   */
  onTargetChange: (target, state) => {
    settings.setTargetOverride(host, target);
    refreshGlosses({ force: true });
    if (state?.term) {
      flow.lookup({ term: state.term, anchor: state.anchor, sourceLang: state.sourceLang });
    }
  },
  /*
   * The dictionary choice in the Popup is temporary by design: it changes what
   * this Popup shows and nothing else, so no setting is written here.
   */
  onDictionaryChange: (id, state) => flow.changeDictionary(id, state),
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
  // Automatic playback is not the Popup button's toggle: when the previous
  // word is still audible, the new Lookup must replace it, not just silence it.
  speak: (term, lang, audioUrl) => {
    pronouncer.stop();
    return pronouncer.play(term, lang, audioUrl);
  },
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

  return {

  };
})();
})();
