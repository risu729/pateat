# ADR 0047: Japanese docs pages under `/ja/`, with no language redirect

Status: accepted by the owner on 2026-10-23. Asked how the docs website should offer
Japanese, the owner chose option A (`/ja/`, no automatic language redirect, a language
switch), then added at 13:00 UTC:
「公開ページはgoogle様の推奨に従えばいいが、privateなのは UX優先して」 (public pages
follow Google's recommendation; private pages put UX first), and on a decision card
(about 13:07 UTC) `/ja/` plus `hreflang`, with no redirect. The owner also said at 12:59
UTC to pick the generally best option for front-end design details instead of asking.
First proposed in [PR 721](https://github.com/risu729/pateat/pull/721) on 2026-10-17.

Date: 2026-10-23

## Context

The owner asked on 2026-10-12 for Japanese alongside English in the README, the
user-facing docs and the extension's UI ([plan](../plan.md#phase-3-public-release)). The
docs website in `apps/docs` has five English pages at the site root. The extension's UI
is translated ([ADR 0043](0043-extension-language-preference.md)) and the README has
`README.ja.md`. Google recommends a separate URL for each language, `hreflang` links
between them, and no redirect by the browser's language, which can keep crawlers and
people from the other version
([Google Search Central](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)).

## Decision

- English stays at the root; each English page has a Japanese page at the same path
  under `/ja/` (`apps/docs/src/ja/`). VitePress's locale switch links the two, and each
  locale has its own navigation, sidebar, search and control labels, with `lang="en"`
  or `lang="ja"` on its HTML.
- No page redirects by the browser's language or remembers a choice; the switch is the
  only way between them.
- Every page names both versions with `<link rel="alternate" hreflang>` (`en`, `ja`,
  and `x-default` for English). The links need absolute URLs, so the build adds them
  only when `PATEAT_DOCS_URL` names the site's origin, which the deployment sets.
- A Japanese heading carries the English heading's ID (`{#vault-timeout}`), so a link
  or language switch to a section works in both languages. `scripts/check-docs.mjs`
  reads explicit IDs and Unicode headings.
- The Japanese pages quote the extension's Japanese UI labels from its catalogs
  (`apps/extension/src/locales/*-ja.ts`) and Chrome's Japanese labels; the service's
  pages, which are English only, keep their English names. Links to developer docs say
  that they are in English.
- The Japanese privacy policy says that it translates the English one, which prevails
  where they differ (Claude's choice, not confirmed by the owner).
- A PR that changes an English page changes its Japanese page too
  ([AGENTS.md](../../AGENTS.md)).

The service's own pages (`/manage`) are not public and are outside this ADR; the owner
put user experience first there, such as following the browser's language or a
remembered choice.

## Consequences

Search engines see two language versions of each page and can show the one that fits
the reader, without a redirect hiding either. Each page change costs a translation in
the same PR. Until the site is deployed with `PATEAT_DOCS_URL`, built pages have no
`hreflang` links.

## Alternatives

- **Japanese at the root and English under `/en/`**: changes every English URL.
- **Redirect by the browser's language**: against Google's advice; a shared link or a
  crawler can end up on the wrong version.
- **One page with both languages**: breaks the page's `lang`, search and navigation in
  each language.
