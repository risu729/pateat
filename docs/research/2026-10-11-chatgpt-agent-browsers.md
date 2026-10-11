# Pateat in ChatGPT's agent browsers

Researched: 2026-10-11, from OpenAI's documentation at learn.chatgpt.com, public
GitHub issues and press coverage. Nothing below was tested: no ChatGPT account was
used and no build was installed. It answers the owner's question of 2026-10-11
whether Pateat can be installed in the browser a ChatGPT agent (a "dot" or a ChatGPT
Work task) uses. It is not a decision and grants no capability. The owner placed
"ChatGPT agent logins must work" in Phase 2 of the plan.

## Which browser the agent uses

The ChatGPT agent mode of 2025 has been withdrawn; its help article now points to
ChatGPT Work and the cloud browser (as reported in search results; help.openai.com
returned HTTP 403 to this session). ChatGPT now has three browsers an agent can
operate:

| Browser | Where it runs | Extensions | Source |
| --- | --- | --- | --- |
| Cloud browser (ChatGPT Work, dots) | OpenAI's cloud computer | None documented | [Browser](https://learn.chatgpt.com/docs/browser), [Connect computers and apps to your dot](https://learn.chatgpt.com/docs/dots/computers-and-apps) |
| Built-in browser of the ChatGPT desktop app | The owner's PC, separate profile | Chrome extensions since 2026-09-18 | [Browser](https://learn.chatgpt.com/docs/browser), [RuntimeWire, 2026-09-18](https://runtimewire.com/article/openai-chatgpt-desktop-browser-chrome-extensions) |
| The owner's own Chrome, Edge, Brave, Opera or Vivaldi | The owner's PC, their regular profile | Everything already installed | [Browser extension](https://learn.chatgpt.com/docs/chrome-extension) |

### Cloud browser

- The cloud browser "doesn't use your personal browser's open tabs, browsing history,
  saved passwords, cookies, extensions, or existing signed-in sessions"
  ([Browser](https://learn.chatgpt.com/docs/browser)). No OpenAI page describes
  installing an extension in it, from the Chrome Web Store or unpacked.
- The dot's computer "can keep its state between periods of use. It has its own files,
  software, and browser sessions", and the owner can **Take over** its mouse and
  keyboard ([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)). Whether a
  takeover can reach `chrome://extensions` or the Web Store was not found in any
  source. The retired agent mode stated it could not install extensions
  ([Atlas help article](https://help-lb.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas)).
- Takeover has open failure reports on Windows and macOS
  ([openai/codex#39295](https://github.com/openai/codex/issues/39295), opened
  2026-08-18, still reported on 2026-10-11).
- Sign-in there uses ChatGPT's own form, whose values go to the remote browser and not
  the model, or the owner signs in during a takeover. Sessions persist until the site
  expires them; **Save to Passwords** optionally stores a login.

Even if an install were possible, Pateat's unlocked vault key and its persistent
unlock key ([ADR 0006](../adr/0006-atomic-local-vault-cache.md)) would then live on
OpenAI's machine. "Keep vault secrets and signing local"
([ADR 0001](../adr/0001-local-login-boundary.md)) does not allow that without a new
owner decision.

### Built-in browser of the desktop app

- OpenAI announced Chrome extension support for the in-app browser on 2026-09-18:
  install, pin and use extensions such as 1Password, with OpenAI stating that
  "ChatGPT's agent cannot interact with extensions or their data"
  ([RuntimeWire](https://runtimewire.com/article/openai-chatgpt-desktop-browser-chrome-extensions)).
  No source says whether unpacked extensions or Developer mode are allowed. Pateat is
  not on the Chrome Web Store, so this is the open question for this route.
- The profile is separate from the owner's Chrome, so Pateat would need its own
  pairing (an interactive Cloudflare Access login on `pateat.takuk.me`,
  [ADR 0020](../adr/0020-direct-device-pairing.md)) and its own Bitwarden login there.
- The desktop app is available for Windows
  ([Windows desktop app](https://learn.chatgpt.com/docs/windows/windows-app)).

### The owner's own Chrome

- With the ChatGPT browser extension and the desktop app's **Settings > Computer Use**,
  a ChatGPT Work or Codex task can drive the owner's Chrome profile with `@Chrome`.
  Computer Use is available on macOS and Windows
  ([Computer Use](https://learn.chatgpt.com/docs/computer-use)). Pateat is already
  installed in that profile.
- A dot works in its cloud browser by default. When a site blocks it, the dot can be
  asked to use a connected computer, which "may create a separate local task" and
  "doesn't guarantee that a particular local browser is supported"
  ([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)).
- The ChatGPT extension asks for "Access the page debugger" and can use CDP after a
  per-site approval
  ([Browser extension](https://learn.chatgpt.com/docs/chrome-extension)). A value
  Pateat fills into the page is readable by the page and its debugger
  ([architecture](../architecture.md#components-and-trust-boundaries)), so the
  agent's debugger can read a filled password in that tab.

## What to check next

None of these has been run. Each needs the owner's ChatGPT account, so each needs
separate owner approval:

1. In the owner's Chrome with Pateat installed, start a ChatGPT Work task with
   `@Chrome` on a site with a recipe and confirm Pateat logs in while the agent drives
   the tab.
2. In the desktop app's built-in browser, check whether an unpacked extension can be
   loaded at all.
3. In a dot's cloud computer during a takeover, check whether `chrome://extensions` or
   the Web Store opens. This only records what is possible; installing Pateat there
   would need an owner decision on the vault key leaving the owner's PC.
