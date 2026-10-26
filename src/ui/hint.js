/**
 * A short-lived label next to the Selection.
 *
 * It exists so an oversized selection answers with words instead of silence:
 * before this, selecting a whole page looked exactly like a broken script.
 * It reuses the Bubble's placement rule, then takes itself away.
 */
import { placeNear } from '../core/gesture.js';

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

export function createHint({ document, window, timers }) {
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
