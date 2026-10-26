const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * Reduce a piece of selected text to the identity used for a vocabulary Entry.
 * Trims, collapses internal whitespace, strips leading/trailing punctuation,
 * and lowercases. Internal hyphens and apostrophes survive, so "don't" and
 * "well-known" stay as written.
 */
export function normalizeTerm(raw) {
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
export function normalizeSentence(raw) {
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
export function scriptOf(text) {
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
export function isCjk(text) {
  const script = scriptOf(text);
  return script === 'han' || script === 'kana' || script === 'hangul';
}

/** Number of whitespace-separated words; a run of CJK counts as one. */
export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

/** Longest term, in words and in characters, an Entry may hold. */
export const MAX_ENTRY_WORDS = 5;
export const MAX_ENTRY_CHARS = 40;

/** A selection may be looked up (any length) but only short ones can be saved. */
export function canBecomeEntry(term) {
  return term.length > 0 && term.length <= MAX_ENTRY_CHARS && countWords(term) <= MAX_ENTRY_WORDS;
}