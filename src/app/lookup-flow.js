/**
 * Turns a raw Selection into a Lookup, and wires the Popup's actions to the
 * Vocabulary Book.
 *
 * DOM access is limited to reading the document language; everything else is
 * injected, so the flow can be exercised without a browser.
 */
import { normalizeTerm, scriptOf, canBecomeEntry } from '../core/normalize.js';
import { resolveTarget } from '../core/lang.js';

/** Read the Selection, cleaned up. Returns '' when there is nothing usable. */
export function readSelection(selection) {
  if (!selection || selection.rangeCount === 0) return '';
  const text = String(selection.toString() ?? '');
  if (text.length > 400) return ''; // selecting the whole page is not a word lookup
  return normalizeTerm(text);
}

/**
 * Language of the selection, when the writing system gives it away.
 * Latin text could be English, French or German, so it stays 'auto' and the
 * provider's own detection is trusted instead.
 */
export function sourceLangOf(term) {
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
 * @param {Function} [deps.dictionary]    (word) => {phonetic, meanings} | undefined
 * @param {Function} [deps.speak]         (term, lang) => void
 * @param {Function} deps.settings        () => settings snapshot
 * @param {string} deps.host              current hostname
 */
export function createLookupFlow({
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
    const normalized = normalizeTerm(term);
    if (!normalized) return [];

    const config = settings();
    const source = sourceLang ?? sourceLangOf(normalized);
    const target = resolveTarget({
      pageLang: pageLanguage(),
      sourceLang: source,
      override: config.targetOverride?.(host),
    });

    const current = ++requestId;
    const canSave = canBecomeEntry(normalized);

    popup.render({ status: 'loading', term: normalized, anchor, sourceLang: source });

    try {
      const [result] = await translator({ text: normalized, source, target });
      if (current !== requestId) return [];

      // Dictionary details are a bonus. A dictionary endpoint that throws (or
      // a parse bug in one) must never turn a working translation into an
      // error state.
      let details;
      if (dictionary) {
        try {
          details = await dictionary(normalized);
        } catch (error) {
          console.debug('[tm] dictionary lookup failed:', error);
          details = undefined;
        }
      }
      if (current !== requestId) return [];

      const detectedSource = result?.detectedSource;
      const entrySource = detectedSource
        ? detectedSource.split('-')[0]
        : source === 'auto'
          ? 'en'
          : source;

      const entry = {
        term: normalized,
        normalized,
        sourceLang: entrySource,
        targetLang: target,
        translation: result?.translation ?? '',
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
        term: normalized,
        translation: entry.translation,
        detectedSource,
        phonetic: details?.phonetic,
        meanings: details?.meanings,
        canSpeak: Boolean(speak),
        canSave,
        lemma,
        // Checked against the resolved source language, not the guess we made
        // before detection: an 'auto' guess would never match a saved 'en|run'.
        alreadySaved: book.has(`${entrySource}|${normalized}`),
        entry,
        anchor,
        sourceLang: entrySource,
        onRetry: () => lookup({ term: normalized, anchor, sourceLang }),
      });
      return [entry];
    } catch (error) {
      if (current !== requestId) return [];
      console.debug('[tm] lookup failed:', error);
      popup.render({
        status: 'error',
        term: normalized,
        anchor,
        sourceLang: source,
        onRetry: () => lookup({ term: normalized, anchor, sourceLang }),
      });
      return [];
    }
  }

  return { lookup, readSelection };
}

/** Save an Entry from the Popup, refreshing the gloss layer afterwards. */
export function addEntry(book, entry, onSaved) {
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