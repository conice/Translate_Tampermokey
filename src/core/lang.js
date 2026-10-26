import { scriptOf } from './normalize.js';

/** 'zh-CN' -> 'zh', 'EN-us' -> 'en', undefined -> ''. */
export function normalizeLangTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

/**
 * The Page Language: the language of the page's main body text.
 * The document's lang attribute wins; only when it is missing do we sample
 * text and guess from the writing system.
 */
export function pageLanguage(langAttr, sampleText = '') {
  const fromAttr = normalizeLangTag(langAttr);
  if (fromAttr) return fromAttr;
  return detectFromText(sampleText);
}

/** Guess a language code from a text sample. Defaults to English. */
export function detectFromText(sample) {
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

/**
 * The Target Language for a lookup.
 *
 * A per-site override wins, unless it would translate a language into itself.
 * Otherwise: a Chinese page translates into English, a non-Chinese page into
 * Chinese — including the case of a Chinese selection sitting on a
 * non-Chinese page, where Chinese would be a no-op.
 */
export function resolveTarget({ pageLang, sourceLang, override } = {}) {
  const page = normalizeLangTag(pageLang);
  const source = normalizeLangTag(sourceLang);
  const forced = normalizeLangTag(override);
  if (forced && forced !== source) return forced;
  if (page === 'zh') return 'en';
  if (source === 'zh') return 'en';
  return 'zh-CN';
}