/**
 * Turns a raw Selection into a Lookup, and wires the Popup's actions to the
 * Vocabulary Book.
 *
 * DOM access is limited to reading the document language; everything else is
 * injected, so the flow can be exercised without a browser.
 */
import { normalizeTerm, normalizeSentence, scriptOf, canBecomeEntry } from '../core/normalize.js';
import { resolveTarget } from '../core/lang.js';
import { dictionaryChoicesFor, dictionaryFor } from '../core/dictionaries.js';

/** Longest Selection worth a Lookup, in characters. */
export const MAX_SELECTION_CHARS = 400;

/**
 * Read the Selection, tidied.
 *
 * Returns a status rather than an empty string for everything that cannot be
 * looked up: "too long" has to be told apart from "nothing selected", because
 * one deserves a short explanation next to the Selection and the other
 * deserves silence. Text is only whitespace-tidied here — whether it is a word
 * or a sentence is the Lookup's decision, not the Selection's.
 */
export function readSelection(selection) {
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
 * @param {Function} [deps.dictionary]    (word, dictionaryId) => {phonetic, meanings} | undefined
 * @param {Function} [deps.speak]         (term, lang, audioUrl) => void, called for a word when auto-speak is on
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

/** Remove an Entry from the Popup, refreshing the gloss layer afterwards. */
export function removeEntry(book, entry, onRemoved) {
  if (!entry?.sourceLang || !entry?.normalized) return false;
  const entryId = `${entry.sourceLang}|${entry.normalized}`;
  if (!book.has(entryId)) return false;
  book.remove(entryId);
  onRemoved?.(entryId);
  return true;
}