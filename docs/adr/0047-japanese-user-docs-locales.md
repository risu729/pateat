# ADR 0047: Japanese user documentation routes

Status: proposed and implemented for review, not accepted by the owner. The owner
asked for Japanese alongside English for user documentation on 2026-10-12 and now
explicitly authorized autonomous implementation, recording unresolved choices as
proposals and continuing with the recommendation. This records agent-selected locale
routing and defaults, not owner acceptance. Depends on the VitePress 2 site in
[PR 612](https://github.com/risu729/pateat/pull/612); does not change its deployment or
license proposals. Amends no accepted ADR.

Date: 2026-10-17

## Context

The owner chose to translate the README and user-facing pages, while keeping ADRs,
the plan and research in English. The docs site supplies five English pages and no
Japanese locale. Extension UI translation is independent work; this change must not
claim that unmerged UI translations already ship.

## Decision

Proposed recommendation, unconfirmed by the owner: keep English at the existing root
URLs and add complete Japanese counterparts under `/ja/`, using VitePress's built-in
language switch. Keep English as the root/default; do not redirect based on browser
language. Each locale has its own navigation, sidebar, document controls and search
labels, with `lang="en"` or `lang="ja"` on the generated HTML. Japanese content links
to Japanese sibling pages; links to developer material explicitly identify English.
Japanese headings use explicit IDs matching their English counterparts, so the
language switch preserves a section fragment without pointing to a missing heading.

Keep the current English Pateat UI control labels in the Japanese setup instructions,
with Japanese explanations, so readers can find the actual controls in the site's
base revision. Reconcile those labels when translated UI wording lands. Translate
Chrome's interface labels as shown in its Japanese desktop UI.

Questions for owner review: approve English as the unchanged root/default and Japanese
under `/ja/`, with an explicit language switch and no automatic language redirect?
The implementation proceeds with this recommendation under the owner's instruction.

## Consequences

The five Japanese pages preserve the English pages' unreleased status, private-service
boundary, security limitations, draft privacy status and unresolved packaging. This
translation is not public service access, deployment or legal/store approval.

AGENTS.md gets the previously planned exception for user-facing Japanese pages and
locale labels. Developer documentation stays in English. The existing build and
built-link checker cover both route trees; browser verification must check language
navigation, translated accessible controls and narrow layouts separately.

## Alternatives

- Japanese at the root and English under `/en/`: changes existing English URLs before
  the owner has selected a new default.
- Browser-language redirects: can surprise readers, crawlers and shared links, and
  are unnecessary when the built-in language switch is available.
- One mixed-language page per topic: weakens document-language accessibility and makes
  navigation and search less useful in each language.
