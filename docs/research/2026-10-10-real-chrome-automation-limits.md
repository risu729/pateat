# Limits on automating the owner's installed Chrome

Researched: 2026-10-10, from Claude Code, Claude in Chrome and Chrome documentation and
public issue reports, after a session on the owner's PC was refused full control of
Chrome. Nothing was worked around. It explains why the installed Chrome checks in
[development](../development.md#installed-chrome-synthetic-login-probe) keep steps for
the owner, and relates to the rule in [AGENTS.md](../../AGENTS.md) not to work around
refused `chrome://` and `chrome-extension://` pages. It grants no capability.

## Findings

- **Computer use gives browsers view-only access.** Claude Code's computer use fixes an
  access tier per application category: browsers and trading apps are "View only",
  terminals and IDEs "Click only", everything else "Full control", and the tier cannot
  be changed
  ([desktop app permissions](https://code.claude.com/docs/en/desktop#app-permissions),
  [computer use](https://code.claude.com/docs/en/computer-use)). This is the same in the
  desktop app, the CLI and Remote Control sessions. Browser actions are meant to go
  through Claude in Chrome instead.
- **Claude in Chrome asks per site.** Choosing "always allow" for a site, or the skip
  mode, removes the per-action prompts
  ([permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)).
  Reports on Windows and macOS say "always allow" is not kept when Claude in Chrome is
  driven from the desktop app or over MCP
  ([anthropics/claude-code#74715](https://github.com/anthropics/claude-code/issues/74715),
  [#49979](https://github.com/anthropics/claude-code/issues/49979)); both were open on
  2026-10-10.
- **Extensions cannot act on `chrome://` pages or other extensions' pages.** Content
  scripts run only on `http`, `https` and `file` URLs
  ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)),
  and the `debugger` API cannot attach to another extension's pages (Chromium's
  [debugger API tests](https://crrev.com/4dafc317b6e614bdd86ea3e2f5c2fc2e8518a877/chrome/browser/extensions/api/debugger/debugger_apitest.cc)).
  Claude in Chrome is an extension, so it is expected to be bound by this (inferred).
  If so, `chrome://extensions` and Pateat's own settings page need the owner's hands in
  installed Chrome.
- **Branded Chrome cannot load an unpacked extension from the command line.** Chrome
  137 and later ignore `--load-extension`
  ([Chromium extensions PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)),
  and since Chrome 136 `--remote-debugging-port` is refused for the default profile
  ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). A fully
  scripted run needs Chromium or Chrome for Testing started by Playwright, which is how
  the cloud and CI browser tests run; the owner's everyday profile cannot be driven that
  way.

## Consequence for testing

Everything that does not need the owner's profile, accounts or other installed
extensions runs in Chromium under Playwright, where extension pages can be opened
directly. Checks that do need installed Chrome are split: the owner does the
`chrome://extensions` and Pateat settings steps by hand, and ordinary HTTPS pages can be
driven with Claude in Chrome.
