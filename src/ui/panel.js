/**
 * The Panel: vocabulary management and settings, as an in-page overlay.
 *
 * Everything lives behind a Shadow DOM so host styles cannot reach it. The
 * panel is opened from the userscript menu, because it is not part of normal
 * reading and should not be one stray click away.
 */
import { THEMES } from '../core/theme.js';
import { groupBySourceLang } from '../core/store.js';
import { CSV_ACCEPT, csvFilename, pickTextFile, saveTextFile } from '../app/file-io.js';

/** How each theme reads in the settings control. UI text, so it lives here. */
const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };

const STYLE = `
:host { all: initial; }
.backdrop {
  /* padding + border-box, rather than margins carved out of the dialog's own
     width and height: the dialog below then sizes itself as a percentage of
     this box, and the two cannot disagree about how much room there is. */
  position: fixed; inset: 0; z-index: 2147483646;
  box-sizing: border-box; padding: 16px;
  background: rgba(0,0,0,.35);
  display: flex;
  /* "safe" falls back to flex-start when the dialog is taller than the box, so
     the title, the tabs and the close button stay on screen instead of being
     pushed off both ends by centring. */
  align-items: center; align-items: safe center;
  justify-content: center;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: var(--tm-fg, #1a1a1a);
}
.dialog {
  width: min(720px, 100%);
  /* A percentage of the backdrop, not vh. On a phone the fixed box, the
     visible viewport and vh can each mean something different: vh ignores the
     browser chrome, and a pinch-zoom shrinks what is visible without
     shrinking the box. Measuring against the very box the dialog is laid out in
     is the only cap that always matches what the user can see; it is what kept
     a long book from pushing the title under the status bar. */
  max-height: min(640px, 100%);
  background: var(--tm-bg, #fff); border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.3);
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid var(--tm-border, #ececec);
}
h1 { font-size: 16px; margin: 0; font-weight: 600; }
.tabs { display: flex; gap: 4px; margin-left: auto; }
.tabs button {
  all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px;
  color: var(--tm-muted, #555); font-size: 13px;
}
.tabs button[aria-selected="true"] { background: var(--tm-hover, #eef2ff); color: var(--tm-accent, #1d4ed8); }
.close { all: unset; cursor: pointer; color: var(--tm-muted, #888); padding: 4px 8px; font-size: 18px; }
.body {
  /* The list scrolls here, never in the dialog. A flex item refuses to shrink
     below its content unless min-height is zeroed, so without this a long book
     would overflow the cap above: the rows past the edge would simply be cut
     off with no way to scroll to them. */
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 0;
  /* A visible scrollbar, not the phone's hit-and-miss overlay one: with a few
     hundred entries there is otherwise nothing on screen saying the list goes
     on below the fold. */
  scrollbar-width: thin;
  scrollbar-color: var(--tm-muted, #8a8a8a) transparent;
}
/*
 * Chromium 121+ and Safari 18.2+ honour the two standard properties above and
 * then ignore ::-webkit-scrollbar entirely, so these rules only take effect
 * where the standard ones are unknown — older WebKit, which otherwise draws
 * its own overlay scrollbar.
 */
@supports not (scrollbar-width: thin) {
  .body::-webkit-scrollbar { width: 8px; }
  .body::-webkit-scrollbar-track { background: transparent; }
  .body::-webkit-scrollbar-thumb {
    background: var(--tm-muted, #8a8a8a); border-radius: 8px;
    border: 2px solid var(--tm-bg, #fff); /* thins the thumb without a second colour */
  }
}
.toolbar {
  /* The search box outlives the scroll. With a few hundred entries, scrolling
     back to the top to filter again is otherwise the only way to find a word. */
  position: sticky; top: 0; z-index: 1;
  padding: 14px 18px 10px;
  background: var(--tm-bg, #fff);
}
.search {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--tm-border, #ddd); border-radius: 8px; font: inherit;
  background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
ul.entries { list-style: none; margin: 0; padding: 0 18px; }
/*
 * A language heading, not a list row: the entries are grouped under it, so the
 * count travels with the name instead of repeating on every row.
 */
.group-title {
  display: flex; align-items: baseline; gap: 6px;
  margin: 0; padding: 12px 18px 2px;
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
  color: var(--tm-muted, #6b6b6b);
}
.group-count { font-weight: 400; opacity: .75; }
ul.entries li {
  display: flex; gap: 10px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px solid var(--tm-border, #f2f2f2);
}
.term { font-weight: 600; }
.meta { color: var(--tm-muted, #8a8a8a); font-size: 12px; }
.translation { margin-left: auto; color: var(--tm-fg, #333); opacity: .82; }
button.danger { all: unset; cursor: pointer; color: var(--tm-danger, #b91c1c); font-size: 12px; padding: 2px 6px; }
button.small {
  all: unset; cursor: pointer; border: 1px solid var(--tm-border, #ddd); border-radius: 7px;
  padding: 4px 10px; font-size: 12px; color: var(--tm-fg, #1a1a1a);
}
button.small:hover { background: var(--tm-hover, #f7f7f7); }
.row { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
label.switch { display: flex; gap: 8px; align-items: center; cursor: pointer; }
select.theme {
  padding: 6px 8px; border: 1px solid var(--tm-border, #ddd); border-radius: 7px;
  font: inherit; background: var(--tm-bg, #fff); color: var(--tm-fg, #1a1a1a);
}
.empty { color: var(--tm-muted, #999); padding: 24px 18px; text-align: center; }
/* The UA sheet's [hidden] rule loses to any author display declaration, and
   .row sets one; without this, a hidden row and a hidden button still paint. */
[hidden] { display: none !important; }
.settings { padding: 14px 18px; }
.status { font-size: 12px; color: var(--tm-muted, #555); }

/* Finger-sized hit areas; the desktop sizes assume a mouse. */
@media (pointer: coarse) {
  .tabs button { padding: 10px 12px; font-size: 14px; }
  .close { padding: 10px 14px; }
  button.small, button.danger { padding: 9px 12px; font-size: 13px; }
  ul.entries li { padding: 11px 0; }
  .search { font-size: 16px; } /* below 16px iOS zooms the page on focus */
  .backdrop { padding: 8px; }
  .body::-webkit-scrollbar { width: 10px; }
  .toolbar { padding: 12px 14px 10px; }
  ul.entries { padding: 0 14px; }
  .group-title { padding: 12px 14px 2px; }
  .empty { padding: 24px 14px; }
  .settings { padding: 12px 14px; }
}
`;

