// The stylesheet of the service's script-free pages (sign-in results, errors and the
// Claude settings page), inlined because their Content-Security-Policy loads nothing.
// The light-dark() tokens repeat services/api/web/styles.css, which
// tests/options/design-tokens.test.tsx checks. These pages have no Theme select, so
// color-scheme: light dark follows the browser. The explicit scheme overrides keep
// the copies identical. The status note is neutral because it shows errors as well
// as "Saved".

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
h2 {
  margin: 1.5rem 0 0.5rem;
  font-size: 1.125rem;
}
p {
  margin: 0.5rem 0;
}
code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", monospace;
  overflow-wrap: anywhere;
}
a {
  color: var(--accent-ink);
}
input,
button {
  font: inherit;
}
input {
  box-sizing: border-box;
  max-width: 100%;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.5rem;
  color: var(--ink);
  background: var(--surface);
}
button {
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 0.5rem;
  color: var(--on-accent);
  background: var(--accent);
  font-weight: 600;
  cursor: pointer;
}
button:hover {
  border-color: var(--accent-hover);
  background: var(--accent-hover);
}
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
table {
  border-collapse: collapse;
}
th,
td {
  padding: 0.25rem 0.75rem 0.25rem 0;
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--ink-muted);
  font-weight: 600;
}
[role="status"] {
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface-sunken);
}
`;
