import {
  MARKER_CLASS,
  ANNOTATION_CLASS,
  createMatcher,
  segment,
  isProseText,
  shouldSkipNode,
} from '../core/gloss.js';

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
export function createGlossLayer({ document, window, translationMap }) {
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

  function refresh(nextMap, { force = false } = {}) {
    matcher = createMatcher(nextMap);
    // Drop every annotation we made and restore the original text, so a changed
    // vocabulary never leaves stale translations on the page.
    suppressed = true;
    try {
      for (const marker of [...document.querySelectorAll(`.${MARKER_CLASS}`)]) {
        const original = marker.firstChild?.nodeType === 3 ? marker.firstChild.nodeValue : marker.textContent;
        marker.replaceWith(document.createTextNode(original));
      }
      document.normalize();
    } finally {
      suppressed = false;
    }
    if (active || force) pass({ force });
  }

  return { start, stop, refresh, pass, get active() { return active; } };
}