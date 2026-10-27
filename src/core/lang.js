import { scriptOf } from './normalize.js';

/** 'zh-CN' -> 'zh', 'EN-us' -> 'en', undefined -> ''. */
export function normalizeLangTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

/**
 * Chinese names for the language codes the UI can meet. One table serves both
 * the Popup's Target Language menu and the Book's group headings, so a
 * language is never called two different things in two places.
 */
export const LANGUAGE_NAMES = {
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
export const LANGUAGE_ORDER = Object.keys(LANGUAGE_NAMES);

/**
 * 'en-US' -> '英语'. A code with no name of its own is shown as it is, which is
 * still more useful than calling it unknown; only a missing code says 未知语言.
 */
export function languageLabel(tag) {
  const base = normalizeLangTag(tag);
  if (!base) return '未知语言';
  return LANGUAGE_NAMES[base] ?? base;
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
export function resolveTarget({ pageLang, sourceLang, override } = {}) {
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