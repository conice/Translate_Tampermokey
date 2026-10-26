/**
 * Copying a translation to the clipboard.
 *
 * Two paths, because neither is dependable on its own: the async Clipboard API
 * is missing on older engines and refused outright on many pages (the document
 * is not focused, the site's permission policy blocks it), while the old
 * `execCommand('copy')` still works in more places but needs a real selection.
 * A failure is reported as `false` and never thrown: copying is a convenience,
 * not something that should ever look like an error in the Popup.
 */
export function createCopyText({ navigator, document }) {
  return async function copyText(text) {
    if (!text) return false;

    const clipboard = navigator?.clipboard;
    if (typeof clipboard?.writeText === 'function') {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        /* fall through to the old command */
      }
    }

    return copyWithSelection(text, document);
  };
}

/**
 * The legacy path: put the text in a scratch textarea, select it, run `copy`.
 *
 * The textarea must be out of the way but still selectable, and it must be
 * removed afterwards -- leaving it in the page would both litter the host DOM
 * and steal the focus the next time the user typed.
 */
function copyWithSelection(text, document) {
  if (typeof document?.execCommand !== 'function') return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area?.remove?.();
  }
}
