import { normalizeTerm, scriptOf } from './normalize.js';

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
export function createMatcher(translationMap) {
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
export function segment(text, matcher) {
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
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS',
]);

export function isSkippableElement(element) {
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
export function isProseText(text, minLength = 2) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < minLength) return false;
  if (/^[\s\d\p{P}]+$/u.test(trimmed)) return false;
  return true;
}

/** Guard against re-processing our own DOM writes. */
export const MARKER_CLASS = 'tm-gloss-wrapped';
export const ANNOTATION_CLASS = 'tm-gloss-annot';

export function shouldSkipNode(node) {
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

export { normalizeTerm };