export function createPanel({
  document,
  settings,
  book,
  host,
  onGlossChange,
  onClearCache,
  onLookupToggle,
  onThemeChange,
  lookupSwitchLabel = '双击取词',
  touch = false,
  fileIO = { saveTextFile, pickTextFile },
}) {
  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-tm', 'panel-host');
  hostEl.style.cssText = 'all:initial;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.append(style);

  /*
   * The inline `all: initial` defeats the UA sheet's `[hidden]` rule (author
   * origin wins), so the display has to be toggled inline as well.
   */
  function setHidden(hidden) {
    hostEl.hidden = hidden;
    hostEl.style.display = hidden ? 'none' : 'block';
  }
  setHidden(true);
  document.documentElement.appendChild(hostEl);

  let tab = 'book';
  let filter = '';

  function close() {
    setHidden(true);
    shadow.querySelector('.backdrop')?.remove();
  }

  function render() {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    const header = document.createElement('header');
    const title = document.createElement('h1');
    title.textContent = '翻译生词本';
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const [id, label] of [['book', '生词本'], ['settings', '设置']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('aria-selected', String(tab === id));
      button.onclick = () => {
        tab = id;
        render();
      };
      tabs.append(button);
    }
    const closeButton = document.createElement('button');
    closeButton.className = 'close';
    closeButton.textContent = '×';
    closeButton.title = '关闭';
    closeButton.onclick = close;
    header.append(title, tabs, closeButton);

    const body = document.createElement('div');
    body.className = 'body';
    body.append(tab === 'book' ? renderBook() : renderSettings());

    dialog.append(header, body);
    backdrop.append(dialog);
    shadow.querySelector('.backdrop')?.remove();
    shadow.append(backdrop);
    setHidden(false);
  }

  function renderBook() {
    /*
     * The search sits in its own sticky row above the list rather than inside
     * the scroll area, so a book with hundreds of entries can still be
     * filtered without scrolling back to the top first.
     */
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const search = document.createElement('input');
    search.className = 'search';
    search.placeholder = '搜索单词或译文…';
    search.value = filter;
    toolbar.append(search);

    let listed = buildList();
    // Only the list is rebuilt on input: replacing the input too would take
    // the caret and the on-screen keyboard's composition with it.
    search.oninput = () => {
      filter = search.value;
      const next = buildList();
      listed.replaceWith(next);
      listed = next;
    };

    const fragment = document.createDocumentFragment();
    fragment.append(toolbar, listed);
    return fragment;
  }

  function buildList() {
    const entries = book
      .all()
      .filter((entry) => {
        if (!filter) return true;
        const needle = filter.toLowerCase();
        return entry.term.toLowerCase().includes(needle) || entry.translation.includes(filter);
      })
      .sort((a, b) => b.addedAt - a.addedAt);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = filter ? '没有匹配的词条' : '生词本还是空的。双击网页上的词试试。';
      return empty;
    }

    /*
     * Newest first inside a group, but groups themselves keep a language order:
     * sorting by recency alone would move a whole language up the book because
     * of one word added today.
     */
    const container = document.createElement('div');
    container.className = 'groups';
    for (const group of groupBySourceLang(entries)) {
      const section = document.createElement('section');
      section.className = 'group';
      const title = document.createElement('h2');
      title.className = 'group-title';
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = String(group.entries.length);
      title.append(document.createTextNode(group.label), count);
      const list = document.createElement('ul');
      list.className = 'entries';
      for (const entry of group.entries) {
        const li = document.createElement('li');
        const term = document.createElement('span');
        term.className = 'term';
        term.textContent = entry.term;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = [entry.phonetic, `${entry.sourceLang}→${entry.targetLang}`].filter(Boolean).join(' · ');
        const translation = document.createElement('span');
        translation.className = 'translation';
        translation.textContent = entry.translation;
        const remove = document.createElement('button');
        remove.className = 'danger';
        remove.textContent = '删除';
        remove.onclick = () => {
          book.remove(entry.entryId);
          onGlossChange?.();
          rerenderBody();
        };
        li.append(term, meta, translation, remove);
        list.append(li);
      }
      section.append(title, list);
      container.append(section);
    }
    return container;
  }

  function rerenderBody() {
    const body = shadow.querySelector('.body');
    if (!body) return;
    body.replaceChildren(tab === 'book' ? renderBook() : renderSettings());
  }

  function renderSettings() {
    const wrap = document.createElement('div');
    wrap.className = 'settings';

    const lookupRow = document.createElement('div');
    lookupRow.className = 'row';
    const lookupLabel = document.createElement('label');
    lookupLabel.className = 'switch';
    const lookupBox = document.createElement('input');
    lookupBox.type = 'checkbox';
    lookupBox.checked = settings.lookupEnabled;
    lookupBox.onchange = () => {
      settings.setLookupEnabled(lookupBox.checked);
      onLookupToggle?.(lookupBox.checked);
    };
    lookupLabel.append(lookupBox, document.createTextNode(lookupSwitchLabel));
    lookupRow.append(lookupLabel);

    const themeRow = document.createElement('div');
    themeRow.className = 'row';
    const themeLabel = document.createElement('span');
    themeLabel.textContent = '外观:';
    const themeSelect = document.createElement('select');
    themeSelect.className = 'theme';
    for (const value of THEMES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = THEME_LABELS[value];
      themeSelect.append(option);
    }
    themeSelect.value = settings.theme;
    themeSelect.onchange = () => {
      settings.setTheme(themeSelect.value);
      onThemeChange?.();
    };
    themeRow.append(themeLabel, themeSelect);

    const glossRow = document.createElement('div');
    glossRow.className = 'row';
    const glossLabel = document.createElement('label');
    glossLabel.className = 'switch';
    const glossBox = document.createElement('input');
    glossBox.type = 'checkbox';
    glossBox.checked = settings.glossOn(host);
    glossBox.onchange = () => {
      settings.setGlossOn(host, glossBox.checked);
      onGlossChange?.();
    };
    glossLabel.append(glossBox, document.createTextNode(`在当前站点 (${host}) 显示注音`));
    glossRow.append(glossLabel);

    const ioRow = document.createElement('div');
    ioRow.className = 'row';
    const exportButton = document.createElement('button');
    exportButton.className = 'small';
    exportButton.textContent = '导出到文件';
    const importButton = document.createElement('button');
    importButton.className = 'small';
    importButton.textContent = '从文件导入';
    const ioStatus = document.createElement('span');
    ioStatus.className = 'status';
    ioRow.append(exportButton, importButton, ioStatus);

    /*
     * Import replaces or merges, and only the user knows which one they want,
     * so the file is read first and the choice is asked afterwards. Asking
     * before choosing a file would put a modal in front of a cancelled dialog.
     */
    const importPrompt = document.createElement('div');
    importPrompt.className = 'row';
    importPrompt.hidden = true;
    const importQuestion = document.createElement('span');
    importQuestion.className = 'status';
    const overwriteButton = document.createElement('button');
    overwriteButton.className = 'small';
    overwriteButton.textContent = '覆盖现有';
    const mergeButton = document.createElement('button');
    mergeButton.className = 'small';
    mergeButton.textContent = '合并';
    const cancelImportButton = document.createElement('button');
    cancelImportButton.className = 'small';
    cancelImportButton.textContent = '取消';
    importPrompt.append(importQuestion, overwriteButton, mergeButton, cancelImportButton);

    let pendingCsv = null;

    function closeImportPrompt() {
      pendingCsv = null;
      importPrompt.hidden = true;
    }

    function runImport(mode) {
      try {
        const report = book.importCsv(pendingCsv, { mode });
        ioStatus.textContent =
          mode === 'replace'
            ? `已覆盖:导入 ${report.added} 条,跳过 ${report.skipped} 条`
            : `导入完成:新增 ${report.added},更新 ${report.updated},跳过 ${report.skipped}`;
        onGlossChange?.();
      } catch (error) {
        ioStatus.textContent = `导入失败:${error.message}`;
      } finally {
        closeImportPrompt();
      }
    }

    exportButton.onclick = async () => {
      const count = book.all().length;
      if (count === 0) {
        ioStatus.textContent = '生词本是空的,没有可导出的内容';
        return;
      }
      ioStatus.textContent = '正在导出…';
      try {
        const result = await fileIO.saveTextFile(document.defaultView ?? globalThis, {
          filename: csvFilename(),
          text: book.exportCsv(),
        });
        ioStatus.textContent = result?.cancelled ? '已取消导出' : `已导出 ${count} 条`;
      } catch (error) {
        ioStatus.textContent = `导出失败:${error.message}`;
      }
    };

    importButton.onclick = async () => {
      ioStatus.textContent = '';
      let text;
      try {
        text = await fileIO.pickTextFile(document, { accept: CSV_ACCEPT });
      } catch (error) {
        ioStatus.textContent = `读取文件失败:${error.message}`;
        return;
      }
      if (text === null || text === undefined) return; // picker dismissed
      pendingCsv = text;
      const existing = book.all().length;
      importQuestion.textContent =
        existing === 0
          ? '生词本当前为空,导入会加入文件里的词条。'
          : `生词本现有 ${existing} 条:合并会保留它们,覆盖会先清空再导入。`;
      importPrompt.hidden = false;
    };

    overwriteButton.onclick = () => runImport('replace');
    mergeButton.onclick = () => runImport('merge');
    cancelImportButton.onclick = () => {
      closeImportPrompt();
      ioStatus.textContent = '已取消导入';
    };

    const cacheRow = document.createElement('div');
    cacheRow.className = 'row';
    const clearButton = document.createElement('button');
    clearButton.className = 'small';
    clearButton.textContent = '清空翻译缓存';
    clearButton.onclick = () => {
      onClearCache?.();
      ioStatus.textContent = '缓存已清空';
    };
    cacheRow.append(clearButton);

    wrap.append(
      lookupRow,
      themeRow,
      glossRow,
      document.createElement('hr'),
      ioRow,
      importPrompt,
      cacheRow,
      helpText(),
    );
    return wrap;
  }

  function helpText() {
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent = touch
      ? '长按选中网页上的词,再点选区旁的「译」即可查询。注音只对生词本里已有的词生效,默认关闭,按站点开启。'
      : '双击网页上的词即可查询。注音只对生词本里已有的词生效,默认关闭,按站点开启。';
    return p;
  }

  return {
    open() {
      render();
    },
    close,
    get isOpen() {
      return !hostEl.hidden;
    },
    host: hostEl,
    destroy() {
      hostEl.remove();
    },
  };
}