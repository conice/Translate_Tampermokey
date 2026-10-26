/**
 * The Panel: vocabulary management and settings, as an in-page overlay.
 *
 * Everything lives behind a Shadow DOM so host styles cannot reach it. The
 * panel is opened from the userscript menu, because it is not part of normal
 * reading and should not be one stray click away.
 */

const STYLE = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483646;
  background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: #1a1a1a;
}
.dialog {
  width: min(720px, calc(100vw - 32px));
  max-height: min(640px, calc(100vh - 48px));
  background: #fff; border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.3);
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid #ececec;
}
h1 { font-size: 16px; margin: 0; font-weight: 600; }
.tabs { display: flex; gap: 4px; margin-left: auto; }
.tabs button {
  all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px;
  color: #555; font-size: 13px;
}
.tabs button[aria-selected="true"] { background: #eef2ff; color: #1d4ed8; }
.close { all: unset; cursor: pointer; color: #888; padding: 4px 8px; font-size: 18px; }
.body { padding: 14px 18px; overflow: auto; }
.search {
  width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 10px;
  border: 1px solid #ddd; border-radius: 8px; font: inherit;
}
ul.entries { list-style: none; margin: 0; padding: 0; }
ul.entries li {
  display: flex; gap: 10px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px solid #f2f2f2;
}
.term { font-weight: 600; }
.meta { color: #8a8a8a; font-size: 12px; }
.translation { margin-left: auto; color: #333; }
button.danger { all: unset; cursor: pointer; color: #b91c1c; font-size: 12px; padding: 2px 6px; }
button.small {
  all: unset; cursor: pointer; border: 1px solid #ddd; border-radius: 7px;
  padding: 4px 10px; font-size: 12px;
}
button.small:hover { background: #f7f7f7; }
.row { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
label.switch { display: flex; gap: 8px; align-items: center; cursor: pointer; }
textarea {
  width: 100%; box-sizing: border-box; min-height: 140px; font-family: ui-monospace, monospace;
  font-size: 12px; border: 1px solid #ddd; border-radius: 8px; padding: 8px;
}
.empty { color: #999; padding: 24px 0; text-align: center; }
.status { font-size: 12px; color: #555; }
`;

export function createPanel({ document, settings, book, host, onGlossChange, onClearCache, onLookupToggle }) {
  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-tm', 'panel-host');
  hostEl.style.cssText = 'all:initial;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.append(style);
  hostEl.hidden = true;
  document.documentElement.appendChild(hostEl);

  let tab = 'book';
  let filter = '';

  function close() {
    hostEl.hidden = true;
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
    hostEl.hidden = false;
  }

  function renderBook() {
    const wrap = document.createElement('div');
    const search = document.createElement('input');
    search.className = 'search';
    search.placeholder = '搜索单词或译文…';
    search.value = filter;
    search.oninput = () => {
      filter = search.value;
      const list = wrap.querySelector('ul.entries');
      list?.replaceWith(buildList());
      const empty = wrap.querySelector('.empty');
      if (empty) empty.replaceWith(buildList());
    };
    wrap.append(search, buildList());
    return wrap;
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

    const list = document.createElement('ul');
    list.className = 'entries';
    for (const entry of entries) {
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
    return list;
  }

  function rerenderBody() {
    const body = shadow.querySelector('.body');
    if (!body) return;
    body.replaceChildren(tab === 'book' ? renderBook() : renderSettings());
  }

  function renderSettings() {
    const wrap = document.createElement('div');

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
    lookupLabel.append(lookupBox, document.createTextNode('双击取词'));
    lookupRow.append(lookupLabel);

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

    const targetRow = document.createElement('div');
    targetRow.className = 'row';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = '本站目标语言:';
    const targetInput = document.createElement('input');
    targetInput.placeholder = '自动(如 zh-CN / en / ja)';
    targetInput.value = settings.targetOverride(host) ?? '';
    targetInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:7px;font:inherit;width:180px;';
    const targetSave = document.createElement('button');
    targetSave.className = 'small';
    targetSave.textContent = '保存';
    const targetStatus = document.createElement('span');
    targetStatus.className = 'status';
    targetSave.onclick = () => {
      settings.setTargetOverride(host, targetInput.value.trim());
      targetStatus.textContent = '已保存,刷新页面后生效';
    };
    targetRow.append(targetLabel, targetInput, targetSave, targetStatus);

    const ioRow = document.createElement('div');
    ioRow.className = 'row';
    const exportButton = document.createElement('button');
    exportButton.className = 'small';
    exportButton.textContent = '导出 JSON';
    const importButton = document.createElement('button');
    importButton.className = 'small';
    importButton.textContent = '导入 JSON';
    const importArea = document.createElement('textarea');
    importArea.placeholder = '把导出的 JSON 粘贴到这里,然后点「确认导入」';
    const importConfirm = document.createElement('button');
    importConfirm.className = 'small';
    importConfirm.textContent = '确认导入';
    importConfirm.hidden = true;
    const ioStatus = document.createElement('span');
    ioStatus.className = 'status';

    exportButton.onclick = () => {
      const json = book.exportJson();
      importArea.value = json;
      navigator.clipboard?.writeText(json).then(
        () => (ioStatus.textContent = `已导出并复制 (${book.all().length} 条)`),
        () => (ioStatus.textContent = '已导出到下方文本框'),
      );
    };
    importButton.onclick = () => {
      importConfirm.hidden = false;
      importArea.focus();
    };
    importConfirm.onclick = () => {
      try {
        const report = book.importJson(importArea.value);
        ioStatus.textContent = `导入完成:新增 ${report.added},更新 ${report.updated},跳过 ${report.skipped}`;
        onGlossChange?.();
      } catch (error) {
        ioStatus.textContent = `导入失败:${error.message}`;
      }
    };
    ioRow.append(exportButton, importButton, importConfirm, ioStatus);

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
      glossRow,
      targetRow,
      document.createElement('hr'),
      ioRow,
      importArea,
      cacheRow,
      helpText(),
    );
    return wrap;
  }

  function helpText() {
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent =
      '双击网页上的词即可查询。注音只对生词本里已有的词生效,默认关闭,按站点开启。';
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
    destroy() {
      hostEl.remove();
    },
  };
}