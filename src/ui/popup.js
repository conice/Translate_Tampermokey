/**
 * The Popup: a float anchored near the Selection showing the translation,
 * dictionary details, and the add-to-book action.
 *
 * Rendered into a Shadow DOM host so the host page's CSS cannot restyle it and
 * our CSS cannot leak out. All styles are inline in one stylesheet string.
 */
import { placeNear } from '../core/gesture.js';
import { languageLabel, normalizeLangTag } from '../core/lang.js';
import { DEFAULT_DICTIONARY, DICTIONARY_CHOICES } from '../core/dictionaries.js';

/**
 * Target Languages the Popup offers, as distinct tags. The list is
 * deliberately short: these are the languages the free providers handle
 * reliably, and a select is easier to hit than the old free-text setting. The
 * names come from the shared table, so they match the Book's group headings.
 * An override left over from the text-field era is added as its own option
 * rather than dropped.
 */
const TARGET_CHOICES = [
  ['', '自动'],
  ...['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'].map((tag) => [tag, languageLabel(tag)]),
];

/**
 * The mark on a Dictionary Source's logo. Three sources have a wordmark colour
 * of their own (Youdao red, Eudic blue) or no mark at all; Microsoft's four
 * squares are drawn as shapes, since no letter can stand in for them.
 */
const DICTIONARY_MARKS = {
  youdao: { text: '有' },
  microsoft: { squares: ['#f25022', '#7fba00', '#00a4ef', '#ffb900'] },
  eudic: { text: 'E' },
  dictionaryapi: { text: 'EN' },
  krdict: { text: '한' },
};

