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
import { placeNear } from '../core/gesture.js';

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

export function createBubble({ document, window, onTap }) {
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