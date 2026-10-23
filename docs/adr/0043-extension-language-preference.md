# Extension language preference

Status: Proposed. The owner chose i18next with react-i18next (2026-10-12 14:31 UTC) and
to translate the extension now rather than in phase 3 (2026-10-18). Where the language
preference is stored is still the owner's question (asked again 2026-10-23, after the
first ask assumed that the service worker shows no translated text); this records the
recommended answer, `chrome.storage.local`, which the implementation follows until the
owner decides. Amends no ADR.

Date: 2026-10-17, revised 2026-10-23

## Context

The [translation work](../plan.md#phase-3-public-release) calls for English and Japanese
extension UI and a language setting. Besides the extension pages, the service worker
writes the toolbar tooltips (`chrome.action.setTitle` in `src/login/badge.ts`, from the
choices and notes `src/login/runtime.ts` passes it). A service worker cannot read
`localStorage`, so a preference kept there, as the theme is, leaves those tooltips in
English. The official Bitwarden extension keeps its locale in extension storage
(`KeyDefinition(TRANSLATION_DISK, "locale")`, global disk state, that is
`chrome.storage.local`) and falls back to the browser's language.

## Decision

Keep `system`, `en` or `ja` in `chrome.storage.local` under `pateat.language`, per
browser profile, independent of service pairing, vault state and synced policy. `system`
uses the first English or Japanese entry of `navigator.languages`, which pages and the
worker both see, and falls back to English. A stored value that is not one of the three,
or a store that cannot be read, behaves like `system`; a choice whose write fails
applies until the page closes.

Each extension page awaits the stored value before its first render, so no English text
flashes, and follows later writes and the browser's `languagechange`. The worker reads
it at start and writes every tab's tooltip again when the language changes; tooltips
keep catalog keys and parameters, translated when drawn. The theme stays in
`localStorage`, since no worker reads it.

Bundle English and Japanese catalogs with i18next and never fetch translations. English
source strings are the keys, and the Japanese catalogs are type-checked against the
English ones. Vault names, usernames, hostnames and unknown status codes are
interpolated as text. Dates and lists use the browser's regional form of the UI language
(`en-GB` for English when the browser lists it). Japanese terms follow the official
Bitwarden Japanese client: 保管庫, アイテム, デバイス, マスターパスワード, 2 段階認証.

These stay in one language whatever the setting: the bug report text, exported logs and
diagnostic codes (English, for the people who read reports); the name "Pateat"; the
standard WebAuthn error text given to sites; and the manifest description, which Chrome
takes from `public/_locales` by its own UI language, since a setting cannot reach the
manifest. The service's own pages are later work.

## Consequences

Language can be changed without pairing or changing login policy, and the toolbar
follows it. No browser permission, messaging contract or service API is added; `storage`
was already granted. Pages wait a few milliseconds for the read before rendering.
Different profiles and the service's pages do not share the preference.

## Alternatives

- `localStorage`, as the theme: synchronous and already implemented, but the toolbar
  tooltips stay English.
- A synced settings field shares the preference between devices, but couples
  presentation to pairing and to settings sync, changes the policy schema, and shows the
  default language until settings load. Bitwarden does not sync its locale.
- `localStorage` for pages with a copy in `chrome.storage.local` for the worker: two
  sources that can drift, to save one asynchronous read.
- English by default is predictable but does not follow the user's browser setting.
