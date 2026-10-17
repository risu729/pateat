// The stylesheet of the service's script-free pages (sign-in results and errors), inlined
// because their Content-Security-Policy loads nothing.
// The tokens repeat services/api/web/styles.css, which tests/options/design-tokens.test.tsx
// checks; the pages have no Theme select, so they follow the browser's
// prefers-color-scheme. The data-theme="dark" block never applies here and is kept so the
// copy stays identical.

export const PAGE_CSS = `
:root {
  color-scheme: light;
  --bg: #f1f5f9;
  --surface: #ffffff;
  --surface-sunken: #f8fafc;
  --border: #d6e0e8;
  --border-strong: #7a8899;
  --ink: #1e293b;
  --ink-muted: #4f5d6f;
  --accent: #115e59;
  --accent-hover: #134e4a;
  --on-accent: #ffffff;
  --accent-tint: #e6f6f2;
  --accent-ink: #115e59;
  --focus: #0f766e;
  --danger: #b42318;
  --danger-tint: #fdecea;
  --warning: #8a5a00;
  --warning-tint: #fff6dc;
  --shadow-panel: 0 1px 2px rgb(15 23 42 / 5%);
  --shadow-menu: 0 8px 24px rgb(15 23 42 / 15%);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0e1316;
  --surface: #161d21;
  --surface-sunken: #11171a;
  --border: #2a353c;
  --border-strong: #5c6b76;
  --ink: #e4ebf0;
  --ink-muted: #9fb0bc;
  --accent: #5cc7ad;
  --accent-hover: #7fd8c2;
  --on-accent: #04201a;
  --accent-tint: #123029;
  --accent-ink: #7fd8c2;
  --focus: #7fd8c2;
  --danger: #ff8a7a;
  --danger-tint: #3a1814;
  --warning: #f2c14e;
  --warning-tint: #33280d;
  --shadow-panel: 0 1px 2px rgb(0 0 0 / 40%);
  --shadow-menu: 0 8px 24px rgb(0 0 0 / 50%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0e1316;
    --surface: #161d21;
    --surface-sunken: #11171a;
    --border: #2a353c;
    --border-strong: #5c6b76;
    --ink: #e4ebf0;
    --ink-muted: #9fb0bc;
    --accent: #5cc7ad;
    --accent-hover: #7fd8c2;
    --on-accent: #04201a;
    --accent-tint: #123029;
    --accent-ink: #7fd8c2;
    --focus: #7fd8c2;
    --danger: #ff8a7a;
    --danger-tint: #3a1814;
    --warning: #f2c14e;
    --warning-tint: #33280d;
    --shadow-panel: 0 1px 2px rgb(0 0 0 / 40%);
    --shadow-menu: 0 8px 24px rgb(0 0 0 / 50%);
  }
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
