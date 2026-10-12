# Translating the extension's UI text

Researched: 2026-10-12, from the repository at `deeee4b` (main). The owner asked for a
comparison of the ways to translate the extension's UI text into Japanese, the first
phase 3 item in the [roadmap](../plan.md#phase-3-public-release). This note is a
comparison for the owner's choice; nothing is adopted. Package data is from the npm
registry on 2026-10-12. One behavior was checked in Chromium (below); nothing else was
prototyped.

## What has to be translated

- Four extension pages, all React: the popup, options, diagnostics and passkey-picker
  entrypoints. Their `.tsx` files under `apps/extension/src` and
  `apps/extension/entrypoints` are 13 files and 3,585 lines; a rough grep finds about
  600 English string literals in them and in `src/diagnostics/labels.ts`. About seven
  places put `<code>`, `<strong>` or `<a>` inside a sentence.
- The pages' `<title>` elements in `entrypoints/*/index.html`, such as
  `Choose a passkey · Pateat`. Chrome does not replace `__MSG_key__` in extension HTML,
  so any option sets `document.title` from code.
- Text the service worker sets: the toolbar button's title (`browser.action.setTitle` in
  `src/login/runtime.ts`), including a count with an English plural:
  `` `Pateat: ${candidates.length} accounts match this page. Click to choose one.` ``.
- English built outside the pages and shown as is: the settings store's `failure(...)`
  messages (`packages/contracts/src/settings-store.ts`), shown through
  `result.error.message` in `src/options/settings-app.tsx`; the diagnostics checks'
  `detail` strings (`src/diagnostics/status.ts`); and thrown errors such as
  `Connection operation could not be confirmed.` in
  `src/options/connection-client.ts`. These need codes or keys too.
- The manifest's `description` (`wxt.config.ts`); `name` and the toolbar's default title
  are `Pateat`. Only Chrome's own `_locales` mechanism (`__MSG_key__`) can translate
  manifest fields, whatever library the pages use.
- Counts with English plurals (`plural()` in `src/diagnostics/labels.ts`), values in
  sentences, and dates. Dates use `toLocaleString()`, which follows the browser's
  language.
- No UI is injected into web pages; the content scripts show no text.

## Candidates

| | `@wxt-dev/i18n` | i18next + react-i18next | Lingui | Paraglide JS |
| --- | --- | --- | --- | --- |
| Latest version | 0.2.8 | 26.4.4 / 17.0.16 | 6.9.1 | 2.27.0 |
| Downloads, last week | 50,404 | 24.1 M / 17.9 M | 1.8 M (`@lingui/core`) | 0.78 M |
| Maintainer | WXT's own monorepo | i18next project | Lingui project | inlang |
| How it works | Wraps `browser.i18n`; builds `_locales/*/messages.json` from YAML/JSON | Runtime library; resources loaded into an instance; React hooks | Macros mark text in source (`` t`Sign in` ``); catalogs extracted and compiled | Compiles each message to a typed function at build time |
| Language used | Chrome's UI language only | Any: Chrome's language or a Pateat setting | Any | Any, through a custom strategy over `chrome.storage` |
| Switch language inside Pateat | No | Yes | Yes | Yes (`setLocale()` reloads the page by default) |
| Manifest field | Yes (same files) | No: one hand-written `_locales` file | No: same | No: same |
| Service worker | Synchronous `getMessage` | Works; needs its own init | Works; needs its own init | Works (plain functions; `getLocale()` is synchronous) |
| Plurals | `0` / `1` / `n` forms only | Full CLDR plurals | ICU MessageFormat | Variants / plurals |
| Markup inside messages | No: plain strings | `<Trans>` component | `<Trans>` component | Plain strings |
| Typed keys | Generated from the English file | Via type declarations | Source text is the key | Generated functions |
| Extra build step | WXT module only | None | Vite plugin: `lingui({ macroTransform: true })` transforms macros natively and compiles catalogs on import; `lingui extract` CLI | Vite plugin; inlang project files |
| Fit with existing choices | Built for WXT, which the owner chose; pre-1.0 with little adoption | Independent of WXT | Independent; the native macro transform is new (6.9.0, 2026-10-01, `@lingui/native-tools` 0.1.x). The older route needs `@rolldown/plugin-babel`, because the repo's `@vitejs/plugin-react` 6 has no Babel | Independent; its compiler depends on `@inlang/sdk` and others (Valibot among them), none of which ship in the built code |

Also considered and not recommended:

- Raw `browser.i18n` with hand-written `_locales/*/messages.json`: what
  `@wxt-dev/i18n` produces, without typed keys, plurals or a readable file format.
- react-intl / FormatJS (3.3 M downloads) and use-intl (7.2 M, mostly through
  next-intl): ICU-based like Lingui; FormatJS has its own `formatjs extract` CLI.
  Neither adds anything over the four above that 600 strings need.
- typesafe-i18n: 5.27.1 on 2026-02-11 after a gap since 2023, 65 k downloads; the least
  active.

## The main tradeoff

Chrome's `i18n` API, and so `@wxt-dev/i18n`, always uses Chrome's UI language: a
Japanese Chrome gets Japanese, and the language cannot be chosen inside Pateat. On
2026-10-12 an MV3 test extension in Chromium returned `ja` and the Japanese message from
`chrome.i18n.getUILanguage()` and `getMessage()` in its service worker when Chromium ran
with `--lang=ja`, and English with `--lang=en-US`.

The other three can follow a Pateat setting, at the cost of a hand-written `_locales`
file for the manifest's one translatable field (`description`), loading messages in each
entrypoint, storing the setting, and passing the chosen locale to every date
formatting call, since `toLocaleString()` follows the browser rather than Pateat.

## Costs common to every option

- Tests that assert English text keep working only if the test setup loads the English
  messages; `@wxt-dev/i18n` needs a fake `browser.i18n` in Vitest, the others an
  initialized instance.
- The copied diagnostics report and the logs are read when fixing bugs. Whether they
  stay English, while the page around them is translated, is a separate decision.

## Recommendation

`@wxt-dev/i18n`, if following Chrome's language is enough: it is part of WXT, covers the
manifest with the same files, and works synchronously in the service worker. Japanese
has no plural forms. Against it: it is pre-1.0 with little adoption, and it cannot put
markup inside messages, so the seven sentences with `<code>`, `<strong>` or `<a>` are
split or reworded. If the owner wants a language setting inside Pateat, i18next with
react-i18next, as the most established library that allows it; Lingui is the
alternative if source-text keys and extraction are preferred.
