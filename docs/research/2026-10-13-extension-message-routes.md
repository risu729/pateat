# Extension message routes and @webext-core/messaging

Researched: 2026-10-13, from the repository at
[`281362e`](https://github.com/risu729/pateat/commit/281362e) (main) and the published
`@webext-core/messaging` 4.0.0 package. The owner asked what sends messages where inside
the extension before `@webext-core/messaging` (approved in
[development.md](../development.md)) was adopted. Line numbers are at `281362e`.
Routes that exist only in probe builds (`login.probe.*`, `crypto.probe`) are left out.

## Routes

Every route goes through the background service worker. Extension pages do not message
each other, and tabs do not message each other; only the background sends into a tab.

| Route | From and to | Mechanism | Main types | Receiver's checks |
| --- | --- | --- | --- | --- |
| A | popup, options, diagnostics, passkey picker to background | `runtime.sendMessage` | `settings.get`/`save`, `service.pair`, `diagnostics.status`, `login.choice.get`/`pick`, `passkey-chooser.load`/`answer` | `sender.url` is one of the known extension pages (`entrypoints/background.ts:384`); Valibot schemas |
| B | options and background | Port `pateat.bitwarden-setup.v1` | `connection.begin`, `connection.sync` and seven more | options page checked on connect; no duplicate `requestId`; at most four at once |
| C | crypto offscreen document and background; offscreen document and its Worker | Port `pateat.crypto-host.v1`; `worker.postMessage` | `crypto.command`, `crypto.result` | a fresh nonce in the offscreen URL; `runtime.getContexts` finds exactly one |
| D1 | login content script to background | `runtime.sendMessage` | `login.document.ready`, `login.document.submitted`, `login.operation.authorize` | `sender.tab.id`, `frameId` and `documentId` required (`src/login/runtime.ts:1931`) |
| D2 | background to login content script | `tabs.sendMessage(tabId, message, { frameId, documentId })` | `login.execute` (carries the password), `login.observe`, `login.extract`, `login.reconnect` | no `sender.tab` (so it came from the extension) and the per-document token |
| E1 | passkey MAIN-world script and passkey isolated-world script | `window.postMessage` | `get`, `create`, `cancel`, `ack`, `result` | not trusted: the page's own scripts can read and forge these |
| E2 | passkey isolated-world script to background | `runtime.sendMessage` | `passkey.get`, `passkey.create`, `passkey.cancel` | top frame, `documentId` present, `sender.origin` matches the URL |

## Why D2 names the document

`src/login/runtime.ts:2470` sends with both `frameId` and `documentId`, as
[architecture.md](../architecture.md) requires for tabs, frames and documents. A
`documentId` changes on every navigation or reload, while `tabId` and `frameId` stay the
same. If the page navigates just before `login.execute` is sent, a send by `frameId`
alone is delivered to the new document. Its content script drops it because the token
differs, but the password has already reached another site's renderer. With the
`documentId`, Chrome refuses delivery because the old document is gone, and the
background stops the login. The renderer exposure is inferred from Chrome's documented
delivery rules; the code comments do not state it.

## What @webext-core/messaging 4.0.0 covers

Read from the package's type definitions and `dist/index.mjs`; nothing was run.

- `defineExtensionMessaging` can carry routes A, D1 and E2: one typed `onMessage` per
  type replaces the long `if` chain in the background's listener
  (`entrypoints/background.ts:391`). Sender checks and Valibot validation stay in each
  handler.
- It cannot carry D2. Its tab target is `{ tabId, frameId? }`, and it calls
  `chrome.tabs.sendMessage` with `{ frameId }` only, so there is no way to pass a
  `documentId`.
- The same tab path does not read `chrome.runtime.lastError`. A failed delivery
  resolves to nothing, and the messenger then throws a generic `No response` error
  instead of Chrome's reason.
- It has no Port support, so routes B and C stay as they are.
- `@webext-core/messaging/page` has `defineWindowMessaging` (over `window.postMessage`)
  and `defineCustomEventMessaging`, which could carry E1's shape. E1 is a channel the
  page can forge, so the isolated-world checks stay either way.
- Every message is wrapped as `{ id, type, data, timestamp }`, so a sender and its
  receiver change in the same pull request.
