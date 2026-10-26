import { normalizeTerm, normalizeSentence } from './normalize.js';

/**
 * Longest selection the bubble will offer to translate.
 *
 * This is the Lookup limit, not an Entry limit: a phone user dragging out a
 * sentence is doing what a desktop user does by double-clicking a paragraph,
 * and a sentence is only ever translated. Anything longer is a copy gesture.
 */
export const MAX_BUBBLE_CHARS = 400;

/**
 * True on devices whose primary input is a finger.
 *
 * Mobile browsers do not reliably fire `dblclick` on a double tap — Chrome on
 * Android only does when double-tap zoom is off, iOS never does — so the
 * desktop gesture cannot be the only way in. `pointer: coarse` is the honest
 * signal; the touch-point fallback covers browsers that omit the media query.
 */
export function isTouchPrimary(windowlike) {
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
export function isEditableSelection(selection) {
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
export function shouldOfferBubble({ selection, target, isOwnUi = false } = {}) {
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
export function selectionTerm(selection) {
  return normalizeSentence(selection?.toString?.() ?? '');
}

/**
 * True while any part of the rect is inside the viewport.
 *
 * A Bubble is fixed on the screen, so it has to follow the Selection it points
 * at. It only goes away once the Selection has left the screen entirely:
 * straddling an edge means the reader can still see what it refers to.
 */
export function isRectVisible(rect, viewport) {
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
export function placeNear({ rect, box, viewport, margin = 8, gap = 8 }) {
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
export function isOwnSelection(selection) {
  const node = selection?.anchorNode;
  if (!node) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!element) return false;
  if (element.closest?.('[data-tm]')) return true;
  const root = element.getRootNode?.();
  return Boolean(root?.host?.matches?.('[data-tm]'));
}