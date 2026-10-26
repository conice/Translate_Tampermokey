/**
 * The Popup: a float anchored near the Selection showing the translation,
 * dictionary details, and the add-to-book action.
 *
 * Rendered into a Shadow DOM host so the host page's CSS cannot restyle it and
 * our CSS cannot leak out. All styles are inline in one stylesheet string.
 */
import { placeNear } from '../core/gesture.js';

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  max-width: 320px;
  min-width: 180px;
  background: #fff;
  color: #1a1a1a;
  border: 1px solid #d8d8d8;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  padding: 10px 12px;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .12s ease, transform .12s ease;
  /*
   * The host zeroes its own box, so the browser's attribute-hiding rule cannot
   * be relied on to hide this: before the first render the Popup sits
   * unpositioned at the viewport corner. Invisible boxes still eat clicks, so
   * it must be untouchable until shown.
   */
  visibility: hidden;
  pointer-events: none;
}
.wrap.show {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  pointer-events: auto;
}
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.term { font-weight: 600; font-size: 15px; word-break: break-word; }
.phonetic { color: #6b6b6b; font-size: 12px; }
.speak {
  all: unset; cursor: pointer; color: #2563eb; font-size: 12px;
  border: 1px solid #cbd5e1; border-radius: 6px; padding: 1px 6px;
}
.speak:hover { background: #eff6ff; }
.translation { margin-top: 6px; font-size: 16px; word-break: break-word; }
.detected { margin-top: 2px; color: #8a8a8a; font-size: 11px; }
.meanings { margin: 7px 0 0; padding: 0; list-style: none; }
.meanings li { color: #4b4b4b; font-size: 12px; margin-top: 3px; }
.pos { color: #9a6b00; font-style: italic; margin-right: 4px; }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
button.primary {
  all: unset; cursor: pointer; background: #2563eb; color: #fff;
  border-radius: 7px; padding: 5px 12px; font-size: 13px;
}
button.primary:hover { background: #1d4ed8; }
button.primary[disabled] { background: #c7d2fe; cursor: default; }
button.ghost {
  all: unset; cursor: pointer; color: #6b6b6b; font-size: 12px; padding: 4px;
}
.hint { color: #9a9a9a; font-size: 11px; margin-left: auto; }
.error { color: #b91c1c; }
.row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }

/*
 * Touch screens: the Popup is the main surface, so it may use the full width
 * and every control gets a finger-sized hit area (44px is the usual minimum).
 */
.wrap.touch {
  max-width: none;
  /* Full width on a phone, but not a 900px ribbon on a tablet. */
  width: min(420px, calc(100vw - 20px));
  padding: 12px 14px;
  font-size: 15px;
}
.wrap.touch button.primary { padding: 11px 16px; font-size: 15px; }
.wrap.touch button.ghost { padding: 10px; font-size: 14px; }
.wrap.touch .speak { padding: 7px 10px; font-size: 14px; }
.wrap.touch .close { display: block; }
/* Only the head row shares space with the close button; everything below it
   starts under the button's 36px box. */
.wrap.touch .head,
.wrap.touch > .term { padding-right: 36px; }
.close {
  all: unset; display: none; position: absolute; top: 2px; right: 2px;
  width: 36px; height: 36px; text-align: center; line-height: 36px;
  color: #8a8a8a; font-size: 18px; cursor: pointer;
}
`;

export function createPopup({ document, onAdd, onSpeak, onClose, touch = false }) {
  const host = document.createElement('div');
  host.setAttribute('data-tm', 'popup-host');
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = touch ? 'wrap touch' : 'wrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-live', 'polite');
  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  close.onclick = () => hide();
  shadow.append(style, wrap);

  /*
   * `host.hidden` alone would not hide this: the host's inline `all: initial`
   * sets `display: inline` in the author origin, which outranks the UA sheet's
   * `[hidden] { display: none }`. The display has to be toggled inline so the
   * invisible box cannot sit over the page.
   */
  function setHidden(hidden) {
    host.hidden = hidden;
    host.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(host);

  let current = null;

  function render(state) {
    current = state;
    wrap.classList.remove('show');
    // `replaceChildren` would drop the close button, so re-seat it each time.
    wrap.replaceChildren(close);

    if (state.status === 'loading') {
      wrap.append(el('div', 'term', state.term), el('div', 'translation hint', '翻译中…'));
    } else if (state.status === 'error') {
      wrap.append(el('div', 'term', state.term));
      wrap.append(el('div', 'translation error', '翻译服务暂不可用'));
      const actions = el('div', 'actions');
      const retry = el('button', 'ghost', '重试');
      retry.onclick = () => state.onRetry?.();
      actions.append(retry);
      wrap.append(actions);
    } else {
      const head = el('div', 'head');
      head.append(el('span', 'term', state.term));
      if (state.phonetic) head.append(el('span', 'phonetic', state.phonetic));
      if (state.canSpeak) {
        const speak = el('button', 'speak', '🔊');
        speak.title = '发音';
        speak.onclick = () => onSpeak?.(state.term, state.sourceLang);
        head.append(speak);
      }
      wrap.append(head);
      wrap.append(el('div', 'translation', state.translation));
      if (state.detectedSource) {
        wrap.append(el('div', 'detected', `检测语言:${state.detectedSource}`));
      }
      if (state.meanings?.length) {
        const list = el('ul', 'meanings');
        for (const meaning of state.meanings) {
          const li = document.createElement('li');
          li.append(el('span', 'pos', meaning.pos), String(meaning.definition));
          list.append(li);
        }
        wrap.append(list);
      }
      if (state.lemma) {
        const row = el('div', 'row');
        row.append(
          el('span', 'hint', `原形:${state.lemma.term}`),
          (() => {
            const b = el('button', 'ghost', '改存原形');
            b.onclick = () => onAdd?.(state.lemma, state);
            return b;
          })(),
        );
        wrap.append(row);
      }
      const actions = el('div', 'actions');
      const add = el('button', 'primary', state.alreadySaved ? '已在生词本' : '加入生词本');
      add.disabled = Boolean(state.alreadySaved) || !state.canSave;
      add.onclick = async () => {
        add.disabled = true;
        await onAdd?.(state.entry, state);
        add.textContent = '已在生词本';
      };
      actions.append(add);
      if (!state.canSave) actions.append(el('span', 'hint', '过长,仅可查看'));
      wrap.append(actions);
    }
    setHidden(false);
    // Force a frame so the transition runs on first paint.
    host.getBoundingClientRect();
    wrap.classList.add('show');
    place(state.anchor);
  }

  function place(anchor) {
    /*
     * Selection rects and `position: fixed` share the layout viewport's
     * coordinate space. The visual viewport's size is the honest bound on a
     * phone, where the on-screen keyboard shrinks what is visible while
     * `innerHeight` stays put; its offsets mark the part scrolled off when the
     * page is pinch-zoomed. Fall back to the window when it is unavailable.
     */
    const viewport = window.visualViewport;
    const viewportBox = {
      width: Math.min(window.innerWidth || Infinity, viewport?.width ?? Infinity),
      height: Math.min(window.innerHeight || Infinity, viewport?.height ?? Infinity),
    };
    const offsetTop = viewport?.offsetTop ?? 0;
    const offsetLeft = viewport?.offsetLeft ?? 0;

    const rect = anchor ?? { top: offsetTop + 20, height: 20, left: offsetLeft + 20 };
    const box = wrap.getBoundingClientRect();
    const { top, left } = placeNear({
      rect,
      box: { width: box.width, height: box.height },
      viewport: viewportBox,
      margin: touch ? 8 : 10,
    });
    Object.assign(wrap.style, { top: `${top}px`, left: `${left}px` });
  }

  function hide() {
    if (host.hidden) return;
    setHidden(true);
    wrap.classList.remove('show');
    current = null;
    onClose?.();
  }

  function contains(target) {
    return shadow.contains(target) || host.contains(target);
  }

  return { render, hide, contains, host, get current() { return current; } };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}