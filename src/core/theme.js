/**
 * Theme resolution.
 *
 * The three floating surfaces (Popup, Bubble, Panel) share one decision, so it
 * is made once, in pure code, rather than by a `prefers-color-scheme` rule
 * inside each shadow root: a user-forced theme has to override the system one
 * everywhere, and a media query cannot express that.
 */

export const THEMES = ['system', 'light', 'dark'];

/** Map whatever is in storage onto a known setting. */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'system';
}

/**
 * @param {object} input
 * @param {string} input.setting      'system' | 'light' | 'dark'
 * @param {boolean} input.prefersDark whether the OS currently prefers dark
 * @returns {'light' | 'dark'} the theme to render
 */
export function resolveTheme({ setting, prefersDark } = {}) {
  const wanted = normalizeTheme(setting);
  if (wanted === 'light' || wanted === 'dark') return wanted;
  return prefersDark ? 'dark' : 'light';
}