/**
 * Moving the Vocabulary Book in and out of the browser as a file.
 *
 * Saving prefers the File System Access API, which is the only path that gives
 * the user a real "choose where to save" dialog; every other engine (Firefox,
 * older Chromium, a userscript sandbox that hides the API) falls back to a
 * blob download, which still lands in the browser's download flow.
 *
 * Opening uses an `<input type="file">`. It is the one picker that works in
 * every engine and needs no secure context, and unlike `showOpenFilePicker`
 * it also works on mobile browsers.
 */

export const CSV_ACCEPT = '.csv,text/csv';

/** `生词本-2026-10-26.csv`: sorts by date in a folder of exports. */
export function csvFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `生词本-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

/**
 * Write `text` to a file the user picks. Resolves to `{saved, cancelled}`;
 * only a refused picker falls through to the download path, an explicit
 * cancel from the user ends here.
 */
export async function saveTextFile(window, { filename, text, type = 'text/csv' }) {
  const view = window;
  const blob = new Blob([text], { type: `${type};charset=utf-8` });

  if (typeof view?.showSaveFilePicker === 'function') {
    try {
      const handle = await view.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { saved: true, cancelled: false };
    } catch (error) {
      if (error?.name === 'AbortError') return { saved: false, cancelled: true };
      /* the API exists but refused (sandbox, permissions): download instead */
    }
  }

  const url = view.URL.createObjectURL(blob);
  const link = view.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  (view.document.body ?? view.document.documentElement).append(link);
  link.click();
  link.remove();
  // The click starts the download; the URL must outlive this tick to be read.
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
  return { saved: true, cancelled: false };
}

/**
 * Ask for a text file and resolve with its contents, or `null` if the user
 * closed the picker without choosing one.
 */
export function pickTextFile(document, { accept = CSV_ACCEPT } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // Kept selectable but invisible: the picker only opens from a real input.
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';

    const finish = (value) => {
      input.remove();
      resolve(value);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish(await readText(file));
      } catch (error) {
        input.remove();
        reject(error);
      }
    };
    // Chromium 113+ fires this when the picker is dismissed; elsewhere the
    // input simply stays unfired until the user tries again.
    input.oncancel = () => finish(null);

    (document.body ?? document.documentElement).append(input);
    input.click();
  });
}

function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}
