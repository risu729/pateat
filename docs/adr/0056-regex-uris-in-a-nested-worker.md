# ADR 0056: Regex URIs run in a nested Worker with a 5-second limit

Status: accepted by the owner on 2026-10-19 at 10:06 UTC. Shown the reviewed proposal
(evaluate Regex with the browser's `RegExp` in a separate Worker stopped after a time
limit, or with the re2js library; use a Regex-only match for automatic login like the
other modes, or only from a popup pick; keep or widen the `http:` rule of
[ADR 0050](0050-http-pages-for-http-items.md)), the owner answered
「おすすめ通りでいいが5秒で打ち切って」 (the recommendations are fine, but stop it after
5 seconds). Implemented (local tests only; not yet checked on a real site).

Date: 2026-10-19

## Context

A Bitwarden URI saved with `match` 4 (Regex) holds a pattern that the official clients
test against the page URL with `new RegExp(uri, "i").test(pageUrl)`; one that does not
compile matches nothing, and nothing bounds how long a test may run
([login-uri.view.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L177-L186)).
A backtracking pattern grows exponentially: `(a+)+$` against `https://example.com/?q=`
followed by 30 `a`s and a `!` took 18 seconds in Node 26.

Pateat did not evaluate Regex URIs. Their item counted as unevaluated, so while such an
item was eligible, every HTTPS page where Pateat chooses the account by URI match was
refused as `item-uri-unevaluated`. Running the pattern in the crypto Worker itself would
let one slow pattern hold the vault session until the 30-second job limit terminated it
and locked the vault, again on every page. The re2js port of RE2 is linear in the URL
only for a fixed pattern (one run of re2js 2.8.8 took 268 seconds for a 37-character
pattern against a 2 MiB URL), reads
some patterns differently from JavaScript (`\z`, `[[:alpha:]]`) and has no lookaround or
backreferences, so it would still need a time limit and a pattern rewriter.

## Decision

- Regex URIs are evaluated with the browser's `RegExp`, exactly as the pinned clients
  do: the raw saved pattern, the `i` flag, the raw page URL, and no match for a pattern
  that does not compile. The pattern is not checked as a URL or for a scheme.
- They run in a nested dedicated Worker that the crypto Worker starts on its first Regex
  URI (`apps/extension/src/crypto/regex-worker.ts`, driven by `regex.ts`). The crypto
  Worker sends it the page URL and the decrypted patterns of one `match-uris` request at
  once, and nothing else; it answers one result per pattern. It disables logging and
  `fetch`, and it ends when the crypto Worker ends, as on lock.
- One page URL's patterns may run for 5 seconds in all, counted from when the Worker is
  ready (its start has a separate 5-second bound). When the time runs out, the Worker is
  terminated, a new one is started on the next request, and the patterns without a
  result are `regex-unevaluated`, so their item stays unevaluated as before this ADR.
  The pattern that was running, when it ran for at least half the time on its own, is
  remembered with a digest of that URL (up to 1,000 pairs) and skipped in later requests
  for the same page, such as the frame's top page check, the item origin checks and the
  popup. A page with several slow patterns waits once for each of them, and a page whose
  URL changes on every visit, as with a one-time `state` query, waits on every visit.
- A Regex match counts as any other mode does (C1 of the proposal): it can choose the
  account on its own, admit the item's origin for a fill, and allow a form destination
  under [ADR 0051](0051-form-destinations-by-item-uri-match.md). On an `http:` page only
  a pattern whose text starts with `http://` counts and runs (ADR 0050, unchanged): a
  pattern starting with `^http://` or `^https?://` does not.

## Consequences

A vault with Regex URIs now logs in where the official clients would match, and no
longer refuses unrelated HTTPS pages as `item-uri-unevaluated`. A slow pattern delays
the first match of a page by up to 5 seconds and leaves its item unevaluated there;
because the limit is time-based, a borderline pattern may finish on a fast computer and
not on a slow one.

A pattern without `^` matches anywhere in the URL, including its query, so
`example\.com` also matches `https://evil.test/?r=example.com`. The official extension
accepts this behind a warning shown when the mode is chosen, and by default fills only
after a click; Pateat logs in with no click, as it does for the other modes. What still
stands between such a page and a fill is a recipe for its exact origin
([ADR 0013](0013-service-held-recipes-and-settings.md)), the form destination check and
the document checks.

Decrypted patterns now reach a second Worker inside the extension. It receives only the
patterns and the page URL, returns only booleans, and shares the crypto Worker's
lifetime. No permission or content security policy changes: `script-src 'self'` covers
the bundled Worker script.