/** Inline icons, drawn as strokes so they take the surface's colour. */
const ICONS = {
  globe:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c2.5 2.4 4 5.4 4 10s-1.5 7.6-4 10c-2.5-2.4-4-5.4-4-10s1.5-7.6 4-10ZM2 12h20',
  speaker: 'M4 9h4l5-4v14l-5-4H4V9ZM16 8.5a4.5 4.5 0 0 1 0 7M18.8 5.8a8.2 8.2 0 0 1 0 12.4',
  copy: 'M9 9h10v10H9V9ZM5 15H4V5h10v1',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
};

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  max-width: 320px;
  min-width: 180px;
  background: var(--tm-bg, #fff);
  color: var(--tm-fg, #1a1a1a);
  border: 1px solid var(--tm-border, #d8d8d8);
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
.head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.term { font-weight: 650; font-size: 16px; letter-spacing: .01em; word-break: break-word; }
.phonetic {
  color: var(--tm-muted, #6b6b6b); font-size: 12px;
  background: var(--tm-chip, rgba(127,127,127,.1)); border-radius: 5px; padding: 1px 5px;
}
.speak {
  all: unset; cursor: pointer; flex: none; width: 24px; height: 24px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--tm-accent, #2563eb); background: var(--tm-accent-soft, #e8f0fe);
}
.speak:hover { background: var(--tm-hover, #eff6ff); }
.speak svg { width: 14px; height: 14px; }
.translation { margin-top: 7px; font-size: 16px; line-height: 1.45; word-break: break-word; }
/* A sentence was written with line breaks; flattening them changes the meaning
   of what the reader selected. */
.wrap.sentence .translation { white-space: pre-wrap; }
.detected { margin-top: 3px; color: var(--tm-muted, #8a8a8a); font-size: 11px; }
/*
 * Two per-lookup decisions, in the two corners where they belong: the
 * Dictionary Source is a row of logos at the top right, beside the word it
 * describes; the Target Language is a dropdown at the bottom right, beside the
 * actions whose result it changes.
 */
.dict { display: flex; align-items: center; gap: 1px; margin-left: auto; }
.logo {
  all: unset; box-sizing: border-box; cursor: pointer;
  width: 24px; height: 24px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  opacity: .45; transition: opacity .12s ease, box-shadow .12s ease;
}
.logo:hover { opacity: .8; }
/* The chosen source is the only one at full strength, ringed in the accent. */
.logo[aria-pressed="true"] { opacity: 1; box-shadow: 0 0 0 2px var(--tm-accent, #2563eb); }
.logo:focus-visible { outline: 2px solid var(--tm-accent, #2563eb); outline-offset: 1px; }
.logo-mark {
  width: 18px; height: 18px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: -.02em;
}
/*
 * Each logo keeps its own brand colour rather than a theme colour: a dictionary
 * is recognised by its mark, and the same red or blue is what the reader knows
 * from the site.
 */
.logo-mark[data-logo="youdao"] { background: #d9271e; color: #fff; }
.logo-mark[data-logo="eudic"] { background: #1f6ff2; color: #fff; }
.logo-mark[data-logo="dictionaryapi"] { background: #5b6472; color: #fff; font-size: 8px; }
.logo-mark[data-logo="krdict"] { background: #0b6bb6; color: #fff; }
.logo-mark.logo-ms svg { width: 15px; height: 15px; }
.target {
  display: flex; align-items: center; gap: 5px; margin-left: auto;
  color: var(--tm-muted, #8a8a8a); font-size: 11px;
}
.target select {
  padding: 2px 4px; border: 1px solid var(--tm-border, #d8d8d8); border-radius: 6px;
  font: inherit; font-size: 11px; max-width: 132px;
  background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
.tool-icon { display: inline-flex; color: var(--tm-muted, #9a9a9a); flex: none; }
.tool-icon svg { width: 12px; height: 12px; }
.meanings-state { margin-top: 7px; color: var(--tm-muted, #8a8a8a); font-size: 12px; }
.meanings { margin: 7px 0 0; padding: 0; list-style: none; }
.meanings li {
  display: flex; gap: 6px; align-items: baseline;
  color: var(--tm-fg, #3f3f46); font-size: 12px; line-height: 1.5; margin-top: 4px;
}
.pos {
  flex: none; color: var(--tm-pos, #9a6b00); font-size: 11px; font-weight: 600;
  background: var(--tm-pos-bg, rgba(154,107,0,.12)); border-radius: 4px; padding: 0 4px;
}
.actions { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
button.primary {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  background: var(--tm-accent, #2563eb); color: var(--tm-accent-fg, #fff);
  border-radius: 8px; padding: 6px 13px; font-size: 13px; font-weight: 550;
}
button.primary svg { width: 13px; height: 13px; }
button.primary:hover { filter: brightness(1.08); }
button.primary[disabled] { background: var(--tm-accent, #2563eb); opacity: .45; cursor: default; }
/*
 * Already in the book: the same button now removes the Entry. It keeps the
 * position and size of the save button, but the accent colour would read as
 * "save", so it takes the removal colour instead.
 */
button.primary.saved { background: var(--tm-chip, #f1f3f5); color: var(--tm-danger, #b91c1c); }
button.primary.saved:hover { background: var(--tm-hover, #eff6ff); }
button.primary.saved[disabled] { background: var(--tm-chip, #f1f3f5); }
button.ghost {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  color: var(--tm-muted, #6b6b6b); font-size: 12px; padding: 4px 5px; border-radius: 6px;
}
button.ghost:hover { background: var(--tm-hover, #f2f4f7); }
button.ghost svg { width: 13px; height: 13px; }
.hint { color: var(--tm-muted, #9a9a9a); font-size: 11px; }
.error { color: var(--tm-danger, #b91c1c); }
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
.wrap.touch button.primary { padding: 10px 16px; font-size: 15px; border-radius: 10px; }
.wrap.touch button.primary svg { width: 15px; height: 15px; }
.wrap.touch button.ghost { padding: 8px 10px; font-size: 14px; border-radius: 8px; }
.wrap.touch .speak { width: 34px; height: 34px; }
.wrap.touch .speak svg { width: 17px; height: 17px; }
.wrap.touch .logo { width: 32px; height: 32px; }
.wrap.touch .logo-mark { width: 22px; height: 22px; font-size: 13px; }
.wrap.touch .logo-mark.logo-ms svg { width: 18px; height: 18px; }
.wrap.touch .target { font-size: 13px; }
.wrap.touch .target select { padding: 8px 10px; font-size: 14px; max-width: 150px; }
.wrap.touch .tool-icon svg { width: 15px; height: 15px; }
.wrap.touch .meanings-state { font-size: 14px; }
.wrap.touch .meanings li { font-size: 13px; }
/* Only the head row shares space with the close button; everything below it
   starts under the button's 36px box. */
.wrap.touch .head,
.wrap.touch > .term,
.wrap.sentence > .translation { padding-right: 36px; }
.close {
  all: unset; display: none; position: absolute; top: 2px; right: 2px;
  width: 36px; height: 36px; text-align: center; line-height: 36px;
  color: var(--tm-muted, #8a8a8a); font-size: 18px; cursor: pointer;
}
`;

export function createPopup({ document, window, onAdd, onRemove, onSpeak, onCopy, onTargetChange, onDictionaryChange, onClose, touch = false }) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

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

  /** An inline stroke icon; `aria-hidden` because the button carries the name. */
  function icon(path) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const shape = document.createElementNS(NS, 'path');
    shape.setAttribute('d', path);
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.7');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.append(shape);
    return svg;
  }

  /** The small glyph that names a control group, e.g. a globe for languages. */
  function groupIcon(path, label) {
    const box = el('span', 'tool-icon');
    box.title = label;
    box.append(icon(path));
    return box;
  }

  /**
   * The per-site Target Language, as a dropdown. It sits at the bottom right of
   * the Popup rather than in the Panel because it is a reading decision made in
   * the moment: change it and the same word is looked up again without leaving
   * the page.
   */
  function targetRow(state) {
    const saved = String(state.targetOverride ?? '').trim().replace(/_/gu, '-');
    const savedBase = normalizeLangTag(saved);
    const row = el('div', 'target');
    row.append(groupIcon(ICONS.globe, '本站目标语言'));
    const select = document.createElement('select');
    select.className = 'target-select';
    select.setAttribute('aria-label', '本站目标语言');

    const choices = [...TARGET_CHOICES];
    // Match by base language so a saved `zh` still selects 「中文」, whose
    // option carries the `zh-CN` tag the default Target Language uses.
    let selected = '';
    if (savedBase) {
      const match = choices.find(([value]) => value && normalizeLangTag(value) === savedBase);
      if (match) {
        selected = match[0];
      } else {
        // A language the short list does not name must still be visible, or
        // choosing another one would silently discard what was saved.
        choices.push([saved, saved]);
        selected = saved;
      }
    }
    for (const [value, label] of choices) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = selected;
    select.onchange = () => onTargetChange?.(select.value, state);
    row.append(select);
    return row;
  }

  /** A Dictionary Source's logo: its own mark, not a letter in our colours. */
  function dictionaryLogo(id) {
    const mark = document.createElement('span');
    mark.className = 'logo-mark';
    const spec = DICTIONARY_MARKS[id];
    if (spec?.squares) {
      // Microsoft: the four squares, drawn rather than lettered.
      mark.classList.add('logo-ms');
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const cells = [
        [1.5, 1.5],
        [13, 1.5],
        [1.5, 13],
        [13, 13],
      ];
      cells.forEach(([x, y], index) => {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', '9.5');
        rect.setAttribute('height', '9.5');
        rect.setAttribute('fill', spec.squares[index]);
        svg.append(rect);
      });
      mark.append(svg);
      return mark;
    }
    mark.dataset.logo = id;
    mark.textContent = spec?.text ?? '';
    return mark;
  }

  /**
   * The Dictionary Source for this Popup, as a row of logos in the top right.
   * It is deliberately not a setting: switching here is a reading decision for
   * one word, so the next Lookup starts from the Default Dictionary again.
   *
   * Returns `null` when the word's language has only one dictionary: a row of
   * one logo would be a control that cannot do anything.
   */
  function dictionaryRow(state) {
    const choices = state.dictionaryChoices ?? DICTIONARY_CHOICES;
    if (choices.length < 2) return null;

    const row = el('div', 'dict');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '释义词典 · 仅本次');
    row.title = '释义词典(仅本次,不改变默认词典)';

    let selected = state.dictionaryId;
    if (!choices.some(([value]) => value === selected)) {
      selected = choices[0][0] ?? DEFAULT_DICTIONARY;
    }
    for (const [value, label] of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'logo';
      button.dataset.dict = value;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', value === selected ? 'true' : 'false');
      button.append(dictionaryLogo(value));
      button.onclick = () => onDictionaryChange?.(value, state);
      row.append(button);
    }
    return row;
  }

  function render(state) {
    current = state;
    wrap.classList.remove('show');
    wrap.classList.toggle('sentence', Boolean(state.sentence));
    // `replaceChildren` would drop the close button, so re-seat it each time.
    wrap.replaceChildren(close);
    // A sentence has no page text to click away from, so it always offers the
    // explicit close; a desktop word box keeps the quieter click-away.
    close.style.display = state.sentence || touch ? 'block' : 'none';

    if (state.status === 'loading') {
      if (!state.sentence) wrap.append(el('div', 'term', state.term));
      wrap.append(el('div', 'translation hint', '翻译中…'));
    } else if (state.status === 'error') {
      if (!state.sentence) wrap.append(el('div', 'term', state.term));
      wrap.append(el('div', 'translation error', '翻译服务暂不可用'));
      const actions = el('div', 'actions');
      const retry = el('button', 'ghost', '重试');
      retry.onclick = () => state.onRetry?.();
      actions.append(retry);
      wrap.append(actions);
    } else if (state.sentence) {
      wrap.append(el('div', 'translation', state.translation));
      const actions = el('div', 'actions');
      addCopy(actions, state);
      if (state.canSpeak) actions.append(speakButton(state));
      actions.append(targetRow(state));
      wrap.append(actions);
    } else {
      const head = el('div', 'head');
      head.append(el('span', 'term', state.term));
      if (state.phonetic) head.append(el('span', 'phonetic', state.phonetic));
      if (state.canSpeak) head.append(speakButton(state));
      const dictRow = state.dictionaryId ? dictionaryRow(state) : null;
      if (dictRow) head.append(dictRow);
      wrap.append(head);
      wrap.append(el('div', 'translation', state.translation));
      if (state.detectedSource) {
        wrap.append(el('div', 'detected', `检测语言:${state.detectedSource}`));
      }
      if (state.dictionaryId) {
        if (state.dictionaryStatus === 'loading') {
          wrap.append(el('div', 'meanings-state', '正在查询释义…'));
        } else if (state.dictionaryStatus === 'empty') {
          wrap.append(el('div', 'meanings-state', '该词典暂无释义'));
        } else if (state.dictionaryStatus === 'error') {
          wrap.append(el('div', 'meanings-state error', '释义加载失败'));
        }
      }
      if (state.meanings?.length) {
        const list = el('ul', 'meanings');
        for (const meaning of state.meanings) {
          const li = document.createElement('li');
          if (meaning.pos) li.append(el('span', 'pos', meaning.pos));
          li.append(String(meaning.definition));
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
      /*
       * One button, two meanings. An Entry already in the book must still be
       * removable from here — otherwise the only way back is the Panel — so the
       * same button flips between "加入生词本" and "移出生词本" instead of
       * sitting disabled.
       */
      const save = el('button', 'primary');
      const saveLabel = el('span', 'label');
      /*
       * The label follows the book, and the state object follows the label, so
       * a re-render of this Popup (switching the Dictionary Source, say) keeps
       * whichever side the user is on.
       */
      const showSaved = (saved) => {
        state.alreadySaved = saved;
        save.classList.toggle('saved', saved);
        save.replaceChildren(icon(saved ? ICONS.minus : ICONS.plus), saveLabel);
        saveLabel.textContent = saved ? '移出生词本' : '加入生词本';
      };
      showSaved(Boolean(state.alreadySaved));
      save.disabled = !state.canSave;
      save.onclick = async () => {
        save.disabled = true;
        try {
          if (state.alreadySaved) {
            // Whatever the book held for this Entry, it does not hold it now.
            // A stale "saved" state (removed from the Panel meanwhile) must not
            // leave the button claiming a removal that already happened.
            await onRemove?.(state.entry, state);
            showSaved(false);
          } else {
            // Saving is only claimed when the book actually took the Entry.
            showSaved((await onAdd?.(state.entry, state)) !== false);
          }
        } finally {
          // Never leave a dead button behind, whatever the book did.
          save.disabled = false;
        }
      };
      actions.append(save);
      if (!state.canSave) actions.append(el('span', 'hint', '过长,仅可查看'));
      addCopy(actions, state);
      actions.append(targetRow(state));
      wrap.append(actions);
    }
    setHidden(false);
    // Force a frame so the transition runs on first paint.
    host.getBoundingClientRect();
    wrap.classList.add('show');
    place(state.anchor);
  }

  /**
   * The speak action: one icon in both the word and the sentence layout, since
   * playing a recording is the same action for both.
   */
  function speakButton(state) {
    const speak = document.createElement('button');
    speak.className = 'speak';
    speak.title = '发音';
    speak.setAttribute('aria-label', '发音');
    speak.append(icon(ICONS.speaker));
    speak.onclick = () => onSpeak?.(state.term, state.sourceLang, state.audio);
    return speak;
  }

  /**
   * "Copy translation", the one action a sentence and a word have in common.
   * A refusal (permission policies block the clipboard on plenty of sites) is
   * not worth a message: the label simply stays put.
   */
  function addCopy(actions, state) {
    const button = el('button', 'ghost copy');
    const label = el('span', 'label', '复制译文');
    button.append(icon(ICONS.copy), label);
    button.onclick = async () => {
      let copied = false;
      try {
        copied = (await onCopy?.(state.translation)) === true;
      } catch {
        copied = false;
      }
      label.textContent = copied ? '已复制' : '复制译文';
    };
    actions.append(button);
    return button;
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
