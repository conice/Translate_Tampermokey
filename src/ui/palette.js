/**
 * The palette shared by every floating surface.
 *
 * Values are applied as inline custom properties on each shadow host, so one
 * set of names works everywhere: the Popup, the Bubble and the Panel each read
 * `var(--tm-bg)` and so on, and nothing has to know which surface it is.
 *
 * Inline and per host, rather than a class plus `:host(.theme-dark)` rules or a
 * `@media (prefers-color-scheme: dark)` block, for two reasons: a media query
 * cannot express "the user forced this theme", and keeping the values here
 * leaves exactly one copy of them instead of a JS copy and a CSS copy that can
 * drift apart.
 */

export function applyPalette(host, theme) {
  const dark = theme === 'dark';
  const values = dark
    ? {
        '--tm-bg': '#1c1c1e',
        '--tm-fg': '#f2f2f7',
        '--tm-muted': '#9b9ba1',
        '--tm-border': '#3a3a3e',
        '--tm-accent': '#60a5fa',
        '--tm-accent-fg': '#0b1220',
        '--tm-hover': '#2c2c31',
        /* A one-step surface for chips and the phonetic pill. */
        '--tm-chip': '#2c2c31',
        /* The speak button's filled circle: accent without competing with it. */
        '--tm-accent-soft': '#1d3350',
        '--tm-danger': '#ff7b72',
        // The part-of-speech label. Kept out of --tm-muted so it stays
        // recognisable as a label rather than as quieter body text.
        '--tm-pos': '#e0a83c',
        '--tm-pos-bg': 'rgba(224,168,60,.16)',
        'color-scheme': 'dark',
      }
    : {
        '--tm-bg': '#ffffff',
        '--tm-fg': '#1a1a1a',
        '--tm-muted': '#6b6b6b',
        '--tm-border': '#d8d8d8',
        '--tm-accent': '#2563eb',
        '--tm-accent-fg': '#ffffff',
        '--tm-hover': '#eff6ff',
        '--tm-chip': '#f1f3f5',
        '--tm-accent-soft': '#e8f0fe',
        '--tm-danger': '#b91c1c',
        '--tm-pos': '#9a6b00',
        '--tm-pos-bg': 'rgba(154,107,0,.12)',
        'color-scheme': 'light',
      };
  for (const [name, value] of Object.entries(values)) {
    host.style.setProperty(name, value);
  }
}