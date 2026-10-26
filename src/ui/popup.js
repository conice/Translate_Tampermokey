/**
 * The Popup: a float anchored near the Selection showing the translation,
 * dictionary details, and the add-to-book action.
 *
 * Rendered into a Shadow DOM host so the host page's CSS cannot restyle it and
 * our CSS cannot leak out. All styles are inline in one stylesheet string.
 */

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed;
  z-index: 2147483647;
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
}
.wrap.show { opacity: 1; transform: translateY(0); }
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
`;

export function createPopup({ document, onAdd, onSpeak, onClose }) {
  const host = document.createElement('div');
  host.setAttribute('data-tm', 'popup-host');
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-live', 'polite');
  shadow.append(style, wrap);
  host.hidden = true;
  document.documentElement.appendChild(host);

  let current = null;

  function render(state) {
    current = state;
    wrap.classList.remove('show');
    wrap.replaceChildren();

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
    host.hidden = false;
    // Force a frame so the transition runs on first paint.
    host.getBoundingClientRect();
    wrap.classList.add('show');
    place(state.anchor);
  }

  function place(anchor) {
    const margin = 10;
    const rect = anchor ?? { top: 20, bottom: 40, left: 20, right: 20 };
    const box = wrap.getBoundingClientRect();
    let top = rect.bottom + 8;
    if (top + box.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - box.height - 8);
    }
    let left = rect.left;
    if (left + box.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - box.width - margin);
    }
    Object.assign(wrap.style, { top: `${top}px`, left: `${left}px` });
  }

  function hide() {
    if (host.hidden) return;
    host.hidden = true;
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