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
 * only a picker that never opened falls through to the download path, an
 * explicit cancel from the user ends here, and a failure after a destination
 * has been chosen rejects — the text must not land somewhere else silently.
 */
export async function saveTextFile(window, { filename, text, type = 'text/csv' }) {
  const view = window;
  const blob = new Blob([text], { type: `${type};charset=utf-8` });

  if (typeof view?.showSaveFilePicker === 'function') {
    let handle = null;
    try {
      handle = await view.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }],
      });
    } catch (error) {
      if (error?.name === 'AbortError') return { saved: false, cancelled: true };
      /*
       * The API exists but refused before any file was chosen (a userscript
       * sandbox, permissions): the download below is still the export the user
       * asked for.
       */
    }

    if (handle) {
      /*
       * Past this point the user has picked a destination. If the write fails,
       * a download would put the same text somewhere else without saying so;
       * the rejection goes to the panel instead.
       */
      const writable = await handle.createWritable();
      let failure = null;
      try {
        await writable.write(blob);
      } catch (error) {
        failure = error;
      } finally {
        // Closing releases the temporary file even when the write failed.
        try {
          await writable.close();
        } catch (error) {
          if (!failure) failure = error;
        }
      }
      if (failure) throw failure;
      return { saved: true, cancelled: false };
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
 * How long after the page regains focus to wait for the picker's `change`
 * event. Chromium fires `cancel` when the dialog is dismissed, but other
 * engines only refocus the page, which would leave the promise pending forever.
 */
const PICKER_SETTLE_MS = 1000;

/**
 * Ask for a text file and resolve with its contents, or `null` if the user
 * closed the picker without choosing one.
 */
export function pickTextFile(document, { accept = CSV_ACCEPT } = {}) {
  return new Promise((resolve, reject) => {
    const view = document.defaultView ?? globalThis;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // Kept selectable but invisible: the picker only opens from a real input.
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';

    let settled = false;
    let timer = null;

    const cleanup = () => {
      input.remove();
      if (timer !== null) {
        view.clearTimeout(timer);
        timer = null;
      }
      view.removeEventListener?.('focus', onFocus);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    /*
     * The picker closes (or the engine brings the page back) before `change`
     * where that event exists. Looking at the file list a moment later catches
     * the engines that never fire `cancel`; an empty list means dismissal,
     * while a chosen file's `change` arrives first and calls off the timer.
     */
    function onFocus() {
      if (settled) return;
      timer = view.setTimeout(() => {
        timer = null;
        if (!input.files?.length) finish(null);
      }, PICKER_SETTLE_MS);
    }

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish(await readText(file));
      } catch (error) {
        fail(error);
      }
    };
    // Chromium 113+ fires this when the picker is dismissed.
    input.oncancel = () => finish(null);

    view.addEventListener?.('focus', onFocus, { once: true });
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
