// The stylesheet of the service's script-free pages (sign-in results and errors), inlined
// because their Content-Security-Policy loads nothing.
// The light-dark() tokens repeat services/api/web/styles.css, which
// tests/options/design-tokens.test.tsx checks. These pages have no Theme select, so
// color-scheme: light dark follows the browser. The explicit scheme overrides keep
// the copies identical.

export const PAGE_CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#f1f5f9, #0e1316);
  --surface: light-dark(#ffffff, #161d21);
  --surface-sunken: light-dark(#f8fafc, #11171a);
  --border: light-dark(#d6e0e8, #2a353c);
  --border-strong: light-dark(#7a8899, #5c6b76);
  --ink: light-dark(#1e293b, #e4ebf0);
  --ink-muted: light-dark(#4f5d6f, #9fb0bc);
  --accent: light-dark(#115e59, #5cc7ad);
  --accent-hover: light-dark(#134e4a, #7fd8c2);
  --on-accent: light-dark(#ffffff, #04201a);
  --accent-tint: light-dark(#e6f6f2, #123029);
  --accent-ink: light-dark(#115e59, #7fd8c2);
  --focus: light-dark(#0f766e, #7fd8c2);
  --danger: light-dark(#b42318, #ff8a7a);
  --danger-tint: light-dark(#fdecea, #3a1814);
  --warning: light-dark(#8a5a00, #f2c14e);
  --warning-tint: light-dark(#fff6dc, #33280d);
  --shadow-panel-color: light-dark(rgb(15 23 42 / 5%), rgb(0 0 0 / 40%));
  --shadow-menu-color: light-dark(rgb(15 23 42 / 15%), rgb(0 0 0 / 50%));
  --shadow-panel: 0 1px 2px var(--shadow-panel-color);
  --shadow-menu: 0 8px 24px var(--shadow-menu-color);
}
:root[data-theme="light"] {
  color-scheme: light;
}
:root[data-theme="dark"] {
  color-scheme: dark;
}
body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font:
    16px/1.5 system-ui,
    -apple-system,
    "Segoe UI",
    "Hiragino Sans",
    "Noto Sans JP",
    "Yu Gothic UI",
    Meiryo,
    sans-serif;
}
.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  font-weight: 700;
}
.brand img {
  width: 1.5rem;
  height: 1.5rem;
}
main {
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}
h1 {
  margin: 0 0 0.75rem;
  font-size: 1.75rem;
  line-height: 2.25rem;
  letter-spacing: -0.02em;
}
p {
  margin: 0.5rem 0;
}
a {
  color: var(--accent-ink);
}
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
`;
